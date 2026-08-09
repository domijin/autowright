import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

# tests/bin holds a fake `claude` CLI so agent calls exercise the real subprocess
# path (backend → executor → Popen) without a real agent installed. Prepended at
# import time so engine subprocesses inherit it.
os.environ["PATH"] = f"{REPO / 'tests' / 'bin'}{os.pathsep}{os.environ['PATH']}"


@pytest.fixture(autouse=True)
def fake_keychain(monkeypatch):
    """In-memory stand-in for the macOS Keychain (backend-process only calls)."""
    from autowright import keychain

    mem: dict[str, str] = {}
    monkeypatch.setattr(keychain, "get_secret", mem.get)
    monkeypatch.setattr(keychain, "set_secret", mem.__setitem__)
    monkeypatch.setattr(keychain, "delete_secret", lambda name: mem.pop(name, None))


@pytest.fixture(autouse=True)
def no_notifications(monkeypatch):
    """Default: notify.post is a no-op. The fixture yields the real function so
    tests/test_notify.py can drive the true osascript path (against the fake
    tests/bin/osascript) while every other test stays silent."""
    from autowright import notify

    real = notify.post
    monkeypatch.setattr(notify, "post", lambda title, body: None)
    yield real


@pytest.fixture(autouse=True)
def reset_module_globals():
    """Module-global caches leak between tests inside one worker — reset the
    known offenders before every test: the §19 `ollama serve` spawn cooldown
    and the §6 robots/site throttle caches."""
    from autowright import executor, harness

    harness._serve_last_spawn = 0.0
    executor._robots.clear()
    executor._site_last.clear()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """Isolated Autowright home per test."""
    monkeypatch.setenv("AUTOWRIGHT_HOME", str(tmp_path))
    from autowright import paths

    paths.ensure_dirs()
    return tmp_path


@pytest.fixture()
def client(home):
    """Authenticated TestClient over the live app — the shared API-suite entry
    point (a mock Claude Code agent is the sole configured agent)."""
    from fastapi.testclient import TestClient

    from autowright import api
    from autowright.storage import store

    store.load_all()
    store.autos.clear()
    store.execs.clear()
    store.agents = [{"id": "mock", "harness": "Claude Code", "mode": "default",
                     "model": None}]
    store.default_agent_id = "mock"  # §4.7 single pointer
    c = TestClient(api.app)
    c.headers["Authorization"] = f"Bearer {api.AUTH_TOKEN}"
    return c


@pytest.fixture()
def devmode(home):
    """developerMode on, persisted — reqlog reads the live setting from settings.yaml."""
    from autowright import paths, reqlog
    from autowright.yamlio import save_yaml

    save_yaml(paths.settings_file(), {"developerMode": True})
    reqlog._dev_cache["t"] = 0.0  # drop the 1 s cache so the write is seen now
    yield
    reqlog._dev_cache["t"] = 0.0


@pytest.fixture()
def store(home):
    from autowright.storage import Store

    s = Store()
    s.load_all()
    return s


def read_all_logs(store, execution_id):
    """Test convenience: every log line of an execution, merged across the
    per-step-attempt files plus the execution log (§5 logs/ layout)."""
    import json

    d = store.exec_dir(execution_id) / "logs"
    out = []
    if d.exists():
        for p in sorted(d.iterdir()):
            for ln in p.read_text(encoding="utf-8").splitlines():
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    pass
    return out


def make_version(**over):
    ver = {
        "description": "Test automation",
        "note": "Created",
        "params": [
            {"name": "greeting", "kind": "text", "label": "Greeting", "help": "", "default": "hello"},
            {"name": "count", "kind": "number", "label": "Count", "help": "", "min": 1, "default": 3},
        ],
        "steps": [
            {"file": "01-say.py", "name": "Say hello", "description": "prints",
             "code": 'from autowright import log, params\n'
                     'log(f"{params[\'greeting\']} x{params[\'count\']}")\n'},
            {"file": "02-finish.py", "name": "Finish", "description": "result",
             "code": 'from autowright import result\n'
                     'result.status("ok")\nresult.chip("All good")\n'},
        ],
        "spec": [{"kind": "h1", "text": "Test automation"}, {"kind": "p", "text": "It tests."}],
        "instructions": None,
    }
    ver.update(over)
    return ver
