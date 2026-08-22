"""Agent harness adapters (§8): send one prompt, receive one text response.

Every adapter is one-shot and non-interactive.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# Top-level import (not lazy): the executor subprocess replaces
# sys.modules["autowright"] with the step SDK shim, which breaks late
# `from . import paths` resolution inside _app_log.
from . import paths, platform, reqlog
from .yamlio import atomic_write_text

log = logging.getLogger("autowright.harness")


def _stamp() -> str:
    return datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m-%d %H:%M:%S %Z")


def _app_log(text: str) -> None:
    # §8/§5: the FULL prompt and raw response are the audit trail — never
    # truncated here (the 200k runtime caps already bound the sizes upstream).
    try:
        with open(paths.app_log(), "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except OSError:
        pass

OLLAMA_URL = os.environ.get("AUTOWRIGHT_OLLAMA_URL", "http://localhost:11434")


class HarnessError(Exception):
    """A harness call failed. `retryable` marks transient failures (timeout,
    nonzero exit that looks transient) the §8 pipeline may retry once;
    environment problems (CLI not installed, unknown harness) and obvious
    deterministic failures (auth / model-not-found stderr — see
    `_deterministic_failure`) are not."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def agent_timeout() -> int:
    """§8/§15: per-invocation agent-call idle window in seconds — the call is
    killed after this long with no stdout output; every streamed line resets
    it. Read per call (like AUTOWRIGHT_STEP_TIMEOUT) so a running backend
    picks up changes."""
    try:
        return int(float(os.environ.get("AUTOWRIGHT_AGENT_TIMEOUT_S") or 300))
    except ValueError:
        return 300


def agent_hard_cap() -> int:
    """§8/§15: per-invocation total wall-clock cap in seconds — ends a call
    that streams forever, which the idle window alone never would. Read per
    call, like `agent_timeout`."""
    try:
        return int(float(os.environ.get("AUTOWRIGHT_AGENT_HARD_CAP_S") or 1800))
    except ValueError:
        return 1800


def kill_group(proc: subprocess.Popen, sig: int | None = None) -> None:
    """Signal a harness child's whole session group (see the §2 platform
    session policy in `_invoke`); falls back to the direct child when the
    group is gone."""
    platform.current().processes.signal_group(proc, sig)


# A backend launched from the Finder/Dock gets a minimal PATH without
# /opt/homebrew/bin or ~/.local/bin, so `shutil.which` alone misses
# normally-installed CLIs (claude installs to ~/.local/bin by default).
# §19: per-OS install locations. On Windows a GUI app inherits the full user
# PATH, so the fallbacks are belt-and-braces there.
_POSIX_FALLBACK_BIN_DIRS = (
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/.opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
)
_WINDOWS_FALLBACK_BIN_DIRS = (
    # Claude Code's native installer uses the same ~/.local/bin layout here.
    os.path.join(os.path.expanduser("~"), ".local", "bin"),
    os.path.join(os.path.expanduser("~"), ".opencode", "bin"),
    # npm's global bin — the Gemini CLI / Codex channel on Windows.
    os.path.join(os.environ.get("APPDATA")
                 or os.path.join(os.path.expanduser("~"), "AppData", "Roaming"), "npm"),
)
_FALLBACK_BIN_DIRS = (
    _WINDOWS_FALLBACK_BIN_DIRS if paths.current_os() == "windows"
    else _POSIX_FALLBACK_BIN_DIRS
)


# §19: `os.access(X_OK)` can't detect executables on Windows — the execute bit
# does not exist there; an extension listed in PATHEXT is what makes a file
# runnable.
_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def _pathext() -> tuple[str, ...]:
    raw = os.environ.get("PATHEXT") or _DEFAULT_PATHEXT
    return tuple(e.lower() for e in raw.split(os.pathsep) if e.strip())


def _is_executable(path: str) -> bool:
    """§19: per-OS executable check — the execute bit on POSIX, existence with
    a PATHEXT extension on Windows."""
    if paths.current_os() != "windows":
        return os.access(path, os.X_OK)
    if not os.path.isfile(path):
        return False
    return os.path.splitext(path)[1].lower() in _pathext()


def _neutral_cwd(provider_id: str) -> str:
    """§6: every provider child runs in its provider's empty workspace dir so
    CLI startup scans never touch TCC-protected folders (no macOS prompts)."""
    d = paths.harness_workspace(provider_id)
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def resolve_bin(binname: str) -> str | None:
    """Absolute path of `binname`, searching PATH then common install dirs."""
    found = shutil.which(binname)
    if found:
        return found
    for d in _FALLBACK_BIN_DIRS:
        if paths.current_os() == "windows":
            # `which` against a single dir honors PATHEXT, so a bare name
            # resolves to `claude.cmd` / `ollama.exe` there (§19).
            hit = shutil.which(binname, path=d)
            if hit:
                return hit
            continue
        path = os.path.join(d, binname)
        if _is_executable(path):
            return path
    return None


