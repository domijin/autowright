"""installer.py internals (§19): downloads, the Ollama app install, shell
streaming, job lifecycle. Nothing real is touched — HTTP servers bind
127.0.0.1, LOCAL_BIN / APPLICATIONS and the harness bin search are redirected
into tmp, and every spawned subprocess is a harmless `sh` builtin or recorded
argv on mocked subprocess entry points.
"""
import contextlib
import os
import shutil
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from autowright import harness, installer


@pytest.fixture(autouse=True)
def _fresh_jobs(monkeypatch):
    """Isolate the module-global job table per test."""
    monkeypatch.setattr(installer, "_jobs", {})
    # Keep localhost requests away from any proxy configured in the real env.
    monkeypatch.setenv("no_proxy", "*")


class Recorder:
    """Stand-in for the `emit` progress callback."""

    def __init__(self):
        self.lines: list[str] = []
        self.pcts: list[int] = []

    def __call__(self, line=None, percent=None, **kw):
        if line is not None:
            self.lines.append(line)
        if percent is not None:
            self.pcts.append(percent)


@contextlib.contextmanager
def _serve(handler_cls):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def _wait_state(provider_id, state, timeout=5.0):
    """Poll status() until the background thread lands on `state`."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = installer.status(provider_id)
        if snap.get("state") == state:
            return snap
        time.sleep(0.01)
    raise AssertionError(
        f"{provider_id} never reached {state!r}: {installer.status(provider_id)}")


# ---------------------------------------------------------------- _download

PAYLOAD = bytes(range(256)) * 800  # 204 800 B → four 64 KiB reads


def test_download_writes_file_and_reports_increasing_progress(tmp_path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.end_headers()
            self.wfile.write(PAYLOAD)

        def log_message(self, *a):
            pass

    rec = Recorder()
    dest = tmp_path / "artifact.bin"
    with _serve(Handler) as base:
        installer._download(f"{base}/artifact.bin", str(dest), rec, "Downloading Codex")

    assert dest.read_bytes() == PAYLOAD
    # Content-Length served → percent progress, strictly increasing, ends at 100.
    assert rec.pcts, "no progress reported despite Content-Length"
    assert rec.pcts == sorted(set(rec.pcts))
    assert rec.pcts[-1] == 100
    assert rec.pcts[0] < 100
    # §19: the number rides only `percent` — the line stays the bare step label.
    assert all(l == "Downloading Codex" for l in rec.lines)


def test_download_trickle_hits_wall_clock_deadline(tmp_path, monkeypatch):
    """A server trickling bytes never EOFs and never trips the per-read
    timeout; the monotonic deadline must abort it. Deadline is derived from
    INSTALL_TIMEOUT_S at call time, so shrink it to keep the test fast."""
    monkeypatch.setattr(installer, "INSTALL_TIMEOUT_S", 1)
    chunk = b"x" * (1 << 16)

    class Trickle(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(chunk) * 50))
            self.end_headers()
            try:
                for _ in range(50):
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    time.sleep(1.3)  # > deadline; client aborts mid-stream
            except OSError:
                pass  # client hung up after raising — expected

        def log_message(self, *a):
            pass

    dest = tmp_path / "slow.bin"
    with _serve(Trickle) as base:
        with pytest.raises(RuntimeError, match="timed out"):
            installer._download(f"{base}/slow.bin", str(dest), Recorder(), "slow")


# ---------------------------------------------------------------- _install_ollama_app

@pytest.fixture()
def local_bin(tmp_path, monkeypatch):
    """Redirect LOCAL_BIN into tmp; never touch the real ~/.local/bin, the
    real /usr/local/bin (nonexistent redirect → the LOCAL_BIN branch runs),
    or the real shell profile (_ensure_login_path stubbed)."""
    d = tmp_path / "localbin"
    monkeypatch.setattr(installer, "LOCAL_BIN", str(d))
    monkeypatch.setattr(installer, "USR_LOCAL_BIN", str(tmp_path / "usr-local-bin"))
    monkeypatch.setattr(installer, "_ensure_login_path", lambda emit: None)
    return d


def _make_app_zip(path):
    """A minimal Ollama.app bundle zip (what ollama.com ships)."""
    with zipfile.ZipFile(path, "w") as zf:
        info = zipfile.ZipInfo("Ollama.app/Contents/Resources/ollama")
        info.external_attr = 0o100755 << 16  # regular file, rwxr-xr-x
        zf.writestr(info, "#!/bin/sh\nreal ollama\n")


@pytest.fixture()
def _passthrough_ditto(monkeypatch):
    """Record subprocess.run argv; really run ditto, no-op pkill/open."""
    runs = []
    real_run = installer.subprocess.run

    def fake_run(cmd, **kw):
        runs.append(list(cmd))
        if cmd[0] == "/usr/bin/ditto":
            return real_run(cmd, **kw)
        return installer.subprocess.CompletedProcess(cmd, 1)

    monkeypatch.setattr(installer.subprocess, "run", fake_run)
    return runs


def test_install_ollama_app_places_bundle_and_user_symlink(tmp_path, local_bin,
                                                           monkeypatch,
                                                           _passthrough_ditto):
    zip_src = tmp_path / "Ollama-darwin.zip"
    _make_app_zip(zip_src)
    apps = tmp_path / "Applications"
    apps.mkdir()
    # an existing install must be replaced, vendor-script style
    stale = apps / "Ollama.app" / "Contents"
    stale.mkdir(parents=True)
    (stale / "stale-marker").write_text("old")
    monkeypatch.setattr(installer, "APPLICATIONS", str(apps))
    urls = []

    def fake_download(url, dest, emit, label):
        urls.append(url)
        shutil.copy(zip_src, dest)

    monkeypatch.setattr(installer, "_download", fake_download)
    ensured = []
    monkeypatch.setattr(installer, "_ensure_login_path",
                        lambda emit: ensured.append(True))
    rec = Recorder()
    dest = installer._install_ollama_app(rec)

    assert urls == [installer.OLLAMA_APP_ZIP]
    assert dest == str(apps / "Ollama.app")
    app_bin = apps / "Ollama.app" / "Contents" / "Resources" / "ollama"
    assert app_bin.read_text() == "#!/bin/sh\nreal ollama\n"
    assert not (apps / "Ollama.app" / "Contents" / "stale-marker").exists()
    link = local_bin / "ollama"
    assert link.is_symlink() and os.readlink(link) == str(app_bin)
    assert os.access(link, os.X_OK)
    assert "Installing the Ollama app…" in rec.lines
    # a running app would have been quit before the bundle swap
    assert ["pkill", "-x", "Ollama"] in _passthrough_ditto
    # a ~/.local/bin symlink comes with the §19 terminal-access guarantee
    assert ensured == [True]


def test_install_ollama_app_symlinks_vendor_dir_when_writable(tmp_path, local_bin,
                                                              monkeypatch,
                                                              _passthrough_ditto):
    """§19 install-location principle: a writable /usr/local/bin gets the
    vendor script's own symlink location — no profile edit needed."""
    zip_src = tmp_path / "Ollama-darwin.zip"
    _make_app_zip(zip_src)
    apps = tmp_path / "Applications"
    apps.mkdir()
    monkeypatch.setattr(installer, "APPLICATIONS", str(apps))
    usr = tmp_path / "usr-local-bin"
    usr.mkdir()
    monkeypatch.setattr(installer, "USR_LOCAL_BIN", str(usr))
    monkeypatch.setattr(installer, "_download",
                        lambda url, dest, emit, label: shutil.copy(zip_src, dest))
    ensured = []
    monkeypatch.setattr(installer, "_ensure_login_path",
                        lambda emit: ensured.append(True))

    installer._install_ollama_app(Recorder())

    link = usr / "ollama"
    app_bin = apps / "Ollama.app" / "Contents" / "Resources" / "ollama"
    assert link.is_symlink() and os.readlink(link) == str(app_bin)
    assert not (local_bin / "ollama").exists()
    assert ensured == []  # /usr/local/bin is on every PATH already


