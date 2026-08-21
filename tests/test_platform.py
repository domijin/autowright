"""§2 platform layer: composition, capability flags, degraded fallbacks, and
the §5 per-OS root table (backend half of the drift guard — the Electron half
is app/tests/platform-roots.test.ts; both pin the same spec table)."""
from pathlib import Path

import pytest

from autowright import paths, platform, service
from autowright.platform import fallback


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