def spawn_env(binpath: str | None = None) -> dict:
    """os.environ with the fallback bin dirs (and `binpath`'s own dir)
    prepended to PATH. Every provider child spawns with this (§19):
    `#!/usr/bin/env node` launchers like npm and gemini can't find `node`
    under the GUI minimal PATH otherwise, even when Node is installed."""
    env = dict(os.environ)
    bindir = os.path.dirname(binpath) if binpath else ""
    dirs = ([bindir] if bindir else []) + list(_FALLBACK_BIN_DIRS)
    current = env.get("PATH", "").split(os.pathsep) if env.get("PATH") else []
    env["PATH"] = os.pathsep.join(dict.fromkeys(dirs + current))
    return env


def step_env() -> dict:
    """os.environ with the fallback bin dirs APPENDED to PATH (§6.1). Every
    step subprocess spawns with this, so a step's system-CLI calls and
    `shutil.which` pre-flights resolve normally-installed tools under a Dock
    launch's minimal GUI PATH — appended, unlike `spawn_env`, so the inherited
    PATH order (the user's own resolution) always wins."""
    env = dict(os.environ)
    current = env.get("PATH", "").split(os.pathsep) if env.get("PATH") else []
    env["PATH"] = os.pathsep.join(dict.fromkeys(current + list(_FALLBACK_BIN_DIRS)))
    return env


# §6 installed-tools probe: automation-relevant CLIs. Curated, not exhaustive —
# the §8 SYSTEM TOOLS header tells the agent an unlisted tool may still exist.
_PROBE_TOOLS = ("gh", "git", "brew", "docker", "node", "npm", "ffmpeg",
                "ffprobe", "yt-dlp", "jq", "pandoc", "sqlite3", "osascript",
                "transmission-remote")


def probe_tools() -> list[dict]:
    """§6: which curated CLIs exist on this Mac, as [{name, path}] — resolved
    against the §6.1 step PATH so the answer matches what a step subprocess
    will find at runtime. Presence + path only (pure stat calls, no version
    subprocesses), so it's cheap enough to run at every prompt build."""
    path = step_env().get("PATH", "")
    out = []
    for name in _PROBE_TOOLS:
        found = shutil.which(name, path=path)
        if found:
            out.append({"name": name, "path": found})
    return out


