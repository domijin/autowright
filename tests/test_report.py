"""§9.5 / §19 bug-report drafting — report.py + the /report/draft endpoints."""

import threading
import time

import pytest

from autowright import harness, paths, report
from autowright.report import ReportDraftJobs, build_prompt, log_tails, parse_reply

REPLY = """===TITLE===
Executions page freezes after cancel
===BODY===
### What happened
The page froze.

### Environment
Autowright v0.3.0
"""


def _wait(jobs, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        j = jobs.get(job_id)
        if j["status"] != "running":
            return j
        time.sleep(0.02)
    raise AssertionError("job never settled")


# ---------- parse_reply ----------

def test_parse_reply_markers():
    d = parse_reply(REPLY)
    assert d["title"] == "Executions page freezes after cancel"
    assert d["body"].startswith("### What happened")
    assert "Autowright v0.3.0" in d["body"]


def test_parse_reply_fallback_no_markers():
    # §19: a reply missing the markers degrades, never fails — whole reply is
    # the body, its first line the title.
    d = parse_reply("Broken toggle\nIt stays on.\n")
    assert d["title"] == "Broken toggle"
    assert d["body"] == "Broken toggle\nIt stays on."


def test_parse_reply_clamps():
    d = parse_reply("===TITLE===\n" + "t" * 500 + "\n===BODY===\n" + "b" * 10_000)
    assert len(d["title"]) == 200
    assert len(d["body"]) == report.BODY_CAP


# ---------- prompt + log tails ----------

def test_build_prompt_sections_and_placeholders():
    p = build_prompt("feature", "add dark mode", "Autowright v0.3.0", "")
    assert "feature request" in p
    assert "add dark mode" in p
    assert "Autowright v0.3.0" in p
    assert "(none)" in p  # empty logs
    p2 = build_prompt("bug", None, None, "log line")
    assert "bug report" in p2
    assert "log line" in p2


def test_log_tails_reads_and_trims(home):
    logs = paths.logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    (logs / "app.log").write_text("hello app\n")
    # backend.err.log longer than the tail cap — partial first line trimmed
    lines = "\n".join(f"line{i}" for i in range(5000))
    (logs / "backend.err.log").write_text(lines)
    out = log_tails()
    assert "----- app.log -----" in out and "hello app" in out
    assert "----- backend.err.log -----" in out
    assert "line4999" in out
    tail = out.split("----- backend.err.log -----\n", 1)[1]
    assert tail.startswith("line")  # no partial first line


def test_log_tails_missing_files_ok(home):
    assert log_tails() == ""


# ---------- job lifecycle ----------

AGENT = {"id": "mock", "harness": "Claude Code", "mode": "default", "model": None}


def test_job_done(monkeypatch, home):
    seen = {}

    def fake_invoke(agent, prompt, **kw):
        seen["prompt"] = prompt
        return REPLY

    monkeypatch.setattr(harness, "invoke", fake_invoke)
    jobs = ReportDraftJobs()
    j = _wait(jobs, jobs.start(AGENT, "bug", "it broke", "v0.3.0 info"))
    assert j["status"] == "done"
    assert j["draft"]["title"] == "Executions page freezes after cancel"
    assert "it broke" in seen["prompt"] and "v0.3.0 info" in seen["prompt"]
    # private keys never serialize out of get()
    assert not any(k.startswith("_") for k in j)


def test_job_failed(monkeypatch, home):
    def fake_invoke(agent, prompt, **kw):
        raise harness.HarnessError("agent exploded")

    monkeypatch.setattr(harness, "invoke", fake_invoke)
    jobs = ReportDraftJobs()
    j = _wait(jobs, jobs.start(AGENT, "bug", None, None))
    assert j["status"] == "failed"
    assert "agent exploded" in j["error"]


def test_job_cancel_mid_call(monkeypatch, home):
    in_call = threading.Event()
    release = threading.Event()

    def fake_invoke(agent, prompt, **kw):
        in_call.set()
        assert release.wait(5)
        return REPLY

    monkeypatch.setattr(harness, "invoke", fake_invoke)
    jobs = ReportDraftJobs()
    job_id = jobs.start(AGENT, "bug", None, None)
    assert in_call.wait(5)
    assert jobs.cancel(job_id) is True
    release.set()
    j = _wait(jobs, job_id)
    # the post-return cancel check wins — the reply is never used
    assert j["status"] == "cancelled"
    assert j["draft"] is None


def test_cancel_terminal_noop_and_unknown():
    jobs = ReportDraftJobs()
    jobs.jobs["d"] = {"id": "d", "status": "done", "_cancel": False, "_proc": {}}
    assert jobs.cancel("d") is False
    assert jobs.jobs["d"]["status"] == "done"
    assert jobs.cancel("nope") is False


# ---------- endpoints ----------

def test_endpoint_lifecycle(client, monkeypatch):
    monkeypatch.setattr(harness, "invoke", lambda agent, prompt, **kw: REPLY)
    r = client.post("/report/draft", json={"kind": "bug", "text": "it broke",
                                           "info": "v0.3.0"})
    assert r.status_code == 200
    job_id = r.json()["jobId"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        j = client.get(f"/report/draft/{job_id}").json()
        if j["status"] != "running":
            break
        time.sleep(0.02)
    assert j["status"] == "done"
    assert j["draft"]["body"].startswith("### What happened")
    assert client.delete(f"/report/draft/{job_id}").json() == {"ok": False}


def test_endpoint_404s(client):
    from autowright.storage import store

    assert client.get("/report/draft/unknown").status_code == 404
    assert client.post("/report/draft",
                       json={"kind": "bug", "agentId": "ghost"}).status_code == 404
    store.agents = []
    store.default_agent_id = None
    assert client.post("/report/draft", json={"kind": "bug"}).status_code == 404


def test_endpoint_validates_kind(client):
    assert client.post("/report/draft", json={"kind": "rant"}).status_code == 422
