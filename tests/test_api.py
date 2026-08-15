import time

import pytest

from conftest import make_version


def test_auth_required(client):
    r = client.get("/state", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert client.get("/health").status_code == 200  # health is open


def test_state_shape(client):
    r = client.get("/state").json()
    assert set(r) >= {"automations", "executions", "agents", "secrets", "settings", "version"}


def test_instructions_endpoint(client):
    from autowright.drafting import CONTRACT_PREAMBLE, DEFAULT_INSTRUCTIONS

    # §11/§19: both instruction files travel to the page verbatim
    r = client.get("/instructions").json()
    assert r["framework"] == CONTRACT_PREAMBLE
    assert r["defaultBuild"] == DEFAULT_INSTRUCTIONS


def test_secret_crud_and_usedby(client):
    from autowright.storage import store

    assert client.put("/secrets/bad-name", json={"value": "x"}).status_code == 422
    assert client.put("/secrets/MY_TOKEN", json={"value": "abc"}).status_code == 200
    assert client.put("/secrets/UNUSED_KEY", json={"value": "z"}).status_code == 200
    names = [s["name"] for s in client.get("/secrets").json()]
    assert "MY_TOKEN" in names
    # §4.8 usedBy: automation names whose current version references the secret —
    # via a step's secrets list or a `secrets.NAME` reference in step code.
    store.create_automation(make_version(steps=[
        {"file": "01-use.py", "name": "Use", "description": "",
         "code": "from autowright import log, secrets\nlog(secrets.MY_TOKEN)\n"}]),
        "Token user", "mock")
    by_name = {s["name"]: s["usedBy"] for s in client.get("/secrets").json()}
    assert by_name["MY_TOKEN"] == ["Token user"]
    assert by_name["UNUSED_KEY"] == []
    assert client.delete("/secrets/MY_TOKEN").status_code == 200


def test_secret_placeholder_lifecycle(client):
    # §4.8: blank value on a new name → placeholder (set: false)
    assert client.put("/secrets/LATER", json={"value": "", "description": "fill me"}).status_code == 200
    s = next(x for x in client.get("/secrets").json() if x["name"] == "LATER")
    assert s["set"] is False and s["description"] == "fill me"
    # blank on the existing placeholder edits only the desc — still unset
    client.put("/secrets/LATER", json={"value": "", "description": "still later"})
    s = next(x for x in client.get("/secrets").json() if x["name"] == "LATER")
    assert s["set"] is False and s["description"] == "still later"
    # a real value flips it
    client.put("/secrets/LATER", json={"value": "v1"})
    s = next(x for x in client.get("/secrets").json() if x["name"] == "LATER")
    assert s["set"] is True


def test_export_import_endpoints(client):
    from autowright.storage import new_id, store

    ver = {"description": "", "params": [], "steps": [{"name": "Go", "description": "", "code": "print(1)\n"}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": None}
    a = store.create_automation(ver, name="Port me", agent_id="mock",
                                triggers=[{"id": new_id(), "kind": "cron", "enabled": True,
                                           "expression": "0 9 * * *"}])
    r = client.get(f"/automations/{a['id']}/export")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert 'filename="Port me.autowright"' in r.headers["content-disposition"]
    r2 = client.post("/automations/import", content=r.content,
                     headers={"Content-Type": "application/octet-stream"})
    assert r2.status_code == 200
    body = r2.json()
    assert body["automation"]["name"] == "Port me"
    assert body["automation"]["id"] != a["id"]
    assert body["automation"]["triggersOff"] is True
    assert set(body["summary"]) == {"secretsCreated", "secretsExisting",
                                    "agentsCreated", "agentsReused", "packages"}
    assert client.post("/automations/import", content=b"junk",
                       headers={"Content-Type": "application/octet-stream"}).status_code == 422
    assert client.get("/automations/nope/export").status_code == 404



def test_import_preview_confirm_flow(client):
    from autowright.storage import new_id, store

    ver = {"description": "Web thing", "params": [],
           "steps": [{"name": "Go", "description": "", "code": "print(1)\n"}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": None}
    a = store.create_automation(ver, name="Previewed", agent_id="mock",
                                triggers=[{"id": new_id(), "kind": "cron", "enabled": True,
                                           "expression": "0 9 * * *"}])
    data = client.get(f"/automations/{a['id']}/export").content
    n_before = len(store.autos)

    r = client.post("/automations/import/preview", content=data,
                    headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 200
    body = r.json()
    # §5.2: preview writes nothing — the automation lands only on confirm
    assert len(store.autos) == n_before
    assert body["preview"]["name"] == "Previewed"
    assert [s["name"] for s in body["preview"]["steps"]] == ["Go"]
    assert body["preview"]["triggers"] == [{"kind": "cron", "expression": "0 9 * * *"}]

    r2 = client.post("/automations/import/confirm", json={"token": body["token"]})
    assert r2.status_code == 200
    assert r2.json()["automation"]["name"] == "Previewed"
    assert r2.json()["automation"]["triggersOff"] is True
    assert len(store.autos) == n_before + 1

    # the token is one-time; unknown tokens 404 too
    assert client.post("/automations/import/confirm", json={"token": body["token"]}).status_code == 404
    assert client.post("/automations/import/confirm", json={"token": "nope"}).status_code == 404
    # an invalid archive previews as the same §5.1 422
    assert client.post("/automations/import/preview", content=b"junk",
                       headers={"Content-Type": "application/octet-stream"}).status_code == 422


def test_import_url_endpoint(client, monkeypatch):
    from autowright import transfer
    from autowright.storage import new_id, store

    ver = {"description": "", "params": [],
           "steps": [{"name": "Go", "description": "", "code": "print(1)\n"}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": None}
    a = store.create_automation(ver, name="From web", agent_id="mock", triggers=[])
    data = client.get(f"/automations/{a['id']}/export").content

    monkeypatch.setattr(transfer, "fetch_archive",
                        lambda url: (data, "https://gh/dl/from-web.autowright"))
    r = client.post("/automations/import/url", json={"url": "https://github.com/alice/from-web"})
    assert r.status_code == 200
    p = r.json()["preview"]
    assert p["sourceUrl"] == "https://github.com/alice/from-web"
    assert p["resolvedUrl"] == "https://gh/dl/from-web.autowright"
    assert client.post("/automations/import/confirm",
                       json={"token": r.json()["token"]}).status_code == 200

    # §5.2 URL-rule failures surface as 422 with the reason
    def boom(url):
        raise transfer.TransferError("only https:// URLs can be imported")
    monkeypatch.setattr(transfer, "fetch_archive", boom)
    r = client.post("/automations/import/url", json={"url": "http://x/a.autowright"})
    assert r.status_code == 422 and "https" in r.json()["detail"]
    assert client.post("/automations/import/url", json={}).status_code == 422

def test_draft_job_and_create_flow(client):
    r = client.post("/drafts", json={"mode": "create", "text": "Watch a product price", "agentId": "mock"})
    job_id = r.json()["jobId"]
    for _ in range(100):
        j = client.get(f"/drafts/{job_id}").json()
        if j["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert j["status"] == "done", j
    draft = j["draft"]
    assert draft["steps"] and draft["spec"]
    # §8: create drafts carry the seeded default build instructions back to Review
    from autowright.drafting import DEFAULT_INSTRUCTIONS
    assert draft["instructions"] == DEFAULT_INSTRUCTIONS
    r = client.post("/automations", json={"draft": draft, "agentId": "mock"})
    assert r.status_code == 200
    auto = r.json()
    assert auto["version"] == 1 and auto["lastStatus"] == "none"
    # §11 create toast state: nothing has executed yet
    assert auto["lastExecutionLabel"] == ""


def _wait_job(client, job_id):
    for _ in range(100):
        j = client.get(f"/drafts/{job_id}").json()
        if j["status"] in ("done", "failed", "blocked"):
            return j
        time.sleep(0.1)
    return j


def test_create_draft_grants_all_agents_by_default(client, monkeypatch):
    # §19: no enabledAgents + no stored automation → every configured agent is granted
    from autowright import api
    from autowright.storage import store

    store.agents.append({"id": "second", "harness": "Claude Code", "mode": "default",
                         "model": None})
    captured = {}

    def fake_start(mode, agent, user_text, current, grants, chat_history=None, **kw):
        captured["grants"] = grants
        return "job-x"

    monkeypatch.setattr(api.draft_jobs, "start", fake_start)
    r = client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock"})
    assert r.status_code == 200
    assert len(captured["grants"]["agents"]) == 2


def test_draft_job_blocked_at_steps_carries_spec(client):
    # §8: a valid blocker envelope ends the job `blocked` (not failed), with the
    # blocker list; in create mode call 1's spec rides along so the §11 Blocker
    # panel can amend it and rebuild.
    r = client.post("/drafts", json={"mode": "create", "text": "blocked-steps mail watcher",
                                     "agentId": "mock"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "steps"
    assert j["error"] is None
    assert j["blockers"] and j["blockers"][0]["reason"] and j["blockers"][0]["fix"]
    assert j["draft"]["spec"]


def test_draft_job_blocked_at_spec(client):
    r = client.post("/drafts", json={"mode": "create", "text": "blocked-spec mail watcher",
                                     "agentId": "mock"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "spec"
    assert j["draft"] is None  # no spec exists yet to amend


def test_sync_blocked_has_no_draft(client):
    from autowright.storage import store

    # sync: the caller already holds the spec — the blocked payload carries none
    a = store.create_automation(make_version(), "Sync blocked", "mock")
    r = client.post("/drafts", json={"mode": "sync", "automationId": a["id"], "agentId": "mock",
                                     "spec": "# blocked-steps title\n\nBody."})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "blocked", j
    assert j["blockedAt"] == "steps"
    assert j["draft"] is None


def test_sync_uses_provided_spec(client):
    from autowright import paths
    from autowright.storage import store

    a = store.create_automation(make_version(), "Sync target", "mock")
    marker = "The provided spec wins over the stored one."
    r = client.post("/drafts", json={"mode": "sync", "automationId": a["id"], "agentId": "mock",
                                     "spec": f"# Synced title\n\n{marker}"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    assert j["draft"]["spec"] is None  # sync returns no spec.md
    logged = paths.app_log().read_text(encoding="utf-8")
    assert marker in logged            # the prompt embedded the PROVIDED spec…
    assert "It tests." not in logged   # …not the stored version's spec


def test_sync_current_still_supported(client):
    from autowright import paths
    from autowright.storage import store

    a = store.create_automation(make_version(), "Sync current", "mock")
    cur = make_version(spec=[{"kind": "h1", "text": "Edited"},
                             {"kind": "h2", "text": "Change (draft)"},
                             {"kind": "p", "text": "In-editor draft spec text."}])
    r = client.post("/drafts", json={"mode": "sync", "automationId": a["id"], "agentId": "mock",
                                     "current": cur})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "In-editor draft spec text." in logged


def test_draft_chat_honors_in_editor_grants(client):
    from autowright import paths
    from autowright.storage import store

    # saved grants: no agents enabled, no secrets allowed
    a = store.create_automation(make_version(), "Ask target", "mock", enabled_agents=[])
    r = client.post("/drafts", json={
        "mode": "chat", "automationId": a["id"], "agentId": "mock",
        "text": "Also check on weekends",
        "enabledAgents": ["mock"], "allowedSecrets": ["MY_SECRET"],  # in-editor grants win
    })
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    # §8: a chat rewrite returns just {spec} — the steps stay untouched
    assert j["draft"]["spec"] is not None
    assert "steps" not in j["draft"]
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "allowed only if nonempty):\n- name: Claude Code" in logged
    assert "reference by secrets.NAME):\n- name: MY_SECRET" in logged
    assert "Also check on weekends" in logged      # the USER REQUEST reached the prompt
    assert "Build the automation that implements" not in logged  # no steps call on chat


def test_draft_chat_question_returns_answer(client):
    # §8 chat call, answer path: a question-shaped request gets prose — the
    # payload is { answer }, nothing rewritten.
    from autowright.storage import store

    a = store.create_automation(make_version(), "Q target", "mock")
    r = client.post("/drafts", json={
        "mode": "chat", "automationId": a["id"], "agentId": "mock",
        "text": "What does this workflow do?",
        "chat": [{"kind": "user", "text": "earlier message"}],
    })
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    assert "answer" in j["draft"] and "Check for changes" in j["draft"]["answer"]


def test_draft_chat_attaches_stored_name_and_desc(client):
    # §8/§19 AUTOMATION section: a chat body without `current` still carries
    # the stored automation's name/desc — identity is top-level (§4.1), never
    # part of the version dict the fallback loads.
    from autowright import paths
    from autowright.storage import store

    a = store.create_automation(make_version(description="Watches the things."), "Ident target", "mock")
    r = client.post("/drafts", json={
        "mode": "chat", "automationId": a["id"], "agentId": "mock", "text": "Rename this better",
    })
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "=== AUTOMATION" in logged
    assert "name: Ident target" in logged and "description: Watches the things." in logged


def test_draft_chat_requires_text(client):
    r = client.post("/drafts", json={"mode": "chat", "agentId": "mock"})
    assert r.status_code == 422
    r2 = client.post("/drafts", json={"mode": "question", "agentId": "mock", "text": "x"})
    assert r2.status_code == 422  # the old modes are gone


def test_execution_and_execution_pages(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "API Exec", "mock")
    r = client.post(f"/automations/{a['id']}/execute", json={})
    assert r.status_code == 200
    execution_id = r.json()["executionId"]
    # §7: starting while live → 409
    r2 = client.post(f"/automations/{a['id']}/execute", json={})
    assert r2.status_code == 409
    for _ in range(100):
        e = client.get(f"/executions/{execution_id}").json()
        if e["status"] != "executing":
            break
        time.sleep(0.1)
    assert e["status"] == "succeeded"
    assert e["result"]["chip"] == "All good"
    assert e["result"]["chipStatus"] == "ok"  # served from the execution header
    assert "logs" not in e  # §19: logs are lazy, never inline
    assert [s["status"] for s in e["steps"]] == ["succeeded", "succeeded"]
    assert all(len(s["attempts"]) == 1 for s in e["steps"])
    # §19 lazy log endpoint: per step attempt, and the execution log
    step_log = client.get(f"/executions/{execution_id}/logs", params={"step": 0, "attempt": 1}).json()
    assert any(l["kind"] == "sys" for l in step_log["lines"])
    assert all({"time", "kind", "sequence", "text"} == set(l) for l in step_log["lines"])
    assert client.get(f"/executions/{execution_id}/logs").json()["lines"] == []
    assert client.get(f"/executions/{execution_id}/logs", params={"step": 9, "attempt": 1}).json()["lines"] == []
    autos = client.get("/automations").json()
    me = next(x for x in autos if x["id"] == a["id"])
    assert me["lastStatus"] == "succeeded"
    assert me["resultChip"] == "All good"
    assert me["resultStatus"] == "ok"  # §4: tints the list-row chip like the detail page


# ---------- §11 Test — §19 POST /tests ----------

def _echo_draft(**over):
    d = {
        "name": "Param echo",
        "spec": [{"kind": "h1", "text": "Param echo"}],
        "params": [
            {"name": "greeting", "kind": "text", "label": "Greeting", "help": "", "default": "hello"},
        ],
        "steps": [{"file": "01-echo.py", "name": "Echo", "description": "",
                   "code": "from autowright import log, params, result\nlog(f\"greeting={params['greeting']}\")\n"
                           "result.status('ok')\nresult.chip(params['greeting'])\n"}],
        "triggers": [],
    }
    d.update(over)
    return d


def _capture_events(monkeypatch):
    from autowright import api

    events: list[dict] = []
    monkeypatch.setattr(api.hub, "publish", lambda ev, **kw: events.append({"event": ev, **kw}))
    return events


def _until(events, ev, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if any(e["event"] == ev for e in events):
            return next(e for e in events if e["event"] == ev)
        time.sleep(0.05)
    raise AssertionError(f"{ev} never arrived (got {[e['event'] for e in events]})")


def _until_finished(events, execution_id, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        e = next((e for e in events if e["event"] == "execution.finished" and e["executionId"] == execution_id), None)
        if e:
            return e
        time.sleep(0.05)
    raise AssertionError(f"exec.finished never arrived (got {[e['event'] for e in events]})")


def test_test_param_values_override(client, monkeypatch):
    # §19: paramValues override the defaults for this test only; the result is
    # an ordinary execution record's.
    events = _capture_events(monkeypatch)
    r = client.post("/tests", json={"draft": _echo_draft(), "paramValues": {"greeting": "bonjour"}})
    assert r.status_code == 200
    eid = r.json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "succeeded"
    full = client.get(f"/executions/{eid}").json()
    assert full["test"] is True and full["ver"] == "Test" and full["trigger"] == "Test"
    assert full["result"]["chip"] == "bonjour"
    logs = [e["line"]["text"] for e in events if e["event"] == "execution.log"]
    assert any("greeting=bonjour" in t for t in logs)


def test_test_trigger_mock_imessage_payload(client, monkeypatch):
    # §19 triggerMock: the mocked payload rides the record like a real firing's
    # (unsuppliable fields null), reaches the step via execution.trigger_payload,
    # and the trigger label still says "Test".
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-see.py", "name": "See", "description": "",
                            "code": "from autowright import execution, log, result\n"
                                    "p = execution.trigger_payload\n"
                                    "log(f\"mock={p['kind']}:{p['sender']}:{p['text']}\")\n"
                                    "result.status('ok')\n"}])
    r = client.post("/tests", json={
        "draft": d,
        "triggerMock": {"kind": "imessage", "text": "new chapter?", "sender": "+15551234567"},
    })
    assert r.status_code == 200
    eid = r.json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "succeeded"
    logs = [e["line"]["text"] for e in events if e["event"] == "execution.log"]
    assert any("mock=imessage:+15551234567:new chapter?" in t for t in logs)
    full = client.get(f"/executions/{eid}").json()
    assert full["test"] is True and full["trigger"] == "Test"
    assert full["triggerPayload"]["chat"] is None
    assert full["triggerPayload"]["messageId"] is None
    assert full["triggerSender"] == "+15551234567"


def test_test_trigger_mock_discord_shape_and_validation(client, monkeypatch):
    # §19 triggerMock validation: 422 on a bad kind, empty text/sender, a
    # non-digit discord channel, or an invalid secret name — and the discord
    # payload carries the trigger's channel/secret with the rest null.
    ok = {"kind": "discord", "text": "go", "sender": "Dave",
          "channel": "123456", "secret": "BOT_TOKEN"}
    for bad in [{**ok, "kind": "cron"}, {**ok, "text": ""}, {**ok, "sender": ""},
                {**ok, "channel": "12a"}, {**ok, "channel": "12٣4"},
                {**ok, "secret": "lower"}, {k: v for k, v in ok.items() if k != "channel"}]:
        r = client.post("/tests", json={"draft": _echo_draft(), "triggerMock": bad})
        assert r.status_code == 422, bad
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    eid = client.post("/tests", json={"draft": _echo_draft(), "triggerMock": ok}).json()["executionId"]
    p = store.execs[eid]["trigger_payload"]
    assert p["channel"] == "123456" and p["secret"] == "BOT_TOKEN"
    assert p["channelName"] is None and p["guildId"] is None and p["messageId"] is None
    _until_finished(events, eid)


def test_test_stored_values_and_flagged_record(client, monkeypatch):
    # §19: with automationId (edit mode) the stored values are the base; the record is
    # flagged test and never touches the automation's derived display state.
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    client.patch(f"/automations/{auto['id']}", json={"paramValues": {"greeting": "stored-hi"}})
    events.clear()
    r = client.post("/tests", json={"draft": _echo_draft(), "automationId": auto["id"]})
    assert r.status_code == 200
    eid = r.json()["executionId"]
    _until_finished(events, eid)
    logs = [e["line"]["text"] for e in events if e["event"] == "execution.log"]
    assert any("greeting=stored-hi" in t for t in logs)
    assert store.execs[eid]["kind"] == "test"
    aj = client.get(f"/automations/{auto['id']}").json()
    assert aj["lastStatus"] == "none" and aj["latest"] is None


def test_test_resolves_default_after_editor_roundtrip(client, monkeypatch):
    # §4.2 regression: the automation JSON's params keep `default` — edit mode
    # seeds the draft's defs from that shape, so a test with no stored value and
    # no paramValues must still resolve the definition's default.
    events = _capture_events(monkeypatch)
    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    aj = client.get(f"/automations/{auto['id']}").json()
    assert aj["params"][0]["default"] == "hello"
    events.clear()
    r = client.post("/tests", json={"draft": _echo_draft(params=aj["params"]),
                                    "automationId": auto["id"]})
    assert r.status_code == 200
    eid = r.json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "succeeded"
    logs = [e["line"]["text"] for e in events if e["event"] == "execution.log"]
    assert any("greeting=hello" in t for t in logs)


def test_test_failure_never_analyzes_by_itself(client, monkeypatch):
    # §11/§8: there is no analysis call at all — a failed test just settles;
    # failure analysis is a user-sent chat job reading the RECENT RUNS context.
    # Seam, not a sleep: every agent call reaches harness.invoke, so zero
    # recorded calls at finish proves nothing analyzed by itself.
    from autowright import harness

    events = _capture_events(monkeypatch)
    calls = []
    real_invoke = harness.invoke

    def recording_invoke(*a, **kw):
        calls.append(a)
        return real_invoke(*a, **kw)

    monkeypatch.setattr(harness, "invoke", recording_invoke)
    d = _echo_draft(steps=[{"file": "01-boom.py", "name": "Boom", "description": "",
                            "code": "raise KeyError('missing')\n"}])
    r = client.post("/tests", json={"draft": d})
    assert r.status_code == 200
    eid = r.json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "failed"
    assert calls == []  # nothing analyzed by itself


def test_failed_run_rides_chat_runs_context(client, monkeypatch):
    # §8/§19: a chat job's RECENT RUNS context (assembled by the backend)
    # carries the failed test's status and error, marked against the sent steps.
    from autowright import testexec

    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-boom.py", "name": "Boom", "description": "",
                            "code": "raise KeyError('missing')\n"}])
    eid = client.post("/tests", json={"draft": d}).json()["executionId"]
    _until_finished(events, eid)
    runs = testexec.runs_context(None, d["steps"], None)
    assert runs is not None
    assert "Test run · failed" in runs
    assert "KeyError" in runs
    assert "steps match the current draft" in runs
    # different in-editor code → the run is flagged as historical
    stale = testexec.runs_context(None, [{**d["steps"][0], "code": "pass\n"}], None)
    assert "ran older steps" in stale


def test_test_cancel(client, monkeypatch):
    # §19: cancel goes through the ordinary execution cancel.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-slow.py", "name": "Slow", "description": "",
                            "code": "from autowright import log\nimport time\nlog('sleeping')\ntime.sleep(60)\n"}])
    eid = client.post("/tests", json={"draft": d}).json()["executionId"]
    t0 = time.time()
    while time.time() - t0 < 10:  # wait until the step subprocess is live
        if any(e["event"] == "execution.log" and e["line"]["text"] == "sleeping" for e in events):
            break
        time.sleep(0.05)
    assert client.post(f"/executions/{eid}/cancel").json()["ok"]
    assert _until_finished(events, eid)["execution"]["status"] == "cancelled"


def test_test_409_while_live(client, monkeypatch):
    # §19: one live test per draft container.
    events = _capture_events(monkeypatch)
    d = _echo_draft(steps=[{"file": "01-slow.py", "name": "Slow", "description": "",
                            "code": "from autowright import log\nimport time\nlog('sleeping')\ntime.sleep(60)\n"}])
    eid = client.post("/tests", json={"draft": d}).json()["executionId"]
    assert client.post("/tests", json={"draft": d}).status_code == 409
    # cancel only once the step subprocess is provably live — a cancel landing
    # during pre-flight can miss the not-yet-spawned sleeper, which then runs
    # its full 60 s and outlives the event wait below
    _until(events, "execution.log")
    client.post(f"/executions/{eid}/cancel")
    _until_finished(events, eid)


def test_patch_automation_triggers_and_grants(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Patchable", "mock")
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{"kind": "cron", "expression": "15 6 * * 3", "enabled": False}],
        "allowedSecrets": ["X_TOKEN"], "paramValues": {"greeting": "yo"},
    })
    j = r.json()
    assert [t["label"] for t in j["triggers"]] == ["Wednesdays at 6:15"]
    assert j["triggers"][0]["id"]  # backend assigned an id
    assert j["triggerChip"] == "Wed 6:15"
    assert j["triggersOff"] is True
    assert j["allowedSecrets"] == ["X_TOKEN"]
    assert next(p for p in j["params"] if p["name"] == "greeting")["value"] == "yo"

    # whole-list replace: ids survive, additions get fresh ids
    tid = j["triggers"][0]["id"]
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{**j["triggers"][0], "enabled": True}, {"kind": "cron", "expression": "0 2 * * *", "enabled": True}],
    })
    j = r.json()
    assert j["triggers"][0]["id"] == tid
    assert j["triggerChip"] == "2 triggers"
    assert j["triggersOff"] is False


def test_app_started_fires_enabled_app_start_triggers(client, monkeypatch):
    # §6 app-start firing: POST /app-started executes every automation with an
    # enabled app_start trigger; off ones stay quiet.
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    a = store.create_automation(make_version(), "On start", "mock")
    b = store.create_automation(make_version(), "On start (off)", "mock")
    assert client.patch(f"/automations/{a['id']}",
                        json={"triggers": [{"kind": "app_start", "enabled": True}]}).status_code == 200
    assert client.patch(f"/automations/{b['id']}",
                        json={"triggers": [{"kind": "app_start", "enabled": False}]}).status_code == 200
    # a second app_start in one list → 422 (§4.3)
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{"kind": "app_start", "enabled": True}, {"kind": "app_start", "enabled": True}]})
    assert r.status_code == 422

    # §19: launchId is required — missing/empty bodies are 422s, never a fire
    assert client.post("/app-started").status_code == 422
    assert client.post("/app-started", json={}).status_code == 422
    assert client.post("/app-started", json={"launchId": ""}).status_code == 422
    assert client.post("/app-started", json={"launchId": "launch-A"}).json() == {"fired": 1}
    _until(events, "execution.finished")
    execs = client.get("/executions").json()
    assert [e["trigger"] for e in execs if e["automationId"] == a["id"]] == ["App start"]
    assert [e for e in execs if e["automationId"] == b["id"]] == []
    # §4.3 derived display: app_start contributes no nextAt
    j = client.get(f"/automations/{a['id']}").json()
    assert j["nextAt"] is None
    assert j["triggers"][0]["label"] == "On app start"
    assert j["triggerChip"] == "App start"