def invoke(agent: dict, prompt: str, timeout: int | None = None,
           proc_holder: dict | None = None, on_chunk=None,
           should_abort=None, web: bool = False, on_tool=None) -> str:
    """Invoke the harness once with `prompt`, return its text reply.

    web=True enables the harness's web-read tools (§6 drafting calls only);
    the default keeps every tool disabled — runtime agent.ask calls must
    never pass it.
    proc_holder, when given, receives {'proc': Popen} so a caller can cancel.
    should_abort, when given, is re-checked right after the spawn lands in
    proc_holder: a cancel racing the spawn (set after the caller's own check,
    before the Popen existed) would otherwise kill nothing and the call would
    run to its full timeout.
    on_chunk, when given, receives each partial-text chunk as the harness
    streams its response (§8 live progress); chunks joined ≙ the reply.
    on_tool, when given, receives each {name, input} tool use the harness
    reports as it streams (§8 activity events; Claude Code only — the other
    CLIs don't report tool use in a parseable form).
    Every request is framed in app.log (§5): BEGIN header + prompt on send,
    response (or error) + END footer when the request ends.
    """
    if timeout is None:
        timeout = agent_timeout()
    harness = agent.get("harness")
    model = agent.get("model") or "configured default"
    log.info("agent request · harness=%s · model=%s · prompt (%d chars):\n%s",
             harness or "?", model, len(prompt), prompt)
    req_id = str(uuid.uuid4())
    _app_log(f">>>>> BEGIN {_stamp()} {req_id} <<<<<\n"
             f"agent request · harness={harness or '?'} · model={model}"
             f" · prompt ({len(prompt)} chars):\n{prompt}")
    # §5 request-log files: one file per agent request, stamped at send time so
    # its name sorts where the request began; written when the request ends.
    ts = reqlog.stamp()
    t0 = time.monotonic()
    try:
        out = _invoke(harness, agent, prompt, timeout, proc_holder, on_chunk,
                      should_abort, web, on_tool)
    except Exception as e:  # noqa: BLE001 — log, close the frame, re-raise
        _app_log(f"request failed: {e}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
        reqlog.write_agent(ts, harness or "?", model, prompt, None, str(e),
                           (time.monotonic() - t0) * 1000)
        raise
    _app_log(f"response ({len(out)} chars):\n{out}\n>>>>> END {_stamp()} {req_id} <<<<<\n")
    reqlog.write_agent(ts, harness or "?", model, prompt, out, None,
                       (time.monotonic() - t0) * 1000)
    return out


# §8 failure policy: a nonzero exit whose stderr names an obvious
# DETERMINISTIC failure — authentication/sign-in trouble or a wrong model
# name — is never retried: a retry can't fix a bad credential or a missing
# model, so drafting surfaces the error immediately instead of costing a
# second multi-minute call. Case-insensitive substrings, matched against the
# stderr tail (the decisive last lines; banners never reach it). Sources:
# Claude Code "Invalid API key · Please run /login", Codex "401 Unauthorized"
# / "You must be logged in", Gemini/OpenCode auth and model-not-found lines.
_DETERMINISTIC_STDERR = (
    "not logged in",
    "login",
    "logged out",
    "unauthorized",
    "401",
    "403",
    "authentication",
    "invalid api key",
    "api key",
    "model not found",
    "model_not_found",
    "unknown model",
    "no such model",
)


def _deterministic_failure(stderr_tail: str) -> bool:
    """True when the stderr tail matches an obvious auth / model-not-found
    pattern — the §8 non-retryable classification."""
    low = stderr_tail.lower()
    return any(pat in low for pat in _DETERMINISTIC_STDERR)


def _claude_stream_line(line: str) -> tuple[str | None, str | None, list[dict]]:
    """One `--output-format stream-json` stdout line → (text_chunk, final_result,
    tool_uses).

    Partial text arrives as stream_event/content_block_delta/text_delta chunks
    (`--include-partial-messages`); the terminal `result` event carries the
    complete reply; an `assistant` message's tool_use blocks become
    `[{name, input}, …]` (§8 live-progress events). Anything else — init
    events, tool results, non-JSON — is (None, None, [])."""
    try:
        obj = json.loads(line)
    except ValueError:
        return None, None, []
    if not isinstance(obj, dict):
        return None, None, []
    if obj.get("type") == "stream_event":
        event = obj.get("event") or {}
        delta = event.get("delta") or {}
        if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
            return delta.get("text") or "", None, []
        return None, None, []
    if obj.get("type") == "assistant":
        content = (obj.get("message") or {}).get("content")
        tools = [{"name": b.get("name") or "", "input": b.get("input") or {}}
                 for b in (content if isinstance(content, list) else [])
                 if isinstance(b, dict) and b.get("type") == "tool_use"]
        return None, None, tools
    if obj.get("type") == "result" and isinstance(obj.get("result"), str):
        return None, obj["result"], []
    return None, None, []


def _invoke(harness: str | None, agent: dict, prompt: str, timeout: int,
            proc_holder: dict | None, on_chunk=None, should_abort=None,
            web: bool = False, on_tool=None) -> str:
    # §4.7/§6: a local-model agent (mode ollama — Claude Code, Codex, or
    # OpenCode) drives the one local Ollama server through that harness's own
    # supported mechanism: OpenCode rides `--model ollama/<model>` after the
    # §19 opencode.json provider sync; Codex rides its official
    # `--oss --local-provider ollama` top-level flags; Claude Code rides its
    # custom-endpoint env vars against Ollama's Anthropic-compatible API
    # (env built below, at spawn). A custom-model agent passes the user-typed
    # string verbatim as `--model` (the same flag on all four CLIs), never
    # validated by the app.
    mode = agent.get("mode", "default")
    model = agent.get("model")
    local = mode == "ollama" and bool(model)
    if harness == "OpenCode" and local:
        sync_opencode_ollama(model)
    model_args: list[str] = []
    if model:
        model_args = ["--model",
                      f"ollama/{model}" if local and harness == "OpenCode" else model]
    codex_local_args = ["--oss", "--local-provider", "ollama"] if local else []
    # §8 prompt delivery is per-OS. POSIX: the prompt rides as the command's
    # last argv element. Windows: the whole command line is capped at 32,767
    # characters — smaller than any real drafting prompt (a minimal build
    # prompt already measures ~38 K), so every spawn would die with
    # `[WinError 206] The filename or extension is too long`. There the
    # adapter omits the argv prompt and pipes it to the child's stdin instead
    # (every §8 CLI has a non-interactive piped-stdin mode).
    pipe_prompt = paths.current_os() == "windows"
    # The `--` separator only exists to protect the positional prompt, so it
    # goes with it. Gemini's prompt rides `-p`, no positional.
    prompt_argv = [] if pipe_prompt else ["--", prompt]
    gemini_prompt_argv = [] if pipe_prompt else ["-p", prompt]
    # §6: runtime calls are query-only — invoke each harness with the
    # strongest flags it offers to disable tools/shell/file access beyond the
    # model API. §6 drafting calls pass web=True: the harness's web-read
    # tools are enabled (and nothing else) so the agent can fetch the pages
    # the request names and write selectors from the real DOM.
    cmd_map = {
        # --tools "" disables every built-in tool; web=True allows exactly
        # WebFetch/WebSearch instead. --strict-mcp-config with no
        # --mcp-config loads zero MCP servers; --no-session-persistence keeps
        # the one-shot call off disk. stream-json + --include-partial-messages
        # streams text deltas for §8 live progress (stream-json in print mode
        # requires --verbose). (Flags verified against claude --help.)
        # `--` before the positional prompt: a runtime agent.ask prompt can
        # legitimately start with "-" (an LLM-written bullet list) and must
        # not parse as a flag. Gemini's prompt rides -p, no positional.
        # Windows form (§8): the same flags with no positional prompt — the
        # CLI reads it from the piped stdin (verified live at ~40 K chars).
        "Claude Code": ["claude", "-p", *model_args,
                        "--tools", "WebFetch,WebSearch" if web else "",
                        "--strict-mcp-config",
                        "--no-session-persistence", "--output-format", "stream-json",
                        "--include-partial-messages", "--verbose", *prompt_argv],
        # Gemini CLI has no documented flag that disables its built-in tools
        # for a one-shot -p call (only sandbox/approval modes) — left bare;
        # its web tools are therefore available in every mode (§6 documented
        # limitation for runtime, the intended behavior for drafting).
        # Windows form (§8): drop `-p <prompt>` entirely — piped stdin runs
        # the CLI non-interactively.
        "Gemini CLI": ["gemini", *model_args, *gemini_prompt_argv],
        # Codex: read-only sandbox blocks writes/shell side effects;
        # --skip-git-repo-check lets exec work outside a git repo (workspace).
        # web=True adds --search — the native web_search tool. Top-level
        # flag: `codex exec --search` is rejected, `codex --search exec` OK —
        # same placement rule for the §6 local-model flags
        # `--oss --local-provider ollama`.
        "Codex": ["codex", *(["--search"] if web else []), *codex_local_args,
                  "exec", *model_args,
                  "--sandbox", "read-only", "--skip-git-repo-check",
                  *prompt_argv],
        # OpenCode has no documented flag that disables tool use for
        # `opencode run` — left bare; same runtime limitation / drafting
        # intent as Gemini.
        # Windows forms (§8): `codex exec` / `opencode run` with no prompt
        # argument read it from stdin.
        "OpenCode": ["opencode", "run", *model_args, *prompt_argv],
    }
    cmd = cmd_map.get(harness)
    if not cmd:
        raise HarnessError(f"unknown harness: {harness}")
    binpath = resolve_bin(cmd[0])
    if binpath is None:
        raise HarnessError(f"{cmd[0]} is not installed on this {paths.machine_noun()}")
    cmd[0] = binpath
    env = spawn_env(binpath)
    if harness == "Claude Code" and local:
        # §6: Claude Code local mode — point the CLI at Ollama's
        # Anthropic-compatible API. Bearer auth via ANTHROPIC_AUTH_TOKEN:
        # Ollama's /v1/messages does not reliably accept x-api-key, so an
        # inherited ANTHROPIC_API_KEY must not win the auth pick.
        env["ANTHROPIC_BASE_URL"] = OLLAMA_URL
        env["ANTHROPIC_AUTH_TOKEN"] = "ollama"
        env.pop("ANTHROPIC_API_KEY", None)
    # Own session, like engine steps (§2 platform session policy):
    # timeout/cancel must reach helper processes the CLI spawns — killing
    # only the direct child can leave a helper holding the stdout pipe open
    # (read loop never sees EOF, the §8 idle window silently never fires).
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            # §8 per-OS prompt delivery: a pipe on Windows (the
                            # prompt goes down it), /dev/null everywhere else
                            # (the prompt is already in argv).
                            stdin=subprocess.PIPE if pipe_prompt else subprocess.DEVNULL,
                            # §2 pipe-encoding contract: never the locale codec.
                            # The stdin text write below inherits it too.
                            encoding="utf-8", errors="replace",
                            env=env, cwd=_neutral_cwd(HARNESS_ID[harness]),
                            **platform.current().processes.session_kwargs())
    if proc_holder is not None:
        proc_holder["proc"] = proc

    def _close_stdin() -> None:
        """Idempotent; safe from any thread (a close racing the writer's own
        close, or the kill path, must never raise)."""
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (OSError, ValueError):
            pass

    if pipe_prompt:
        # §8: a DEDICATED writer thread, started right after the spawn — never
        # the stdout read loop's thread. A ~40 K prompt overflows the stdin
        # pipe buffer, so the write blocks until the child drains it; a child
        # that fills its own stdout pipe first would then deadlock against a
        # reader that is busy writing.
        def _write_prompt() -> None:
            try:
                proc.stdin.write(prompt)  # type: ignore[union-attr]
                proc.stdin.flush()  # type: ignore[union-attr]
            except (OSError, ValueError):
                # BrokenPipeError (the child exited or was killed before it
                # read the prompt) and ValueError (the kill path closed the
                # pipe underneath us) are both normal ends, not failures —
                # the exit code and stderr carry the real story.
                pass
            finally:
                _close_stdin()  # EOF: every §8 CLI waits for it

        threading.Thread(target=_write_prompt, daemon=True).start()
    # Cancel/spawn race: a cancel that landed after the caller's own check but
    # before this Popen existed killed nothing — re-check now that the proc is
    # visible, so no harness call can outlive a cancel by its full timeout.
    if should_abort is not None and should_abort():
        kill_group(proc)
    # §8 live progress: read stdout as it streams instead of communicate();
    # the timeout is enforced by a watchdog that kills the group (readline
    # then sees EOF), and stderr drains on its own thread so a chatty child
    # can't deadlock on a full pipe.
    timed_out = threading.Event()

    def _kill() -> None:
        timed_out.set()
        kill_group(proc)
        # An escaped child could still hold the pipe — close our read end so
        # the loop unblocks regardless.
        try:
            proc.stdout.close()  # type: ignore[union-attr]
        except OSError:
            pass
        # §8 Windows delivery: a writer thread blocked on a prompt the dead
        # child will never drain unblocks on the closed pipe (and swallows
        # the resulting error), so the kill leaks no thread and no handle.
        _close_stdin()

    # §8: `timeout` is an idle window — every stdout line pushes the deadline
    # out, so a call still streaming keeps running (a harness that buffers its
    # whole output gets no resets and the window degrades to a fixed timeout).
    # The hard cap bounds total wall clock even when output never stops.
    hard_cap = agent_hard_cap()
    start = time.monotonic()
    idle_deadline = [start + timeout]
    hard_deadline = start + hard_cap
    hard_capped = threading.Event()
    done = threading.Event()

    def _watch() -> None:
        while not done.is_set():
            now = time.monotonic()
            if now >= hard_deadline:
                hard_capped.set()
                _kill()
                return
            if now >= idle_deadline[0]:
                _kill()
                return
            # Sleep to the nearer deadline; a reset moves idle_deadline
            # forward, so waking at the stale deadline just re-checks and
            # sleeps again.
            done.wait(min(idle_deadline[0], hard_deadline) - now)

    watcher = threading.Thread(target=_watch, daemon=True)
    watcher.start()
    err_parts: list[str] = []
    drain = threading.Thread(target=lambda: err_parts.append(proc.stderr.read() or ""),
                             daemon=True)
    drain.start()
    raw_parts: list[str] = []
    deltas: list[str] = []
    final: str | None = None
    try:
        try:
            for line in proc.stdout:
                idle_deadline[0] = time.monotonic() + timeout
                raw_parts.append(line)
                if harness == "Claude Code":
                    chunk, result, tools = _claude_stream_line(line)
                    if result is not None:
                        final = result
                    if chunk:
                        deltas.append(chunk)
                        if on_chunk:
                            on_chunk(chunk)
                    if on_tool:
                        for tool in tools:
                            on_tool(tool)
                elif on_chunk:
                    on_chunk(line)
        except ValueError:
            # The timeout kill closed our read end — anything else is real.
            if not timed_out.is_set():
                raise
        proc.wait()
    except BaseException:
        # A raising on_chunk (or any read error) must not orphan the child —
        # the timer gets cancelled below, so nothing else would ever reap it.
        kill_group(proc)
        proc.wait()
        raise
    finally:
        done.set()
        # Closed on EVERY path (the writer normally got here first, and the
        # call is idempotent), so no handle is left open on a long-lived
        # backend — mirrors the engine's step-process pipe hygiene.
        _close_stdin()
    drain.join(timeout=5)
    if timed_out.is_set() and proc.returncode != 0:
        # returncode guard: a watchdog firing in the instant after a successful
        # exit must not discard a complete valid reply.
        if hard_capped.is_set():
            raise HarnessError(f"{harness} timed out after {hard_cap}s total",
                               retryable=True)
        raise HarnessError(f"{harness} timed out after {timeout}s without output",
                           retryable=True)
    raw = "".join(raw_parts)
    if proc.returncode != 0:
        err = (err_parts[0] if err_parts else "") or raw
        # The TAIL of stderr, not the head: CLIs print banners first and the
        # decisive ERROR line last (verified with Codex).
        tail = "\n".join(err.strip().splitlines()[-3:])
        raise HarnessError(f"{harness} failed: {tail[-400:]}",
                           retryable=not _deterministic_failure(tail))
    if harness == "Claude Code":
        # The result event is authoritative; joined deltas cover a CLI that
        # streamed but never sent one; raw stdout covers non-stream output.
        return final if final is not None else ("".join(deltas) or raw)
    return raw


