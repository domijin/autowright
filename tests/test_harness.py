"""Harness adapters (§6/§8): query-only invocation flags + CLI detection."""
import io
import json
import time
from pathlib import Path

import pytest


class _FakeProc:
    """Streamed-read stand-in (§8): invoke() iterates stdout, drains stderr on
    a thread, then wait()s — no communicate()."""
    returncode = 0

    def __init__(self):
        self.stdout = io.StringIO("ok")
        self.stderr = io.StringIO("")

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0

    def kill(self):
        pass


def _captured_invoke(monkeypatch, agent, web=False):
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        return _FakeProc()

    monkeypatch.setattr(harness.subprocess, "Popen", fake_popen)
    out = harness.invoke(agent, "question: hi?", web=web)
    assert out == "ok"
    return captured["cmd"]


def test_claude_invoked_with_no_tools_flags(monkeypatch):
    cmd = _captured_invoke(monkeypatch, {"harness": "Claude Code"})
    assert cmd[0] == "/usr/local/bin/claude" and "-p" in cmd
    i = cmd.index("--tools")
    assert cmd[i + 1] == ""  # all built-in tools disabled
    assert "--strict-mcp-config" in cmd
    assert "--no-session-persistence" in cmd
    # §8 live progress: partial text streams as stream-json deltas
    j = cmd.index("--output-format")
    assert cmd[j + 1] == "stream-json"
    assert "--include-partial-messages" in cmd
    assert "--verbose" in cmd  # stream-json in print mode requires it
    assert cmd[-1] == "question: hi?"


def test_fake_cli_streams_chunks_and_result():
    # §8 live progress: the fake CLI answers stream-json — on_chunk sees each
    # text delta and the returned text comes from the terminal result event.
    from autowright import harness

    chunks = []
    out = harness.invoke({"harness": "Claude Code"}, "question: hi?",
                         on_chunk=chunks.append)
    assert out == "Mock answer: nothing new."
    assert chunks and "".join(chunks) == out


def test_opencode_local_model_invoked_with_ollama_model_flag(monkeypatch):
    # §4.7: a local-model agent rides in as `--model ollama/<model>` after the
    # §19 opencode.json provider sync.
    from autowright import harness

    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    cmd = _captured_invoke(monkeypatch, {"harness": "OpenCode", "mode": "ollama",
                                         "model": "qwen3:8b"})
    assert cmd[:2] == ["/usr/local/bin/opencode", "run"]
    i = cmd.index("--model")
    assert cmd[i + 1] == "ollama/qwen3:8b"
    assert cmd[-1] == "question: hi?"
    assert synced == ["qwen3:8b"]

    cmd = _captured_invoke(monkeypatch, {"harness": "OpenCode"})
    assert "--model" not in cmd  # default mode: no model is ever passed
    assert synced == ["qwen3:8b"]  # and no sync either


def _captured_invoke_full(monkeypatch, agent, web=False):
    """Like _captured_invoke but also captures the spawn kwargs (env)."""
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    captured = {}

    def fake_popen(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw.get("env")
        return _FakeProc()

    monkeypatch.setattr(harness.subprocess, "Popen", fake_popen)
    out = harness.invoke(agent, "question: hi?", web=web)
    assert out == "ok"
    return captured


def test_claude_local_model_invoked_via_ollama_env(monkeypatch):
    # §6: a Claude Code local-model agent rides the CLI's custom-endpoint env
    # vars against Ollama's Anthropic-compatible API — bare `--model` (no
    # ollama/ prefix), bearer auth, and never an inherited ANTHROPIC_API_KEY
    # (Ollama doesn't reliably accept x-api-key).
    from autowright import harness

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-real-key")
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    cap = _captured_invoke_full(monkeypatch, {"harness": "Claude Code",
                                              "mode": "ollama", "model": "qwen3:8b"})
    cmd, env = cap["cmd"], cap["env"]
    i = cmd.index("--model")
    assert cmd[i + 1] == "qwen3:8b"
    assert env["ANTHROPIC_BASE_URL"] == harness.OLLAMA_URL
    assert env["ANTHROPIC_AUTH_TOKEN"] == "ollama"
    assert "ANTHROPIC_API_KEY" not in env
    assert synced == []  # opencode.json sync is OpenCode-only

    # default mode never overrides the endpoint
    cap = _captured_invoke_full(monkeypatch, {"harness": "Claude Code"})
    assert "ANTHROPIC_BASE_URL" not in cap["env"]
    assert cap["env"]["ANTHROPIC_API_KEY"] == "sk-real-key"


def test_codex_local_model_invoked_with_oss_flags(monkeypatch):
    # §6: a Codex local-model agent rides the official top-level flags
    # `--oss --local-provider ollama` before the exec subcommand (exec itself
    # rejects them), with the model as a plain `--model` after it.
    from autowright import harness

    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex", "mode": "ollama",
                                         "model": "qwen3:8b"})
    ex = cmd.index("exec")
    assert cmd.index("--oss") < ex
    lp = cmd.index("--local-provider")
    assert lp < ex and cmd[lp + 1] == "ollama"
    i = cmd.index("--model")
    assert i > ex and cmd[i + 1] == "qwen3:8b"
    assert "--sandbox" in cmd and "--skip-git-repo-check" in cmd
    assert synced == []

    # web=True composes: both top-level flags before exec
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex", "mode": "ollama",
                                         "model": "qwen3:8b"}, web=True)
    ex = cmd.index("exec")
    assert cmd.index("--search") < ex and cmd.index("--oss") < ex

    # default mode: no local flags
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex"})
    assert "--oss" not in cmd and "--local-provider" not in cmd


