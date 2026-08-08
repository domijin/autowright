"""§6 listener manager: Discord firing rules, payload shape, §6.1 reply
sending, dispatch, and the engine/executor plumbing around triggerPayload."""
import logging
import time

from conftest import make_version, read_all_logs

from autowright import keychain
from autowright.listeners import (
    Listeners, message_matches, notify_busy, send_reply, trigger_payload,
)


def _msg(**over):
    d = {"channel_id": "42", "content": "please Deploy now",
         "author": {"id": "7", "username": "dave", "global_name": "Dave"},
         "mentions": [], "id": "m1", "guild_id": "g1",
         "timestamp": "2026-07-27T10:00:00+00:00"}
    d.update(over)
    return d


def _trig(**over):
    t = {"id": "t1", "kind": "discord", "enabled": True,
         "channel": "42", "secret": "TOKEN"}
    t.update(over)
    return t


def test_message_matches_rules():
    assert message_matches(_trig(), _msg(), bot_id="bot9")
    # wrong channel
    assert not message_matches(_trig(channel="99"), _msg(), "bot9")
    # bot-authored messages never fire — including the listening bot itself
    assert not message_matches(_trig(), _msg(author={"id": "8", "bot": True}), "bot9")
    assert not message_matches(_trig(), _msg(author={"id": "bot9"}), "bot9")
    # mention: only messages that @-mention the bot
    assert not message_matches(_trig(mention=True), _msg(), "bot9")
    assert message_matches(_trig(mention=True),
                           _msg(mentions=[{"id": "bot9"}]), "bot9")
    # mention: the bot's managed role counts too (typing @BotName often
    # inserts the role mention, not the user mention)
    assert message_matches(_trig(mention=True),
                           _msg(mention_roles=["r5"]), "bot9",
                           bot_roles={"r5"})
    assert not message_matches(_trig(mention=True),
                               _msg(mention_roles=["r6"]), "bot9",
                               bot_roles={"r5"})
    # pattern: case-insensitive substring
    assert message_matches(_trig(pattern="deploy"), _msg(), "bot9")
    assert not message_matches(_trig(pattern="rollback"), _msg(), "bot9")
    # author: only the configured senders' messages fire
    assert message_matches(_trig(author=["7"]), _msg(), "bot9")
    assert message_matches(_trig(author=["6", "7"]), _msg(), "bot9")
    assert not message_matches(_trig(author=["8"]), _msg(), "bot9")
    # filters AND together
    assert message_matches(_trig(author=["7"], pattern="deploy"), _msg(), "bot9")
    assert not message_matches(_trig(author=["8"], pattern="deploy"), _msg(), "bot9")


def test_trigger_payload_shape():
    p = trigger_payload(_trig(), _msg())
    assert p == {"kind": "discord", "text": "please Deploy now", "sender": "Dave",
                 "channel": "42", "channelName": None, "guildName": None,
                 "messageId": "m1", "guildId": "g1",
                 "secret": "TOKEN", "at": "2026-07-27T10:00:00+00:00"}
    # §6 name cache resolved names ride on the payload
    p = trigger_payload(_trig(), _msg(), channel_name="deploys", guild_name="Ops")
    assert p["channelName"] == "deploys" and p["guildName"] == "Ops"


def test_send_reply_needs_discord_payload_and_token():
    assert "message trigger" in send_reply({}, "hi")
    # fake keychain (conftest) holds no TOKEN value
    assert "has no value" in send_reply({"kind": "discord", "channel": "42",
                                         "secret": "TOKEN"}, "hi")


def _busy_recorder(monkeypatch):
    """Capture notify_busy's sends and run them inline — the real one hands the
    send to a daemon thread, which a test can't join on."""
    from autowright import listeners as li_mod

    sent = []
    monkeypatch.setattr(li_mod, "send_reply",
                        lambda payload, text: sent.append((payload, text)))
    monkeypatch.setattr(li_mod.threading, "Thread",
                        lambda target, args, daemon, name: type(
                            "T", (), {"start": lambda self: target(*args)})())
    return sent