_OPENCODE_CONFIG = os.path.expanduser("~/.config/opencode/opencode.json")
_opencode_cfg_lock = threading.Lock()


def sync_opencode_ollama(model: str) -> None:
    """§19: merge the Ollama provider entry into `~/.config/opencode/opencode.json`
    so `opencode run --model ollama/<model>` resolves. Merge only — the user's
    other config keys are never touched, and nothing is written when the entry
    is already in place."""
    with _opencode_cfg_lock:  # two agent steps must not race the read-modify-write
        _sync_opencode_ollama_locked(model)


def _sync_opencode_ollama_locked(model: str) -> None:
    try:
        with open(_OPENCODE_CONFIG, encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            cfg = {}
    except OSError:
        cfg = {}
    except ValueError:
        # A corrupt (e.g. half-written) config must not be silently replaced
        # with only our entry — that would discard the user's other keys.
        # Preserve the bytes next door and start clean.
        try:
            os.replace(_OPENCODE_CONFIG, _OPENCODE_CONFIG + ".corrupt")
            log.warning("opencode.json was not valid JSON — kept as opencode.json.corrupt")
        except OSError:
            pass
        cfg = {}
    before = json.dumps(cfg, sort_keys=True)
    provider = cfg.setdefault("provider", {})
    if not isinstance(provider, dict):
        provider = cfg["provider"] = {}
    entry = provider.setdefault("ollama", {})
    if not isinstance(entry, dict):
        entry = provider["ollama"] = {}
    entry.setdefault("npm", "@ai-sdk/openai-compatible")
    entry.setdefault("name", "Ollama (local)")
    options = entry.setdefault("options", {})
    if not isinstance(options, dict):
        options = entry["options"] = {}
    options["baseURL"] = f"{OLLAMA_URL}/v1"
    models = entry.setdefault("models", {})
    if not isinstance(models, dict):
        models = entry["models"] = {}
    models.setdefault(model, {"name": model})
    if json.dumps(cfg, sort_keys=True) == before:
        return
    try:
        # Atomic (§5 pattern): a crash mid-write must never truncate the
        # user's config file.
        atomic_write_text(Path(_OPENCODE_CONFIG), json.dumps(cfg, indent=2) + "\n")
    except OSError as e:
        raise HarnessError(f"couldn't update opencode.json: {e}") from e


# §19: on macOS the app may sit in the system or the per-user Applications
# folder; on Windows its per-user installer lands in %LOCALAPPDATA%\Programs.
_POSIX_OLLAMA_APP_BINS = tuple(
    os.path.join(apps, "Ollama.app/Contents/Resources/ollama")
    for apps in ("/Applications", os.path.expanduser("~/Applications")))
_WINDOWS_OLLAMA_APP_BINS = (
    os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local"),
        "Programs", "Ollama", "ollama.exe"),
)
_OLLAMA_APP_BINS = (
    _WINDOWS_OLLAMA_APP_BINS if paths.current_os() == "windows"
    else _POSIX_OLLAMA_APP_BINS
)


