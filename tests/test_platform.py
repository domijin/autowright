"""§2 platform layer: composition, capability flags, degraded fallbacks, and
the §5 per-OS root table (backend half of the drift guard — the Electron half
is app/tests/platform-roots.test.ts; both pin the same spec table)."""
from pathlib import Path

import pytest

from autowright import paths, platform, service
from autowright.platform import fallback, windows


# ---------------------------------------------------------------- composition

def test_darwin_build_composes_full_capabilities():
    plat = platform.current()  # test hosts are macOS (§15)
    assert plat.os_token == "macos"
    assert plat.capabilities.as_dict() == {
        "imessage": True, "notifications": True, "keepAwake": True, "service": True}


def test_fallback_build_flags_everything_off():
    plat = fallback.build("linux", "Linux")
    assert plat.os_token == "linux"
    assert plat.capabilities.as_dict() == {
        "imessage": False, "notifications": False, "keepAwake": False, "service": False}
    # The notifier and power assertion are silent no-ops, never raises.
    plat.notifier.post("t", "b")
    plat.power.reconcile(True)
    plat.power.reconcile(False)


def test_windows_build_composes_real_process_control():
    """§2 Windows groundwork: degraded service/notifier/power and all-false
    capabilities, but real tree-kill process control."""
    plat = windows.build("Windows")
    assert plat.os_token == "windows"
    assert plat.capabilities.as_dict() == {
        "imessage": False, "notifications": False, "keepAwake": False, "service": False}
    assert isinstance(plat.processes, windows.WindowsProcessControl)
    assert plat.service.install() == "install failed: not supported on Windows yet"
    plat.notifier.post("t", "b")
    plat.power.reconcile(True)


def test_current_routes_windows_token_to_groundwork_build(monkeypatch):
    monkeypatch.setattr(paths, "current_os", lambda: "windows")
    platform.current.cache_clear()
    try:
        assert isinstance(platform.current().processes, windows.WindowsProcessControl)
    finally:
        platform.current.cache_clear()


def test_windows_session_kwargs_are_a_new_process_group():
    kwargs = windows.WindowsProcessControl().session_kwargs()
    # The Win32 CREATE_NEW_PROCESS_GROUP flag; no POSIX-only Popen kwargs.
    assert kwargs == {"creationflags": 0x00000200}


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


def test_windows_pid_reuse_guard_answers_false():
    """§3: no pid+creation-time identity check yet — orphan recovery must
    no-op rather than kill an unverifiable tree."""
    assert windows.WindowsProcessControl().group_has_command(99, "autowright.executor") is False


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
    body = client.get("/health").json()
    assert body["os"] == "macos"
    assert body["capabilities"] == {
        "imessage": True, "notifications": True, "keepAwake": True, "service": True}
    assert body["app"] == "Autowright" and body["version"]
