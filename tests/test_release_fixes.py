"""Regression tests for the pre-release bug sweep (2026-07)."""
import io
import zipfile

import pytest

from conftest import make_version


def _write_memory(store, a, content="items: [1]\n"):
    d = store.auto_dir(a) / "memory"
    d.mkdir(parents=True, exist_ok=True)
    (d / "seen.yaml").write_text(content)


def test_restore_survives_unnamed_prune(store):
    """Restoring the oldest of 5 unnamed snapshots must not prune the restore
    source mid-restore: the pre-restore snapshot taken inside restore is the
    6th unnamed, so the §6.3 prune targets exactly the snapshot being restored
    (it used to rmtree the target, then crash after wiping live memory)."""
    a = store.create_automation(make_version(), "Pruney", None)
    _write_memory(store, a, "items: [0]\n")
    oldest = store.snapshot_memory(a, "manual")  # unnamed
    for i in range(1, 5):
        _write_memory(store, a, f"items: [{i}]\n")
        store.snapshot_memory(a, "manual")
    _write_memory(store, a, "items: [99]\n")

    meta = store.restore_snapshot(a, oldest["id"])
    assert meta is not None and meta["id"] == oldest["id"]
    mem = store.auto_dir(a) / "memory" / "seen.yaml"
    assert mem.read_text() == "items: [0]\n"
    # §6.3: restore is repeatable — the source snapshot still exists
    assert store.get_snapshot(a, oldest["id"]) is not None
    assert store.restore_snapshot(a, oldest["id"]) is not None


def test_time_trigger_rejects_utc_offset(client):
    r = client.post("/automations", json={
        "draft": make_version(triggers=[{"kind": "time", "at": "2030-01-01T10:00+02:00"}]),
        "name": "Aware", "agentId": "mock",
    })
    assert r.status_code == 422  # used to 500 with a TypeError


def test_offset_aware_trigger_on_disk_does_not_brick_load(store, home):
    from autowright.storage import Store
    from autowright.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "Diskey", None)
    y = home / "automations" / a["id"] / "automation.yaml"
    data = load_yaml(y)
    data["triggers"] = [{"id": "t-1", "kind": "time", "at": "2030-01-01T10:00+02:00"}]
    save_yaml(y, data)

    s2 = Store()
    s2.load_all()  # used to raise TypeError out of validate_trigger
    assert s2.autos[a["id"]]["triggers"] == []


def test_step_without_file_does_not_brick_load(store, home):
    from autowright.storage import Store
    from autowright.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "NoFile", None)
    y = home / "automations" / a["id"] / "versions" / "v1" / "automation.yaml"
    data = load_yaml(y)
    del data["steps"][0]["file"]
    save_yaml(y, data)

    s2 = Store()
    s2.load_all()  # used to raise IsADirectoryError
    steps = s2.autos[a["id"]]["versions"][1]["steps"]
    assert steps[0]["code"] == "" and steps[1]["code"]


def test_cron_trailing_slash_rejected():
    """Backend and renderer cron parsers must agree: "5/" is invalid, not step 1."""
    import pytest as _pytest

    from autowright import schedule

    with _pytest.raises(schedule.CronError):
        schedule.parse_cron("5/ * * * *")
    schedule.parse_cron("*/5 * * * *")  # real steps still parse


def test_settings_days_validation(client):
    assert client.patch("/settings", json={"days": "ninety"}).status_code == 422
    assert client.patch("/settings", json={"notif": "sometimes"}).status_code == 422
    r = client.patch("/settings", json={"days": "14"})
    assert r.status_code == 200
    from autowright.storage import store as live_store
    assert live_store.settings["days"] == 14  # coerced to int, retention-safe


def test_import_rejects_oversized_member(client):
    from autowright import transfer

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", "\0" * (transfer._MAX_MEMBER_BYTES + 1))
    r = client.post("/automations/import", content=buf.getvalue())
    assert r.status_code == 422
    assert "large" in r.json()["detail"]


