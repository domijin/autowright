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

    from autowright import triggers

    with _pytest.raises(triggers.CronError):
        triggers.parse_cron("5/ * * * *")
    triggers.parse_cron("*/5 * * * *")  # real steps still parse


def test_settings_days_validation(client):
    assert client.patch("/settings", json={"days": "ninety"}).status_code == 422
    assert client.patch("/settings", json={"notifications": "sometimes"}).status_code == 422
    assert client.patch("/settings", json={"days": "14"}).status_code == 422  # strict int
    r = client.patch("/settings", json={"days": 14})
    assert r.status_code == 200
    from autowright.storage import store as live_store
    assert live_store.settings["days"] == 14


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
    automation_id = r.json()["id"]
    a = live_store.autos[automation_id]
    live_store.save_draft(a, make_version())
    h = live_store.create_execution(a, "draft", None, "manual",
                                    [{"name": "s", "file": "01-say.py", "agent": False,
                                      "status": "executing", "duration_ms": None, "attempts": []}])
    a["_live"] = {h["id"]}
    try:
        assert client.put(f"/draft/{automation_id}",
                          json={"draft": make_version()}).status_code == 409
        assert client.delete(f"/draft/{automation_id}").status_code == 409
    finally:
        a["_live"] = set()
    assert client.put(f"/draft/{automation_id}",
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
    a["triggers"] = [{"id": "t1", "kind": "app_start", "enabled": True}]

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


# ---------- 2026-08 release proofread ----------

def test_validate_steps_rejects_non_dict_entries():
    """§8: a manifest whose steps are bare strings (a plausible agent
    shorthand) must fail validation — it used to slip through every per-step
    filter and settle a stepless 'done' draft."""
    from autowright.drafting import validate_steps

    manifest = (
        "name: Hello\n"
        "description: Says hello\n"
        "note: Created\n"
        "steps:\n"
        "  - 01-fetch.py\n"
    )
    _, errors = validate_steps({"manifest.yaml": manifest})
    assert any("must be a mapping" in e for e in errors)


def test_reconcile_skips_unparsable_started_at(store, home):
    """§5: a hand-damaged started_at must stay out of the index — it used to
    be restored by the reconcile and 500 the whole executions list (and, via
    _latest_exec, the automations list) on every request."""
    from autowright.storage import Store
    from autowright.yamlio import load_yaml, save_yaml

    a = store.create_automation(make_version(), "Recon", None)
    h = store.create_execution(a, "version", 1, "manual", steps=[])
    h["status"] = "succeeded"
    store.update_execution(h)
    y = store.exec_dir(h["id"]) / "execution.yaml"
    data = load_yaml(y)
    data["started_at"] = "banana"
    save_yaml(y, data)
    store.close_exec_db()
    for suffix in ("", "-wal", "-shm"):
        (store.executions_dir() / ("executions.db" + suffix)).unlink(missing_ok=True)

    s2 = Store()
    s2.load_all()
    assert h["id"] not in s2.execs  # left out of the index, not restored broken
    # the serializers that used to 500 still work for the rest of the store
    assert isinstance(s2.auto_json(s2.autos[a["id"]]), dict)


def test_retention_never_deletes_queued(store, monkeypatch):
    """§5/§6: queued records ARE the firing queue — retention used to delete
    one older than the cutoff, silently dropping a waiting firing."""
    from datetime import datetime, timedelta, timezone

    a = store.create_automation(make_version(), "Queuey", None)
    old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    q = store.create_execution(a, "version", 1, "discord", steps=[], status="queued")
    q["queued_at"] = q["started_at"] = old
    store.update_execution(q)
    done = store.create_execution(a, "version", 1, "manual", steps=[])
    done["status"] = "succeeded"
    done["started_at"] = old
    store.update_execution(done)
    store.settings["days"] = 7

    deleted = store.retention_cleanup()
    assert deleted == 1
    assert q["id"] in store.execs          # the queued firing survives
    assert done["id"] not in store.execs   # ordinary old records still go


def test_damaged_snapshot_yaml_never_500s_detail(store):
    """§5: a hand-damaged snapshot.yaml is skipped, never fatal to the
    automation detail that serializes it."""
    a = store.create_automation(make_version(), "Snappy", None)
    d = store.auto_dir(a) / "memory"
    d.mkdir(parents=True, exist_ok=True)
    (d / "seen.yaml").write_text("x: 1\n")
    good = store.snapshot_memory(a, "manual")
    bad = store.snapshot_memory(a, "manual")
    (store.snapshots_dir(a) / bad["id"] / "snapshot.yaml").write_text("just a string\n")

    metas = store.list_snapshots(a)
    assert [m["id"] for m in metas] == [good["id"]]
    assert store.get_snapshot(a, bad["id"]) is None
    assert isinstance(store.auto_json(a), dict)  # used to AttributeError/KeyError


def test_load_yaml_survives_permission_error(home, monkeypatch):
    """§5: an unreadable top-level yaml (permissions) must fall back to the
    default, not crash startup into a launchd crash loop."""
    import builtins

    from autowright.yamlio import load_yaml

    real_open = builtins.open

    def deny(path, *a, **kw):
        if str(path).endswith("settings.yaml"):
            raise PermissionError(13, "Permission denied", str(path))
        return real_open(path, *a, **kw)

    monkeypatch.setattr(builtins, "open", deny)
    assert load_yaml(home / "settings.yaml", {"d": 1}) == {"d": 1}


def test_import_rejects_unordered_step_filenames(store):
    """§5.1: step filenames obey the NN-name.py rule in listed order — a
    looser archive used to import fine and then 422 on every later save."""
    import yaml as pyyaml

    from autowright import transfer

    a = store.create_automation(make_version(), "Archivey", None)
    data = transfer.export_automation(store, a)
    zin = zipfile.ZipFile(io.BytesIO(data))
    meta = pyyaml.safe_load(zin.read("automation/automation.yaml"))
    meta["steps"][0]["file"] = "say.py"  # no NN- prefix
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for n in zin.namelist():
            if n == "automation/automation.yaml":
                zout.writestr(n, pyyaml.safe_dump(meta))
            elif n == "automation/01-say.py":
                zout.writestr("automation/say.py", zin.read(n))
            else:
                zout.writestr(n, zin.read(n))
    with pytest.raises(transfer.TransferError, match="NN-name.py"):
        transfer.import_automation(store, buf.getvalue())


def test_retry_create_mode_test_answers_409(client):
    """§19: retrying a create-mode test record (automationId null) answers the
    test rule's 409 — it used to 404 on the null automation lookup."""
    from autowright.storage import store as live_store

    h = live_store.create_execution({"id": None, "name": "Draft"}, "test", None,
                                    "test", steps=[])
    r = client.post(f"/executions/{h['id']}/retry")
    assert r.status_code == 409


def test_fabricated_trigger_id_cannot_store_past_time(client):
    """§19: a past `time` answers 422 — a client-made id used to bypass the
    check via the stored-entry leniency."""
    r = client.post("/automations", json={"draft": make_version(), "name": "Timey",
                                          "agentId": "mock"})
    aid = r.json()["id"]
    r2 = client.patch(f"/automations/{aid}", json={
        "triggers": [{"kind": "time", "at": "2020-01-01T10:00", "id": "fake-id"}]})
    assert r2.status_code == 422
    # the real leniency still holds: an id the automation actually stores
    r3 = client.patch(f"/automations/{aid}", json={
        "triggers": [{"kind": "time", "at": "2030-01-01T10:00"}]})
    assert r3.status_code == 200
    stored = r3.json()["triggers"][0]
    r4 = client.patch(f"/automations/{aid}", json={
        "triggers": [{"kind": "time", "at": "2020-01-01T10:00", "id": stored["id"]}]})
    assert r4.status_code == 200


def test_draft_out_of_sync_roundtrips(client):
    """§4.4/§11: the dirty-gate state rides the draft container — a kept
    out-of-sync draft must resume with saving still locked."""
    d = {**make_version(), "outOfSync": True}
    assert client.put("/draft/pending", json={"draft": d}).status_code == 200
    got = client.get("/draft/pending").json()["draft"]
    assert got["outOfSync"] is True
    # and absent when the editor is in sync
    assert client.put("/draft/pending", json={"draft": make_version()}).status_code == 200
    assert "outOfSync" not in client.get("/draft/pending").json()["draft"]