def test_patch_automation_discord_trigger(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Discordant", "mock")
    r = client.patch(f"/automations/{a['id']}", json={"triggers": [
        {"kind": "discord", "channel": "123", "secret": "BOT_TOKEN",
         "pattern": "go", "enabled": True}]})
    assert r.status_code == 200
    j = r.json()
    t = j["triggers"][0]
    assert (t["label"], t["short"]) == ("Discord · 123 · “go”", "Discord")
    assert t["connection"] == {"state": "connecting"}  # §4.3: derived, no listener state yet
    assert j["nextAt"] is None  # no computable next occurrence
    assert j["triggerChip"] == "Discord"


def test_patch_automation_imessage_trigger(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Texter", "mock")
    r = client.patch(f"/automations/{a['id']}", json={"triggers": [
        {"kind": "imessage", "from": "+15551234567", "pattern": "go", "enabled": True}]})
    assert r.status_code == 200
    j = r.json()
    t = j["triggers"][0]
    assert (t["label"], t["short"]) == ("iMessage · +15551234567 · “go”", "iMessage")
    assert t["connection"] == {"state": "connecting"}  # §4.3: shared watcher state, derived
    assert j["nextAt"] is None  # no computable next occurrence
    assert j["triggerChip"] == "iMessage"
    # §4.3: `from` must be nonempty without whitespace
    r = client.patch(f"/automations/{a['id']}", json={"triggers": [
        {"kind": "imessage", "from": "has spaces"}]})
    assert r.status_code == 422


def test_imessage_permissions_endpoint(client, tmp_path, monkeypatch):
    from autowright import imessage

    # point the probe at an empty dir — never at this machine's real chat.db
    monkeypatch.setattr(imessage, "CHAT_DB", str(tmp_path / "chat.db"))
    r = client.get("/imessage/permissions")
    assert r.status_code == 200
    assert r.json() == {"fullDisk": False, "automation": "unknown"}


def test_patch_automation_triggers_422(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Strict", "mock")
    # reserved/incomplete message kinds (§4.3), bad cron and past one-shots are refused
    for bad in ([{"kind": "imessage"}],
                [{"kind": "discord"}],  # no channel/secret
                [{"kind": "discord", "channel": "general", "secret": "TOKEN"}],
                [{"kind": "cron", "expression": "not cron"}],
                [{"kind": "time", "at": "2020-01-01T00:00"}]):
        r = client.patch(f"/automations/{a['id']}", json={"triggers": bad})
        assert r.status_code == 422
    assert store.autos[a["id"]]["triggers"] == []  # nothing stored


def test_save_version_and_restore(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Versioner", "mock")
    r = client.post(f"/automations/{a['id']}/versions",
                    json={"draft": make_version(notes="second", note="Change")})
    assert r.json()["version"] == 2
    r = client.post(f"/automations/{a['id']}/restore", json={"version": 1})
    assert r.json()["version"] == 3
    j = client.get(f"/automations/{a['id']}").json()
    assert [v["version"] for v in j["versions"]] == [2, 1]


def test_save_version_applies_draft_triggers(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Scheduled", "mock",
                                triggers=[{"id": "t1", "kind": "cron", "expression": "0 8 * * *", "enabled": False},
                                          {"id": "t2", "kind": "time", "at": "2999-01-01T00:00", "enabled": True}])
    # §4.3 cron-subset replace: sent list (the editor's merge) replaces whole;
    # sent ids survive, new entries get one assigned
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(notes="second"),
        "triggers": [{"id": "t1", "kind": "cron", "expression": "0 8 * * *", "enabled": False},
                     {"kind": "cron", "expression": "30 9 * * 1", "enabled": True},
                     {"id": "t2", "kind": "time", "at": "2999-01-01T00:00", "enabled": True}],
    }})
    assert r.status_code == 200
    trigs = r.json()["automation"]["triggers"]
    assert [t.get("id") for t in trigs][0] == "t1" and trigs[0]["enabled"] is False
    assert trigs[1]["expression"] == "30 9 * * 1" and trigs[1]["id"]
    assert trigs[2]["id"] == "t2"

    # invalid trigger → 422 and no version minted
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(), "triggers": [{"kind": "cron", "expression": "junk"}],
    }})
    assert r.status_code == 422
    assert store.autos[a["id"]]["current_version"] == 2

    # no triggers key → the stored list is untouched
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": make_version()})
    assert r.status_code == 200
    assert [t["id"] for t in r.json()["automation"]["triggers"]] == ["t1", trigs[1]["id"], "t2"]