def test_draft_endpoints_409_while_draft_execution_live(client):
    from autowright.storage import store as live_store

    r = client.post("/automations", json={"draft": make_version(), "name": "Busy",
                                          "agentId": "mock"})
    auto_id = r.json()["id"]
    a = live_store.autos[auto_id]
    live_store.save_draft(a, make_version())
    h = live_store.create_execution(a, "draft", None, "manual",
                                    [{"name": "s", "file": "01-say.py", "agent": False,
                                      "status": "executing", "dur_ms": None, "attempts": []}])
    a["_live"] = {h["id"]}
    try:
        assert client.put(f"/automations/{auto_id}/draft",
                          json={"draft": make_version()}).status_code == 409
        assert client.delete(f"/automations/{auto_id}/draft").status_code == 409
    finally:
        a["_live"] = set()
    assert client.put(f"/automations/{auto_id}/draft",
                      json={"draft": make_version()}).status_code == 200


# ---------- 2026-07-30 sweep: outbound secret paths, CORS, memory keys ----------

def test_reply_and_prompt_refuse_secret_values():
    """§6.1: text bound for a third party (agent prompt, message reply) is
    refused outright when it carries a secret value."""
    from autowright.executor import scan_outbound

    scan = {"API_TOKEN": "s3cret-value", "PEM": "line-one\nline-two"}
    for what in ("prompt", "reply"):
        with pytest.raises(RuntimeError, match="API_TOKEN"):
            scan_outbound("here you go: s3cret-value", what, scan)
        # a partial paste of a multi-line value is caught line by line
        with pytest.raises(RuntimeError, match="PEM"):
            scan_outbound("line-two", what, scan)
    scan_outbound("nothing sensitive here", "reply", scan)  # clean text passes


def test_scan_map_is_not_reachable_from_the_step_sdk():
    """§6: a step that declared no secrets must not read another step's value
    off the agent object."""
    from autowright.executor import Agent

    ctx = {"secrets": {}, "scan_secrets": {"OTHER": "v"}, "is_agent_step": True}
    scan = ctx.pop("scan_secrets")
    agent = Agent(ctx, scan)
    assert "scan_secrets" not in agent._ctx
    assert "OTHER" not in (agent._ctx.get("secrets") or {})


def test_memory_names_cannot_escape_the_memory_dir(tmp_path):
    """§6.1: snapshots and Clear memory operate on the memory dir — a key must
    never address a file outside it."""
    from autowright.executor import Memory

    m = Memory(str(tmp_path / "mem"))
    for bad in ("../escape", "sub/dir", "/abs", ".."):
        with pytest.raises(ValueError):
            m.save(bad, {"a": 1})
        with pytest.raises(ValueError):
            m.load(bad)
    m.save("fine", {"a": 1})
    assert m.load("fine") == {"a": 1}
    assert not (tmp_path / "escape.yaml").exists()


def test_cors_allows_only_the_renderer_origins(client):
    """§19: a page on the open internet must not get a usable response, even
    from the one unauthenticated route."""
    allow = "access-control-allow-origin"
    for origin in ("null", "http://localhost:5173", "http://127.0.0.1:5173"):
        r = client.get("/health", headers={"Origin": origin})
        assert r.headers.get(allow) == origin, origin
    for origin in ("https://evil.example", "http://localhost.evil.example"):
        r = client.get("/health", headers={"Origin": origin})
        assert allow not in r.headers, origin


def test_interactive_docs_are_not_served(client):
    """§19: /health is the only unauthenticated route — no schema publishing."""
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, path


def test_ollama_pull_rejects_option_shaped_model(client):
    assert client.post("/ollama/pull", json={"model": "--rm"}).status_code == 422
    assert client.post("/ollama/pull", json={"model": "a b"}).status_code == 422


def test_app_started_is_idempotent_per_launch(client, monkeypatch):
    """§19: the Electron caller retries until it gets a response — a reply lost
    after the server already fired must not execute everything twice."""
    from autowright import api
    from autowright.storage import store as live_store

    r = client.post("/automations", json={"draft": make_version(), "name": "On launch",
                                          "agentId": "mock"})
    a = live_store.autos[r.json()["id"]]
    a["triggers"] = [{"id": "t1", "kind": "app_start", "off": False}]

    # Count firings without starting real executions: a live engine thread would
    # outlive this test and publish into the next one's event recorder.
    fired = []
    monkeypatch.setattr(api, "fire_trigger",
                        lambda store, engine, auto, t: fired.append(auto["id"]) or True)

    first = client.post("/app-started", json={"launchId": "launch-1"})
    assert first.status_code == 200
    assert first.json()["fired"] == 1
    # the same launch retrying fires nothing more
    again = client.post("/app-started", json={"launchId": "launch-1"})
    assert again.json()["fired"] == 0
    assert fired == [a["id"]]
