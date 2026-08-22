"""§2 platform layer: composition, capability flags, degraded fallbacks, and
the §5 per-OS root table (backend half of the drift guard — the Electron half
is app/tests/platform-roots.test.ts; both pin the same spec table)."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from autowright import paths, platform, service
from autowright.platform import darwin, fallback, windows


# ---------------------------------------------------------------- composition

def test_darwin_build_composes_full_capabilities():
    """darwin.build() composes on any host (the module imports everywhere), so
    the macOS table is pinned wherever the suite runs."""
    plat = darwin.build()
    assert plat.os_token == "macos"
    assert plat.capabilities.as_dict() == {
        "imessage": True, "notifications": True, "keepAwake": True, "service": True,
        "agentInstall": True}
    assert isinstance(plat.service, darwin.LaunchdService)
    assert isinstance(plat.notifier, darwin.OsascriptNotifier)
    assert isinstance(plat.power, darwin.CaffeinatePower)


# What each §2 build composes, keyed by §5.1 platform token — the one table the
# host-dependent assertions below read, so they state a per-OS truth instead of
# assuming the suite runs on a Mac.
#
# Windows `notifications` is the one entry that is not a constant: §3 makes it a
# *probe* (a toast needs the AUMID a §3 NSIS install registers), so the table
# states the rule — "whatever the probe answers on this machine" — and the
# probe's own behavior is pinned by the dedicated tests below and in
# tests/test_notify.py. A dev machine without the installed app answers False.
EXPECTED_CAPABILITIES = {
    "macos": {"imessage": True, "notifications": True, "keepAwake": True,
              "service": True, "agentInstall": True},
    "windows": {"imessage": False, "notifications": windows._aumid_registered(),
                "keepAwake": True, "service": True, "agentInstall": False},
    "linux": {"imessage": False, "notifications": False, "keepAwake": False,
              "service": False, "agentInstall": False},
}


def test_current_composes_this_hosts_platform():
    """§2: `current()` picks the build for the host it runs on, and its
    capability table is that build's."""
    plat = platform.current()
    assert plat.os_token == paths.current_os()
    assert plat.capabilities.as_dict() == EXPECTED_CAPABILITIES[plat.os_token]


def test_fallback_build_flags_everything_off():
    plat = fallback.build("linux", "Linux")
    assert plat.os_token == "linux"
    assert plat.capabilities.as_dict() == {
        "imessage": False, "notifications": False, "keepAwake": False, "service": False,
        "agentInstall": False}
    # The notifier and both power assertions are silent no-ops, never raise.
    plat.notifier.post("t", "b")
    plat.power.reconcile(True)
    plat.power.reconcile(False)
    release = plat.power.hold_execution()
    release()
    release()  # double release is harmless


def test_windows_build_composes_real_service_process_control_and_power():
    """§2/§3: every Windows implementation is real now — the Task Scheduler
    service manager, tree-kill process control, the keepAwake assertion and the
    WinRT toast notifier."""
    plat = windows.build("Windows")
    assert plat.os_token == "windows"
    assert plat.capabilities.as_dict() == EXPECTED_CAPABILITIES["windows"]
    assert isinstance(plat.service, windows.WindowsService)
    assert isinstance(plat.processes, windows.WindowsProcessControl)
    assert isinstance(plat.power, windows.WindowsPower)
    assert isinstance(plat.notifier, windows.WindowsNotifier)


def test_windows_notifications_capability_is_probed_not_assumed(monkeypatch):
    """§3: `notifications` is true only where the AUMID is registered — a
    packaged install's Start-menu shortcut. The notifier itself is composed
    either way (posting where the id is unknown is harmless, and silent)."""
    monkeypatch.setattr(windows, "_aumid_registered", lambda: True)
    plat = windows.build("Windows")
    assert plat.capabilities.notifications is True
    assert isinstance(plat.notifier, windows.WindowsNotifier)

    monkeypatch.setattr(windows, "_aumid_registered", lambda: False)
    plat = windows.build("Windows")
    assert plat.capabilities.notifications is False
    assert isinstance(plat.notifier, windows.WindowsNotifier)