def test_save_version_applies_staged_param_values(client):
    # §4.2/§19: the chat-staged map lands after the version — matched by name
    # AND kind against the landing definitions, unmatched dropped silently.
    from autowright.storage import store

    a = store.create_automation(make_version(), "Valued", "mock")
    r = client.post(f"/automations/{a['id']}/versions", json={
        "draft": make_version(notes="second"),
        "paramValues": {"greeting": "hi there", "count": "not a number", "nope": "x"},
    })
    assert r.status_code == 200
    vals = store.autos[a["id"]]["param_values"]
    assert vals == {"greeting": "hi there"}  # kind-mismatched count + unknown nope dropped


def test_create_applies_staged_param_values(client):
    from autowright.storage import store

    r = client.post("/automations", json={
        "draft": make_version(), "name": "Created",
        "paramValues": {"count": 7, "nope": "x"},
    })
    assert r.status_code == 200
    assert store.autos[r.json()["id"]]["param_values"] == {"count": 7}


def test_operational_only_save_skips_version_mint(client):
    # §4.4: unchanged versioned content mints nothing — the trigger replace and
    # staged values still apply, and the response shape is unchanged.
    from autowright.storage import store

    a = store.create_automation(make_version(), "Quiet", "mock",
                                triggers=[{"id": "t1", "kind": "cron", "expression": "0 8 * * *",
                                           "enabled": True, "source": "spec"}])
    r = client.post(f"/automations/{a['id']}/versions", json={
        "draft": {**make_version(),
                  "triggers": [{"id": "t1", "kind": "cron", "expression": "0 8 * * *",
                                "enabled": True, "source": "spec"},
                               {"kind": "cron", "expression": "0 9 * * *", "enabled": True,
                                "source": "user"}]},
        "paramValues": {"greeting": "staged"},
    })
    assert r.status_code == 200
    assert r.json()["version"] == 1  # no mint
    assert store.autos[a["id"]]["current_version"] == 1
    trigs = r.json()["automation"]["triggers"]
    assert [t["expression"] for t in trigs] == ["0 8 * * *", "0 9 * * *"]
    assert trigs[1]["source"] == "user"
    assert store.autos[a["id"]]["param_values"] == {"greeting": "staged"}
    # a param-definition change is real content — it mints
    ver2 = make_version()
    ver2["params"] = ver2["params"] + [
        {"name": "extra", "kind": "text", "label": "Extra", "help": "", "default": ""}]
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": ver2})
    assert r.json()["version"] == 2
    # a value-field-only delta on an unchanged definition is operational, not content
    ver3 = {**ver2, "params": [{**p, "value": "typed"} if p["name"] == "greeting" else p
                               for p in ver2["params"]]}
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": ver3})
    assert r.json()["version"] == 2


