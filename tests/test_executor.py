"""Step-SDK surface of the executor (§6.1) — pure parts, no real subprocess."""
import io
import json

import pytest


@pytest.fixture()
def ctrl(monkeypatch):
    """Capture @@AD@@ control lines emit() writes to the real stdout."""
    from autowright import executor

    buf = io.StringIO()
    monkeypatch.setattr(executor, "_real_stdout", buf)

    def lines():
        out = []
        for ln in buf.getvalue().splitlines():
            assert ln.startswith(executor.CTRL)
            out.append(json.loads(ln[len(executor.CTRL):]))
        return out

    return lines


# ---------- Secrets ----------

def test_secrets_allowed_and_injected():
    from autowright.executor import Secrets

    s = Secrets({"TOKEN": "abc"}, ["TOKEN", "OTHER"])
    assert s.TOKEN == "abc"


def test_secrets_allowed_but_not_in_keychain():
    from autowright.executor import MissingSecret, Secrets

    s = Secrets({"TOKEN": "abc"}, ["TOKEN", "OTHER"])
    with pytest.raises(MissingSecret, match="OTHER wasn't injected into this step"):
        s.OTHER


def test_secrets_not_allowed():
    from autowright.executor import MissingSecret, Secrets

    s = Secrets({"TOKEN": "abc"}, ["TOKEN"])
    with pytest.raises(MissingSecret, match="NOPE is not allowed for this automation"):
        s.NOPE


def test_secrets_underscore_attrs_raise_attribute_error():
    from autowright.executor import Secrets

    s = Secrets({}, [])
    with pytest.raises(AttributeError):
        s._missing


# ---------- Result ----------

def test_result_status_validation(tmp_path, ctrl):
    from autowright.executor import Result

    r = Result(str(tmp_path / "res"))
    with pytest.raises(ValueError, match="result.status must be"):
        r.status("junk")
    r.status("ok")
    assert ctrl() == [{"op": "result", "field": "status", "value": "ok"}]


def test_result_chip_coerces_to_str(tmp_path, ctrl):
    from autowright.executor import Result

    r = Result(str(tmp_path / "res"))
    r.chip(42)
    assert ctrl() == [{"op": "result", "field": "chip", "value": "42"}]


# ---------- Agent._ask guard rails ----------

def make_ctx(**over):
    ctx = {
        "is_agent_step": True,
        "agents": [{"name": "helper", "harness": "claude"}],
        "secrets": {"TOKEN": "s3cr3t-value"},
        "secret_names_with_values": ["TOKEN"],
        "agent_timeout": 5,
    }
    ctx.update(over)
    return ctx


def make_agent(ctx=None, **over):
    """Build an Agent the way main() does: the automation-wide scan map comes
    off the context, then is handed to Agent explicitly (§6)."""
    from autowright.executor import Agent

    ctx = make_ctx(**over) if ctx is None else ctx
    scan = ctx.pop("scan_secrets", None) or ctx.get("secrets", {})
    return Agent(ctx, scan)


@pytest.fixture()
def invoke_spy(monkeypatch):
    from autowright import executor

    calls = []

    # Strict signature on purpose: §6 runtime agent.ask calls must never pass
    # web= (drafting-only) — if the executor ever did, this spy TypeErrors.
    def fake_invoke(cfg, prompt, timeout=120):
        calls.append((cfg, prompt, timeout))
        return "  the reply  "

    monkeypatch.setattr(executor._harness, "invoke", fake_invoke)
    return calls


def test_ask_happy_path_emits_audit(ctrl, invoke_spy):
    a = make_agent()
    assert a.ask("summarize", data="rows") == "the reply"
    assert len(invoke_spy) == 1
    assert invoke_spy[0][1] == "question: summarize\n\ndata:\nrows"
    audit = [e for e in ctrl() if e["op"] == "agent_audit"]
    # §6: the full prompt/reply are logged for audit
    assert audit == [{"op": "agent_audit",
                      "prompt": "question: summarize\n\ndata:\nrows",
                      "reply": "  the reply  "}]