def test_current_routes_windows_token_to_groundwork_build(monkeypatch):
    monkeypatch.setattr(paths, "current_os", lambda: "windows")
    platform.current.cache_clear()
    try:
        assert isinstance(platform.current().processes, windows.WindowsProcessControl)
    finally:
        platform.current.cache_clear()


def test_windows_session_kwargs_are_a_new_process_group_with_no_window():
    kwargs = windows.WindowsProcessControl().session_kwargs()
    # The Win32 CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW flags (§2 spawn
    # policy: a console child of the pythonw backend must not open a terminal
    # window); no POSIX-only Popen kwargs.
    assert kwargs == {"creationflags": 0x00000200 | 0x08000000}


def test_windows_kill_group_is_a_taskkill_tree_kill(monkeypatch):
    ran = []
    monkeypatch.setattr(windows.subprocess, "run",
                        lambda argv, **kw: ran.append(argv))
    windows.WindowsProcessControl().kill_group(1234)
    assert ran == [["taskkill", "/F", "/T", "/PID", "1234"]]


def test_windows_signal_group_kills_tree_then_direct_child(monkeypatch):
    """Both grades (sig set or None) collapse to the tree kill, and a child
    the tree kill didn't reap is killed directly."""
    ran = []
    monkeypatch.setattr(windows.subprocess, "run",
                        lambda argv, **kw: ran.append(argv))

    class Proc:
        pid = 77
        killed = False

        def poll(self):
            return None

        def kill(self):
            self.killed = True

    for sig in (None, 15):
        proc = Proc()
        windows.WindowsProcessControl().signal_group(proc, sig)
        assert proc.killed
    assert ran == [["taskkill", "/F", "/T", "/PID", "77"]] * 2


# ------------------------------------------------- §3 Windows power assertion

SET_AWAKE = 0x80000000 | 0x00000001  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
CLEAR = 0x80000000                   # ES_CONTINUOUS alone — never ES_DISPLAY_REQUIRED


@pytest.fixture()
def win_power(monkeypatch):
    """A WindowsPower whose SetThreadExecutionState is a recorder. The real
    calls happen on the class's dedicated thread, so every assertion waits for
    the queue to drain first."""
    calls: list[int] = []
    monkeypatch.setattr(windows, "_set_thread_execution_state",
                        lambda flags: (calls.append(flags), True)[1])
    power = windows.WindowsPower()

    def settled() -> list[int]:
        power._wait_idle()
        return calls

    return power, settled


def test_windows_power_permanent_hold_is_counted_and_idempotent(win_power):
    """§3/§4.9: reconcile(True) sets the state once; a second reconcile(True)
    is not a second hold, and an execution hold on top adds no extra call."""
    power, settled = win_power
    power.reconcile(True)
    assert settled() == [SET_AWAKE]
    power.reconcile(True)
    assert settled() == [SET_AWAKE]  # idempotent — still one set
    release = power.hold_execution()
    assert settled() == [SET_AWAKE]  # already asserted; nothing to change
    release()
    assert settled() == [SET_AWAKE]  # the permanent hold still stands
    power.reconcile(False)
    assert settled() == [SET_AWAKE, CLEAR]  # last hold gone → cleared


def test_windows_power_execution_hold_alone_sets_and_clears(win_power):
    """§3 per-execution hold with keepAwake off: one set on acquire, one
    clear on release, and a double release drops nothing extra."""
    power, settled = win_power
    release = power.hold_execution()
    assert settled() == [SET_AWAKE]
    second = power.hold_execution()
    assert settled() == [SET_AWAKE]  # count 1 → 2, state unchanged
    release()
    release()  # double release is a no-op — the second hold still holds
    assert settled() == [SET_AWAKE]
    second()
    assert settled() == [SET_AWAKE, CLEAR]


def test_windows_power_reconcile_off_with_no_holds_is_silent(win_power):
    """Turning an assertion that was never on off again changes nothing."""
    power, settled = win_power
    power.reconcile(False)
    assert settled() == []


def test_windows_power_is_silent_when_the_setter_fails(monkeypatch):
    """A SetThreadExecutionState that answers False (or no Win32 at all, the
    POSIX test host) degrades silently — nothing here ever raises."""
    monkeypatch.setattr(windows, "_set_thread_execution_state", lambda flags: False)
    power = windows.WindowsPower()
    power.reconcile(True)
    release = power.hold_execution()
    release()
    power.reconcile(False)
    power._wait_idle()