def test_custom_model_invoked_with_verbatim_model_flag(monkeypatch):
    # §4.7: a custom-model agent passes the user-typed string verbatim as
    # `--model` on every harness — no ollama/ prefix, no opencode.json sync.
    from autowright import harness

    synced = []
    monkeypatch.setattr(harness, "sync_opencode_ollama", synced.append)
    for name, model in (("Claude Code", "claude-opus-4-8"),
                        ("Gemini CLI", "gemini-2.5-pro"),
                        ("Codex", "gpt-5-codex"),
                        ("OpenCode", "anthropic/claude-opus-4-8")):
        cmd = _captured_invoke(monkeypatch, {"harness": name, "mode": "custom",
                                             "model": model})
        i = cmd.index("--model")
        assert cmd[i + 1] == model
        assert cmd[-1] == "question: hi?"
    assert synced == []


def test_sync_opencode_ollama_merges_config(monkeypatch, tmp_path):
    import json

    from autowright import harness

    cfg = tmp_path / "opencode.json"
    cfg.write_text(json.dumps({"theme": "dark", "provider": {"anthropic": {}}}))
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(cfg))
    harness.sync_opencode_ollama("qwen3:8b")
    out = json.loads(cfg.read_text())
    assert out["theme"] == "dark"                    # untouched keys survive
    assert "anthropic" in out["provider"]
    entry = out["provider"]["ollama"]
    assert entry["npm"] == "@ai-sdk/openai-compatible"
    assert entry["options"]["baseURL"].endswith("/v1")
    assert "qwen3:8b" in entry["models"]
    # idempotent: a second sync writes nothing new
    before = cfg.read_text()
    harness.sync_opencode_ollama("qwen3:8b")
    assert cfg.read_text() == before


def test_codex_invoked_with_read_only_sandbox(monkeypatch):
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex"})
    assert cmd[:2] == ["/usr/local/bin/codex", "exec"]
    i = cmd.index("--sandbox")
    assert cmd[i + 1] == "read-only"
    assert "--skip-git-repo-check" in cmd
    assert cmd[-1] == "question: hi?"


def test_web_enabled_claude_allows_only_web_read_tools(monkeypatch):
    # §6 drafting calls: web=True swaps the empty --tools list for exactly
    # WebFetch,WebSearch — every other lockdown flag stays.
    cmd = _captured_invoke(monkeypatch, {"harness": "Claude Code"}, web=True)
    i = cmd.index("--tools")
    assert cmd[i + 1] == "WebFetch,WebSearch"
    assert "--strict-mcp-config" in cmd
    assert "--no-session-persistence" in cmd
    assert cmd[-1] == "question: hi?"


def test_web_enabled_codex_adds_top_level_search_flag(monkeypatch):
    # §6: --search must precede the subcommand — `codex exec --search` is
    # rejected by the CLI. The read-only sandbox stays.
    cmd = _captured_invoke(monkeypatch, {"harness": "Codex"}, web=True)
    assert cmd[:3] == ["/usr/local/bin/codex", "--search", "exec"]
    i = cmd.index("--sandbox")
    assert cmd[i + 1] == "read-only"
    assert "--skip-git-repo-check" in cmd


def test_web_flag_leaves_gemini_and_opencode_unchanged(monkeypatch):
    # Bare invocations already carry their built-in web tools; web=True must
    # not sprout a stray flag.
    for name in ("Gemini CLI", "OpenCode"):
        assert _captured_invoke(monkeypatch, {"harness": name}, web=True) == \
            _captured_invoke(monkeypatch, {"harness": name})


def test_detect_reports_all_four_with_sign_in_state(monkeypatch):
    from autowright import harness

    present = {"gemini", "opencode"}
    monkeypatch.setattr(harness, "resolve_bin",
                        lambda name: f"/usr/local/bin/{name}" if name in present else None)

    class _R:
        returncode = 0
        stdout = "9.9.9\n"
        stderr = ""

    monkeypatch.setattr(harness.subprocess, "run", lambda *a, **kw: _R())
    monkeypatch.setattr(harness, "signed_in", lambda pid: pid == "gemini")
    by_id = {f["id"]: f for f in harness.detect()}
    # §19: one entry per harness, all four always present — Ollama is not a
    # harness and never appears in detection
    assert set(by_id) == {"claude", "codex", "gemini", "opencode"}
    assert by_id["gemini"]["installed"] and by_id["gemini"]["signedIn"] is True
    assert "9.9.9" in by_id["gemini"]["detail"] and "signed in" in by_id["gemini"]["detail"]
    assert by_id["opencode"]["installed"] and by_id["opencode"]["signedIn"] is False
    assert "not signed in yet" in by_id["opencode"]["detail"]
    assert not by_id["claude"]["installed"] and by_id["claude"]["detail"] == ""