def test_ask_refuses_secret_value_in_prompt(ctrl, invoke_spy):
    a = make_agent()
    with pytest.raises(RuntimeError, match="contains the value of secret TOKEN"):
        a.ask("please use s3cr3t-value to log in")
    # the secret may hide in the data payload too — same refusal
    with pytest.raises(RuntimeError, match="contains the value of secret TOKEN"):
        a.ask("harmless question", data={"auth": "s3cr3t-value"})
    assert invoke_spy == []


def test_ask_refuses_single_line_of_multiline_secret(ctrl, invoke_spy):
    ctx = make_ctx(secrets={"PEM": "AAA-first\nBBB-second\nCCC-third"},
                   secret_names_with_values=["PEM"])
    a = make_agent(ctx)
    with pytest.raises(RuntimeError, match="contains the value of secret PEM"):
        a.ask("header BBB-second footer")  # one pasted line is enough
    assert invoke_spy == []


def test_ask_caps_prompt_at_200k(ctrl, invoke_spy):
    a = make_agent()
    with pytest.raises(RuntimeError, match="agent prompt too large"):
        a.ask("x" * 200_001)
    assert invoke_spy == []
    assert a.ask("x" * 200_000) == "the reply"  # exactly at the cap still goes


def test_ask_unknown_agent_name_lists_available(ctrl, invoke_spy):
    ctx = make_ctx(agents=[{"name": "helper", "harness": "claude"},
                           {"name": None, "harness": "opencode"}])
    a = make_agent(ctx)
    # §8 grant names: explicit name, or the harness name for unnamed agents
    with pytest.raises(RuntimeError, match=r"'nope' isn't available.*helper, opencode"):
        a.ask("hi", agent="nope")
    assert invoke_spy == []


def test_ask_outside_agent_step_or_without_agents(ctrl, invoke_spy):
    with pytest.raises(RuntimeError, match="only available in steps marked as agent steps"):
        make_agent(is_agent_step=False).ask("hi")
    with pytest.raises(RuntimeError, match="no enabled agent for this step"):
        make_agent(agents=[]).ask("hi")
    assert invoke_spy == []


def test_ask_wraps_invoke_failure_naming_harness(ctrl, monkeypatch):
    """§7: a failing harness invoke surfaces as AgentCallError naming the
    harness, so the engine can classify it as an agent failure."""
    from autowright import executor

    def boom(cfg, prompt, timeout=120):
        raise ValueError("cli went away")

    monkeypatch.setattr(executor._harness, "invoke", boom)
    a = make_agent()
    with pytest.raises(executor.AgentCallError,
                       match=r"agent call failed \(claude\): cli went away"):
        a.ask("hi")


def test_ask_caps_reply_at_200k(ctrl, monkeypatch):
    from autowright import executor

    monkeypatch.setattr(executor._harness, "invoke",
                        lambda cfg, prompt, timeout=120: "y" * 200_001)
    a = make_agent()
    with pytest.raises(RuntimeError, match="agent reply too large"):
        a.ask("hi")
    # exactly at the cap still goes through
    monkeypatch.setattr(executor._harness, "invoke",
                        lambda cfg, prompt, timeout=120: "y" * 200_000)
    assert a.ask("hi") == "y" * 200_000


# ---------- _LineWriter (stdout/stderr shim) ----------

def test_line_writer_splits_lines_and_suppresses_blanks(ctrl):
    from autowright.executor import _LineWriter

    w = _LineWriter("out")
    assert w.write("a\nb\npartial") == len("a\nb\npartial")
    assert [e["text"] for e in ctrl()] == ["a", "b"]  # partial stays buffered
    w.write("-rest\n\n   \n x\n")
    events = ctrl()
    # blank and whitespace-only lines are suppressed; leading spaces survive
    assert [e["text"] for e in events] == ["a", "b", "partial-rest", " x"]
    assert all(e["op"] == "log" and e["kind"] == "out" for e in events)
    assert w.buf == ""