def test_windows_pid_reuse_guard_answers_false():
    """§3: no pid+creation-time identity check yet — orphan recovery must
    no-op rather than kill an unverifiable tree."""
    assert windows.WindowsProcessControl().group_has_command(99, "autowright.executor") is False


# ------------------------------------------ §3 Windows service: Task Scheduler
#
# powershell.exe never runs here: the `task_scheduler` fixture (conftest.py)
# swaps `windows._powershell` for a recorder that models Task Scheduler's
# state, so every test below runs on any host.

TASK = "ai.autowright.backend"
_CMDLETS = ("Unregister-ScheduledTask", "Register-ScheduledTask",
            "Start-ScheduledTask", "Stop-ScheduledTask", "Get-ScheduledTask")


def _cmdlets(scripts):
    """The operation each recorded PowerShell script performs, in order."""
    out = []
    for script in scripts:
        out.append(next((c for c in _CMDLETS if c in script), script))
    return out


@pytest.fixture()
def win_service(task_scheduler, monkeypatch):
    """The Task Scheduler double plus a pinned action program, so the result
    lines and registration script read the same on every host."""
    monkeypatch.setattr(windows, "_backend_program",
                        lambda: (r"C:\Program Files\Autowright\pythonw.exe", None))
    return task_scheduler


def _no_shim_note():
    return f"CLI not installed — use `{sys.executable} -m autowright.cli`"


def test_windows_install_registers_starts_and_verifies(win_service):
    out = win_service.service.install()
    assert out == (f"installed and started (Task Scheduler task {TASK}) · "
                   f"{_no_shim_note()}")
    assert service.result_code(out) == 0
    assert win_service.task["state"] == "Running"
    # Stop-then-register-then-start (the launchd unload/load shape), then the
    # state read that verifies it actually started.
    assert _cmdlets(win_service.scripts) == [
        "Stop-ScheduledTask", "Register-ScheduledTask", "Start-ScheduledTask",
        "Get-ScheduledTask"]


def test_windows_registration_pins_the_launchd_equivalents(win_service):
    win_service.service.install()
    reg = next(s for s in win_service.scripts
               if "Register-ScheduledTask" in s and "Unregister" not in s)
    # RunAtLoad → -AtLogOn (this user only); KeepAlive → restart-on-failure.
    assert ("New-ScheduledTaskAction -Execute "
            r"'C:\Program Files\Autowright\pythonw.exe' "
            "-Argument '-m autowright.main'") in reg
    assert "New-ScheduledTaskTrigger -AtLogOn -User $user" in reg
    assert "-RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)" in reg
    # A long-lived backend: no 3-day execution kill, no battery gating.
    assert "-ExecutionTimeLimit ([TimeSpan]::Zero)" in reg
    assert "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries" in reg
    assert "-StartWhenAvailable" in reg
    assert f"Register-ScheduledTask -TaskName '{TASK}'" in reg and "-Force" in reg
    assert '"' not in reg  # single-quoted PS literals only — nothing to mangle


def test_windows_install_never_claims_success_for_a_task_that_never_started(win_service):
    """§3 launchd reality (b), mapped: the cmdlets can accept everything and
    leave the job unstarted — success is the state Task Scheduler reports."""
    win_service.canned["Start-ScheduledTask"] = (0, f"{windows._OK}\n", "")
    out = win_service.service.install()
    assert out == "install failed: the task is registered but did not start (state Ready)"
    assert service.result_code(out) == 1


def test_windows_install_reports_a_failed_registration(win_service):
    win_service.canned["Register-ScheduledTask"] = (
        1, "", "Register-ScheduledTask : Access is denied.\nAt line:1 char:1\n")
    out = win_service.service.install()
    assert out == "install failed: Register-ScheduledTask : Access is denied."
    assert service.result_code(out) == 1