def test_install_ollama_app_without_bundle_errors(tmp_path, local_bin,
                                                  monkeypatch, _passthrough_ditto):
    zip_src = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_src, "w") as zf:
        zf.writestr("README.md", "docs")
    apps = tmp_path / "Applications"
    apps.mkdir()
    monkeypatch.setattr(installer, "APPLICATIONS", str(apps))
    monkeypatch.setattr(installer, "_download",
                        lambda url, dest, emit, label: shutil.copy(zip_src, dest))
    with pytest.raises(RuntimeError, match="no Ollama.app found"):
        installer._install_ollama_app(Recorder())
    assert not (apps / "Ollama.app").exists()
    assert not (local_bin / "ollama").exists()


# ---------------------------------------------------------------- _stream_shell

def test_stream_shell_streams_each_line_and_succeeds(home):
    rec = Recorder()
    installer._stream_shell(["/bin/sh", "-c", "echo one; echo two"], rec, "claude")
    assert rec.lines == ["one", "two"]


def test_stream_shell_failure_raises_with_last_output_line(home):
    # Note: a 5-line tail is kept while streaming, but only tail[-1] — the
    # final non-empty line — becomes the error message (current behavior).
    rec = Recorder()
    script = "; ".join(f"echo l{i}" for i in range(1, 7)) + "; exit 7"
    with pytest.raises(RuntimeError) as ei:
        installer._stream_shell(["/bin/sh", "-c", script], rec, "claude")
    assert str(ei.value) == "l6"
    assert rec.lines == [f"l{i}" for i in range(1, 7)]


