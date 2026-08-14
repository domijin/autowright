"""Real harness installers and sign-in help (§19).

Each vendor's own suggested install method — never sudo, never Homebrew
(CLIs land in user bin dirs; Ollama is the official Mac app plus a
`~/.local/bin` symlink). One background install per provider at a time;
progress streams through a publish callback (the API layer forwards it as
`harness.install` WS events) and the latest snapshot is kept for
`GET /agents/install/{id}` so a remounted UI can reattach.
"""
from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request

from . import harness

LOCAL_BIN = os.path.expanduser("~/.local/bin")

# Wall-clock cap per install phase: a black-holing server or a byte-trickling
# download would otherwise keep the job "running" forever — and the running
# guard in start() would block every retry until a backend restart.
INSTALL_TIMEOUT_S = 15 * 60

CLAUDE_INSTALLER = "https://claude.ai/install.sh"
OPENCODE_INSTALLER = "https://opencode.ai/install"
CODEX_INSTALLER = "https://chatgpt.com/codex/install.sh"
# The official Mac app archive — the same payload ollama.com's install.sh ships.
OLLAMA_APP_ZIP = "https://ollama.com/download/Ollama-darwin.zip"
APPLICATIONS = "/Applications"

_lock = threading.Lock()
_jobs: dict[str, dict] = {}  # provider id → §19 install snapshot


def status(provider_id: str) -> dict:
    with _lock:
        snap = _jobs.get(provider_id)
        return dict(snap) if snap else {"state": "idle"}


def start(provider_id: str, publish) -> bool:
    """Kick off a background install. False if one is already running."""
    with _lock:
        if _jobs.get(provider_id, {}).get("state") == "running":
            return False
        _jobs[provider_id] = {"state": "running", "line": "", "percent": None}

    def emit(line: str | None = None, percent: int | None = None) -> None:
        with _lock:
            snap = _jobs[provider_id]
            if line is not None:
                snap["line"] = line
            if percent is not None:
                snap["percent"] = percent
        publish(line=line, percent=percent, done=False)

    def run() -> None:
        try:
            _INSTALLERS[provider_id](emit)
        except Exception as e:  # noqa: BLE001 — becomes the §10 failure card
            msg = (str(e).strip().splitlines() or ["install failed"])[0][:300]
            with _lock:
                _jobs[provider_id] = {"state": "failed", "error": msg}
            publish(done=True, ok=False, error=msg)
            return
        with _lock:
            _jobs[provider_id] = {"state": "done"}
        publish(done=True, ok=True)

    threading.Thread(target=run, daemon=True).start()
    return True


def login(provider_id: str) -> str:
    """Start sign-in help; returns the §19 method (`browser` | `terminal`).

    Codex's `login` completes on its own OAuth browser callback, so it runs
    detached. The other CLIs sign in through interactive TUIs — those open in
    Terminal.app, and the UI polls `GET /agents/signin/{id}` until done.
    """
    if provider_id == "ollama":
        # No account, nothing to sign into (§4.7) — reject cleanly instead of
        # crashing into a 500 below.
        raise RuntimeError("Ollama needs no sign-in")
    binpath = harness.resolve_bin(harness.PROVIDER_BIN[provider_id])
    if binpath is None:
        raise RuntimeError(f"{harness.PROVIDER_NAME[provider_id]} isn't installed on this Mac")
    if provider_id == "codex":
        subprocess.Popen([binpath, "login"], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                         start_new_session=True, env=harness.spawn_env(binpath),
                         cwd=harness._neutral_cwd("codex"))
        return "browser"
    args = {"claude": ["/login"], "gemini": [], "opencode": ["auth", "login"]}[provider_id]
    # §6/§19: Terminal shells start in ~ — cd into the provider's empty
    # workspace first so the CLI's startup scan never walks the home folder.
    cmd = (f"cd {shlex.quote(harness._neutral_cwd(provider_id))} && "
           + " ".join(shlex.quote(p) for p in [binpath, *args]))
    osa = cmd.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e", 'tell application "Terminal" to activate',
                    "-e", f'tell application "Terminal" to do script "{osa}"'],
                   capture_output=True, timeout=10, check=False)
    return "terminal"


# ---------- mechanics ----------

def _stream_shell(cmd: list[str], emit, provider_id: str,
                  env_extra: dict | None = None) -> None:
    """Run an installer child, forwarding each output line; raise on failure
    with the last decisive line as the message."""
    env = harness.spawn_env(cmd[0])
    env.setdefault("HOME", os.path.expanduser("~"))
    if env_extra:
        env.update(env_extra)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, text=True, errors="replace",
                            env=env, cwd=harness._neutral_cwd(provider_id),
                            # own session: the timeout kill reaches the whole
                            # pipeline (curl | bash spawns children)
                            start_new_session=True)
    timed_out = threading.Event()

    def _kill() -> None:
        timed_out.set()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            if proc.poll() is None:
                proc.kill()
        # An escaped child (a daemonizing grandchild that re-setsid'd) could
        # still hold the merged pipe open — close our read end so the loop
        # unblocks regardless, like harness._invoke's timeout kill.
        try:
            proc.stdout.close()  # type: ignore[union-attr]
        except OSError:
            pass

    timer = threading.Timer(INSTALL_TIMEOUT_S, _kill)
    timer.daemon = True
    timer.start()
    tail: list[str] = []
    try:
        try:
            for raw in proc.stdout:  # type: ignore[union-attr]
                line = raw.strip()
                if line:
                    tail = (tail + [line])[-5:]
                    emit(line=line)
        except ValueError:
            # The timeout kill closed our read end — anything else is real.
            if not timed_out.is_set():
                raise
        proc.wait()
    finally:
        timer.cancel()
    if timed_out.is_set() and proc.returncode != 0:
        # returncode guard: a timer firing in the instant after a successful
        # exit must not report a completed install as a timeout.
        raise RuntimeError(f"the installer timed out after {INSTALL_TIMEOUT_S // 60} minutes")
    if proc.returncode != 0:
        raise RuntimeError(tail[-1] if tail else f"installer exited with code {proc.returncode}")