def _isolate_host(monkeypatch, tmp_path):
    """Pin detection/sign-in to the fake CLI alone: the host's real ~/.gemini,
    ~/.local/share/opencode, GEMINI_API_KEY, and CLIs on the fallback bin dirs
    must never leak into the result."""
    from autowright import harness

    fake_home = tmp_path / "home"
    fake_home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(fake_home))  # expanduser reads it per call
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("AUTOWRIGHT_TEST_CLAUDE_SIGNED_OUT", raising=False)
    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", ())
    tests_bin = Path(__file__).resolve().parent / "bin"
    monkeypatch.setenv("PATH", f"{tests_bin}:/usr/bin:/bin")
    return fake_home


def test_detect_finds_fake_claude_from_path(monkeypatch, tmp_path):
    """conftest prepends tests/bin, so the real detection path finds the fake CLI."""
    from autowright import harness

    _isolate_host(monkeypatch, tmp_path)
    found = harness.detect()
    by_id = {f["id"]: f for f in found}
    assert by_id["claude"]["installed"]
    assert "autowright test fake" in by_id["claude"]["detail"]
    # the isolated host has no other CLI installed
    assert not by_id["codex"]["installed"]
    assert not by_id["gemini"]["installed"]
    assert not by_id["opencode"]["installed"]


def test_detect_reports_claude_sign_in_from_auth_status_exit(monkeypatch, tmp_path):
    """§19: `signed_in("claude")` shells out to `claude auth status` and reads
    the exit code — AUTOWRIGHT_TEST_CLAUDE_SIGNED_OUT=1 flips the fake CLI to
    exit 1, and the real detect() path must report signed out."""
    from autowright import harness

    _isolate_host(monkeypatch, tmp_path)
    by_id = {f["id"]: f for f in harness.detect()}
    assert by_id["claude"]["installed"] and by_id["claude"]["signedIn"] is True
    assert "signed in" in by_id["claude"]["detail"]

    monkeypatch.setenv("AUTOWRIGHT_TEST_CLAUDE_SIGNED_OUT", "1")
    assert harness.signed_in("claude") is False
    by_id = {f["id"]: f for f in harness.detect()}
    assert by_id["claude"]["installed"] and by_id["claude"]["signedIn"] is False
    assert "not signed in yet" in by_id["claude"]["detail"]


def test_check_ready_requires_sign_in(monkeypatch):
    """§19: every account-backed harness must be signed in to be ready."""
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)
    for name in ("Claude Code", "Codex", "Gemini CLI", "OpenCode"):
        assert not harness.check_ready(name)
    monkeypatch.setattr(harness, "signed_in", lambda pid: True)
    for name in ("Claude Code", "Codex", "Gemini CLI", "OpenCode"):
        assert harness.check_ready(name)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: None)
    assert not harness.check_ready("Codex")  # not installed → never ready


def test_signin_state_is_cheap_per_provider(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: "/usr/local/bin/x")
    monkeypatch.setattr(harness, "signed_in", lambda pid: pid == "codex")
    assert harness.signin_state("codex") == {"installed": True, "signedIn": True}
    assert harness.signin_state("gemini") == {"installed": True, "signedIn": False}
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": False, "models": []})
    assert harness.signin_state("ollama") == {"installed": False, "signedIn": None}


def test_check_ready_local_model_requires_installed_model(monkeypatch):
    """§4.7: a local-model agent is a local-model harness + Ollama server +
    the model — no sign-in needed."""
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)
    monkeypatch.setattr(harness, "sync_opencode_ollama", lambda model: None)
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b", "llama3.2:latest"],
                                 "version": "0.14.2"})
    # signed out is fine — every local-model harness (§4.7)
    assert harness.check_ready("OpenCode", "qwen3:8b", "ollama")
    assert harness.check_ready("Claude Code", "qwen3:8b", "ollama")
    assert harness.check_ready("Codex", "qwen3:8b", "ollama")
    assert harness.check_ready("OpenCode", "llama3.2", "ollama")  # bare name → :latest
    assert not harness.check_ready("OpenCode", "mistral:7b", "ollama")
    assert not harness.check_ready("Gemini CLI", "qwen3:8b", "ollama")  # never local (§4.7)
    # §4.7 custom mode: model string never validated — sign-in decides, and a
    # signed-out harness is not ready
    assert not harness.check_ready("Claude Code", "made-up-model", "custom")
    monkeypatch.setattr(harness, "signed_in", lambda pid: True)
    assert harness.check_ready("Claude Code", "made-up-model", "custom")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": False, "installed": True, "models": [],
                                 "version": None})
    assert not harness.check_ready("OpenCode", "qwen3:8b", "ollama")

    monkeypatch.setattr(harness, "resolve_bin", lambda name: None)
    assert not harness.check_ready("OpenCode", "qwen3:8b")  # no binary → never ready