def test_trigger_source_validates_and_round_trips(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Sourced", "mock")
    r = client.patch(f"/automations/{a['id']}", json={"triggers": [
        {"kind": "cron", "expression": "0 8 * * *", "enabled": True, "source": "user"}]})
    assert r.status_code == 200
    assert r.json()["triggers"][0]["source"] == "user"
    r = client.patch(f"/automations/{a['id']}", json={"triggers": [
        {"kind": "cron", "expression": "0 8 * * *", "enabled": True, "source": "wat"}]})
    assert r.status_code == 422


def test_edit_draft_snapshot_carries_param_values(client):
    # §4.2/§4.4: the staged map rides the snapshot as the draft-only
    # `param_values` key and echoes back camelCase.
    from autowright.storage import store

    a = store.create_automation(make_version(), "Staged", "mock")
    r = client.put(f"/draft/{a['id']}", json={"draft": {
        **make_version(), "paramValues": {"greeting": "staged"},
    }})
    assert r.status_code == 200
    d = client.get(f"/automations/{a['id']}").json()["draft"]
    assert d["paramValues"] == {"greeting": "staged"}
    # the automation's stored values stay untouched until the draft is saved
    assert store.autos[a["id"]]["param_values"] == {}


def test_edit_draft_snapshot_carries_triggers(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Drafted", "mock")
    r = client.put(f"/draft/{a['id']}", json={"draft": {
        **make_version(), "triggers": [{"kind": "cron", "expression": "15 7 * * *", "enabled": True}],
    }})
    assert r.status_code == 200
    d = client.get(f"/automations/{a['id']}").json()["draft"]
    assert d["triggers"] == [{"kind": "cron", "expression": "15 7 * * *", "enabled": True}]
    # the automation's live triggers stay untouched until the draft is saved
    assert store.autos[a["id"]]["triggers"] == []


def test_edit_draft_snapshot_carries_chat_thread(client, home):
    # §4.4/§5: the §11 thread rides the draft payload as `chat` and lands as
    # the container's chat.jsonl; transient keys are stripped, the rest echoes
    # back on the automation's draft object.
    from autowright.storage import store

    a = store.create_automation(make_version(), "Chatty", "mock")
    chat = [
        {"id": "e1", "kind": "user", "text": "add weekends", "at": "2026-08-01T00:00:00+00:00"},
        {"id": "e2", "kind": "rewrite", "text": "add weekends", "junk": "dropped"},
        {"id": "e3", "kind": "blockers", "source": "sync", "dismissed": True,
         "blockers": [{"reason": "r", "fix": "f"}], "resolved": ["r — f"]},
        {"kind": ""},  # no kind → skipped
    ]
    r = client.put(f"/draft/{a['id']}", json={"draft": {**make_version(), "chat": chat}})
    assert r.status_code == 200
    f = home / "automations" / a["id"] / "draft" / "chat.jsonl"
    assert f.exists()
    assert "junk" not in f.read_text(encoding="utf-8")
    d = client.get(f"/automations/{a['id']}").json()["draft"]
    assert [e["id"] for e in d["chat"]] == ["e1", "e2", "e3"]
    assert d["chat"][2]["dismissed"] is True
    assert d["chat"][2]["blockers"] == [{"reason": "r", "fix": "f"}]
    # the container GET echoes the same payload as the automation's draft object
    assert client.get(f"/draft/{a['id']}").json() == {"draft": d, "agentId": "mock"}
    # a re-save without the key leaves the thread untouched
    client.put(f"/draft/{a['id']}", json={"draft": make_version()})
    assert client.get(f"/automations/{a['id']}").json()["draft"]["chat"][0]["id"] == "e1"
    # an empty list clears it
    client.put(f"/draft/{a['id']}", json={"draft": {**make_version(), "chat": []}})
    assert not f.exists()
    assert "chat" not in client.get(f"/automations/{a['id']}").json()["draft"]
    # the thread dies with the draft
    client.put(f"/draft/{a['id']}", json={"draft": {**make_version(), "chat": chat[:1]}})
    client.delete(f"/draft/{a['id']}")
    assert not f.exists()


def test_pending_draft_carries_chat_thread(client):
    # §4.4: the create-mode slot persists the thread the same way.
    client.post("/draft/pending/open")
    r = client.put("/draft/pending", json={"draft": {
        **make_version(), "name": "Pending chat",
        "chat": [{"id": "c1", "kind": "user", "text": "hello"}],
    }, "agentId": "mock"})
    assert r.status_code == 200
    d = client.get("/draft/pending").json()["draft"]
    assert d["chat"] == [{"id": "c1", "kind": "user", "text": "hello"}]
    client.delete("/draft/pending")
    assert client.get("/draft/pending").json()["draft"] is None


def test_draft_container_surface_uniform_across_owners(client):
    """§19: ONE /draft/{owner} surface — owner `pending` and an automation id
    answer the same envelope and container shape; only the §4.4 identity
    extras (name/description) and the automation-only 409 guard differ."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Owned", "mock")
    body = {"draft": {**make_version(), "name": "Uniform",
                      "stepAgents": ["mock"], "allowedSecrets": [],
                      "triggers": [{"kind": "cron", "expression": "0 9 * * *", "enabled": True}],
                      "chat": [{"id": "c1", "kind": "user", "text": "hi"}]},
            "agentId": "mock"}
    for owner in ("pending", a["id"]):
        assert client.post(f"/draft/{owner}/open").json() == {"ok": True}
        assert client.put(f"/draft/{owner}", json=body).status_code == 200
    pj = client.get("/draft/pending").json()
    oj = client.get(f"/draft/{a['id']}").json()
    assert pj["agentId"] == oj["agentId"] == "mock"
    # Same shape from the shared serializer; the pending payload adds only the
    # identity fields no automation record exists to hold.
    assert set(pj["draft"]) - set(oj["draft"]) == {"name", "description"}
    assert {k: v for k, v in pj["draft"].items()
            if k not in ("name", "description")} == oj["draft"]
    # The 409 draft-execution guard applies to the automation owner only —
    # no execution can hold the pending slot's scripts.
    h = store.create_execution(a, "draft", None, "manual", [])
    try:
        assert client.put(f"/draft/{a['id']}", json=body).status_code == 409
        assert client.delete(f"/draft/{a['id']}").status_code == 409
        assert client.put("/draft/pending", json=body).status_code == 200
    finally:
        a["_live"].discard(h["id"])
    # An owner that resolves to nothing is 404 (`pending` is the only literal).
    assert client.get("/draft/nope").status_code == 404
    for owner in ("pending", a["id"]):
        assert client.delete(f"/draft/{owner}").json() == {"ok": True}
        assert client.get(f"/draft/{owner}").json()["draft"] is None


def test_runs_context_covers_real_executions_and_run_id(client, monkeypatch):
    # §8/§19: the chat RECENT RUNS context includes an automation's real
    # executions, and `runId` forces a specific run into the section.
    from autowright import testexec
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    ver = make_version(steps=[{"file": "01-boom.py", "name": "Boom", "description": "",
                               "code": "raise KeyError('missing page')\n"}],
                       spec=[{"kind": "h1", "text": "Real spec title"},
                             {"kind": "p", "text": "Body."}])
    a = store.create_automation(ver, "Real fail", "mock")
    eid = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "failed"
    runs = testexec.runs_context(a, ver["steps"], eid)
    assert runs is not None
    assert "v1 run · failed" in runs
    assert "KeyError" in runs
    assert "log tail (failing step)" in runs


def test_delete_agent_reassigns_default(client):
    from autowright.storage import store

    r = client.post("/agents", json={"harness": "OpenCode", "mode": "ollama",
                                     "model": "qwen3:8b", "name": "Local"})
    new_id = r.json()["id"]
    client.patch(f"/agents/{new_id}", json={"default": True})
    r = client.delete(f"/agents/{new_id}")
    assert r.status_code == 200
    agents = client.get("/agents").json()
    assert any(g.get("default") for g in agents)


def test_agent_local_model_harness_matrix(client):
    # §4.7: mode ollama is valid with Claude Code, Codex, and OpenCode —
    # never Gemini CLI (422); PATCH follows the same rule as POST.
    for h in ("Claude Code", "Codex", "OpenCode"):
        r = client.post("/agents", json={"harness": h, "mode": "ollama",
                                         "model": "qwen3:8b", "name": f"Local {h}"})
        assert r.status_code == 200, h
    r = client.post("/agents", json={"harness": "Gemini CLI", "mode": "ollama",
                                     "model": "qwen3:8b", "name": "Nope"})
    assert r.status_code == 422
    gid = client.post("/agents", json={"harness": "Gemini CLI", "name": "G"}).json()["id"]
    r = client.patch(f"/agents/{gid}", json={"mode": "ollama", "model": "qwen3:8b"})
    assert r.status_code == 422
    r = client.patch(f"/agents/{gid}", json={"harness": "Codex", "mode": "ollama",
                                             "model": "qwen3:8b"})
    assert r.status_code == 200


def test_seed_then_state(client, home):
    from autowright.storage import store
    from seed_data import seed

    seed(store)
    r = client.get("/state").json()
    names = {a["name"] for a in r["automations"]}
    assert names == {"Track manga chapters", "Nightly folder backup",
                     "Weekly report email", "Clean screenshots folder"}
    assert len(r["executions"]) == 12  # the §16 twelve
    statuses = {e["status"] for e in r["executions"]}
    assert {"succeeded", "failed", "cancelled", "interrupted", "skipped"} <= statuses
    manga = next(a for a in r["automations"] if a["name"] == "Track manga chapters")
    assert manga["version"] == 3
    assert manga["latest"]["chip"] == "2 new chapters"
    assert manga["triggerChip"] == "Daily 8:00"
    assert len(manga["versions"]) == 2  # v2, v1 in history
    secrets = {s["name"] for s in r["secrets"]}
    assert secrets == {"SMTP_PASSWORD", "VAULT_DRIVE_KEY"}
    report = next(a for a in r["automations"] if a["name"] == "Weekly report email")
    assert "SMTP_PASSWORD" in report["allowedSecrets"]

    # terminal seeded executions carry finished_at (started + duration)
    for h in store.execs.values():
        if h["status"] in ("succeeded", "failed", "cancelled", "interrupted", "skipped"):
            assert h.get("finished_at"), h["id"]

    # §4.5 manga result: the table as a result.md markdown file, files
    # listing = the dir listing, path for Show in Finder
    manga_execs = [e for e in r["executions"] if e["automationName"] == "Track manga chapters"]
    fulls = [client.get(f"/executions/{e['id']}").json() for e in manga_execs]
    tabled = next(f for f in fulls if f.get("result") and f["result"].get("chip") == "2 new chapters")
    assert [f["name"] for f in tabled["result"]["files"]] == ["result.md"]
    assert tabled["result"]["path"].endswith("result")
    md = client.get(f"/executions/{tabled['id']}/result/result.md")
    assert md.status_code == 200 and "| Manga |" in md.text
    assert client.get(f"/executions/{tabled['id']}/result/nope.md").status_code == 404

    # §5 logs/ layout: per-step-attempt files, lines {ts, t, k, seq, text}
    step1 = store.read_log(tabled["id"], 0, 1)
    assert step1 and all(set(l) == {"timestamp", "time", "kind", "sequence", "text"} for l in step1)
    assert step1[0]["text"].startswith("▸ Step 1")
    step2 = store.read_log(tabled["id"], 1, 1)
    assert any(l["text"].startswith("▸ Step 2") for l in step2)
    # a line before any step marker is execution-level → execution.ndjson
    shots_int = next(e for e in r["executions"] if e["status"] == "interrupted")
    int_logs = store.read_log(shots_int["id"])
    assert int_logs and "went to sleep" in int_logs[0]["text"]
    # §16: the retried report execution's failing step carries two attempts
    retried = next(f for f in (client.get(f"/executions/{e['id']}").json()
                               for e in r["executions"] if e["trigger"] == "Manual"
                               and e["automationName"] == "Weekly report email")
                   if any(len(s["attempts"]) == 2 for s in f["steps"]))
    send = next(s for s in retried["steps"] if s["name"] == "Send the email")
    assert [x["number"] for x in send["attempts"]] == [1, 2]


def test_settings_devmode_gates_request_logging(client):
    import logging

    from autowright.main import _DevModeFilter

    # §4.9: default off; PATCH persists it
    assert client.get("/settings").json()["developerMode"] is False
    flt = _DevModeFilter()
    info = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             "GET /state", None, None)
    warn = logging.LogRecord("autowright.api", logging.WARNING, __file__, 1,
                             "boom", None, None)
    # §5: off → warnings only
    assert not flt.filter(info)
    assert flt.filter(warn)
    assert client.patch("/settings", json={"developerMode": True}).json()["developerMode"] is True
    # §5: the filter reads the live setting — no restart needed
    assert flt.filter(info)


def test_settings_keep_awake_holds_assertion(client, monkeypatch):
    import os

    from autowright import awake

    calls: list[list[str]] = []

    class FakeProc:
        def __init__(self, argv, **_kw):
            calls.append(argv)
            self.terminated = False

        def poll(self):
            return 1 if self.terminated else None

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(awake, "_proc", None)
    monkeypatch.setattr(awake.subprocess, "Popen", FakeProc)
    # §4.9: default on; PATCH persists it and starts/stops the §3 assertion live
    assert client.get("/settings").json()["keepAwake"] is True
    assert client.patch("/settings", json={"keepAwake": False}).json()["keepAwake"] is False
    assert calls == []  # nothing running yet in tests — nothing to stop
    assert client.patch("/settings", json={"keepAwake": True}).json()["keepAwake"] is True
    assert calls == [["caffeinate", "-i", "-w", str(os.getpid())]]
    # unrelated PATCH while on: idempotent — no second caffeinate
    client.patch("/settings", json={"developerMode": True})
    assert len(calls) == 1
    proc = awake._proc
    # off → the subprocess is terminated and reaped
    assert client.patch("/settings", json={"keepAwake": False}).json()["keepAwake"] is False
    assert proc.terminated
    assert awake._proc is None


def test_packages_outdated_and_update(client, monkeypatch):
    from autowright import packages as pkglib

    # §6.2: the installed distribution is the comparison baseline for `latest`.
    monkeypatch.setattr(pkglib, "_installed_versions",
                        lambda: {"pandas": "2.2.3", "numpy": "2.0.0"})
    monkeypatch.setattr(pkglib, "_latest_compatible",
                        lambda name: {"pandas": "2.2.4", "numpy": "2.0.0"}.get(name))
    r = client.post("/packages/outdated", json={"packages": [
        {"pip": "pandas", "import": "pandas"},     # newer exists
        {"pip": "numpy", "import": "numpy"},       # already at latest
        {"pip": "left_pad", "import": "left_pad"},  # not installed → no badge
    ]}).json()["packages"]
    assert r[0]["latest"] == "2.2.4"
    assert "latest" not in r[1] and "latest" not in r[2]

    # §19 update: pip install --upgrade, no manifest writes.
    monkeypatch.setattr(pkglib, "upgrade",
                        lambda entries: [{**e, "status": "installed", "version": "2.2.4"}
                                         for e in entries])
    r = client.post("/packages/update", json={"packages": [
        {"pip": "pandas", "import": "pandas"}]}).json()
    assert r["packages"][0] == {"pip": "pandas", "import": "pandas",
                                "status": "installed", "version": "2.2.4"}

    # a version specifier is malformed now → 422
    assert client.post("/packages/update",
                       json={"packages": [{"pip": "pandas==2.2.4", "import": "pandas"}]}).status_code == 422


def test_memory_snapshot_endpoints(client):
    # §6.3/§19: manual snapshot, rename, restore, delete; pre-clear rides clear.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    base = f"/automations/{auto['id']}/memory/snapshots"

    # empty memory → 422; unknown automation → 404
    assert client.post(base, json={"name": "x"}).status_code == 422
    assert client.post("/automations/nope/memory/snapshots", json={}).status_code == 404

    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: old\n")
    r = client.post(base, json={"name": "  before edit  "})
    assert r.status_code == 200
    snap = r.json()["snapshot"]
    assert snap["name"] == "before edit" and snap["reason"] == "manual"

    # full automation JSON carries the newest-first list (§4.1)
    j = client.get(f"/automations/{auto['id']}").json()
    assert [s["id"] for s in j["snapshots"]] == [snap["id"]]

    # rename (empty clears), unknown sid → 404
    assert client.patch(f"{base}/{snap['id']}", json={"name": "pinned"}).json()["snapshot"]["name"] == "pinned"
    assert client.patch(f"{base}/{snap['id']}", json={"name": ""}).json()["snapshot"]["name"] is None
    assert client.patch(f"{base}/{'0' * 36}", json={"name": "x"}).status_code == 404

    # clear takes a pre-clear snapshot first (§6.3), then empties memory
    assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 200
    assert not (store.auto_dir(a) / "memory" / "seen.yaml").exists()
    reasons = [s["reason"] for s in store.list_snapshots(a)]
    assert "pre-clear" in reasons

    # restore brings the snapshot's copy back (memory now empty → no pre-restore)
    assert client.post(f"{base}/{snap['id']}/restore").status_code == 200
    assert (store.auto_dir(a) / "memory" / "seen.yaml").read_text() == "v: old\n"
    assert client.post(f"{base}/{'0' * 36}/restore").status_code == 404

    # delete
    assert client.delete(f"{base}/{snap['id']}").status_code == 200
    assert client.delete(f"{base}/{snap['id']}").status_code == 404


def test_memory_read_endpoints(client):
    # §19 GET memory/files + memory/files/{name}: list, content, traversal
    # 422, binary 422, unknown 404 — all lock-free reads.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    base = f"/automations/{auto['id']}/memory"

    assert client.get("/automations/nope/memory/files").status_code == 404
    assert client.get(f"{base}/files").json() == {"files": []}

    mem = store.auto_dir(a) / "memory"
    (mem / "seen.yaml").write_text("v: old\n")
    (mem / "sub").mkdir()
    (mem / "sub" / "cache.bin").write_bytes(b"\xff\xfe\x00")

    files = client.get(f"{base}/files").json()["files"]
    assert [f["name"] for f in files] == ["seen.yaml", "sub/cache.bin"]
    assert files[0]["size"] == 7 and files[0]["updated"] == "Today"

    r = client.get(f"{base}/files/seen.yaml")
    assert r.status_code == 200
    assert r.json() == {"name": "seen.yaml", "size": 7, "text": "v: old\n"}

    # binary answers 422 pointing at the on-disk memory dir, never bytes
    r = client.get(f"{base}/files/sub/cache.bin")
    assert r.status_code == 422 and "binary" in r.json()["detail"]

    assert client.get(f"{base}/files/nope.yaml").status_code == 404
    # traversal: an encoded ../ reaches the handler as a name and is rejected
    assert client.get(f"{base}/files/..%2Fautomation.yaml").status_code == 422

    # the resolver itself: escapes → None; normalizing inside memory/ is fine
    assert store.memory_file_path(a, "../automation.yaml") is None
    assert store.memory_file_path(a, "/etc/passwd") is None
    assert store.memory_file_path(a, "sub/../seen.yaml") == (mem / "seen.yaml").resolve()


def test_patch_snapshot_settings_and_gated_clear(client):
    # §19 PATCH snapshotSettings: partial merge; §6.3 pre-clear off → clear leaves no snapshot.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    assert auto["snapshotSettings"] == {"preVersion": True, "preClear": True, "preRestore": True}

    r = client.patch(f"/automations/{auto['id']}", json={"snapshotSettings": {"preClear": False}})
    assert r.status_code == 200
    assert r.json()["snapshotSettings"] == {"preVersion": True, "preClear": False, "preRestore": True}

    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: old\n")
    assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 200
    assert not (store.auto_dir(a) / "memory" / "seen.yaml").exists()
    assert store.list_snapshots(a) == []


def test_memory_snapshot_409_while_live(client):
    # §6.3: manual snapshot and restore are blocked while an execution is live.
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: 1\n")
    base = f"/automations/{auto['id']}/memory/snapshots"
    snap = client.post(base, json={}).json()["snapshot"]

    a["_live"] = {"fake-exec-id"}
    try:
        assert client.post(base, json={}).status_code == 409
        assert client.post(f"{base}/{snap['id']}/restore").status_code == 409
    finally:
        a["_live"] = set()


def test_check_harness_endpoint(client, monkeypatch):
    # §19: the §4.7 readiness check before an agent record exists (§10 cards).
    from autowright import harness

    monkeypatch.setattr(harness, "check_ready",
                        lambda name, model=None, mode="default": name == "Codex")
    assert client.post("/agents/check-harness",
                       json={"harness": "Codex"}).json() == {"status": "ready"}
    assert client.post("/agents/check-harness",
                       json={"harness": "Gemini CLI"}).json() == {"status": "needs-setup"}
    assert client.post("/agents/check-harness", json={"harness": "GPT-5"}).status_code == 422


def test_signin_and_login_endpoints(client, monkeypatch):
    # §19 sign-in help: only for an installed, signed-out, account-backed provider.
    from autowright import harness, installer

    monkeypatch.setattr(harness, "signin_state",
                        lambda pid: {"installed": pid != "gemini", "signedIn": pid == "claude"})
    assert client.get("/agents/signin/codex").json() == {"installed": True, "signedIn": False}
    assert client.get("/agents/signin/nope").status_code == 422

    assert client.post("/agents/login", json={"id": "ollama"}).status_code == 409  # no account
    assert client.post("/agents/login", json={"id": "gemini"}).status_code == 409  # not installed
    assert client.post("/agents/login", json={"id": "claude"}).status_code == 409  # already signed in
    monkeypatch.setattr(installer, "login", lambda pid: "browser")
    assert client.post("/agents/login", json={"id": "codex"}).json() == {"ok": True, "method": "browser"}


def test_install_endpoints(client, monkeypatch):
    # §19: install runs in the backend; the status snapshot reattaches a remounted UI.
    from autowright import installer

    assert client.post("/agents/install", json={"id": "nope"}).status_code == 422
    assert client.get("/agents/install/claude").json() == {"state": "idle"}

    started = {}
    monkeypatch.setattr(installer, "start", lambda pid, publish: started.setdefault(pid, True))
    assert client.post("/agents/install", json={"id": "codex"}).json() == {"ok": True}
    monkeypatch.setattr(installer, "start", lambda pid, publish: False)  # already running
    assert client.post("/agents/install", json={"id": "codex"}).status_code == 409


# ---------- appended coverage: guards, repair, WS auth, export names, delete ----------

def test_result_file_traversal_rejected(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Guarded", "mock")
    h = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    store.update_execution(h)
    (store.exec_dir(h["id"]) / "result" / "ok.txt").write_text("fine", encoding="utf-8")
    outside = store.exec_dir(h["id"]) / "execution.yaml"   # real file outside result/
    assert outside.exists()

    ok = client.get(f"/executions/{h['id']}/result/ok.txt")
    assert ok.status_code == 200 and ok.text == "fine"

    # traversal shapes (encoded so the client can't pre-normalize them) → 404,
    # and the record yaml outside the result dir is never served
    for name in ("..%2F..%2Fsomething", "..%2Fexecution.yaml",
                 "%2E%2E%2Fexecution.yaml", "..%5Cexecution.yaml"):
        r = client.get(f"/executions/{h['id']}/result/{name}")
        assert r.status_code == 404, name
        assert "automation_id" not in r.text


def test_repair_stale_executing_flips_to_interrupted(client):
    from autowright import api
    from autowright.storage import store

    a = store.create_automation(make_version(), "Stale", "mock")
    steps = [{"name": "Say hello", "file": "01-say.py", "status": "executing",
              "attempts": [{"number": 1, "status": "executing",
                            "started_at": None, "duration_ms": None}]}]
    h = store.create_execution(a, "version", 1, "manual", steps)    # status: executing
    assert not api.engine.is_live(h["id"])                  # no engine thread owns it
    # §6: a leftover queue entry is swept in the same pass — the in-memory queue
    # died with the process, so it must not execute minutes late.
    q = store.create_execution(a, "version", 1, "discord", [], status="queued",
                               trigger_payload={"kind": "discord", "channel": "42",
                                                "secret": "TOKEN", "sender": "Dave"})

    api._repair_stale_executing()                           # also runs at startup

    qf = store.execs[q["id"]]
    assert qf["status"] == "skipped"
    assert qf["note"] == "backend restarted before this ran"
    assert store.queued_execs(a["id"]) == []

    full = store.exec_full(h["id"])
    assert full["status"] == "interrupted"
    assert full["note"] == "backend restarted mid-execution"
    assert [s["status"] for s in full["steps"]] == ["interrupted"]
    assert [at["status"] for s in full["steps"] for at in s["attempts"]] == ["interrupted"]
    assert store.read_exec_yaml(h["id"])["status"] == "interrupted"   # persisted
    assert a["_live"] == set() and a["_last_status"] == "interrupted"


def test_repair_kills_orphaned_step_group(client, monkeypatch):
    """§3: a stale executing record's persisted pgid is killed (and cleared)
    before the record flips to interrupted — the previous backend's step
    process must not keep writing memory/ beside the next execution."""
    from autowright import api
    from autowright.storage import store

    a = store.create_automation(make_version(), "Orphaned", "mock")
    steps = [{"name": "Say hello", "file": "01-say.py", "status": "executing",
              "attempts": [{"number": 1, "status": "executing",
                            "started_at": None, "duration_ms": None}]}]
    h = store.create_execution(a, "version", 1, "manual", steps)
    h["pgid"] = 54321
    store.update_execution(h)
    assert store.read_exec_yaml(h["id"])["pgid"] == 54321   # §4.5: on-disk only

    killed = []
    monkeypatch.setattr(api, "kill_orphan_group", killed.append)
    api._repair_stale_executing()

    assert killed == [54321]
    full = store.exec_full(h["id"])
    assert full["status"] == "interrupted"
    assert full["pgid"] is None
    assert store.read_exec_yaml(h["id"])["pgid"] is None


def test_create_empty_step_agents_is_kept_empty(client):
    """§4.1: an explicit empty stepAgents list is a real choice — create must
    not silently re-grant the drafting agent the user just unchecked."""
    r = client.post("/automations", json={
        "name": "No agents", "agentId": "mock", "stepAgents": [],
        "allowedSecrets": [],
        "draft": {"steps": [{"name": "S", "file": "01-s.py", "code": "log('x')"}]},
    })
    assert r.status_code == 200
    assert r.json()["stepAgents"] == []
    # absent field still falls back to the drafting agent
    r2 = client.post("/automations", json={
        "name": "Default agents", "agentId": "mock",
        "draft": {"steps": [{"name": "S", "file": "01-s.py", "code": "log('x')"}]},
    })
    assert r2.json()["stepAgents"] == ["mock"]


def test_data_path_switch_refused_while_queue_nonempty(client, tmp_path):
    """§19: a queued firing must block the data-path switch — the in-memory
    queue dies with the reload and the sender would never be told."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Queued blocker", "mock")
    store.create_execution(a, "version", 1, "cron", [], status="queued")
    r = client.post("/settings/data-path", json={"path": str(tmp_path / "elsewhere")})
    assert r.status_code == 409
    assert "queued" in r.json()["detail"]


def test_finish_queued_reports_promotion_loss(client):
    """§6/§19 cancel race: finish_queued must say whether it won — a promoted
    entry answers False so cancel retries on the live record."""
    from autowright.firing import finish_queued
    from autowright.storage import store

    a = store.create_automation(make_version(), "Promoted", "mock")
    h = store.create_execution(a, "version", 1, "cron", [], status="queued")
    h["status"] = "executing"          # promoted under us
    assert finish_queued(store, h, "cancelled before it ran") is False
    h["status"] = "queued"
    assert finish_queued(store, h, "cancelled before it ran") is True
    assert store.execs[h["id"]]["status"] == "skipped"


def test_restore_snapshot_recovers_aside_memory(client):
    """§6.3: a crash between the rename-aside and the rename-in must be
    recoverable — the aside dir is the sole surviving memory copy."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Crashy restore", "mock")
    mem = store.auto_dir(a) / "memory"
    (mem / "state.txt").parent.mkdir(parents=True, exist_ok=True)
    (mem / "state.txt").write_text("current", encoding="utf-8")
    snap = store.snapshot_memory(a, "manual")
    assert snap
    # simulate the crash window: memory/ renamed aside, staged copy never landed
    aside = mem.parent / ".ad-old-memory"
    mem.rename(aside)
    assert not mem.exists()

    meta = store.restore_snapshot(a, snap["id"])
    assert meta
    assert (mem / "state.txt").read_text(encoding="utf-8") == "current"
    assert not aside.exists()


def test_delete_waits_for_live_execution_thread(client):
    """§19 delete: the rmtree must not race a cancelled execution still dying
    in the §7 SIGTERM grace — delete waits for the engine thread to exit."""
    import threading

    from autowright import api
    from autowright.storage import store

    a = store.create_automation(make_version(), "Race me", "mock")
    h = store.create_execution(a, "version", 1, "manual", [])
    store.update_execution(h)
    assert h["id"] in a["_live"]

    memory = store.auto_dir(a) / "memory" / "v1"
    done = threading.Event()

    def dying_step():
        done.wait(10)                       # released by engine.cancel below
        # simulate the step's final memory write during the grace window
        memory.mkdir(parents=True, exist_ok=True)
        (memory / "late.txt").write_text("late", encoding="utf-8")
        h["status"] = "cancelled"
        store.update_execution(h)

    t = threading.Thread(target=dying_step, daemon=True)
    real_cancel = api.engine.cancel

    def cancel_and_release(eid):
        done.set()
        return real_cancel(eid)

    api.engine._live[h["id"]] = {"proc": None, "cancel": False, "thread": t}
    t.start()
    api.engine.cancel = cancel_and_release
    try:
        r = client.delete(f"/automations/{a['id']}")
    finally:
        api.engine.cancel = real_cancel
        api.engine._live.pop(h["id"], None)
    assert r.status_code == 200
    # the late write landed BEFORE the rmtree — nothing survives it
    assert not store.auto_dir(a).exists()


def test_kill_orphan_group_pid_reuse_guard():
    """kill_orphan_group must never signal a group that no longer contains an
    autowright.executor process — a recycled pgid is somebody else's now."""
    import subprocess as sp

    from autowright.engine import kill_orphan_group

    proc = sp.Popen(["sleep", "30"], start_new_session=True)
    try:
        kill_orphan_group(proc.pid)          # group exists, but it's not ours
        assert proc.poll() is None           # untouched
    finally:
        import os
        import signal as sig
        os.killpg(proc.pid, sig.SIGKILL)
        proc.wait(timeout=10)


def test_ws_rejects_missing_or_wrong_token(client):
    from starlette.websockets import WebSocketDisconnect

    for url in ("/ws", "/ws?token=wrong"):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(url):
                pass
        assert exc.value.code == 4401, url


def test_export_filename_non_ascii(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Café ☕ backup", "mock")
    r = client.get(f"/automations/{a['id']}/export")
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    # ASCII fallback (non-ASCII replaced) plus the RFC 5987 UTF-8 parameter
    assert 'filename="Caf? ? backup.autowright"' in cd
    assert "filename*=UTF-8''Caf%C3%A9%20%E2%98%95%20backup.autowright" in cd
    cd.encode("ascii")  # the whole header must stay ASCII-clean


def test_delete_automation_removes_test_exec_records(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Doomed", "mock")
    t = store.create_execution(a, "test", None, "test", [], status="succeeded")
    real = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    store.update_execution(real)
    tdir = store.exec_dir(t["id"])
    assert tdir.exists()

    assert client.delete(f"/automations/{a['id']}").status_code == 200
    assert a["id"] not in store.autos
    # the §11 test record and its on-disk directory are gone
    assert t["id"] not in store.execs and not tdir.exists()
    # real records stay, flagged automationDeleted
    assert real["id"] in store.execs
    assert client.get(f"/executions/{real['id']}").json()["automationDeleted"] is True


# ---------- §8/§19 grant propagation — the editor's agent/secret checkboxes ----------

def _capture_draft_grants(monkeypatch):
    from autowright import api

    captured = {}

    def fake_start(mode, agent, user_text, current, grants, chat_history=None, **kw):
        captured["mode"] = mode
        captured["grants"] = grants
        captured["kw"] = kw
        return "job-x"

    monkeypatch.setattr(api.draft_jobs, "start", fake_start)
    return captured


def test_unchecked_grants_are_not_passed_to_drafting(client, monkeypatch):
    # §19: explicit empty arrays win over every default — unchecking every agent
    # and secret in the editor means the authoring agent is granted none of them.
    from autowright.storage import store

    store.agents.append({"id": "second", "name": "Fast local", "harness": "OpenCode",
                         "mode": "ollama", "model": "qwen3:8b", "default": False})
    client.put("/secrets/MY_TOKEN", json={"value": "s3cret"})
    captured = _capture_draft_grants(monkeypatch)
    r = client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock",
                                     "enabledAgents": [], "allowedSecrets": []})
    assert r.status_code == 200
    assert captured["grants"] == {"agents": [], "secrets": []}


def test_unchecked_grants_render_none_in_prompt(client):
    # End to end through the real drafting job: with everything unchecked the
    # prompt's grant sections carry the literal `none` and never name a secret.
    from autowright import paths

    client.put("/secrets/MY_TOKEN", json={"value": "s3cret-value"})
    r = client.post("/drafts", json={"mode": "create", "text": "Watch a product price",
                                     "agentId": "mock",
                                     "enabledAgents": [], "allowedSecrets": []})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "pick the most appropriate entries yourself) ===\nnone" in logged  # agents
    assert "otherwise pick by judgment) ===\nnone" in logged                  # secrets
    assert "MY_TOKEN" not in logged
    assert "s3cret-value" not in logged


def test_grant_subset_excludes_unchecked_entries(client, monkeypatch):
    # §19: a partial selection passes exactly the checked entries, nothing else.
    from autowright.storage import store

    store.agents.append({"id": "second", "name": "Fast local", "harness": "OpenCode",
                         "mode": "ollama", "model": "qwen3:8b", "default": False})
    client.put("/secrets/KEEP_KEY", json={"value": "a"})
    client.put("/secrets/DROP_KEY", json={"value": "b"})
    captured = _capture_draft_grants(monkeypatch)
    r = client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock",
                                     "enabledAgents": ["second"],
                                     "allowedSecrets": ["KEEP_KEY"]})
    assert r.status_code == 200
    assert [g["name"] for g in captured["grants"]["agents"]] == ["Fast local"]
    assert captured["grants"]["agents"][0]["model"] == "qwen3:8b"
    assert [s["name"] for s in captured["grants"]["secrets"]] == ["KEEP_KEY"]