def test_stream_shell_silent_failure_reports_exit_code(home):
    with pytest.raises(RuntimeError, match="exited with code 9"):
        installer._stream_shell(["/bin/sh", "-c", "exit 9"], Recorder(), "claude")


def test_stream_shell_timeout_sigkills_whole_process_group(home, tmp_path,
                                                           monkeypatch):
    monkeypatch.setattr(installer, "INSTALL_TIMEOUT_S", 1)
    pidfile = tmp_path / "sleeper.pid"
    cmd = ["/bin/sh", "-c",
           f"sleep 30 & echo $! > {pidfile}; echo started; wait"]
    t0 = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out"):
        installer._stream_shell(cmd, Recorder(), "claude")
    assert time.monotonic() - t0 < 10  # timer fired, not a natural exit

    # the backgrounded sleep shares the session's process group → killed too
    pid = int(pidfile.read_text().strip())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, 9)  # cleanup before failing
        pytest.fail(f"sleep {pid} leaked past the group SIGKILL")


# ---------------------------------------------------------------- status/start

def test_status_idle_when_never_started():
    assert installer.status("claude") == {"state": "idle"}


def test_start_running_guard_is_per_provider(monkeypatch):
    gate, started = threading.Event(), threading.Event()

    def blocking(emit):
        emit(line="working", percent=3)
        started.set()
        assert gate.wait(10), "test never released the gate"

    monkeypatch.setitem(installer._INSTALLERS, "claude", blocking)
    monkeypatch.setitem(installer._INSTALLERS, "codex", lambda emit: None)

    pubs = []
    assert installer.start("claude", lambda **kw: pubs.append(kw)) is True
    assert started.wait(5)
    snap = installer.status("claude")
    assert snap["state"] == "running"
    assert snap["line"] == "working" and snap["percent"] == 3

    # second start for the same provider: refused, job untouched
    assert installer.start("claude", lambda **kw: pubs.append(kw)) is False
    assert installer.status("claude")["state"] == "running"

    # a different provider is not blocked by claude's running job
    assert installer.start("codex", lambda **kw: None) is True
    _wait_state("codex", "done")
    assert installer.status("claude")["state"] == "running"

    gate.set()
    _wait_state("claude", "done")
    assert pubs[-1] == {"done": True, "ok": True}
    # done again → a fresh start is allowed
    assert installer.start("claude", lambda **kw: None) is True
    gate.set()
    _wait_state("claude", "done")


def test_start_failure_surfaces_first_error_line_capped_at_300(monkeypatch):
    long_line = "E" * 400

    def boom(emit):
        raise RuntimeError(f"{long_line}\nsecond line never shown")

    monkeypatch.setitem(installer._INSTALLERS, "claude", boom)
    pubs = []
    assert installer.start("claude", lambda **kw: pubs.append(kw)) is True
    snap = _wait_state("claude", "failed")
    assert snap["error"] == "E" * 300
    assert len(snap["error"]) <= 300
    assert pubs[-1] == {"done": True, "ok": False, "error": "E" * 300}


def test_start_failure_with_empty_message_gets_fallback(monkeypatch):
    monkeypatch.setitem(installer._INSTALLERS, "claude",
                        lambda emit: (_ for _ in ()).throw(RuntimeError("")))
    installer.start("claude", lambda **kw: None)
    assert _wait_state("claude", "failed")["error"] == "install failed"


# ---------------------------------------------------------------- recipes

def test_gemini_without_node_fails_fast_without_spawning(monkeypatch):
    monkeypatch.setattr(harness, "resolve_bin", lambda name: None)

    def no_spawn(*a, **kw):
        raise AssertionError("subprocess must not be spawned without Node")

    monkeypatch.setattr(installer.subprocess, "Popen", no_spawn)
    with pytest.raises(RuntimeError, match="Node.js"):
        installer._install_gemini(Recorder())