def test_line_writer_overflow_flushes_without_newline(ctrl):
    from autowright.executor import _LineWriter

    w = _LineWriter("out")
    w.write("x" * w.MAX_LINE)  # exactly at the cap: still buffered
    assert ctrl() == []
    w.write("x")  # over the cap: the whole buffer flushes as one line
    events = ctrl()
    assert [e["text"] for e in events] == ["x" * (w.MAX_LINE + 1)]
    assert w.buf == ""


def test_line_writer_flush_emits_partial_line(ctrl):
    from autowright.executor import _LineWriter

    w = _LineWriter("err")
    w.write("tail no newline")
    assert ctrl() == []
    w.flush()
    assert ctrl() == [{"op": "log", "kind": "err", "text": "tail no newline"}]
    w.flush()  # empty buffer: nothing new
    assert len(ctrl()) == 1
    w.write("   ")
    w.flush()  # whitespace-only partial: suppressed, buffer still cleared
    assert len(ctrl()) == 1
    assert w.buf == ""


# ---------- Memory.save cleanup ----------

def test_memory_save_failed_replace_removes_tmp_keeps_old_value(tmp_path, monkeypatch):
    """§6: a failure at the final os.replace (past the YAML dump — the temp
    file exists and holds the new content) removes the temp file and leaves
    the previous value intact."""
    import os

    from autowright.executor import Memory

    m = Memory(str(tmp_path / "memory"))
    m.save("notes", {"a": 1})

    calls = []

    def boom(src, dst):
        calls.append((src, dst))
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError, match="disk full"):
        m.save("notes", {"a": 2})
    assert calls, "the dump must succeed and reach os.replace"
    assert m.load("notes") == {"a": 1}  # previous version intact
    assert [p.name for p in (tmp_path / "memory").iterdir()] == ["notes.yaml"]  # no tmp litter


# ---------- emit framing ----------

def test_emit_control_line_roundtrip(ctrl):
    from autowright import executor

    executor.emit("log", kind="out", text="héllo @@AD@@ world")
    executor.emit("notify", text="done")
    assert executor.CTRL == "@@AD@@"
    assert ctrl() == [
        {"op": "log", "kind": "out", "text": "héllo @@AD@@ world"},
        {"op": "notify", "text": "done"},
    ]


def test_emit_keeps_unicode_unescaped(monkeypatch):
    from autowright import executor

    buf = io.StringIO()
    monkeypatch.setattr(executor, "_real_stdout", buf)
    executor.emit("log", kind="out", text="héllo")
    line = buf.getvalue()
    assert line.startswith(executor.CTRL) and line.endswith("\n")
    assert "héllo" in line  # ensure_ascii=False: no é escaping


# ---------- Execution metadata ----------

def test_execution_metadata_read_only():
    from autowright.executor import Execution

    e = Execution({"automation_id": "a-1", "automation_name": "Job", "id": "e-1",
                   "step_index": 2, "step_name": "Say hello", "trigger": "Manual"})
    assert e.automation_id == "a-1"
    assert e.automation_name == "Job"
    assert e.id == "e-1"
    assert e.step_index == 2
    assert e.step_name == "Say hello"
    assert e.trigger == "Manual"
    with pytest.raises(AttributeError, match="read-only"):
        e.id = "other"
    # absent meta keys read as None rather than raising
    assert Execution({}).trigger is None


# ---------- fetch_page (§6 web policies) — urllib and clock monkeypatched ----------

class _FakeResp:
    def __init__(self, body: bytes):
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def clean_fetch_state(monkeypatch):
    """Isolated robots/spacing caches and a controllable clock, no real sleeps."""
    from autowright import executor

    monkeypatch.setattr(executor, "_robots", {})
    monkeypatch.setattr(executor, "_site_last", {})
    clock = {"t": 1000.0}
    sleeps: list[float] = []

    def fake_sleep(s: float) -> None:
        sleeps.append(s)
        clock["t"] += s

    monkeypatch.setattr(executor.time, "time", lambda: clock["t"])
    monkeypatch.setattr(executor.time, "sleep", fake_sleep)
    return clock, sleeps