def test_notify_busy_replies_once_per_sender_within_cooldown(monkeypatch):
    from autowright import listeners as li_mod

    sent = _busy_recorder(monkeypatch)
    monkeypatch.setattr(li_mod, "BUSY_COOLDOWN_S", 60.0)
    payload = {"kind": "discord", "channel": "42", "secret": "TOKEN",
               "sender": "Dave"}

    notify_busy(payload)
    notify_busy(payload)  # same sender, still inside the cooldown
    assert len(sent) == 1
    assert sent[0][1] == li_mod.BUSY_TEXT

    # a different sender in the same channel is answered independently
    notify_busy({**payload, "sender": "Ana"})
    assert len(sent) == 2


def test_notify_busy_skips_non_message_firings(monkeypatch):
    sent = _busy_recorder(monkeypatch)
    notify_busy({})  # a skipped cron firing carries no payload
    assert sent == []


def test_notify_busy_reply_failure_never_raises(monkeypatch, caplog):
    from autowright import listeners as li_mod

    _busy_recorder(monkeypatch)
    monkeypatch.setattr(li_mod, "send_reply",
                        lambda payload, text: "couldn't reach Discord: boom")
    with caplog.at_level(logging.WARNING, logger="autowright.listeners"):
        notify_busy({"kind": "discord", "channel": "42", "secret": "TOKEN",
                     "sender": "Dave"})  # logged, not raised
    assert any("busy notice failed — couldn't reach Discord: boom" in r.getMessage()
               for r in caplog.records)


def test_send_reply_posts_with_bot_token(monkeypatch):
    import requests

    keychain.set_secret("TOKEN", "abc123")
    calls = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.update(url=url, headers=headers, body=json)

        class R:
            status_code = 200
        return R()

    monkeypatch.setattr(requests, "post", fake_post)
    payload = {"kind": "discord", "channel": "42", "secret": "TOKEN"}
    assert send_reply(payload, "x" * 3000) is None
    assert calls["url"].endswith("/channels/42/messages")
    assert calls["headers"]["Authorization"] == "Bot abc123"
    assert len(calls["body"]["content"]) == 2000  # Discord cap — truncated


def test_send_reply_reports_http_failures(monkeypatch):
    # §6.1: a failed send returns an error string, never raises — the engine
    # logs it and the step goes on.
    import requests

    keychain.set_secret("TOKEN", "abc123")
    payload = {"kind": "discord", "channel": "42", "secret": "TOKEN"}

    def boom(*a, **kw):
        raise requests.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr(requests, "post", boom)
    err = send_reply(payload, "hi")
    assert err.startswith("couldn't reach Discord: ")
    assert "connection refused" in err

    class R:
        status_code = 500

    monkeypatch.setattr(requests, "post", lambda *a, **kw: R())
    assert send_reply(payload, "hi") == "Discord answered HTTP 500"


def test_dispatch_fires_matching_triggers_with_payload(store):
    fired = []

    class FakeEngine:
        @staticmethod
        def at_capacity(a):
            return False

        def start(self, a, label, version_label=None, payload=None, adopt=None):
            fired.append((a["id"], label, payload))
            return {"id": "x"}

    a = store.create_automation(make_version(), "Chat", None)
    a["triggers"] = [_trig()]
    b = store.create_automation(make_version(), "Other", None)
    b["triggers"] = [_trig(channel="99"), _trig(id="t2", enabled=False)]
    li = Listeners(store, FakeEngine())
    li.dispatch("TOKEN", _msg(), bot_id="bot9",
                chan_names={"42": "deploys"}, guild_names={"g1": "Ops"})
    assert [f[0] for f in fired] == [a["id"]]  # b: wrong channel / off
    assert fired[0][1] == "discord"
    assert fired[0][2]["text"] == "please Deploy now"
    # §4.5: the §6 name cache stamps channelName/guildName at firing time
    assert fired[0][2]["channelName"] == "deploys"
    assert fired[0][2]["guildName"] == "Ops"
    # a different token secret routes nothing
    fired.clear()
    li.dispatch("OTHER", _msg(), bot_id="bot9")
    assert fired == []


def test_desired_secrets_and_status(store):
    a = store.create_automation(make_version(), "Chat", None)
    a["triggers"] = [_trig(), _trig(id="t2", secret="TOKEN_B", enabled=False)]
    li = Listeners(store, None)
    assert li._desired_secrets() == ({"TOKEN"}, set())  # off triggers don't listen
    li.set_status("TOKEN", "error", "bad token")
    assert store.listener_status["TOKEN"] == {"state": "error", "error": "bad token"}
    # the §4.3 `connection` rides trigger serialization; unknown secrets read connecting
    t_json = store.trigger_json(a["triggers"][0])
    assert t_json["connection"] == {"state": "error", "error": "bad token"}
    assert store.trigger_json(a["triggers"][1])["connection"] == {"state": "connecting"}