def test_create_draft_grants_all_secrets_by_default(client, monkeypatch):
    # §19: no allowedSecrets + no stored automation → every stored secret is
    # granted (the all-on seed the Review page starts from). Names only — the
    # grant entries never carry values.
    client.put("/secrets/A_KEY", json={"value": "a", "description": "first"})
    client.put("/secrets/B_KEY", json={"value": "b"})
    captured = _capture_draft_grants(monkeypatch)
    client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock"})
    grants = captured["grants"]["secrets"]
    assert sorted(s["name"] for s in grants) == ["A_KEY", "B_KEY"]
    assert all(set(s) <= {"name", "description"} for s in grants)


def test_chat_draft_falls_back_to_stored_grants(client, monkeypatch):
    # §19: absent grant arrays on chat/sync → the stored automation's grants.
    from autowright.storage import store

    store.agents.append({"id": "second", "name": "Fast local", "harness": "OpenCode",
                         "mode": "ollama", "model": "qwen3:8b", "default": False})
    client.put("/secrets/STORED_KEY", json={"value": "a"})
    client.put("/secrets/OTHER_KEY", json={"value": "b"})
    a = store.create_automation(make_version(), "Grant fallback", "mock",
                                enabled_agents=["second"],
                                allowed_secrets=["STORED_KEY"])
    captured = _capture_draft_grants(monkeypatch)
    client.post("/drafts", json={"mode": "chat", "automationId": a["id"], "agentId": "mock",
                                 "text": "change something"})
    assert [g["name"] for g in captured["grants"]["agents"]] == ["Fast local"]
    assert [s["name"] for s in captured["grants"]["secrets"]] == ["STORED_KEY"]