def test_windows_backend_program_prefers_pythonw(monkeypatch, tmp_path):
    """§3: pythonw.exe beside this interpreter (venv Scripts\\ and the flat
    python-build-standalone layout both have it) — no console window flashes at
    logon. A layout without it still registers, with the reason on the line."""
    from types import SimpleNamespace

    exe = tmp_path / "python.exe"
    exe.write_text("")
    pythonw = tmp_path / "pythonw.exe"
    pythonw.write_text("")
    # The module's own `sys` reference, so nothing global moves under a
    # concurrently running thread.
    monkeypatch.setattr(windows, "sys", SimpleNamespace(executable=str(exe)))
    assert windows._backend_program() == (str(pythonw), None)
    pythonw.unlink()
    program, note = windows._backend_program()
    assert program == str(exe)
    assert note == ("no pythonw.exe beside python.exe — running it directly "
                    "(a console window may flash at logon)")


def test_windows_status_three_states(win_service, home):
    from autowright import paths

    out = win_service.service.status()
    assert out == "not installed" and service.result_code(out) == 1

    win_service.task["state"] = "Ready"
    out = win_service.service.status()
    assert out == "stopped (task present) — returns at next logon or app launch"
    assert service.result_code(out) == 0  # stopped on purpose is not a failure

    win_service.task["state"] = "Running"
    assert win_service.service.status() == "active (task running)"
    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "t"}))
    assert win_service.service.status() == "active (task running) · port 5151"
    paths.backend_json().write_text('{"port": 51')  # SIGKILL-style truncation
    assert win_service.service.status() == "active (task running) · stale backend.json"


def test_windows_stop_keeps_the_task_registered(win_service):
    """§3 quit-entirely backend half: the task stays registered and returns at
    the next logon — the Windows form of launchd's bootout-only rule."""
    win_service.task["state"] = "Running"
    out = win_service.service.stop()
    assert out == "stopped — returns at next logon or app launch"
    assert service.result_code(out) == 0
    assert win_service.task["state"] == "Ready"  # still registered
    assert "Unregister-ScheduledTask" not in _cmdlets(win_service.scripts)


def test_windows_stop_when_not_installed(win_service):
    out = win_service.service.stop()
    assert out == "not installed — nothing to stop"
    assert service.result_code(out) == 1
    assert "Stop-ScheduledTask" not in _cmdlets(win_service.scripts)


def test_windows_stop_reports_a_task_that_is_still_running(win_service):
    """§3: stop reports failure when the job is still there afterwards — the
    app must not quit its UI while the backend it promised to stop lives on."""
    win_service.task["state"] = "Running"
    win_service.canned["Stop-ScheduledTask"] = (0, f"{windows._OK}\n", "")
    out = win_service.service.stop()
    assert out == "stop failed: the task is still running"
    assert service.result_code(out) == 1


def test_windows_restart_stops_then_starts(win_service):
    win_service.task["state"] = "Running"
    out = win_service.service.restart()
    assert out == "restarted" and service.result_code(out) == 0
    assert win_service.task["state"] == "Running"
    assert _cmdlets(win_service.scripts) == [
        "Get-ScheduledTask",   # registered?
        "Stop-ScheduledTask", "Get-ScheduledTask",   # stopped?
        "Start-ScheduledTask", "Get-ScheduledTask"]  # started?


def test_windows_restart_when_not_installed(win_service):
    out = win_service.service.restart()
    assert out == "not installed — use `autowright service install` first"
    assert service.result_code(out) == 1


def test_windows_uninstall_stops_and_unregisters(win_service):
    win_service.task["state"] = "Running"
    out = win_service.service.uninstall()
    assert out == "service stopped and unregistered"
    assert service.result_code(out) == 0
    assert win_service.task["state"] == "absent"
    assert _cmdlets(win_service.scripts) == [
        "Get-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask"]


def test_windows_uninstall_when_not_installed(win_service):
    out = win_service.service.uninstall()
    assert out == "service was not installed"
    assert service.result_code(out) == 0  # nothing to remove is not a failure