def _wait_done(engine, execution_id, timeout=30):
    t0 = time.time()
    while engine.is_live(execution_id):
        assert time.time() - t0 < timeout, "execution never finished"
        time.sleep(0.05)


def test_engine_reply_and_payload_end_to_end(store, monkeypatch):
    from autowright import listeners as li_mod
    from autowright.engine import Engine

    sent = []
    monkeypatch.setattr(li_mod, "send_reply",
                        lambda payload, text: sent.append((payload, text)) or None)
    ver = make_version()
    ver["steps"] = [{"file": "01-echo.py", "name": "Echo", "description": "",
                     "code": 'from autowright import execution, reply\nreply(f"got: {execution.trigger_payload[\'text\']}")\n'}]
    a = store.create_automation(ver, "Replier", None)
    engine = Engine(store)
    payload = trigger_payload(_trig(), _msg())
    h = engine.start(a, "discord", payload=payload)
    _wait_done(engine, h["id"])
    assert store.execs[h["id"]]["status"] == "succeeded"
    assert sent == [(payload, "got: please Deploy now")]
    logs = [ln["text"] for ln in read_all_logs(store, h["id"])]
    assert any("reply sent to Discord (42)" in t for t in logs)
    # §4.5: the payload persists on the record
    assert store.read_exec_yaml(h["id"])["trigger_payload"] == payload
    # §4.5 triggerSender rides on the list row; the payload is full-record-only
    row = store.exec_json(store.execs[h["id"]])
    assert row["triggerSender"] == payload["sender"]
    assert "triggerPayload" not in row
    assert store.exec_json(store.execs[h["id"]], full=True)["triggerPayload"] == payload


def test_reply_outside_message_trigger_fails_step(store):
    from autowright.engine import Engine

    ver = make_version()
    ver["steps"] = [{"file": "01-nope.py", "name": "Nope", "description": "",
                     "code": 'from autowright import reply\nreply("hi")\n'}]
    a = store.create_automation(ver, "NoOrigin", None)
    engine = Engine(store)
    h = engine.start(a, "manual")
    _wait_done(engine, h["id"])
    rec = store.execs[h["id"]]
    assert rec["status"] == "failed"
    assert "reply() is only available" in rec["error"]["message"]


# ---------- §6 reconcile lifecycle (fake conn/watcher, real store) ----------

def test_reconcile_starts_and_stops_listeners(store, monkeypatch):
    from autowright import listeners as li_mod

    events = []

    class FakeConn:
        def __init__(self, secret, mgr):
            self.secret = secret
            events.append(("conn-new", secret))

        def start(self):
            events.append(("conn-start", self.secret))

        def stop(self):
            events.append(("conn-stop", self.secret))

    class FakeWatcher:
        def __init__(self, mgr):
            events.append(("imsg-new",))

        def tick(self, senders):
            events.append(("imsg-tick", tuple(sorted(senders))))

        def close(self):
            events.append(("imsg-close",))

    monkeypatch.setattr(li_mod, "_Conn", FakeConn)
    monkeypatch.setattr(li_mod, "_ImsgWatcher", FakeWatcher)
    a = store.create_automation(make_version(), "Chat", None)
    li = Listeners(store, None)

    li._reconcile()  # no enabled triggers → nothing exists
    assert events == []

    # discord trigger + secret appears → one conn, started
    a["triggers"] = [_trig()]
    li._reconcile()
    assert events == [("conn-new", "TOKEN"), ("conn-start", "TOKEN")]

    # trigger toggled off → conn stopped AND its status entry removed
    li.set_status("TOKEN", "connected")
    a["triggers"][0]["enabled"] = False
    events.clear()
    li._reconcile()
    assert events == [("conn-stop", "TOKEN")]
    assert "TOKEN" not in store.listener_status

    # imessage trigger appears → the one watcher is created and ticked
    a["triggers"] = [{"id": "t9", "kind": "imessage", "enabled": True,
                      "from": "dave@example.com"}]
    events.clear()
    li._reconcile()
    assert events == [("imsg-new",), ("imsg-tick", ("dave@example.com",))]

    # last imessage trigger removed → watcher closed, status entry removed
    li.set_status(li_mod.IMSG_KEY, "connected")
    a["triggers"] = []
    events.clear()
    li._reconcile()
    assert events == [("imsg-close",)]
    assert li_mod.IMSG_KEY not in store.listener_status