def test_check_ready_claude_local_gates_on_ollama_version(monkeypatch):
    # §19: Claude Code talks to Ollama's Anthropic-compatible endpoint, which
    # shipped in 0.14.0 — an older (or unknown-version) Ollama reads
    # needs-setup for Claude Code while the other local harnesses stay ready.
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "signed_in", lambda pid: False)
    monkeypatch.setattr(harness, "sync_opencode_ollama", lambda model: None)
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b"], "version": "0.13.9"})
    assert not harness.check_ready("Claude Code", "qwen3:8b", "ollama")
    assert harness.check_ready("Codex", "qwen3:8b", "ollama")
    assert harness.check_ready("OpenCode", "qwen3:8b", "ollama")

    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b"], "version": None})
    assert not harness.check_ready("Claude Code", "qwen3:8b", "ollama")


def test_version_at_least():
    from autowright import harness

    floor = harness.OLLAMA_MIN_ANTHROPIC
    assert harness.version_at_least("0.14.0", floor)
    assert harness.version_at_least("0.14.2", floor)
    assert harness.version_at_least("1.0.0", floor)
    assert harness.version_at_least("v0.15.0-rc1", floor)
    assert not harness.version_at_least("0.13.9", floor)
    assert not harness.version_at_least(None, floor)
    assert not harness.version_at_least("", floor)
    assert not harness.version_at_least("garbage", floor)


def test_disallowed_imports_matches_drafting_rule():
    from autowright.imports_check import ALLOWED_IMPORTS, disallowed_imports

    code = ("import django\n"
            "import requests\n"
            "from bs4 import BeautifulSoup\n"
            "from dateutil.parser import parse\n"
            "from . import sibling\n"           # relative → ignored
            "import numpy.linalg\n")
    assert disallowed_imports(code) == ["django", "numpy"]
    assert disallowed_imports("x = 1 +\n") == []  # syntax error surfaces at exec
    # rule identical to §8 draft validation — drafting uses the shared module directly
    from autowright import drafting

    assert drafting.disallowed_imports is disallowed_imports
    assert "requests" in ALLOWED_IMPORTS


def test_sync_opencode_ollama_sidesteps_corrupt_config(monkeypatch, tmp_path):
    # §19: corrupt (half-written) opencode.json is preserved as .corrupt and a
    # fresh valid config written — the user's bytes are never silently replaced.
    import json

    from autowright import harness

    cfg = tmp_path / "opencode.json"
    corrupt = '{"theme": "dark", "provider": {'  # truncated mid-write
    cfg.write_text(corrupt)
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(cfg))
    harness.sync_opencode_ollama("qwen3:8b")

    assert (tmp_path / "opencode.json.corrupt").read_text() == corrupt
    out = json.loads(cfg.read_text())  # fresh file parses
    assert "theme" not in out  # started clean, not from the corrupt bytes
    entry = out["provider"]["ollama"]
    assert entry["npm"] == "@ai-sdk/openai-compatible"
    assert "qwen3:8b" in entry["models"]


def test_spawn_env_path_prepend_dedupe_order(monkeypatch):
    # §19 GUI minimal PATH fix. Fallback dirs go in FRONT of the existing PATH
    # (not appended), duplicates collapse to their first occurrence, and the
    # surviving original entries keep their relative order.
    from autowright import harness

    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", ("/fb1", "/b"))
    monkeypatch.setenv("PATH", "/a:/b:/c")
    env = harness.spawn_env()
    assert env["PATH"] == "/fb1:/b:/a:/c"  # /b deduped; /a before /c preserved
    assert env["PATH"].split(":")[-2:] == ["/a", "/c"]


def test_spawn_env_idempotent_and_binpath_dir_first(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", ("/fb1", "/b"))
    monkeypatch.setenv("PATH", "/a:/b:/c")
    once = harness.spawn_env()["PATH"]
    monkeypatch.setenv("PATH", once)
    assert harness.spawn_env()["PATH"] == once  # already-present dirs: no change

    monkeypatch.setenv("PATH", "/a")
    env = harness.spawn_env("/opt/x/claude")
    assert env["PATH"] == "/opt/x:/fb1:/b:/a"  # binary's own dir leads


# ---------- Ollama runtime (§19 /ollama/status, §10 Free local AI card) ----------

def test_ollama_status_ready_when_server_answers(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "_ollama_models", lambda: ["qwen3:8b", "gemma4:e4b"])
    monkeypatch.setattr(harness, "_ollama_version", lambda: "0.14.2")
    monkeypatch.setattr(harness, "ollama_bin", lambda: "/fake/ollama")
    spawned = []
    monkeypatch.setattr(harness.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a) or object())
    st = harness.ollama_status()
    assert st == {"ready": True, "installed": True,
                  "models": ["qwen3:8b", "gemma4:e4b"], "version": "0.14.2"}
    assert spawned == []  # server already up — never a spawn