def test_windows_powershell_calls_are_time_boxed_and_utf8(monkeypatch):
    """§3: a wedged PowerShell must answer an ordinary failure line (exit 1),
    never hang the caller (the app's ensure-backend step waits on this) and
    never raise TimeoutExpired. §2: pipes are explicit UTF-8."""
    calls = []

    def wedged(argv, **kw):
        calls.append((argv, kw))
        raise subprocess.TimeoutExpired(argv, kw["timeout"])

    monkeypatch.setattr(windows.subprocess, "run", wedged)
    monkeypatch.setattr(windows, "_POLL_INTERVAL_S", 0)
    svc = windows.WindowsService()
    for verb in ("install", "uninstall", "status", "stop", "restart"):
        out = getattr(svc, verb)()
        assert out == f"{verb} failed: PowerShell timed out"
        assert service.result_code(out) == 1
    argv, kw = calls[0]
    assert argv[:6] == ["powershell.exe", "-NoProfile", "-NonInteractive",
                        "-OutputFormat", "Text", "-Command"]
    assert kw["timeout"] == windows.POWERSHELL_TIMEOUT_S == 30
    assert kw["capture_output"] is True
    assert kw["encoding"] == "utf-8" and kw["errors"] == "replace"
    assert kw["creationflags"] == windows._NO_WINDOW  # §2 spawn policy


def test_windows_missing_powershell_is_a_plain_failure_line(monkeypatch):
    def missing(argv, **kw):
        raise FileNotFoundError(2, "The system cannot find the file specified")

    monkeypatch.setattr(windows.subprocess, "run", missing)
    out = windows.WindowsService().status()
    assert out.startswith("status failed: powershell.exe could not be run (")
    assert service.result_code(out) == 1


# ------------------------------------------------------ §3 Windows .cmd shim