# ---------- §6 iMessage dispatch ----------

def _imsg(**over):
    m = {"from_me": False, "group": False, "tapback": False,
         "text": "please Deploy now", "sender": "dave@example.com",
         "chat": "iMessage;-;dave@example.com", "guid": "g1", "ts": time.time()}
    m.update(over)
    return m


def _imsg_trig(**over):
    t = {"id": "t1", "kind": "imessage", "enabled": True, "from": "dave@example.com"}
    t.update(over)
    return t


def test_dispatch_imessage_fires_matching_triggers_with_payload(store):
    fired = []

    class FakeEngine:
        @staticmethod
        def at_capacity(a):
            return False

        def start(self, a, label, version_label=None, payload=None, adopt=None):
            fired.append((a["id"], label, payload))
            return {"id": "x"}

    a = store.create_automation(make_version(), "Chat", None)
    a["triggers"] = [_imsg_trig()]
    b = store.create_automation(make_version(), "Other", None)
    b["triggers"] = [_imsg_trig(**{"from": "other@example.com"}),
                     _imsg_trig(id="t2", enabled=False)]
    li = Listeners(store, FakeEngine())
    li.dispatch_imessage(_imsg())
    assert [f[0] for f in fired] == [a["id"]]  # b: wrong sender / off
    assert fired[0][1] == "imessage"
    payload = fired[0][2]
    assert payload["kind"] == "imessage"
    assert payload["text"] == "please Deploy now"
    assert payload["sender"] == "dave@example.com"
    assert payload["chat"] == "iMessage;-;dave@example.com"
    # a non-matching sender routes nothing
    fired.clear()
    li.dispatch_imessage(_imsg(sender="stranger@example.com"))
    assert fired == []


# ---------- §6 _Conn.run: auth failures park at the backoff cap ----------

class _FakeMgr:
    def __init__(self):
        self.statuses = []

    def set_status(self, key, state, error=None):
        self.statuses.append((key, state, error))


def _stub_stop_wait(monkeypatch, conn):
    """Record every _stop.wait duration and break the loop after one park —
    the run loop would otherwise spin forever inside the test."""
    waits = []

    def fake_wait(timeout=None):
        waits.append(timeout)
        conn._stop.set()
        return True

    monkeypatch.setattr(conn._stop, "wait", fake_wait)
    return waits


def test_conn_auth_close_parks_at_backoff_max(monkeypatch):
    from websockets.exceptions import ConnectionClosed
    from websockets.frames import Close

    from autowright import listeners as li_mod

    keychain.set_secret("BOT", "tok")
    mgr = _FakeMgr()
    conn = li_mod._Conn("BOT", mgr)

    def raise_auth_close(token):
        raise ConnectionClosed(Close(4004, "Authentication failed."), None, None)

    monkeypatch.setattr(conn, "_session", raise_auth_close)
    waits = _stub_stop_wait(monkeypatch, conn)
    conn.run()  # inline, no thread — the stubbed wait ends it after one park
    assert waits == [li_mod.BACKOFF_MAX]  # parked at the cap, no hot loop
    assert ("BOT", "error", li_mod._CLOSE_REASONS[4004]) in mgr.statuses
    # the plain-word reason, not a close-code dump
    assert "Discord rejected the bot token" in li_mod._CLOSE_REASONS[4004]


def test_conn_missing_token_parks_with_plain_status(monkeypatch):
    from autowright import listeners as li_mod

    mgr = _FakeMgr()
    conn = li_mod._Conn("NO_VALUE", mgr)  # fake keychain holds nothing for it
    waits = _stub_stop_wait(monkeypatch, conn)
    conn.run()
    assert waits == [li_mod.BACKOFF_MAX]
    key, state, error = mgr.statuses[0]
    assert (key, state) == ("NO_VALUE", "error")
    assert "secret NO_VALUE has no value yet" in error