def test_ollama_status_autostarts_serve_once(monkeypatch):
    # §19: installed but not answering → start `ollama serve` and wait
    # briefly; a still-down probe inside the cooldown never spawns again
    # (but the self-heal comes back after the cooldown — no forever-latch).
    from autowright import harness

    monkeypatch.setattr(harness, "OLLAMA_URL", "http://localhost:11434")
    monkeypatch.setattr(harness, "ollama_bin", lambda: "/fake/ollama")
    monkeypatch.setattr(harness, "_ollama_version", lambda: "0.14.2")
    monkeypatch.setattr(harness.time, "sleep", lambda s: None)
    answers = [None, None, ["qwen3:8b"]]  # down, then up after the spawn
    monkeypatch.setattr(harness, "_ollama_models",
                        lambda: answers.pop(0) if answers else None)
    spawned = []
    monkeypatch.setattr(harness.subprocess, "Popen",
                        lambda cmd, **k: spawned.append(cmd) or object())

    st = harness.ollama_status()
    assert spawned == [["/fake/ollama", "serve"]]
    assert st["ready"] is True and st["models"] == ["qwen3:8b"]

    st2 = harness.ollama_status()  # answers exhausted → server down again
    assert len(spawned) == 1      # cooldown guard held
    assert st2["ready"] is False and st2["installed"] is True

    # past the cooldown the self-heal retries the spawn
    monkeypatch.setattr(harness, "_serve_last_spawn",
                        harness.time.time() - harness._SERVE_COOLDOWN_S - 1)
    harness.ollama_status()
    assert len(spawned) == 2


def test_ollama_status_not_installed(monkeypatch):
    from autowright import harness

    monkeypatch.setattr(harness, "_ollama_models", lambda: None)
    monkeypatch.setattr(harness, "ollama_bin", lambda: None)
    assert harness.ollama_status() == {"ready": False, "installed": False,
                                       "models": [], "version": None}


def test_ollama_status_remote_url_never_autostarts(monkeypatch):
    # §19: the autostart is for the local server only — a remote
    # AUTOWRIGHT_OLLAMA_URL must never spawn a local `ollama serve`.
    from autowright import harness

    monkeypatch.setattr(harness, "OLLAMA_URL", "http://gpu-box:11434")
    monkeypatch.setattr(harness, "_ollama_models", lambda: None)
    monkeypatch.setattr(harness, "ollama_bin", lambda: "/fake/ollama")
    spawned = []
    monkeypatch.setattr(harness.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a) or object())
    st = harness.ollama_status()
    assert spawned == []
    assert st == {"ready": False, "installed": True, "models": [], "version": None}


def test_ollama_model_installed_bare_name_matches_latest():
    from autowright import harness

    assert harness.ollama_model_installed("qwen3:8b", ["qwen3:8b"]) is True
    assert harness.ollama_model_installed("qwen3", ["qwen3:latest"]) is True
    assert harness.ollama_model_installed("qwen3", ["qwen3:8b"]) is False
    assert harness.ollama_model_installed("qwen3:8b", ["qwen3:latest"]) is False
    assert harness.ollama_model_installed("qwen3:8b", []) is False