def test_windows_shim_paths_and_text(monkeypatch, tmp_path):
    monkeypatch.delenv("AUTOWRIGHT_SHIM", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert windows.shim_paths() == [
        tmp_path / "Local" / "Autowright" / "bin" / "autowright.cmd"]
    # §15 knob (mirrored in electron/main.cjs): tests never touch the real one.
    monkeypatch.setenv("AUTOWRIGHT_SHIM", str(tmp_path / "elsewhere" / "aw.cmd"))
    assert windows.shim_paths() == [tmp_path / "elsewhere" / "aw.cmd"]
    # Byte-for-byte the shell's win32.cjs form: CRLF, marker, module form.
    assert windows.shim_text() == (
        f"@echo off\r\nrem autowright CLI shim\r\n"
        f'"{sys.executable}" -m autowright.cli %*\r\n')


def test_ps_literal_doubles_embedded_quotes():
    assert windows._ps_literal(r"C:\Bob's Files\py.exe") == r"'C:\Bob''s Files\py.exe'"


def test_windows_install_heals_our_shim(win_service):
    """§3: ours (marker) + another interpreter → rewritten in place."""
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(f"@echo off\r\n{windows.SHIM_MARKER}\r\n"
                     '"C:\\old\\gone\\pythonw.exe" -m autowright.cli %*\r\n'.encode())
    out = win_service.service.install()
    assert f"CLI at {shim}" in out
    raw = shim.read_bytes()
    assert raw == windows.shim_text().encode()
    assert b"\r\r\n" not in raw and raw.endswith(b"%*\r\n")  # CRLF exactly once
    assert f'"{sys.executable}" -m autowright.cli %*' in raw.decode()


def test_windows_install_reports_a_current_shim(win_service):
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(windows.shim_text().encode())
    assert f"CLI at {shim}" in win_service.service.install()


def test_windows_install_never_creates_a_shim(win_service):
    # §3: creation is the Electron shell's cli-install flow; install only heals.
    out = win_service.service.install()
    assert _no_shim_note() in out
    assert not win_service.shim.exists()


def test_windows_install_leaves_a_foreign_cmd_alone(win_service):
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(b"@echo off\r\necho someone else's autowright\r\n")
    out = win_service.service.install()
    assert f"foreign {shim} left alone" in out
    assert b"someone else" in shim.read_bytes()


def test_windows_install_leaves_an_undecodable_file_alone(win_service):
    payload = b"\x00\x80\xff not utf-8"
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(payload)
    out = win_service.service.install()
    assert out.startswith("installed and started")
    assert shim.read_bytes() == payload


def test_windows_uninstall_removes_our_shim(win_service):
    win_service.task["state"] = "Ready"
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(windows.shim_text().encode())
    assert win_service.service.uninstall() == "service stopped and unregistered"
    assert not shim.exists()


def test_windows_uninstall_leaves_a_foreign_cmd_alone(win_service):
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(b"@echo off\r\necho someone else's autowright\r\n")
    win_service.service.uninstall()
    assert shim.exists()


def test_windows_uninstall_reports_an_undeletable_shim(win_service, monkeypatch):
    shim = win_service.shim
    shim.parent.mkdir(parents=True)
    shim.write_bytes(windows.shim_text().encode())

    def refuse(self):
        raise OSError("in use")

    monkeypatch.setattr(Path, "unlink", refuse)
    out = win_service.service.uninstall()
    assert f"CLI shim left at {shim}" in out and "couldn't delete" in out
    assert service.result_code(out) == 0  # informational, after the "·"


# ---------------------------------------------------- §3 degraded service verbs

def test_fallback_service_answers_plain_failure_lines():
    svc = fallback.build("windows", "Windows").service
    for verb in ("install", "uninstall", "status", "stop", "restart"):
        out = getattr(svc, verb)()
        assert out == f"{verb} failed: not supported on Windows yet"
        assert service.result_code(out) == 1  # §3 exit-code rule


def test_service_actions_route_through_platform(monkeypatch):
    """§2: `python -m autowright.service <verb>` and the §20 wrapper go through
    the composed ServiceManager — on an unsupported OS they degrade to the
    plain failure line instead of crashing on a missing launchctl."""
    monkeypatch.setattr(service.platform, "current",
                        lambda: fallback.build("linux", "Linux"))
    assert service.ACTIONS["install"]() == "install failed: not supported on Linux yet"
    assert service.main(["install"]) == 1


# ---------------------------------------------------------- §5 per-OS root table

@pytest.fixture()
def bare_home(monkeypatch, tmp_path):
    """Roots resolve from the OS defaults: no AUTOWRIGHT_HOME, a pinned home,
    and no XDG/Windows env overrides leaking in from the host."""
    monkeypatch.delenv("AUTOWRIGHT_HOME", raising=False)
    for var in ("XDG_DATA_HOME", "XDG_STATE_HOME", "LOCALAPPDATA"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def test_root_table_macos(bare_home, monkeypatch):
    monkeypatch.setattr(paths, "current_os", lambda: "macos")
    assert paths.app_support() == bare_home / "Library" / "Application Support" / "Autowright"
    assert paths.logs_dir() == bare_home / "Library" / "Logs" / "Autowright"


def test_root_table_linux_defaults_and_xdg(bare_home, monkeypatch):
    monkeypatch.setattr(paths, "current_os", lambda: "linux")
    assert paths.app_support() == bare_home / ".local" / "share" / "autowright"
    assert paths.logs_dir() == bare_home / ".local" / "state" / "autowright" / "log"
    monkeypatch.setenv("XDG_DATA_HOME", str(bare_home / "xdg-data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(bare_home / "xdg-state"))
    assert paths.app_support() == bare_home / "xdg-data" / "autowright"
    assert paths.logs_dir() == bare_home / "xdg-state" / "autowright" / "log"


def test_root_table_windows_defaults_and_localappdata(bare_home, monkeypatch):
    monkeypatch.setattr(paths, "current_os", lambda: "windows")
    assert paths.app_support() == bare_home / "AppData" / "Local" / "Autowright"
    assert paths.logs_dir() == bare_home / "AppData" / "Local" / "Autowright" / "Logs"
    monkeypatch.setenv("LOCALAPPDATA", str(bare_home / "LocalAppData"))
    assert paths.app_support() == bare_home / "LocalAppData" / "Autowright"
    assert paths.logs_dir() == bare_home / "LocalAppData" / "Autowright" / "Logs"


def test_autowright_home_overrides_every_os(monkeypatch, tmp_path):
    monkeypatch.setenv("AUTOWRIGHT_HOME", str(tmp_path / "override"))
    for token in ("macos", "linux", "windows"):
        monkeypatch.setattr(paths, "current_os", lambda token=token: token)
        assert paths.app_support() == tmp_path / "override"
        assert paths.logs_dir() == tmp_path / "override" / "logs"


# ------------------------------------------------------------- §19 /health

def test_health_serves_os_and_capabilities(client):
    plat = platform.current()
    body = client.get("/health").json()
    assert body["os"] == plat.os_token
    assert body["capabilities"] == plat.capabilities.as_dict()
    # …and what it serves is this host's real table, not an empty echo.
    assert body["capabilities"] == EXPECTED_CAPABILITIES[plat.os_token]
    assert body["app"] == "Autowright" and body["version"]
