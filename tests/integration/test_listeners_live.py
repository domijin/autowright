"""§15 integration: the §6 iMessage message-trigger loop over a fixture
chat.db — a real backend's listener manager polls the db (`AUTOWRIGHT_CHAT_DB`,
1 s reconcile ticks), a fresh row fires a real execution, and the step's reply
goes out through the fake `osascript` (argv captured to a log file)."""
import sqlite3
import sys
import time

import pytest

from .it_harness import create_auto, run_cli, wait_for, wait_status

pytestmark = [
    pytest.mark.integration,
    # §2: iMessage is Apple-only — elsewhere capabilities compose
    # `imessage: false` and the watcher can never reach `connected`.
    pytest.mark.skipif(sys.platform != "darwin",
                       reason="iMessage capability is macOS-only"),
]

# Apple epoch offset (2001-01-01) — chat.db stores ns since then.
EPOCH = 978307200

SENDER = "+15551234567"


def _make_chat_db(path) -> sqlite3.Connection:
    """Minimal chat.db shape (same as tests/test_imessage.py): only the
    tables/columns the §6 queries touch."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
            attributedBody BLOB, is_from_me INTEGER DEFAULT 0, date INTEGER,
            associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
            handle_id INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        INSERT INTO handle VALUES (1, '+15551234567');
        INSERT INTO chat VALUES (1, 'iMessage;-;+15551234567', 45);
    """)
    db.commit()
    return db


def _add_msg(db: sqlite3.Connection, rowid: int, text: str) -> None:
    db.execute("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?)",
               (rowid, f"g{rowid}", text, None, 0,
                int((time.time() - EPOCH) * 1e9), 0, 0, 1))
    db.execute("INSERT INTO chat_message_join VALUES (?,?)", (1, rowid))
    db.commit()


def test_imessage_trigger_fires_and_replies(backend_factory, tmp_path):
    chat_path = tmp_path / "chat.db"
    db = _make_chat_db(chat_path)
    _add_msg(db, 1, "history — must never fire")
    osa_log = tmp_path / "osa.log"
    b = backend_factory(extra_env={
        "AUTOWRIGHT_CHAT_DB": str(chat_path),
        "AUTOWRIGHT_LISTEN_TICK_S": "1",
        "AUTOWRIGHT_IMSG_MAX_AGE_S": "9999",
        "AUTOWRIGHT_TEST_OSASCRIPT_LOG": str(osa_log),
    })
    with b.client() as c:
        a = create_auto(c, name="Messaged", steps=[
            {"file": "01-reply.py", "name": "Reply", "description": "acks",
             "code": 'from autowright import log, reply\n'
                     'log("message fired me")\nreply("integration reply done")\n'},
        ])
        # Add the trigger through the real CLI surface (§20).
        r = run_cli(b.home, "automation", "trigger", "add", "Messaged",
                    "--imessage", SENDER)
        assert r.returncode == 0, r.stderr + r.stdout

        # The watcher opens at the next 1 s reconcile tick with its cursor at
        # MAX(ROWID) — insert the firing row only once it reports connected,
        # so the row is unambiguously fresh (history must never fire).
        def connected():
            full = c.get(f"/automations/{a['id']}").json()
            t = (full.get("triggers") or [{}])[0]
            return (t.get("connection") or {}).get("state") == "connected"

        wait_for(connected, 30, "imessage watcher to connect")
        assert c.get("/executions").json()["executions"] == []  # history row didn't fire

        _add_msg(db, 2, "fresh message, please run")

        def fired():
            ex = c.get("/executions").json()["executions"]
            return ex[0] if ex else None

        e = wait_for(fired, 30, "message firing to reach an execution")
        e = wait_status(c, e["id"])
        assert e["status"] == "succeeded"

        # The reply left through the real send path: fake osascript recorded
        # its argv (tab-joined), last fields are the chat id and the text.
        argv = wait_for(lambda: osa_log.exists() and osa_log.read_text().strip(),
                        30, "osascript reply argv").split("\t")
        assert argv[-2:] == ["iMessage;-;+15551234567", "integration reply done"]
    db.close()
