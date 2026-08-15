"""Live-backend drafting (§8/§19): the real subprocess runs the chat call
against the fake `claude` CLI on PATH (tests/bin, prepended by the
root conftest and inherited by the child). Covers the §11 grant toggles
end to end: explicit empty grant arrays reach the authoring prompt as the
literal `none`, and the unchecked secret's name never travels.

The secret is a §4.8 value-less placeholder — integration backends use the
real macOS Keychain, and a blank value never writes to it.
"""
import pytest

from .it_harness import wait_for

pytestmark = pytest.mark.integration


def _settled_job(client, job_id):
    j = client.get(f"/drafts/{job_id}").json()
    return j if j["status"] in ("done", "failed", "blocked", "cancelled") else None


def test_draft_create_over_live_backend_honors_unchecked_grants(backend, client):
    ag = client.post("/agents", json={"harness": "Claude Code", "mode": "default",
                                      "name": "Mock writer"}).json()
    assert client.put("/secrets/LIVE_KEY",
                      json={"value": "", "description": "placeholder only"}).status_code == 200

    r = client.post("/drafts", json={"mode": "chat",
                                     "text": "Watch a page for changes",
                                     "agentId": ag["id"],
                                     "enabledAgents": [], "allowedSecrets": []})
    assert r.status_code == 200
    j = wait_for(lambda: _settled_job(client, r.json()["jobId"]), 90,
                 "draft job to settle")
    assert j["status"] == "done", j
    # §8 new-automation rule: the fresh-draft chat call lands the spec plus
    # the name/description/sync actions.
    assert j["draft"]["spec"] and j["draft"]["actions"]["sync"] is True

    # §8: every invocation's prompt is logged to the app log — the grant
    # sections must carry the literal `none`, and the unchecked secret's
    # name must not appear anywhere in the prompt.
    log = (backend.home / "logs" / "app.log").read_text(encoding="utf-8")
    assert "allowed only if nonempty):\nnone" in log
    assert "reference by secrets.NAME):\nnone" in log
    assert "LIVE_KEY" not in log


def test_draft_create_defaults_grant_everything(backend, client):
    # §19: absent grant arrays with no automationId → all agents + all
    # secrets, the same all-on seed the Review page starts from.
    ag = client.post("/agents", json={"harness": "Claude Code", "mode": "default",
                                      "name": "Mock writer"}).json()
    client.put("/secrets/GRANTED_KEY", json={"value": "", "description": "placeholder"})

    r = client.post("/drafts", json={"mode": "chat", "text": "Watch the weather",
                                     "agentId": ag["id"]})
    j = wait_for(lambda: _settled_job(client, r.json()["jobId"]), 90,
                 "draft job to settle")
    assert j["status"] == "done", j
    log = (backend.home / "logs" / "app.log").read_text(encoding="utf-8")
    assert "- name: Mock writer" in log
    assert "- name: GRANTED_KEY" in log