def test_test_grant_arrays_propagate(client, monkeypatch):
    # §19 POST /tests: grant arrays as in /drafts — explicit [] wins, absent
    # falls back to the stored automation's grants, and create mode (no
    # automationId) defaults to ALL configured agents / ALL stored secrets (the
    # all-on seeds the Review page starts from).
    from autowright import api

    captured = {}

    def fake_start(engine, d, auto, enabled, allowed, param_values, trigger_payload=None):
        captured["enabled"], captured["allowed"] = enabled, allowed
        return "exec-x"

    monkeypatch.setattr(api.testexec, "start", fake_start)
    d = _echo_draft()
    auto = client.post("/automations", json={"draft": d, "stepAgents": ["mock"],
                                             "allowedSecrets": ["X_KEY"]}).json()

    r = client.post("/tests", json={"draft": d, "automationId": auto["id"],
                                    "enabledAgents": [], "allowedSecrets": []})
    assert r.status_code == 200
    assert (captured["enabled"], captured["allowed"]) == ([], [])

    client.post("/tests", json={"draft": d, "automationId": auto["id"]})
    assert (captured["enabled"], captured["allowed"]) == (["mock"], ["X_KEY"])

    client.post("/tests", json={"draft": d})
    assert captured["enabled"] == [g["id"] for g in api.store.agents]
    assert captured["allowed"] == [s["name"] for s in api.store.secrets]


# ---------- §10/§19 detection + Ollama endpoints ----------

def test_agents_detect_endpoint(client, monkeypatch):
    # §19: detection reports all four harnesses with real installed/sign-in state.
    from autowright import harness

    fake = [{"id": p, "name": harness.PROVIDER_NAME[p], "installed": p == "claude",
             "signedIn": p == "claude", "detail": "1.0.24 · signed in"}
            for p in ("claude", "codex", "gemini", "opencode")]
    monkeypatch.setattr(harness, "detect", lambda: fake)
    assert client.get("/agents/detect").json() == fake


def test_ollama_status_endpoint(client, monkeypatch):
    from autowright import harness

    st = {"ready": True, "installed": True, "models": ["qwen3:8b"]}
    monkeypatch.setattr(harness, "ollama_status", lambda: st)
    assert client.get("/ollama/status").json() == st