def _urlopen_router(monkeypatch, robots, page):
    """Route urlopen: /robots.txt → `robots` (bytes | Exception), else `page`
    (bytes | Exception | list of per-attempt values). Returns the call log."""
    import urllib.request

    from autowright import executor

    calls: list[str] = []
    pages = list(page) if isinstance(page, list) else None

    def fake_urlopen(req, timeout=None):
        url = req.full_url
        calls.append(url)
        assert timeout == 10
        out = robots if url.endswith("/robots.txt") else (pages.pop(0) if pages else page)
        if isinstance(out, Exception):
            raise out
        return _FakeResp(out)

    monkeypatch.setattr(executor.urllib.request, "urlopen", fake_urlopen)
    return calls


def test_fetch_page_robots_403_disallows_all(monkeypatch, clean_fetch_state):
    import urllib.error

    from autowright.executor import fetch_page

    err = urllib.error.HTTPError("u", 403, "forbidden", None, None)
    _urlopen_router(monkeypatch, err, b"body")
    with pytest.raises(RuntimeError, match="robots.txt disallows"):
        fetch_page("https://example.com/a")


def test_fetch_page_robots_404_allows_and_returns_body(monkeypatch, clean_fetch_state):
    import urllib.error

    from autowright.executor import fetch_page

    err = urllib.error.HTTPError("u", 404, "not found", None, None)
    calls = _urlopen_router(monkeypatch, err, "héllo".encode())
    assert fetch_page("https://example.com/a") == "héllo"
    # robots fetched once, then cached for the host
    assert fetch_page("https://example.com/b") == "héllo"
    assert calls.count("https://example.com/robots.txt") == 1


def test_fetch_page_robots_rule_blocks_matching_path(monkeypatch, clean_fetch_state):
    from autowright.executor import fetch_page

    robots = b"User-agent: *\nDisallow: /private/\n"
    _urlopen_router(monkeypatch, robots, b"body")
    assert fetch_page("https://example.com/open") == "body"
    with pytest.raises(RuntimeError, match="robots.txt disallows"):
        fetch_page("https://example.com/private/x")


def test_fetch_page_robots_network_error_allows(monkeypatch, clean_fetch_state):
    from autowright.executor import fetch_page

    _urlopen_router(monkeypatch, OSError("robots black hole"), b"body")
    assert fetch_page("https://example.com/a") == "body"


def test_fetch_page_spaces_same_host_by_two_seconds(monkeypatch, clean_fetch_state):
    from autowright.executor import fetch_page

    clock, sleeps = clean_fetch_state
    _urlopen_router(monkeypatch, b"", b"body")
    fetch_page("https://example.com/a")
    assert sleeps == []  # first hit: no wait
    clock["t"] += 0.5
    fetch_page("https://example.com/b")
    assert len(sleeps) == 1 and sleeps[0] == pytest.approx(1.5)  # tops up to 2s
    clock["t"] += 10
    fetch_page("https://example.com/c")
    assert len(sleeps) == 1  # ≥2s already elapsed: no extra wait


def test_fetch_page_retries_twice_then_raises(monkeypatch, clean_fetch_state):
    from autowright.executor import fetch_page

    _, sleeps = clean_fetch_state
    calls = _urlopen_router(monkeypatch, b"", OSError("conn reset"))
    with pytest.raises(RuntimeError, match="couldn't fetch .*conn reset"):
        fetch_page("https://example.com/a")
    assert calls.count("https://example.com/a") == 3  # first try + two retries
    assert sleeps == [2, 2]  # no sleep after the final failure


def test_fetch_page_second_attempt_succeeds(monkeypatch, clean_fetch_state):
    from autowright.executor import fetch_page

    _urlopen_router(monkeypatch, b"", [OSError("flaky"), b"recovered"])
    assert fetch_page("https://example.com/a") == "recovered"