def ollama_bin() -> str | None:
    found = resolve_bin("ollama")
    if found:
        return found
    for path in _OLLAMA_APP_BINS:
        if _is_executable(path):
            return path
    return None


def _ollama_models() -> list[str] | None:
    """Model names if the server answers, else None."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2) as r:
            tags = json.loads(r.read().decode())
        return [m["name"] for m in tags.get("models", [])]
    except Exception:  # noqa: BLE001
        return None


def _ollama_version() -> str | None:
    """The server's version string if it answers, else None (§19)."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/version", timeout=2) as r:
            return str(json.loads(r.read().decode()).get("version") or "") or None
    except Exception:  # noqa: BLE001
        return None


# §19/§6: Ollama's Anthropic-compatible /v1/messages endpoint (what a Claude
# Code local-model agent talks to) shipped in 0.14.0.
OLLAMA_MIN_ANTHROPIC = (0, 14, 0)


def version_at_least(version: str | None, floor: tuple[int, ...]) -> bool:
    """Compare a dotted version string's leading numeric parts against
    `floor`. Unknown/unparseable versions read False — the §19 check answers
    needs-setup rather than letting the invoke fail later."""
    if not version:
        return False
    parts: list[int] = []
    for piece in version.strip().lstrip("v").split("."):
        digits = ""
        for ch in piece:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            break
        parts.append(int(digits))
    if not parts:
        return False
    return tuple(parts) >= floor


