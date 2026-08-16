"""Backend entry point: bind localhost on a free port, write backend.json (§3),
load files, start the scheduler, serve the API."""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import socket
import sys
import threading

import uvicorn

from . import __version__, api, awake, paths
from .listeners import Listeners
from .scheduler import Scheduler
from .storage import store
from .yamlio import atomic_write_text


LOG_CAP = 100 * 1024 * 1024  # §5 log size cap
LOG_TRIM_TO = LOG_CAP // 2  # trim target — half the cap, so a saturated log isn't rewritten every boot


def trim_logs() -> None:
    """§5 log size cap: at startup, trim any over-cap backend log in place to
    its newest LOG_TRIM_TO bytes (cut at a line boundary) — oldest lines die
    first. In place because launchd holds backend.out/err.log open in append
    mode; renaming would leave the live fd writing to the renamed file."""
    for name in ("app.log", "backend.out.log", "backend.err.log"):
        path = paths.logs_dir() / name
        try:
            if path.stat().st_size <= LOG_CAP:
                continue
            with open(path, "rb+") as f:
                f.seek(-LOG_TRIM_TO, os.SEEK_END)
                tail = f.read()
                nl = tail.find(b"\n")
                if nl != -1:
                    tail = tail[nl + 1:]
                f.seek(0)
                f.write(tail)
                f.truncate()
        except OSError:
            continue


class _DevModeFilter(logging.Filter):
    """§4.9 developerMode: INFO request logs pass only while the setting is on.
    Also scrubs the auth token from logged request lines — the WS handshake
    carries it in the query string, and the access log would otherwise copy
    the sole credential into backend.out.log (not 0600 like backend.json)."""

    _TOKEN = re.compile(r"token=[^&\s\"']+")

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args:
            record.args = tuple(
                self._TOKEN.sub("token=***", a) if isinstance(a, str) else a
                for a in record.args)
        return record.levelno >= logging.WARNING or bool(store.settings.get("developerMode"))


def republish_if_lost(payload: str) -> bool:
    """§3 discovery guard: rewrite backend.json when it is missing or
    unreadable (recreating the §5 dirs first) — an externally wiped
    Application Support dir must not strand clients on a healthy backend that
    launchd KeepAlive will never restart. A well-formed file is left alone
    whatever pid it holds: during a service restart it may already be the
    successor's. Returns True when it rewrote."""
    try:
        json.loads(paths.backend_json().read_text())
        return False
    except (OSError, ValueError):
        paths.ensure_dirs()
        atomic_write_text(paths.backend_json(), payload, mode=0o600)
        return True


def main() -> None:
    paths.ensure_dirs()
    trim_logs()
    store.load_all()
    # Bind before publishing: uvicorn serves on this very socket, so the port
    # is ours the moment backend.json exists. Probing a free port, closing it,
    # and letting uvicorn rebind would leave a gap where another process can
    # take the port — with backend.json (auth token included) already pointing
    # clients at it.
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", int(os.environ.get("AUTOWRIGHT_PORT", 0))))
    port = sock.getsockname()[1]
    # §3 discovery: port + auth token, 0600. `python` feeds the shell's
    # CLI-on-PATH shim (§3) so it execs the interpreter that runs the backend.
    discovery = json.dumps({
        "port": port, "token": api.AUTH_TOKEN, "version": __version__, "pid": os.getpid(),
        "python": sys.executable,
    })
    atomic_write_text(paths.backend_json(), discovery, mode=0o600)
    # §3 discovery guard: backend.json is written once at boot — if something
    # deletes it while we live, clients are stranded forever. Re-publish it.
    stop_guard = threading.Event()

    def _guard() -> None:
        while not stop_guard.wait(10):
            republish_if_lost(discovery)

    threading.Thread(target=_guard, name="backend-json-guard", daemon=True).start()
    scheduler = Scheduler(store, api.engine)
    scheduler.start()
    listeners = Listeners(store, api.engine)  # §6 message-trigger listener manager
    listeners.start()
    awake.reconcile(bool(store.settings.get("keepAwake")))  # §3/§4.9 permanent assertion
    # §4.9 developerMode: request logging (every HTTP request via the uvicorn access
    # log, every agent request via autowright.harness) prints only while the
    # Settings toggle is on. The filter reads the live setting, so flipping the
    # toggle applies immediately — no restart. WARNING+ always prints.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    logging.getLogger().handlers[0].addFilter(_DevModeFilter())
    # uvicorn's dictConfig would wipe filters added to its loggers up front, so
    # the filter rides in on its log_config handlers instead.
    log_config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    log_config["filters"] = {"devmode": {"()": _DevModeFilter}}
    for handler in log_config["handlers"].values():
        handler.setdefault("filters", []).append("devmode")
    try:
        config = uvicorn.Config(api.app, host="127.0.0.1", port=port,
                                log_level="info", log_config=log_config)
        uvicorn.Server(config).run(sockets=[sock])
    finally:
        stop_guard.set()  # before the unlink below — the guard must not resurrect the file
        scheduler.stop()
        listeners.stop()
        try:
            # Only remove our own discovery file: during a service restart the
            # successor may already have published its fresh port/token here —
            # deleting that would strand the UI/CLI on nothing (§3).
            if json.loads(paths.backend_json().read_text()).get("pid") == os.getpid():
                paths.backend_json().unlink()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    main()