def test_gemini_with_node_runs_npm_global_into_local_prefix(home, monkeypatch):
    """Recipe assertion via recorded argv — npm itself is never executed."""
    fake_npm = str(home / "fakebin" / "npm")
    monkeypatch.setattr(harness, "resolve_bin",
                        lambda name: fake_npm if name == "npm" else "/x/gemini")
    argvs = []
    monkeypatch.setattr(installer, "_stream_shell",
                        lambda cmd, emit, provider_id, env_extra=None: argvs.append(list(cmd)))
    ensured = []
    monkeypatch.setattr(installer, "_ensure_login_path",
                        lambda emit: ensured.append(True))
    installer._install_gemini(Recorder())
    assert argvs == [[fake_npm, "install", "-g", "--prefix",
                      os.path.expanduser("~/.local"), "@google/gemini-cli"]]
    # the --prefix bin placement is ours → §19 terminal-access guarantee runs
    assert ensured == [True]


def test_claude_recipe_pipes_official_installer_and_requires_binary(monkeypatch):
    calls = []
    monkeypatch.setattr(installer, "_stream_shell",
                        lambda cmd, emit, provider_id, env_extra=None: calls.append(list(cmd)))
    required = []
    monkeypatch.setattr(installer, "_require", required.append)
    ensured = []
    monkeypatch.setattr(installer, "_ensure_login_path",
                        lambda emit: ensured.append(True))
    installer._install_claude(Recorder())
    assert calls == [["/bin/bash", "-c",
                      f"curl -fsSL {installer.CLAUDE_INSTALLER} | bash"]]
    assert required == ["claude"]
    # the vendor script lands in ~/.local/bin but only prints PATH
    # instructions → §19 terminal-access guarantee runs
    assert ensured == [True]


# ---------------------------------------------------------------- _ensure_login_path