_serve_last_spawn = 0.0
_SERVE_COOLDOWN_S = 30.0


def ollama_status() -> dict:
    global _serve_last_spawn
    models = _ollama_models()
    binpath = ollama_bin()
    local = "localhost" in OLLAMA_URL or "127.0.0.1" in OLLAMA_URL
    if (models is None and binpath and local
            and time.time() - _serve_last_spawn > _SERVE_COOLDOWN_S):
        # Installed but the server isn't up — start it and wait. A cooldown
        # instead of a once-latch: the server dying later (or a failed spawn)
        # must not disable the self-heal for the backend's whole lifetime.
        _serve_last_spawn = time.time()
        try:
            subprocess.Popen([binpath, "serve"], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL,
                             env=spawn_env(binpath), cwd=_neutral_cwd("ollama"),
                             **platform.current().processes.session_kwargs())
        except Exception:  # noqa: BLE001
            pass
        else:
            for _ in range(10):
                time.sleep(0.3)
                models = _ollama_models()
                if models is not None:
                    break
    return {"ready": models is not None,
            "installed": models is not None or binpath is not None,
            "models": models or [],
            "version": _ollama_version() if models is not None else None}


def ollama_model_installed(model: str, installed: list[str]) -> bool:
    """A bare name without a tag matches its `:latest` variant."""
    if model in installed:
        return True
    return ":" not in model and f"{model}:latest" in installed