def test_ollama_models_parses_tags_and_none_on_error(monkeypatch):
    import http.server
    import json as _json
    import threading

    from autowright import harness

    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")

    class Tags(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = _json.dumps({"models": [{"name": "qwen3:8b", "size": 1},
                                           {"name": "gemma4:e4b", "size": 2}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Tags)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        monkeypatch.setattr(harness, "OLLAMA_URL", f"http://127.0.0.1:{srv.server_port}")
        assert harness._ollama_models() == ["qwen3:8b", "gemma4:e4b"]
    finally:
        srv.shutdown()
        srv.server_close()
    # dead port → None, never an exception
    assert harness._ollama_models() is None


def test_ollama_bin_falls_back_to_app_bundle(monkeypatch, tmp_path):
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda b: None)
    fake = tmp_path / "ollama"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(harness, "_OLLAMA_APP_BIN", str(fake))
    assert harness.ollama_bin() == str(fake)
    monkeypatch.setattr(harness, "_OLLAMA_APP_BIN", str(tmp_path / "missing"))
    assert harness.ollama_bin() is None


def test_agent_timeout_env(monkeypatch):
    # §15 AUTOWRIGHT_AGENT_TIMEOUT_S: read per call, default 300, junk ignored.
    from autowright import harness

    monkeypatch.delenv("AUTOWRIGHT_AGENT_TIMEOUT_S", raising=False)
    assert harness.agent_timeout() == 300
    monkeypatch.setenv("AUTOWRIGHT_AGENT_TIMEOUT_S", "600")
    assert harness.agent_timeout() == 600
    monkeypatch.setenv("AUTOWRIGHT_AGENT_TIMEOUT_S", "junk")
    assert harness.agent_timeout() == 300


def test_agent_hard_cap_env(monkeypatch):
    # §15 AUTOWRIGHT_AGENT_HARD_CAP_S: read per call, default 1800, junk ignored.
    from autowright import harness

    monkeypatch.delenv("AUTOWRIGHT_AGENT_HARD_CAP_S", raising=False)
    assert harness.agent_hard_cap() == 1800
    monkeypatch.setenv("AUTOWRIGHT_AGENT_HARD_CAP_S", "60")
    assert harness.agent_hard_cap() == 60
    monkeypatch.setenv("AUTOWRIGHT_AGENT_HARD_CAP_S", "junk")
    assert harness.agent_hard_cap() == 1800


def test_harness_error_retryable_flag():
    from autowright.harness import HarnessError

    assert HarnessError("x").retryable is False
    assert HarnessError("x", retryable=True).retryable is True


# ---------- invoke() child lifecycle (§8: real Popen, no mocks) ----------

def test_invoke_timeout_kills_group_and_is_retryable(monkeypatch, tmp_path, home):
    # §8: the timeout timer kills the whole session group — invoke returns
    # promptly with a retryable timeout error, never after the child's sleep.
    from autowright import harness

    script = tmp_path / "claude"
    script.write_text("#!/bin/sh\nsleep 60\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
    t0 = time.monotonic()
    with pytest.raises(harness.HarnessError) as ei:
        harness.invoke({"harness": "Claude Code"}, "question: hi?", timeout=1)
    assert time.monotonic() - t0 < 10  # the group kill worked — no 60 s wait
    assert "timed out after 1s" in str(ei.value)
    assert ei.value.retryable is True


def test_invoke_output_resets_idle_window(monkeypatch, tmp_path, home):
    # §8: the timeout is an idle window — a child that streams a line every
    # 0.4 s outlives a 1 s window because each line resets it. The old fixed
    # timer would have killed this run at 1 s.
    from autowright import harness

    script = tmp_path / "claude"
    script.write_text("#!/bin/sh\n"
                      "i=0\n"
                      "while [ $i -lt 5 ]; do echo tick; sleep 0.4; i=$((i+1)); done\n"
                      "echo done\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
    out = harness.invoke({"harness": "Claude Code"}, "question: hi?", timeout=1)
    assert "done" in out


def test_invoke_hard_cap_ends_endless_streamer(monkeypatch, tmp_path, home):
    # §8: the hard cap bounds total wall clock — a child that streams forever
    # never trips the idle window but dies at the cap, with a retryable error.
    from autowright import harness

    script = tmp_path / "claude"
    script.write_text("#!/bin/sh\nwhile true; do echo tick; sleep 0.3; done\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
    monkeypatch.setenv("AUTOWRIGHT_AGENT_HARD_CAP_S", "2")
    t0 = time.monotonic()
    with pytest.raises(harness.HarnessError) as ei:
        harness.invoke({"harness": "Claude Code"}, "question: hi?", timeout=1)
    assert time.monotonic() - t0 < 10
    assert "timed out after 2s total" in str(ei.value)
    assert ei.value.retryable is True


def test_invoke_failure_carries_stderr_tail(monkeypatch, tmp_path, home):
    # §8: a nonzero exit raises with the TAIL of stderr (last 3 lines) —
    # banners die first, the decisive last line always survives.
    from autowright import harness

    script = tmp_path / "claude"
    script.write_text("#!/bin/sh\n"
                      "echo 'banner line one' >&2\n"
                      "echo 'banner line two' >&2\n"
                      "echo 'banner line three' >&2\n"
                      "echo 'ERROR: the decisive line' >&2\n"
                      "exit 2\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
    with pytest.raises(harness.HarnessError) as ei:
        harness.invoke({"harness": "Claude Code"}, "question: hi?")
    msg = str(ei.value)
    assert msg.startswith("Claude Code failed:")
    assert "ERROR: the decisive line" in msg
    assert "banner line two" in msg and "banner line three" in msg
    assert "banner line one" not in msg  # only the last 3 lines ride along
    assert ei.value.retryable is True


def test_invoke_auth_failure_is_not_retryable(monkeypatch, tmp_path, home):
    # §8 failure policy: a nonzero exit whose stderr names an obvious
    # deterministic failure (auth / model-not-found) is NOT retryable —
    # drafting surfaces it immediately instead of retrying a doomed call.
    from autowright import harness

    for stderr_line in ("Invalid API key · Please run /login",
                        "ERROR: 401 Unauthorized",
                        "You are not logged in",
                        "Authentication failed",
                        "ERROR: model not found: gemini-9.9-ultra",
                        "unknown model gpt-99"):
        script = tmp_path / "claude"
        script.write_text(f"#!/bin/sh\necho '{stderr_line}' >&2\nexit 1\n")
        script.chmod(0o755)
        monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
        with pytest.raises(harness.HarnessError) as ei:
            harness.invoke({"harness": "Claude Code"}, "question: hi?")
        assert stderr_line in str(ei.value)
        assert ei.value.retryable is False, stderr_line


def test_deterministic_failure_classification():
    # Case-insensitive substrings; a generic crash stays retryable, and the
    # timeout path never goes through this classifier at all.
    from autowright.harness import _deterministic_failure

    assert _deterministic_failure("Please run /login") is True
    assert _deterministic_failure("401 UNAUTHORIZED") is True
    assert _deterministic_failure("Not Logged In") is True
    assert _deterministic_failure("Model Not Found") is True
    assert _deterministic_failure("Unknown Model") is True
    assert _deterministic_failure("invalid api key") is True
    assert _deterministic_failure("segmentation fault") is False
    assert _deterministic_failure("connection reset by peer") is False
    assert _deterministic_failure("") is False


def test_claude_stream_line_parse_table():
    # §8: one stream-json stdout line → (text_chunk, final_result, tool_uses).
    from autowright.harness import _claude_stream_line as parse

    assert parse("not json") == (None, None, [])
    assert parse("[1, 2]") == (None, None, [])  # valid JSON, not an object
    delta = json.dumps({"type": "stream_event",
                        "event": {"type": "content_block_delta",
                                  "delta": {"type": "text_delta", "text": "hi"}}})
    assert parse(delta) == ("hi", None, [])
    other = json.dumps({"type": "stream_event",
                        "event": {"type": "content_block_delta",
                                  "delta": {"type": "input_json_delta",
                                            "partial_json": "{"}}})
    assert parse(other) == (None, None, [])  # non-text delta is noise
    # an assistant message's tool_use blocks surface as {name, input} (§8
    # activity events); its text blocks stay out — text rides the deltas
    tooluse = json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "checking the page"},
        {"type": "tool_use", "name": "WebFetch", "input": {"url": "https://x"}},
        {"type": "tool_use", "name": "WebSearch", "input": {"query": "q"}}]}})
    assert parse(tooluse) == (None, None, [
        {"name": "WebFetch", "input": {"url": "https://x"}},
        {"name": "WebSearch", "input": {"query": "q"}}])
    assert parse(json.dumps({"type": "assistant", "message": {}})) == (None, None, [])
    # the terminal result event is authoritative…
    assert parse(json.dumps({"type": "result", "result": "full reply"})) == (None, "full reply", [])
    # …but only when its result is a string
    assert parse(json.dumps({"type": "result", "result": {"nested": 1}})) == (None, None, [])


# ---------- §19 per-provider sign-in rules ----------

def test_signed_in_gemini_rules(monkeypatch, tmp_path):
    # §19: oauth_creds.json must PARSE as JSON carrying a refresh token —
    # file existence alone never counts; a stale/empty/garbage file must not
    # fake a working sign-in. GEMINI_API_KEY alone still counts.
    from autowright import harness

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    assert harness.signed_in("gemini") is False  # nothing on disk, no API key

    gdir = tmp_path / ".gemini"
    gdir.mkdir()
    creds = gdir / "oauth_creds.json"
    creds.write_text("{}")
    assert harness.signed_in("gemini") is False   # no refresh token
    creds.write_text("not json {")
    assert harness.signed_in("gemini") is False   # unparseable → signed out
    creds.write_text(json.dumps({"refresh_token": ""}))
    assert harness.signed_in("gemini") is False   # empty token → signed out
    creds.write_text(json.dumps([1, 2]))
    assert harness.signed_in("gemini") is False   # JSON but not a dict
    creds.write_text(json.dumps({"access_token": "a", "refresh_token": "1//r"}))
    assert harness.signed_in("gemini") is True    # a real refresh token

    creds.unlink()
    assert harness.signed_in("gemini") is False
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert harness.signed_in("gemini") is True    # the API key alone suffices


def test_signed_in_opencode_rules(monkeypatch, tmp_path):
    # §19: auth.json must parse as a dict with at least one provider entry
    # holding a non-empty credential (key / token / access / refresh — the
    # shapes the OpenCode CLI writes). A credential-less, empty, unparseable,
    # or non-dict file reads signed out.
    from autowright import harness

    monkeypatch.setenv("HOME", str(tmp_path))

    assert harness.signed_in("opencode") is False  # nothing on disk

    ocdir = tmp_path / ".local" / "share" / "opencode"
    ocdir.mkdir(parents=True)
    auth = ocdir / "auth.json"
    auth.write_text("{}")
    assert harness.signed_in("opencode") is False  # empty dict → no account
    auth.write_text("garbage {")
    assert harness.signed_in("opencode") is False  # unparseable → signed out
    auth.write_text(json.dumps([{"key": "k"}]))
    assert harness.signed_in("opencode") is False  # JSON but not a dict
    auth.write_text(json.dumps({"anthropic": {"type": "oauth"}}))
    assert harness.signed_in("opencode") is False  # entry with no credential
    auth.write_text(json.dumps({"anthropic": {"type": "oauth", "refresh": "",
                                              "access": ""}}))
    assert harness.signed_in("opencode") is False  # empty credentials
    auth.write_text(json.dumps({"anthropic": {"type": "oauth", "refresh": "r",
                                              "access": "a", "expires": 1}}))
    assert harness.signed_in("opencode") is True   # oauth entry with tokens
    auth.write_text(json.dumps({"openai": {"type": "api", "key": "sk-x"}}))
    assert harness.signed_in("opencode") is True   # api-key entry
    auth.write_text(json.dumps({"github-copilot": {"type": "wellknown",
                                                   "key": "k", "token": "t"}}))
    assert harness.signed_in("opencode") is True   # wellknown entry

    assert harness.signed_in("ollama") is None  # no account concept at all


def test_check_ready_opencode_sync_failure_is_needs_setup(monkeypatch):
    # §19: check endpoints answer ready/needs-setup, never raise — an
    # unwritable opencode.json surfaces as not-ready.
    from autowright import harness

    monkeypatch.setattr(harness, "resolve_bin", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(harness, "ollama_status",
                        lambda: {"ready": True, "installed": True,
                                 "models": ["qwen3:8b"]})

    def boom(model):
        raise harness.HarnessError("couldn't update opencode.json: disk full")

    monkeypatch.setattr(harness, "sync_opencode_ollama", boom)
    assert harness.check_ready("OpenCode", "qwen3:8b", "ollama") is False


def test_invoke_non_claude_streams_raw_lines(monkeypatch, tmp_path, home):
    # §8: a non-stream-json harness streams each raw stdout line to on_chunk
    # and returns the raw output verbatim.
    from autowright import harness

    script = tmp_path / "gemini"
    script.write_text("#!/bin/sh\necho 'line one'\necho 'line two'\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))
    chunks = []
    out = harness.invoke({"harness": "Gemini CLI"}, "question: hi?",
                         on_chunk=chunks.append)
    assert out == "line one\nline two\n"
    assert chunks == ["line one\n", "line two\n"]


def test_invoke_on_chunk_error_reaps_the_child(monkeypatch, tmp_path, home):
    # §8: an on_chunk callback that raises must not orphan the CLI child —
    # the group dies and the original error surfaces promptly.
    from autowright import harness

    script = tmp_path / "gemini"
    script.write_text("#!/bin/sh\necho 'first'\nsleep 60\n")
    script.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda name: str(script))

    def bad_chunk(text):
        raise RuntimeError("renderer went away")

    t0 = time.monotonic()
    with pytest.raises(RuntimeError, match="renderer went away"):
        harness.invoke({"harness": "Gemini CLI"}, "question: hi?",
                       on_chunk=bad_chunk)
    assert time.monotonic() - t0 < 10  # the child never got to sleep out 60 s


def test_sync_opencode_ollama_replaces_non_dict_shapes(monkeypatch, tmp_path):
    # §19: a config whose nodes hold the wrong JSON type (valid JSON, so not
    # the .corrupt path) is normalized in place; a missing file starts clean.
    import json

    from autowright import harness

    cfg = tmp_path / "opencode.json"
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(cfg))

    # missing file → clean config written from scratch
    harness.sync_opencode_ollama("qwen3:8b")
    out = json.loads(cfg.read_text())
    assert "qwen3:8b" in out["provider"]["ollama"]["models"]

    # top level not a dict
    cfg.write_text(json.dumps([1, 2, 3]))
    harness.sync_opencode_ollama("qwen3:8b")
    out = json.loads(cfg.read_text())
    assert "qwen3:8b" in out["provider"]["ollama"]["models"]

    # provider / entry / options / models each the wrong type
    cfg.write_text(json.dumps({"provider": "nope"}))
    harness.sync_opencode_ollama("qwen3:8b")
    assert "qwen3:8b" in json.loads(cfg.read_text())["provider"]["ollama"]["models"]

    cfg.write_text(json.dumps({"provider": {"ollama": 5}}))
    harness.sync_opencode_ollama("qwen3:8b")
    assert "qwen3:8b" in json.loads(cfg.read_text())["provider"]["ollama"]["models"]

    cfg.write_text(json.dumps({"provider": {"ollama": {"options": [], "models": "x"}}}))
    harness.sync_opencode_ollama("qwen3:8b")
    entry = json.loads(cfg.read_text())["provider"]["ollama"]
    assert entry["options"]["baseURL"].endswith("/v1")
    assert "qwen3:8b" in entry["models"]


def test_sync_opencode_ollama_write_failure_raises_harness_error(monkeypatch, tmp_path):
    # §19: an unwritable config dir surfaces as a HarnessError (check_ready
    # turns it into needs-setup) — never a bare OSError up the stack.
    from autowright import harness

    ro = tmp_path / "ro"
    ro.mkdir()
    ro.chmod(0o500)
    monkeypatch.setattr(harness, "_OPENCODE_CONFIG", str(ro / "opencode.json"))
    try:
        with pytest.raises(harness.HarnessError, match="couldn't update opencode.json"):
            harness.sync_opencode_ollama("qwen3:8b")
    finally:
        ro.chmod(0o700)


def test_ollama_bin_prefers_path_resolution(monkeypatch, tmp_path):
    from autowright import harness

    fake = tmp_path / "ollama"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(harness, "resolve_bin", lambda b: str(fake))
    assert harness.ollama_bin() == str(fake)  # PATH hit wins; no bundle probe