@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    """Point HOME at tmp so profile writes never touch the real one."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    return h


def test_ensure_login_path_noop_when_already_on_login_path(monkeypatch, fake_home):
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(installer, "_login_shell_path",
                        lambda: ["/usr/bin", installer.LOCAL_BIN])
    installer._ensure_login_path(Recorder())
    assert not (fake_home / ".zprofile").exists()


def test_ensure_login_path_appends_marked_export_to_zprofile(monkeypatch, fake_home):
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(installer, "_login_shell_path", lambda: ["/usr/bin"])
    rec = Recorder()
    installer._ensure_login_path(rec)
    text = (fake_home / ".zprofile").read_text()
    assert installer.PATH_MARKER in text
    assert 'export PATH="$HOME/.local/bin:$PATH"' in text
    assert any(".zprofile" in line and "new terminal" in line for line in rec.lines)
    # idempotent: a second run finds the mention and never duplicates it
    installer._ensure_login_path(rec)
    assert (fake_home / ".zprofile").read_text() == text


def test_ensure_login_path_respects_existing_profile_mention(monkeypatch, fake_home):
    monkeypatch.setenv("SHELL", "/bin/bash")
    profile = fake_home / ".bash_profile"
    profile.write_text('PATH="$HOME/.local/bin:$PATH"\n')
    monkeypatch.setattr(installer, "_login_shell_path", lambda: [])
    installer._ensure_login_path(Recorder())
    assert profile.read_text() == 'PATH="$HOME/.local/bin:$PATH"\n'


def test_login_shell_path_empty_on_probe_failure(monkeypatch):
    monkeypatch.setenv("SHELL", "/usr/bin/false")
    assert installer._login_shell_path() == []


# ---------------------------------------------------------------- _require

def test_require_passes_when_binary_present_in_redirected_dir(tmp_path,
                                                              monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = bindir / "codex"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    empty = tmp_path / "emptypath"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    monkeypatch.setattr(harness, "_FALLBACK_BIN_DIRS", (str(bindir),))

    installer._require("codex")  # present → no raise
    with pytest.raises(RuntimeError, match="`gemini` didn't appear"):
        installer._require("gemini")


# ---------- sign-in help (§19 POST /agents/login) ----------

def test_login_codex_runs_detached_and_reports_browser(monkeypatch):
    # Codex's `login` completes on its own OAuth browser callback → detached
    # child, method `browser`, never a Terminal window.
    monkeypatch.setattr(harness, "resolve_bin", lambda b: f"/fake/{b}")
    popen = {}

    def fake_popen(cmd, **kw):
        popen["cmd"], popen["kw"] = cmd, kw

    monkeypatch.setattr(installer.subprocess, "Popen", fake_popen)
    runs = []
    monkeypatch.setattr(installer.subprocess, "run",
                        lambda *a, **k: runs.append(a))
    assert installer.login("codex") == "browser"
    assert popen["cmd"] == ["/fake/codex", "login"]
    assert popen["kw"]["start_new_session"] is True
    assert runs == []  # no osascript for the browser flow


@pytest.mark.parametrize("pid,binname,args", [
    ("claude", "claude", "/login"),
    ("gemini", "gemini", None),
    ("opencode", "opencode", "auth login"),
])
def test_login_terminal_providers_open_terminal_in_neutral_cwd(monkeypatch, pid,
                                                               binname, args):
    # §19: interactive TUI logins open Terminal.app via osascript, cd'ing into
    # the provider's empty workspace first so the CLI startup scan never walks ~.
    monkeypatch.setattr(harness, "resolve_bin", lambda b: f"/fake/{b}")
    runs = []
    monkeypatch.setattr(installer.subprocess, "run",
                        lambda cmd, **kw: runs.append(cmd))
    assert installer.login(pid) == "terminal"
    cmd = runs[-1]
    assert cmd[0] == "osascript"
    script = cmd[-1]
    expected = f"/fake/{binname}" + (f" {args}" if args else "")
    assert expected in script
    assert 'do script "cd ' in script
    assert harness._neutral_cwd(pid) in script


def test_login_requires_installed_binary(monkeypatch):
    monkeypatch.setattr(harness, "resolve_bin", lambda b: None)
    with pytest.raises(RuntimeError, match="isn't installed"):
        installer.login("claude")


# ---------- remaining per-provider recipes ----------

def test_opencode_recipe_pipes_installer_with_vendor_defaults(monkeypatch):
    calls = {}

    def fake_stream(cmd, emit, provider_id, env_extra=None):
        calls["cmd"], calls["env"] = cmd, env_extra

    monkeypatch.setattr(installer, "_stream_shell", fake_stream)
    monkeypatch.setattr(installer, "_require", lambda b: calls.setdefault("req", b))
    installer._install_opencode(lambda **k: None)
    assert calls["cmd"][:2] == ["/bin/bash", "-c"]
    assert installer.OPENCODE_INSTALLER in calls["cmd"][2]
    # §19: the live script ignores OPENCODE_INSTALL_DIR — vendor defaults only
    assert calls["env"] is None
    assert calls["req"] == "opencode"


def test_codex_recipe_pipes_official_installer_non_interactive(monkeypatch):
    calls = {}

    def fake_stream(cmd, emit, provider_id, env_extra=None):
        calls["cmd"], calls["env"] = cmd, env_extra

    monkeypatch.setattr(installer, "_stream_shell", fake_stream)
    monkeypatch.setattr(installer, "_require", lambda b: calls.setdefault("req", b))
    ensured = []
    monkeypatch.setattr(installer, "_ensure_login_path",
                        lambda emit: ensured.append(True))
    installer._install_codex(lambda **k: None)
    assert calls["cmd"] == ["/bin/bash", "-c",
                            f"curl -fsSL {installer.CODEX_INSTALLER} | sh"]
    # §19: no TTY on the backend — the script must never wait on a prompt
    assert calls["env"] == {"CODEX_NON_INTERACTIVE": "1"}
    assert calls["req"] == "codex"
    # the vendor symlink lands in ~/.local/bin → §19 guarantee runs
    assert ensured == [True]


def test_ollama_recipe_opens_app_and_waits_for_server_ready(monkeypatch):
    monkeypatch.setattr(installer, "_install_ollama_app",
                        lambda emit: "/apps/Ollama.app")
    monkeypatch.setattr(installer, "_require", lambda b: None)
    monkeypatch.setattr(installer.time, "sleep", lambda s: None)
    runs = []
    monkeypatch.setattr(installer.subprocess, "run",
                        lambda cmd, **kw: runs.append(list(cmd)))
    answers = [{"ready": False}, {"ready": True}]
    monkeypatch.setattr(harness, "ollama_status", lambda: answers.pop(0))
    installer._install_ollama(lambda **k: None)  # returns once ready flips
    assert answers == []
    # §19: the app is launched hidden — its menu-bar agent owns the server
    assert runs == [["open", "/apps/Ollama.app", "--args", "hidden"]]


def test_ollama_recipe_fails_when_server_never_starts(monkeypatch):
    monkeypatch.setattr(installer, "_install_ollama_app", lambda emit: "/apps/Ollama.app")
    monkeypatch.setattr(installer, "_require", lambda b: None)
    monkeypatch.setattr(installer.time, "sleep", lambda s: None)
    monkeypatch.setattr(installer.subprocess, "run", lambda cmd, **kw: None)
    monkeypatch.setattr(harness, "ollama_status", lambda: {"ready": False})
    with pytest.raises(RuntimeError, match="server didn't start"):
        installer._install_ollama(lambda **k: None)