def _download(url: str, dest: str, emit, label: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "autowright"})
    deadline = time.monotonic() + INSTALL_TIMEOUT_S
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, -1
        while True:
            if time.monotonic() > deadline:
                # the per-read timeout can't catch a server trickling bytes
                raise RuntimeError(f"{label} timed out after {INSTALL_TIMEOUT_S // 60} minutes")
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                percent = int(got * 100 / total)
                if percent != last:
                    last = percent
                    # §19: the number rides only `percent` — `line` stays the
                    # bare step label the UI renders under the one install bar.
                    emit(line=label, percent=percent)


def _require(binname: str) -> None:
    if harness.resolve_bin(binname) is None:
        raise RuntimeError(f"the installer finished but `{binname}` didn't appear on this Mac")


def _install_claude(emit) -> None:
    emit(line="Downloading the Claude Code installer…")
    _stream_shell(["/bin/bash", "-c", f"curl -fsSL {CLAUDE_INSTALLER} | bash"], emit,
                  "claude")
    _require("claude")


def _install_opencode(emit) -> None:
    # The script installs into its own default `~/.opencode/bin` (on the §19
    # fallback bin-dir list); its documented OPENCODE_INSTALL_DIR is ignored
    # by the live script, so nothing is passed.
    emit(line="Downloading the OpenCode installer…")
    _stream_shell(["/bin/bash", "-c", f"curl -fsSL {OPENCODE_INSTALLER} | bash"], emit,
                  "opencode")
    _require("opencode")


def _install_gemini(emit) -> None:
    # Gemini CLI ships only through npm (§19) — fail fast without Node.
    npm = harness.resolve_bin("npm")
    if npm is None:
        raise RuntimeError("Gemini CLI needs Node.js — install it from nodejs.org first, "
                           "then try again.")
    emit(line="Installing @google/gemini-cli with npm…")
    _stream_shell([npm, "install", "-g", "--prefix", os.path.expanduser("~/.local"),
                   "@google/gemini-cli"], emit, "gemini")
    _require("gemini")


def _install_codex(emit) -> None:
    emit(line="Downloading the Codex installer…")
    # CODEX_NON_INTERACTIVE: the backend has no TTY to answer its prompts.
    _stream_shell(["/bin/bash", "-c", f"curl -fsSL {CODEX_INSTALLER} | sh"], emit,
                  "codex", env_extra={"CODEX_NON_INTERACTIVE": "1"})
    _require("codex")


def _install_ollama_app(emit) -> str:
    """Install the official Mac app the way ollama.com's install.sh does,
    minus its sudo'd `/usr/local/bin` symlink — a `~/.local/bin` one instead.
    Returns the installed app path."""
    apps = APPLICATIONS if os.access(APPLICATIONS, os.W_OK) \
        else os.path.expanduser("~/Applications")
    dest = os.path.join(apps, "Ollama.app")
    with tempfile.TemporaryDirectory() as td:
        zip_path = os.path.join(td, "Ollama-darwin.zip")
        _download(OLLAMA_APP_ZIP, zip_path, emit, "Downloading Ollama")
        emit(line="Installing the Ollama app…")
        subprocess.run(["/usr/bin/ditto", "-x", "-k", zip_path, td],
                       check=True, capture_output=True)
        src = os.path.join(td, "Ollama.app")
        if not os.path.isdir(src):
            raise RuntimeError("no Ollama.app found in the downloaded archive")
        # Vendor-script parity: quit a running app, replace an existing install.
        if subprocess.run(["pkill", "-x", "Ollama"], capture_output=True).returncode == 0:
            time.sleep(2)
        os.makedirs(apps, exist_ok=True)
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.move(src, dest)
    os.makedirs(LOCAL_BIN, exist_ok=True)
    link = os.path.join(LOCAL_BIN, "ollama")
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(os.path.join(dest, "Contents", "Resources", "ollama"), link)
    return dest


def _install_ollama(emit) -> None:
    app = _install_ollama_app(emit)
    _require("ollama")
    emit(line="Starting the Ollama server…")
    # The app's menu-bar agent owns the server (and auto-updates) — launch it
    # hidden like the vendor script does.
    subprocess.run(["open", app, "--args", "hidden"], capture_output=True, check=False)
    for _ in range(30):
        if harness.ollama_status()["ready"]:
            return
        time.sleep(1)
    raise RuntimeError("Ollama installed but its server didn't start")


_INSTALLERS = {
    "claude": _install_claude,
    "codex": _install_codex,
    "gemini": _install_gemini,
    "opencode": _install_opencode,
    "ollama": _install_ollama,
}