def grant_name(agent: dict) -> str:
    """§8 grant name of an agent record — the name steps and grants yaml use
    to refer to it (falls back to the harness name when the agent is unnamed)."""
    return agent.get("name") or agent.get("harness", "")


# §4.7: the harnesses local-model mode (mode ollama) is valid with. Gemini CLI
# is excluded — the stock CLI speaks only the Gemini wire format and has no
# local or OpenAI-compatible endpoint support.
LOCAL_MODEL_HARNESSES = ("Claude Code", "Codex", "OpenCode")

# Provider ids (§19 install/login/signin endpoints, §10 cards) ↔ harness names.
# Ollama is an installable provider but never a harness (§4.7) — it's the
# local-model runtime the §4.7 local-model harnesses drive.
PROVIDERS: tuple[tuple[str, str], ...] = (
    ("claude", "Claude Code"),
    ("ollama", "Ollama"),
    ("codex", "Codex"),
    ("gemini", "Gemini CLI"),
    ("opencode", "OpenCode"),
)
PROVIDER_NAME = dict(PROVIDERS)
PROVIDER_BIN = {"claude": "claude", "codex": "codex", "gemini": "gemini",
                "opencode": "opencode", "ollama": "ollama"}
HARNESS_ID = {name: pid for pid, name in PROVIDERS if pid != "ollama"}