def _wait_pull_done(events, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if any(e["event"] == "ollama.pull" and e.get("done") for e in events):
            return [e for e in events if e["event"] == "ollama.pull"]
        time.sleep(0.05)
    raise AssertionError(f"ollama.pull done never arrived (got {events})")


def test_ollama_pull_streams_lines_then_done(client, monkeypatch):
    # §19: with the server not answering, the pull falls back to the CLI and
    # streams raw `ollama pull` output over ollama.pull events — each carrying
    # the single overall `percent` once one is known — closing with
    # done/ok/percent 100 and an agents.changed refresh nudge.
    from autowright import api, harness

    events = _capture_events(monkeypatch)
    monkeypatch.setattr(harness, "_ollama_models", lambda: None)
    monkeypatch.setattr(harness, "ollama_bin", lambda: "/fake/ollama")

    lines = [
        "pulling manifest\n",
        "pulling 3f2a... 42% ▕█▏ 2.2 GB/5.2 GB\n",
        "pulling 3f2a... 100% ▕█▏ 5.2 GB/5.2 GB\n",
        # a small metadata layer restarts the raw bar at 0% — the overall
        # percent must not reset with it
        "pulling ab12... 0% ▕▏ 0 B/1.2 KB\n",
        "verifying sha256 digest\n",
    ]

    class FakeProc:
        returncode = 0

        def __init__(self):
            # per-instance: a class-attribute iterator would be exhausted by
            # the first FakeProc and starve any later one
            self.stdout = iter(lines)

        def wait(self):
            return 0

    popen = {}

    def fake_popen(cmd, **kw):
        popen["cmd"] = cmd
        return FakeProc()

    monkeypatch.setattr(api.subprocess, "Popen", fake_popen)
    assert client.post("/ollama/pull", json={}).status_code == 422
    assert client.post("/ollama/pull", json={"model": "qwen3:8b"}).json() == {"ok": True}
    pulls = _wait_pull_done(events)
    assert popen["cmd"] == ["/fake/ollama", "pull", "qwen3:8b"]
    assert [e["line"] for e in pulls[:-1]] == [ln.strip() for ln in lines]
    assert [e.get("percent") for e in pulls] == [None, 42, 100, 100, 100, 100]
    assert "percent" not in pulls[0]  # nothing parseable yet → key omitted
    assert pulls[-1]["done"] is True and pulls[-1]["ok"] is True
    assert all(e["model"] == "qwen3:8b" for e in pulls)
    t0 = time.time()
    while not any(e["event"] == "agents.changed" for e in events):
        assert time.time() - t0 < 5
        time.sleep(0.05)


def test_pull_progress_byte_weights_layers_and_never_goes_backwards():
    # §19 _PullProgress: one overall percent — byte-weighted across layers,
    # bare-`N%` fallback when no byte counts parse, monotonic throughout.
    from autowright.api import _PullProgress

    p = _PullProgress()
    assert p.update("pulling manifest") is None
    assert p.update("pulling a1b2c3... 50% ▕█▏ 2.6 GB/5.2 GB") == 50
    assert p.update("pulling a1b2c3... 100% ▕█▏ 5.2 GB/5.2 GB") == 100
    assert p.update("pulling ff00aa... 0% ▕▏ 0 B/1.2 KB") == 100  # no reset
    assert p.update("verifying sha256 digest") == 100
    assert p.update("writing manifest") == 100

    # bare-percent fallback (no byte counts): later layers restart the raw
    # number — the overall percent holds
    q = _PullProgress()
    assert q.update("pulling a1b2... 90%") == 90
    assert q.update("pulling c3d4... 3%") == 90


def test_ollama_pull_without_server_or_binary_reports_not_running(client, monkeypatch):
    # §19: no server answering, no resolvable binary → terminal ok=false with
    # "Ollama isn't running" (never a Popen on a bare "ollama" guess).
    from autowright import api, harness

    events = _capture_events(monkeypatch)
    monkeypatch.setattr(harness, "_ollama_models", lambda: None)
    monkeypatch.setattr(harness, "ollama_bin", lambda: None)

    def no_popen(cmd, **kw):
        raise AssertionError("CLI must not be spawned without a resolved binary")

    monkeypatch.setattr(api.subprocess, "Popen", no_popen)
    assert client.post("/ollama/pull", json={"model": "qwen3:8b"}).json() == {"ok": True}
    pulls = _wait_pull_done(events)
    assert pulls[-1]["line"] == "Ollama isn't running"
    assert pulls[-1]["done"] is True and pulls[-1]["ok"] is False


def test_ollama_pull_rides_server_api_when_answering(client, monkeypatch):
    # §19: /ollama/status reports installed/active from the server answering,
    # so a pull in that state must succeed with no CLI binary at all — it
    # rides the server's /api/pull stream. This is the "status says active but
    # pull says not installed" regression.
    import json as jsonlib

    from autowright import api, harness

    events = _capture_events(monkeypatch)
    monkeypatch.setattr(harness, "_ollama_models", lambda: [])  # server answers
    monkeypatch.setattr(harness, "ollama_bin", lambda: None)    # no CLI anywhere

    stream = [
        {"status": "pulling manifest"},
        {"status": "pulling 3f2a", "digest": "sha256:3f2a", "completed": 2.6e9, "total": 5.2e9},
        {"status": "pulling 3f2a", "digest": "sha256:3f2a", "completed": 5.2e9, "total": 5.2e9},
        # tiny metadata layer joins the weighting — overall percent must not reset
        {"status": "pulling ab12", "digest": "sha256:ab12", "completed": 0, "total": 1.2e3},
        {"status": "verifying sha256 digest"},
        {"status": "success"},
    ]

    calls = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def __iter__(self):
            return iter([(jsonlib.dumps(m) + "\n").encode() for m in stream])

    def fake_urlopen(req, timeout=None):
        calls["url"] = req.full_url
        calls["body"] = jsonlib.loads(req.data.decode())
        return FakeResp()

    monkeypatch.setattr(api.urllib.request, "urlopen", fake_urlopen)

    def no_popen(cmd, **kw):
        raise AssertionError("CLI must not be spawned when the server answers")

    monkeypatch.setattr(api.subprocess, "Popen", no_popen)
    assert client.post("/ollama/pull", json={"model": "qwen3:8b"}).json() == {"ok": True}
    pulls = _wait_pull_done(events)
    assert calls["url"].endswith("/api/pull")
    assert calls["body"] == {"model": "qwen3:8b"}
    assert [e["line"] for e in pulls[:-1]] == [m["status"] for m in stream]
    assert [e.get("percent") for e in pulls] == [None, 50, 100, 100, 100, 100, 100]
    assert pulls[-1]["done"] is True and pulls[-1]["ok"] is True


# ---------- §4.7/§19 agent record validation ----------

def test_add_agent_validation_matrix(client):
    # §4.7: mode ollama needs a local-model harness (never Gemini CLI) and a
    # model; custom needs a model; default mode always stores a null model.
    assert client.post("/agents", json={"harness": "GPT-5"}).status_code == 422
    assert client.post("/agents", json={"harness": "Codex", "mode": "turbo"}).status_code == 422
    assert client.post("/agents", json={"harness": "Gemini CLI", "mode": "ollama",
                                        "model": "qwen3:8b"}).status_code == 422
    assert client.post("/agents", json={"harness": "OpenCode", "mode": "ollama"}).status_code == 422
    assert client.post("/agents", json={"harness": "Codex", "mode": "custom"}).status_code == 422
    ag = client.post("/agents", json={"harness": "Claude Code", "mode": "default",
                                      "model": "ignored-in-default-mode"}).json()
    assert ag["model"] is None
    good = client.post("/agents", json={"harness": "OpenCode", "mode": "ollama",
                                        "model": "qwen3:8b", "name": "Fast local"}).json()
    assert good["model"] == "qwen3:8b" and good["harness"] == "OpenCode"


def test_patch_agent_validation_and_default_switch(client):
    from autowright.storage import store

    ag = client.post("/agents", json={"harness": "OpenCode", "mode": "ollama",
                                      "model": "qwen3:8b", "name": "Local"}).json()
    # PATCH can't create a shape POST rejects
    assert client.patch(f"/agents/{ag['id']}",
                        json={"harness": "Gemini CLI"}).status_code == 422  # never local (§4.7)
    assert client.patch(f"/agents/{ag['id']}",
                        json={"model": None}).status_code == 422       # ollama needs a model
    # switching to default mode nulls the model
    p = client.patch(f"/agents/{ag['id']}", json={"mode": "default"}).json()
    assert p["model"] is None
    # default flips exclusively
    p = client.patch(f"/agents/{ag['id']}", json={"default": True}).json()
    assert p["default"] is True
    assert store.default_agent_id == ag["id"]  # §4.7: pointer moved off "mock"


def test_concurrency_settings_patch_and_validate(client):
    """§19: maxParallel/maxQueued are ints with a floor — a bad value is a 422
    and nothing is stored, rather than a silent clamp the user never learns about."""
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    aid = auto["id"]
    assert auto["maxParallel"] == 1 and auto["maxQueued"] == 10  # §4.1 defaults
    assert auto["live"] == []  # §4.1 live is a list now

    body = client.patch(f"/automations/{aid}", json={"maxParallel": 3, "maxQueued": 0}).json()
    assert body["maxParallel"] == 3 and body["maxQueued"] == 0
    # survives a reload from disk (§5 top-level automation.yaml)
    a = store.autos[aid]
    assert store._load_automation(store.auto_dir(a))["max_parallel"] == 3

    for bad in ({"maxParallel": 0}, {"maxParallel": "2"}, {"maxParallel": True},
                {"maxQueued": -1}, {"maxQueued": 1.5}):
        assert client.patch(f"/automations/{aid}", json=bad).status_code == 422
    assert client.get(f"/automations/{aid}").json()["maxParallel"] == 3  # unchanged


def test_queue_clear_endpoint(client, monkeypatch):
    """§19: clears every waiting entry, answers 0 on an empty queue (not 404),
    and leaves running executions alone."""
    from autowright import listeners as li_mod
    from autowright.firing import fire_trigger
    from autowright.storage import store
    from autowright import api as api_mod

    monkeypatch.setattr(li_mod, "notify_busy", lambda payload: None)

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    aid = auto["id"]
    a = store.autos[aid]
    assert client.post(f"/automations/{aid}/queue/clear").json() == {"cancelled": 0}

    a["_live"] = {"blocking"}
    trig = {"id": "t1", "kind": "discord", "enabled": True, "secret": "TOKEN", "channel": "42"}
    for sender in ("Dave", "Ana"):
        fire_trigger(store, api_mod.engine, a, trig,
                     payload={"kind": "discord", "channel": "42", "secret": "TOKEN",
                              "sender": sender})
    # §9.2 counts these records client-side — the automation JSON carries no count.
    assert len(store.queued_execs(aid)) == 2
    assert "queuedCount" not in client.get(f"/automations/{aid}").json()

    assert client.post(f"/automations/{aid}/queue/clear").json() == {"cancelled": 2}
    assert store.queued_execs(aid) == []
    assert a["_live"] == {"blocking"}  # the running execution is untouched
    assert client.post("/automations/nope/queue/clear").status_code == 404


# ---------- §4.1 step-flag spelling boundary (api._norm_steps) ----------

def _flagged_steps():
    return [{"file": "01-s.py", "name": "S", "description": "",
             "code": "from autowright import log\nlog('x')\n",
             "noTimeout": True, "infiniteRetries": True}]


def _assert_snake_only(s):
    assert s["no_timeout"] is True and s["infinite_retries"] is True
    assert "noTimeout" not in s and "infiniteRetries" not in s


def test_norm_steps_camel_boundary_on_create_and_save_version(client):
    """§4.1: the API spelling is camelCase (noTimeout/infiniteRetries); disk and
    the internal shape are snake_case only — nothing past the boundary reads the
    camel keys (engine, storage all dropped their camel fallbacks)."""
    from autowright import engine as eng
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": {"steps": _flagged_steps()}}).json()
    a = store.autos[auto["id"]]
    s = a["versions"][1]["steps"][0]
    _assert_snake_only(s)
    manifest = (store.auto_dir(a) / "versions" / "v1" / "automation.yaml").read_text(encoding="utf-8")
    assert "no_timeout" in manifest and "infinite_retries" in manifest
    assert "noTimeout" not in manifest and "infiniteRetries" not in manifest
    # downstream readers see the snake keys
    assert eng.step_timeout_for(s) is None
    assert eng.step_retries_forever(s) is True
    # the API serializes them back to camelCase
    j = client.get(f"/automations/{auto['id']}").json()
    assert j["steps"][0]["noTimeout"] is True and j["steps"][0]["infiniteRetries"] is True

    # POST /automations/{id}/versions goes through the same boundary (notes
    # delta so the §4.4 operational-only rule still mints)
    r = client.post(f"/automations/{auto['id']}/versions",
                    json={"draft": {"steps": _flagged_steps(), "notes": "v2"}})
    assert r.status_code == 200 and r.json()["version"] == 2
    _assert_snake_only(a["versions"][2]["steps"][0])


def test_norm_steps_camel_boundary_on_draft_put(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Flagged draft", "mock")
    r = client.put(f"/draft/{a['id']}",
                   json={"draft": {**make_version(), "steps": _flagged_steps()}})
    assert r.status_code == 200
    _assert_snake_only(a["draft"]["steps"][0])
    d = client.get(f"/automations/{a['id']}").json()["draft"]
    assert d["steps"][0]["noTimeout"] is True and d["steps"][0]["infiniteRetries"] is True


def test_norm_steps_camel_boundary_on_drafts_current(client, monkeypatch):
    # §4.1: an in-editor draft sent as `current` carries the API's camelCase
    # step flags — normalized before the drafting job ever sees them.
    from autowright import api

    captured = {}

    def fake_start(mode, agent, user_text, current, grants, chat_history=None, **kw):
        captured["current"] = current
        return "job-x"

    monkeypatch.setattr(api.draft_jobs, "start", fake_start)
    r = client.post("/drafts", json={"mode": "create", "text": "x", "agentId": "mock",
                                     "current": {**make_version(), "steps": _flagged_steps()}})
    assert r.status_code == 200
    _assert_snake_only(captured["current"]["steps"][0])


# ---------- §19 POST /automations/{id}/execute trigger validation ----------

def test_execute_trigger_menubar_and_validation(client, monkeypatch):
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    a = store.create_automation(make_version(), "Tray start", "mock")
    assert client.post(f"/automations/{a['id']}/execute",
                       json={"trigger": "cron"}).status_code == 422
    r = client.post(f"/automations/{a['id']}/execute", json={"trigger": "menubar"})
    assert r.status_code == 200
    eid = r.json()["executionId"]
    _until_finished(events, eid)
    # §4.5: the record stores the machine kind; the label derives at serialization
    assert store.execs[eid]["trigger"] == "menubar"
    assert client.get(f"/executions/{eid}").json()["trigger"] == "Menu bar"


def test_execute_queue_mode(client):
    """§19 `queue: true` (the §9.2 popup's Queue action): a free slot starts
    (`queued: false`); at capacity the start is admitted to the §6 queue
    (`queued: true`); a full queue or a Draft answers 409 with no record; a
    plain execute at capacity keeps the refusal."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "API Queue", "mock")
    a["max_queued"] = 1

    # Free slot: queue: true simply starts.
    r0 = client.post(f"/automations/{a['id']}/execute", json={"queue": True})
    assert r0.status_code == 200 and r0.json()["queued"] is False
    for _ in range(200):
        if client.get(f"/executions/{r0.json()['executionId']}").json()["status"] != "executing":
            break
        time.sleep(0.1)

    a["_live"] = {"blocking"}  # fake a busy slot — §6 at_capacity reads _live
    r = client.post(f"/automations/{a['id']}/execute", json={"queue": True})
    assert r.status_code == 200
    assert r.json()["queued"] is True
    eid = r.json()["executionId"]
    assert store.execs[eid]["status"] == "queued"
    assert store.execs[eid]["trigger"] == "manual"
    assert client.get(f"/executions/{eid}").json()["trigger"] == "Manual"

    # Full queue → 409, no record; the §6 message names the cap.
    n = len(store.execs)
    r2 = client.post(f"/automations/{a['id']}/execute", json={"queue": True})
    assert r2.status_code == 409 and "the queue is full (1 waiting)" in r2.json()["detail"]
    # A Draft is never queued (§6) and a plain execute keeps the refusal (§7).
    assert client.post(f"/automations/{a['id']}/execute",
                       json={"queue": True, "version": "draft"}).status_code == 409
    assert client.post(f"/automations/{a['id']}/execute", json={}).status_code == 409
    assert len(store.execs) == n
    a["_live"] = set()


# ---------- §7 draft-execution guard (api._reject_live_draft_exec) ----------

def test_draft_endpoints_409_while_draft_execution_live(client):
    """§7: while a Draft-version execution runs, rewriting/pruning the draft's
    step scripts (PUT/DELETE draft, save version) would break the per-step sha."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Live draft", "mock")
    h = store.create_execution(a, "draft", None, "manual", [])   # status: executing
    assert h["id"] in a["_live"]
    try:
        for r in (client.put(f"/draft/{a['id']}", json={"draft": make_version()}),
                  client.delete(f"/draft/{a['id']}"),
                  client.post(f"/automations/{a['id']}/versions", json={"draft": make_version()})):
            assert r.status_code == 409
            assert r.json()["detail"] == "a draft execution is in progress"
    finally:
        a["_live"].discard(h["id"])
    # a live non-draft execution does not trip the guard
    h2 = store.create_execution(a, "version", 1, "manual", [])
    try:
        assert client.put(f"/draft/{a['id']}",
                          json={"draft": make_version()}).status_code == 200
    finally:
        a["_live"].discard(h2["id"])


# ---------- §4.5 execution full record: workspace + redact list ----------

def test_exec_full_workspace_path_and_redact_list(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Redacted", "mock")
    h = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    h["redacted_secrets"] = ["MY_TOKEN", "OTHER_KEY"]
    store.update_execution(h)

    full = client.get(f"/executions/{h['id']}").json()
    # §4.5: full-record-only absolute path under the execution dir
    assert full["workspace"] == str(store.exec_dir(h["id"]) / "workspace")
    import os
    assert os.path.isabs(full["workspace"])
    # §4.5: redact is a LIST — display surfaces join it themselves
    assert full["redactedSecrets"] == ["MY_TOKEN", "OTHER_KEY"]

    h2 = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    store.update_execution(h2)
    full2 = client.get(f"/executions/{h2['id']}").json()
    assert full2["redactedSecrets"] is None  # nothing redacted → null, never ""


# ---------- §4.7 agent default pointer branches ----------

def test_first_agent_becomes_default_when_pointer_is_none(client):
    from autowright.storage import store

    store.agents = []
    store.default_agent_id = None
    ag = client.post("/agents", json={"harness": "Claude Code", "mode": "default"}).json()
    assert ag["default"] is True
    assert store.default_agent_id == ag["id"]
    # a second agent never steals the pointer
    ag2 = client.post("/agents", json={"harness": "Codex", "mode": "default"}).json()
    assert ag2["default"] is False
    assert store.default_agent_id == ag["id"]


def test_delete_last_agent_clears_pointer_and_automation_agents(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Orphan-to-be", "mock")
    assert a["agent_id"] == "mock" and a["enabled_agents"] == ["mock"]
    assert client.delete("/agents/mock").status_code == 200
    assert store.agents == []
    assert store.default_agent_id is None
    assert a["agent_id"] is None
    assert a["enabled_agents"] == []
    assert client.get("/agents").json() == []


# ---------- §8/§19 chat runs/pkg_state server-side assembly ----------

def test_chat_assembles_recent_runs_and_run_id_forces_detail(client, monkeypatch):
    """§8/§19: the backend assembles RECENT RUNS for a chat job; only the newest
    run carries full detail (log tails) — `runId` forces an older run's full
    detail in. Checked at the fake-CLI prompt via the app log."""
    from autowright import paths
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    old_steps = [{"file": "01-boom.py", "name": "Boom", "description": "",
                  "code": "from autowright import log\nlog('OLD-TAIL-MARK')\n"
                          "raise KeyError('old boom')\n"}]
    a = store.create_automation(make_version(steps=old_steps), "Chat runs", "mock")
    old_eid = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    assert _until_finished(events, old_eid)["execution"]["status"] == "failed"

    new_steps = [{"file": "01-boom.py", "name": "Boom", "description": "",
                  "code": "from autowright import log\nlog('NEW-TAIL-MARK')\n"
                          "raise KeyError('new boom')\n"}]
    assert client.post(f"/automations/{a['id']}/versions",
                       json={"draft": {**make_version(), "steps": new_steps}}).status_code == 200
    events.clear()
    new_eid = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    assert _until_finished(events, new_eid)["execution"]["status"] == "failed"

    # without runId: the newest run alone carries its log tail
    r = client.post("/drafts", json={"mode": "chat", "automationId": a["id"], "agentId": "mock",
                                     "text": "Why did the last run fail?"})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "=== RECENT RUNS" in logged
    assert "v2 run · failed" in logged and "v1 run · failed" in logged
    assert "NEW-TAIL-MARK" in logged
    assert "OLD-TAIL-MARK" not in logged   # older run stays summary-only

    # runId (the §11 Fix-with-AI entry) forces the old run in, in full detail
    r = client.post("/drafts", json={"mode": "chat", "automationId": a["id"], "agentId": "mock",
                                     "text": "Why did that older run fail?",
                                     "runId": old_eid})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "OLD-TAIL-MARK" in logged


# ---------- §19 request models: shapes, cross-field checks, strict types ----------

def test_patch_rejects_malformed_bodies(client):
    """§19: the pydantic request model answers 422 on shape mismatches, and the
    handler's cross-field checks cover what needs store state."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Strict body", "mock")
    url = f"/automations/{a['id']}"
    for bad in ({"paramValues": "greeting=yo"},        # non-dict paramValues
                {"paramValues": ["greeting"]},
                {"stepAgents": "mock"},                # string, not a list
                {"stepAgents": [1, 2]},                # non-string entries
                {"allowedSecrets": "X_TOKEN"},
                {"name": 42},                          # name must be a string
                {"triggers": "cron"},                  # not a list of objects
                {"triggers": [123]},
                {"snapshotSettings": {"preClear": "no"}}):
        assert client.patch(url, json=bad).status_code == 422, bad
    # cross-field: paramValues names + kinds against the param definitions
    assert client.patch(url, json={"paramValues": {"ghost": "x"}}).status_code == 422
    assert client.patch(url, json={"paramValues": {"count": "three"}}).status_code == 422
    assert client.patch(url, json={"paramValues": {"count": True}}).status_code == 422
    # cross-field: agent references must name configured agents
    assert client.patch(url, json={"agentId": "ghost"}).status_code == 422
    assert client.patch(url, json={"stepAgents": ["ghost"]}).status_code == 422
    # nothing stored by any of it
    assert store.autos[a["id"]]["param_values"] == {}
    assert store.autos[a["id"]]["enabled_agents"] == ["mock"]
    # the valid shapes still land
    r = client.patch(url, json={"paramValues": {"count": 5}, "stepAgents": ["mock"]})
    assert r.status_code == 200
    assert store.autos[a["id"]]["param_values"] == {"count": 5}


def test_create_rejects_unknown_agent_refs(client):
    d = {"steps": [{"name": "S", "file": "01-s.py", "code": "x = 1\n"}]}
    assert client.post("/automations", json={"draft": d, "agentId": "ghost"}).status_code == 422
    assert client.post("/automations",
                       json={"draft": d, "stepAgents": ["ghost"]}).status_code == 422
    assert client.post("/automations", json={"draft": d, "name": 42}).status_code == 422


def test_settings_patch_strict_types(client):
    """§19: settings booleans must be booleans, days a real int — bool-as-int,
    floats, and numeric strings are 422s, never coerced."""
    for bad in ({"days": True}, {"days": 2.5}, {"days": "14"}, {"days": None},
                {"login": "yes"}, {"login": 1}, {"menuBarIcon": 0},
                {"keepAwake": "true"}, {"keepForever": "no"}, {"developerMode": 1},
                {"automaticUpdateCheck": 1},
                {"notifications": "sometimes"}, {"notifications": True}):
        assert client.patch("/settings", json=bad).status_code == 422, bad
    from autowright.storage import store

    assert client.patch("/settings", json={"days": 14}).status_code == 200
    assert store.settings["days"] == 14
    assert client.patch("/settings", json={"days": 0}).status_code == 200
    assert store.settings["days"] == 1  # §4.9 floor
    assert client.patch("/settings", json={"login": True}).status_code == 200
    # §4.9 automaticUpdateCheck: on by default, stored for §20 CLI parity
    assert client.get("/settings").json()["automaticUpdateCheck"] is True
    assert client.patch("/settings", json={"automaticUpdateCheck": False}).status_code == 200
    assert store.settings["automaticUpdateCheck"] is False


def test_restore_and_skip_step_strict_ints(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Strict ints", "mock")
    assert client.post(f"/automations/{a['id']}/restore", json={"version": "1"}).status_code == 422
    assert client.post(f"/automations/{a['id']}/restore", json={"version": True}).status_code == 422
    assert client.post(f"/automations/{a['id']}/restore", json={"version": 9}).status_code == 404
    h = store.create_execution(a, "version", 1, "manual", [], status="failed")
    store.update_execution(h)
    a["_live"].discard(h["id"])
    assert client.post(f"/executions/{h['id']}/skip-step", json={"index": "0"}).status_code == 422
    assert client.post(f"/executions/{h['id']}/skip-step", json={}).status_code == 422


def test_packages_body_shape_422(client):
    for bad in ({"packages": "pandas"},
                {"packages": [{"pip": "pandas"}]},           # import missing
                {"packages": [{"import": "pandas"}]},        # pip missing
                {"packages": [{"pip": 1, "import": "x"}]}):
        assert client.post("/packages/check", json=bad).status_code == 422, bad
    assert client.post("/packages/check", json={}).json() == {"packages": []}


def test_drafts_stale_automation_id_404(client):
    """§19: an unresolvable automationId on /drafts is a 404 — never a silent
    fall-back to the create-mode grant defaults."""
    r = client.post("/drafts", json={"mode": "chat", "automationId": "nope",
                                     "agentId": "mock", "text": "why did it fail?"})
    assert r.status_code == 404
    assert r.json()["detail"] == "automation not found"


def test_memory_clear_409_while_live(client):
    """§19: clear shares the snapshot/restore live-guard — a mid-execution
    clear could delete files a step is reading."""
    from autowright.storage import store

    auto = client.post("/automations", json={"draft": _echo_draft()}).json()
    a = store.autos[auto["id"]]
    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("v: 1\n")
    a["_live"] = {"fake-exec-id"}
    try:
        assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 409
        assert (store.auto_dir(a) / "memory" / "seen.yaml").exists()  # untouched
    finally:
        a["_live"] = set()
    assert client.post(f"/automations/{auto['id']}/memory/clear").status_code == 200
    assert not (store.auto_dir(a) / "memory" / "seen.yaml").exists()


# ---------- §19 POST /triggers/preview ----------

def test_triggers_preview_happy_and_invalid_entries(client):
    from autowright.storage import store

    n_autos = len(store.autos)
    r = client.post("/triggers/preview", json={"triggers": [
        {"kind": "cron", "expression": "0 9 * * *"},
        {"kind": "app_start"},
        {"kind": "cron", "expression": "not cron"},
        {"kind": "time", "at": "2999-01-01T00:00"},
        {"kind": "discord", "channel": "123", "secret": "BOT_TOKEN", "pattern": "go"},
        {"kind": "pubsub"},
    ]})
    assert r.status_code == 200
    ts = r.json()["triggers"]
    assert len(ts) == 6  # one result per entry, in order

    cron = ts[0]
    assert cron["valid"] is True and "error" not in cron
    assert (cron["label"], cron["short"]) == ("Daily at 9:00", "Daily 9:00")
    assert isinstance(cron["nextAt"], int) and cron["nextAt"] > 0
    assert cron["nextLabel"]

    start = ts[1]
    assert start["valid"] is True
    assert (start["label"], start["short"]) == ("On app start", "App start")
    assert start["nextAt"] is None and "nextLabel" not in start  # no computable next

    bad = ts[2]
    assert bad["valid"] is False
    assert "cron" in bad["error"]
    assert bad["nextAt"] is None

    once = ts[3]
    assert once["valid"] is True
    assert once["label"].startswith("Once at Jan 1")
    assert once["nextLabel"] == "Jan 1, 12:00 AM"

    disc = ts[4]
    assert disc["valid"] is True and disc["short"] == "Discord"
    assert disc["nextAt"] is None  # message triggers have no computable next

    reserved = ts[5]
    assert reserved["valid"] is False and "coming soon" in reserved["error"]

    # pure function: nothing was stored
    assert len(store.autos) == n_autos


def test_triggers_preview_shape_and_list_rules(client):
    # only a body that isn't a list of trigger dicts is a 422
    assert client.post("/triggers/preview", json={}).status_code == 422
    assert client.post("/triggers/preview", json={"triggers": "cron"}).status_code == 422
    assert client.post("/triggers/preview", json={"triggers": [123]}).status_code == 422
    assert client.post("/triggers/preview", json={"triggers": []}).json() == {"triggers": []}

    # an elapsed one-shot with an id revalidates leniently (it would store) but
    # has no next occurrence; a NEW past one-shot is invalid — same as the PATCH
    r = client.post("/triggers/preview", json={"triggers": [
        {"id": "t1", "kind": "time", "at": "2020-01-01T00:00"},
        {"kind": "time", "at": "2020-01-01T00:00"},
        {"kind": "app_start"}, {"kind": "app_start"},
    ]}).json()["triggers"]
    assert r[0]["valid"] is True and r[0]["nextAt"] is None and "nextLabel" not in r[0]
    assert r[1]["valid"] is False and "future" in r[1]["error"]
    # §4.3: at most one app_start per list — the second reports per-entry
    assert r[2]["valid"] is True
    assert r[3]["valid"] is False and "app-start" in r[3]["error"]


# ---------- §19 server-side step validation on create / save-version ----------

def test_create_rejects_invalid_step_drafts(client):
    from autowright.storage import store

    n = len(store.autos)
    good = {"file": "01-ok.py", "name": "Ok", "description": "", "code": "x = 1\n"}
    for bad_draft, why in (
        ({"steps": [{**good, "code": "def broken(:\n"}]}, "syntax error"),
        ({"steps": [{**good, "code": "import numpy\n"}]}, "import numpy isn't allowed"),
        ({"steps": [{**good, "file": "notes.txt"}]}, "NN-name.py"),
        ({"steps": [{**good, "file": "02-ok.py"}]}, "out of order"),
        ({"steps": [good, {**good}]}, "1:1"),  # duplicate file names collapse
        ({"steps": [{**good, "timeout": -5}]}, "timeout"),
        ({"steps": [{**good, "retries": 99}]}, "retries"),
        ({"steps": [{**good, "timeout": 5, "noTimeout": True}]}, "combined"),
        ({"steps": [good],
          "params": [{"name": "p", "kind": "shape", "default": "x"}]}, "unknown kind"),
        ({"steps": [good],
          "packages": [{"pip": "left-pad==1", "import": "left_pad", "why": "w"}]}, "bare distribution"),
    ):
        r = client.post("/automations", json={"draft": bad_draft})
        assert r.status_code == 422, (why, r.json())
        assert why in r.json()["detail"], r.json()["detail"]
    assert len(store.autos) == n  # nothing landed

    # a valid draft still creates
    assert client.post("/automations", json={"draft": {"steps": [good]}}).status_code == 200


def test_save_version_rejects_invalid_step_drafts(client):
    from autowright.storage import store

    a = store.create_automation(make_version(), "Validated saves", "mock")
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(), "steps": [{"file": "01-bad.py", "name": "Bad",
                                     "description": "", "code": "import numpy\n"}],
    }})
    assert r.status_code == 422
    assert "numpy" in r.json()["detail"]
    assert store.autos[a["id"]]["current_version"] == 1  # no version minted
    # per-step secret entries must name real stored secrets (the §8 validators)
    r = client.post(f"/automations/{a['id']}/versions", json={"draft": {
        **make_version(),
        "steps": [{"file": "01-s.py", "name": "S", "description": "", "code": "x = 1\n",
                   "secrets": [{"name": "NOT_A_SECRET", "why": "w"}]}],
    }})
    assert r.status_code == 422
    assert "NOT_A_SECRET" in r.json()["detail"]


def test_chat_assembles_pkg_state_section(client):
    # §8/§19: declared packages in the in-editor draft reach the prompt as the
    # PACKAGES section with their real install state — the editor sends none of it.
    from autowright import paths

    cur = {**make_version(), "packages": [{"pip": "left-pad-nope", "import": "left_pad_nope"}]}
    r = client.post("/drafts", json={"mode": "chat", "agentId": "mock",
                                     "text": "What packages does this need?",
                                     "current": cur})
    j = _wait_job(client, r.json()["jobId"])
    assert j["status"] == "done", j
    logged = paths.app_log().read_text(encoding="utf-8")
    assert "=== PACKAGES" in logged
    assert "left-pad-nope" in logged
    assert "status: missing" in logged


# ---------- §19 retry / skip-step endpoints ----------

def test_retry_endpoint_reruns_and_answers_conflicts(client, monkeypatch):
    """§19 POST /executions/{id}/retry: a failed record re-executes in place
    and answers its own id; an unresolvable version is the 409, not a 500."""
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-flag.py", "name": "Needs flag", "description": "",
         "code": 'import os\nassert os.path.exists("flag"), "flaky"\n'},
    ]
    a = store.create_automation(ver, "API Retry", "mock")
    eid = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    assert _until_finished(events, eid)["execution"]["status"] == "failed"

    # §7: retry re-enters the same record — make the step pass this time
    (store.exec_dir(eid) / "workspace" / "flag").write_text("ok")
    events.clear()
    r = client.post(f"/executions/{eid}/retry")
    assert r.status_code == 200 and r.json()["executionId"] == eid
    assert _until_finished(events, eid)["execution"]["status"] == "succeeded"

    # a failed record whose version is gone → 409 with the engine's words
    h2 = store.create_execution(a, "version", 99, "manual", [], status="failed")
    store.update_execution(h2)
    a["_live"].discard(h2["id"])
    r2 = client.post(f"/executions/{h2['id']}/retry")
    assert r2.status_code == 409
    assert "not found" in r2.json()["detail"]

    assert client.post("/executions/nope/retry").status_code == 404


def test_skip_step_endpoint_live_and_conflicts(client, monkeypatch):
    """§19 POST /executions/{id}/skip-step: skips the live step and the
    execution continues; a finished record is the 409, an unknown id the 404."""
    from autowright.storage import store

    events = _capture_events(monkeypatch)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-sleep.py", "name": "Sleep", "description": "",
         "code": "import time\ntime.sleep(30)\n"},
        {"file": "02-after.py", "name": "After", "description": "",
         "code": 'from autowright import log\nlog("after ran")\n'},
    ]
    a = store.create_automation(ver, "API Skip", "mock")
    eid = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    t0 = time.time()
    while store.execs[eid]["steps"][0]["status"] != "executing":
        assert time.time() - t0 < 30
        time.sleep(0.05)
    # the wrong index is refused while step 0 is the live one
    assert client.post(f"/executions/{eid}/skip-step", json={"index": 1}).status_code == 409
    r = client.post(f"/executions/{eid}/skip-step", json={"index": 0})
    assert r.status_code == 200 and r.json() == {"ok": True}
    fin = _until_finished(events, eid)["execution"]
    assert time.time() - t0 < 25, "the skip must kill the 30 s sleep"
    assert fin["status"] == "succeeded"
    full = store.exec_full(eid)
    assert [s["status"] for s in full["steps"]] == ["skipped", "succeeded"]

    # terminal record: nothing is executing → 409; unknown id → 404
    assert client.post(f"/executions/{eid}/skip-step", json={"index": 0}).status_code == 409
    assert client.post("/executions/nope/skip-step", json={"index": 0}).status_code == 404


# ---------- §19 data-path switch (success) ----------

def test_data_path_switch_moves_the_executions_root(client, tmp_path):
    """§19 POST /settings/data-path: with nothing live or queued the store
    closes the old DB, persists the new path (normalized to …/executions),
    and reloads — old records stay behind, the automation survives."""
    from autowright.storage import store

    a = store.create_automation(make_version(), "Mover", "mock")
    h = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    store.update_execution(h)
    a["_live"].discard(h["id"])

    new_root = tmp_path / "elsewhere"
    r = client.post("/settings/data-path", json={"path": str(new_root)})
    assert r.status_code == 200
    assert r.json()["dataPath"] == str(new_root / "executions")
    assert store.settings["dataPath"] == str(new_root / "executions")
    assert (new_root / "executions").is_dir()
    # reloaded from the (empty) new location: records gone, automations kept
    assert h["id"] not in store.execs
    assert a["id"] in store.autos
    # …and a path already ending in /executions is not nested again
    r2 = client.post("/settings/data-path", json={"path": str(new_root / "executions")})
    assert r2.status_code == 200
    assert r2.json()["dataPath"] == str(new_root / "executions")


# ---------- §19 websocket streaming + app lifespan ----------

def test_ws_streams_events_and_lifespan_repairs(client):
    """§3/§19: startup binds the hub loop and repairs stale records; an
    authenticated /ws socket receives published events; shutdown runs the
    kill-all hook. The nested TestClient context drives the real lifespan."""
    from fastapi.testclient import TestClient

    from autowright import api
    from autowright.storage import store

    a = store.create_automation(make_version(), "WS", "mock")
    stale = store.create_execution(a, "version", 1, "manual",
                                   [{"name": "Say hello", "file": "01-say.py",
                                     "status": "executing", "attempts": []}])
    assert stale["status"] == "executing"
    try:
        with TestClient(api.app) as c:  # runs the real startup/shutdown events
            # §3: startup repair marked the crashed record interrupted
            assert store.exec_full(stale["id"])["status"] == "interrupted"
            with c.websocket_connect(f"/ws?token={api.AUTH_TOKEN}") as sock:
                api.hub.publish("test.ping", n=1)  # thread-safe publish path
                msg = sock.receive_json()
                assert msg == {"event": "test.ping", "n": 1}
    finally:
        # the loop died with the context — unbind so later tests' publishes
        # fall back to the no-op path instead of hitting a closed loop
        api.hub._loop = None