def _status_ok(cmd: list[str], provider_id: str) -> bool:
    try:
        # §2 spawn policy via session_kwargs: on Windows the windowless
        # backend's console children each open a terminal window without it.
        r = subprocess.run(cmd, capture_output=True, timeout=10,
                           encoding="utf-8", errors="replace",  # §2 pipe-encoding contract
                           env=spawn_env(cmd[0]), cwd=_neutral_cwd(provider_id),
                           **platform.current().processes.session_kwargs())
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def signed_in(provider_id: str) -> bool | None:
    """§19 per-harness sign-in rule. None means the provider needs no account
    (Ollama); False for an account-backed provider that isn't installed."""
    if provider_id == "ollama":
        return None
    if provider_id == "claude":
        binpath = resolve_bin("claude")
        return bool(binpath) and _status_ok([binpath, "auth", "status"], "claude")
    if provider_id == "codex":
        binpath = resolve_bin("codex")
        return bool(binpath) and _status_ok([binpath, "login", "status"], "codex")
    if provider_id == "gemini":
        # §19: an API key alone counts as signed in; otherwise oauth_creds.json
        # must parse as JSON carrying a refresh token — file existence never
        # counts (a stale/empty/garbage file must not fake a working sign-in).
        if os.environ.get("GEMINI_API_KEY"):
            return True
        try:
            with open(os.path.expanduser("~/.gemini/oauth_creds.json"),
                      encoding="utf-8") as f:
                creds = json.load(f)
        except (OSError, ValueError):
            return False
        return isinstance(creds, dict) and bool(str(creds.get("refresh_token") or "").strip())
    if provider_id == "opencode":
        # §19: auth.json maps provider id → credential entry. The OpenCode CLI
        # writes { type: api, key } / { type: oauth, access, refresh, expires }
        # / { type: wellknown, key, token } shapes — signed in means at least
        # one entry is a dict carrying a non-empty token-like field (key /
        # token / access / refresh); a credential-less or unparseable file
        # reads signed out.
        try:
            with open(os.path.expanduser("~/.local/share/opencode/auth.json"),
                      encoding="utf-8") as f:
                creds = json.load(f)
        except (OSError, ValueError):
            return False
        if not isinstance(creds, dict):
            return False
        return any(isinstance(entry, dict)
                   and any(str(entry.get(k) or "").strip()
                           for k in ("key", "token", "access", "refresh"))
                   for entry in creds.values())
    return False


def signin_state(provider_id: str) -> dict:
    """§19 `GET /agents/signin/{id}` — cheap poll, no version lookups."""
    if provider_id == "ollama":
        st = ollama_status()
        return {"installed": st["installed"], "signedIn": None}
    binpath = resolve_bin(PROVIDER_BIN[provider_id])
    return {"installed": binpath is not None, "signedIn": signed_in(provider_id)}


def check_ready(harness_name: str, model: str | None = None,
                mode: str = "default") -> bool:
    """The single readiness check behind §19 `/agents/{id}/check` and
    `/agents/check-harness`.

    Ready means the harness can take a prompt right now: the binary resolves.
    A local-model agent (mode ollama — Claude Code, Codex, or OpenCode, §4.7)
    additionally needs the Ollama server answering and the model installed —
    and no sign-in, a local model needs no account. Claude Code additionally
    needs Ollama ≥ 0.14.0 (the Anthropic-compatible endpoint it talks to, §6);
    OpenCode additionally needs the opencode.json provider sync to land.
    Default- and custom-mode checks instead
    require the harness to be signed in by the §19 per-harness rule; the
    custom-mode model string is never validated (§4.7) — a wrong name
    surfaces at invoke time.
    """
    pid = HARNESS_ID.get(harness_name)
    if not pid:
        return False
    if resolve_bin(PROVIDER_BIN[pid]) is None:
        return False
    if mode == "ollama":
        if harness_name not in LOCAL_MODEL_HARNESSES or not model:
            return False
        st = ollama_status()
        if not st["ready"] or not ollama_model_installed(model, st["models"]):
            return False
        if (harness_name == "Claude Code"
                and not version_at_least(st["version"], OLLAMA_MIN_ANTHROPIC)):
            return False
        if harness_name == "OpenCode":
            try:
                sync_opencode_ollama(model)
            except HarnessError:
                # §19: check endpoints answer ready/needs-setup, never 500 —
                # an unwritable opencode.json is a needs-setup condition.
                return False
        return True
    return signed_in(pid) is True


def detect() -> list[dict]:
    """§10 step 2 — one entry per harness, all four always present, with real
    installed and sign-in state (§19). Ollama is not part of detection — the
    §10 Free local AI card reads its state from `/ollama/status`."""
    def version_of(binpath: str, pid: str) -> str | None:
        try:
            # §2 spawn policy via session_kwargs (hidden console on Windows).
            r = subprocess.run([binpath, "--version"], capture_output=True,
                               encoding="utf-8", errors="replace",  # §2 pipe-encoding contract
                               timeout=5, env=spawn_env(binpath), cwd=_neutral_cwd(pid),
                               **platform.current().processes.session_kwargs())
            return (r.stdout or r.stderr).strip().splitlines()[0][:40] if r.returncode == 0 else None
        except Exception:  # noqa: BLE001
            return None

    out = []
    for pid, name in PROVIDERS:
        if pid == "ollama":
            continue
        binpath = resolve_bin(PROVIDER_BIN[pid])
        if not binpath:
            out.append({"id": pid, "name": name, "installed": False,
                        "signedIn": False, "detail": ""})
            continue
        s = signed_in(pid) is True
        v = version_of(binpath, pid)
        detail = f"{v or 'installed'} · {'signed in' if s else 'not signed in yet'}"
        out.append({"id": pid, "name": name, "installed": True,
                    "signedIn": s, "detail": detail})
    return out
