"""launchd LaunchAgent management (§3): install/status/uninstall.

launchctl is never touched — every subprocess.run is a recorded fake, and
plist_path is redirected into the per-test home.
"""
import json
import os
import plistlib
import sys
from types import SimpleNamespace

import pytest


@pytest.fixture()
def svc(home, monkeypatch):
    """service module with plist_path in tmp home and subprocess.run recorded."""
    from autowright import service

    plist = home / "LaunchAgents" / f"{service.LABEL}.plist"
    monkeypatch.setattr(service, "plist_path", lambda: plist)
    shim = home / "bin" / "autowright"
    monkeypatch.setattr(service, "shim_path", lambda: shim)

    calls = []
    results = {}  # verb ("bootstrap"/"bootout"/"load"/"unload"/"list") → canned result
    registered = {"job": False}  # launchd's view, driven by the verbs below

    def fake_run(cmd, **kw):
        calls.append(list(cmd))
        assert cmd[0] == "launchctl"
        verb = cmd[1]
        # `print` answers from the modeled launchd state — the §3 unload poll
        # and load verification depend on it flipping with the other verbs.
        if verb == "print":
            return SimpleNamespace(returncode=0 if registered["job"] else 113,
                                   stdout="", stderr="")
        r = results.get(verb, SimpleNamespace(returncode=0, stdout="", stderr=""))
        if r.returncode == 0:
            if verb in ("bootout", "unload"):
                registered["job"] = False
            elif verb in ("bootstrap", "load"):
                registered["job"] = True
        return r

    monkeypatch.setattr(service.subprocess, "run", fake_run)

    def actions():
        """Recorded calls minus the `print` state probes."""
        return [c for c in calls if c[1] != "print"]

    return SimpleNamespace(mod=service, plist=plist, shim=shim, calls=calls,
                           results=results, actions=actions)


def _gui_domain():
    return f"gui/{os.getuid()}"


# ---------------------------------------------------------------- install

def test_install_writes_plist_and_reloads(svc):
    out = svc.mod.install()
    assert str(svc.plist) in out and out.startswith("installed and started")

    with open(svc.plist, "rb") as f:
        plist = plistlib.load(f)
    assert plist["Label"] == "com.autowright.backend"
    assert plist["ProgramArguments"] == [sys.executable, "-m", "autowright.main"]
    assert plist["RunAtLoad"] is True
    assert plist["KeepAlive"] is True

    # stop-then-start, in that order: modern bootout/bootstrap against the
    # per-user gui domain (the legacy verbs are fallbacks, not tried when the
    # modern ones succeed)
    assert svc.actions() == [
        ["launchctl", "bootout", f"{_gui_domain()}/{svc.mod.LABEL}"],
        ["launchctl", "bootstrap", _gui_domain(), str(svc.plist)],
    ]


# ---------------------------------------------------------------- CLI shim

def test_install_writes_cli_shim(svc):
    out = svc.mod.install()
    assert f"CLI at {svc.shim}" in out
    text = svc.shim.read_text()
    assert text.startswith("#!/bin/sh\n")
    assert svc.mod.SHIM_MARKER in text
    assert f'exec "{sys.executable}" -m autowright.cli "$@"' in text
    assert svc.shim.stat().st_mode & 0o111  # executable


def test_install_survives_unwritable_shim_dir(svc):
    # §3: no sudo anywhere — a root-owned /usr/local/bin skips the shim with a
    # manual-invocation note; registration itself still succeeds.
    svc.shim.parent.mkdir(parents=True)
    svc.shim.parent.chmod(0o555)
    try:
        out = svc.mod.install()
    finally:
        svc.shim.parent.chmod(0o755)
    assert out.startswith("installed and started")
    assert "CLI shim not written" in out
    assert f"{sys.executable} -m autowright.cli" in out
    assert not svc.shim.exists()


def test_install_rewrites_existing_shim(svc):
    # A moved bundle or dev↔prod switch heals through re-install (§3).
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(f"#!/bin/sh\n{svc.mod.SHIM_MARKER}\n"
                        f'exec "/old/gone/python3" -m autowright.cli "$@"\n')
    svc.mod.install()
    assert f'"{sys.executable}"' in svc.shim.read_text()


def test_uninstall_removes_own_shim(svc):
    svc.mod.install()
    assert svc.shim.exists()
    svc.mod.uninstall()
    assert not svc.shim.exists()


def test_uninstall_leaves_foreign_shim_alone(svc):
    # No marker → not ours → never touched (§3).
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text("#!/bin/sh\necho someone else's autowright\n")
    svc.mod.uninstall()
    assert svc.shim.exists()


def test_install_falls_back_to_legacy_load(svc):
    # A box where the modern verbs fail (or an old macOS): legacy unload/load
    # still bootstraps the service.
    svc.results["bootout"] = SimpleNamespace(returncode=1, stdout="", stderr="")
    svc.results["bootstrap"] = SimpleNamespace(returncode=5, stdout="",
                                               stderr="Bootstrap failed: 5\n")
    out = svc.mod.install()
    assert out.startswith("installed and started")
    assert ["launchctl", "unload", str(svc.plist)] in svc.calls
    assert ["launchctl", "load", str(svc.plist)] in svc.calls


def test_install_reports_failed_load(svc):
    svc.results["bootstrap"] = SimpleNamespace(returncode=5, stdout="",
                                               stderr="Bootstrap failed: 5\n")
    svc.results["load"] = SimpleNamespace(returncode=1, stdout="",
                                          stderr="Load failed: 5\n")
    out = svc.mod.install()
    assert out == "install failed: Bootstrap failed: 5"
    assert svc.plist.exists()  # plist written before the load attempt


# ---------------------------------------------------------------- status

def _list_result(stdout):
    return SimpleNamespace(returncode=0, stdout=stdout, stderr="")


def test_status_parses_active_pid_and_port(svc, home):
    svc.results["list"] = _list_result(
        "PID\tStatus\tLabel\n"
        "77\t0\tcom.apple.other\n"
        "1234\t0\tcom.autowright.backend\n")
    from autowright import paths

    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "t"}))
    assert svc.mod.status() == "active (pid 1234) · port 5151"


def test_status_loaded_not_active(svc):
    svc.results["list"] = _list_result("-\t0\tcom.autowright.backend\n")
    assert svc.mod.status() == "loaded, not active (pid -)"


def test_status_not_installed(svc):
    svc.results["list"] = _list_result("1\t0\tcom.apple.other\n")
    assert svc.mod.status() == "not installed"


def test_status_tolerates_stale_or_garbage_backend_json(svc):
    svc.results["list"] = _list_result("42\t0\tcom.autowright.backend\n")
    from autowright import paths

    bj = paths.backend_json()
    for garbage in ('{"port": 51', "not json at all", json.dumps({"token": "t"}),
                    ""):
        bj.write_text(garbage)
        assert svc.mod.status() == "active (pid 42) · stale backend.json"


# ---------------------------------------------------------------- uninstall

def test_uninstall_removes_plist_and_unloads(svc):
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    assert svc.mod.uninstall() == "service unloaded and removed"
    assert not svc.plist.exists()
    assert svc.actions() == [["launchctl", "bootout", f"{_gui_domain()}/{svc.mod.LABEL}"]]


def test_uninstall_when_not_installed(svc):
    assert svc.mod.uninstall() == "service was not installed"
    # the stop is still attempted (harmless), plist untouched
    assert svc.actions() == [["launchctl", "bootout", f"{_gui_domain()}/{svc.mod.LABEL}"]]


# ------------------------------------------------- §3 discovery guard (main.py)

def test_republish_rewrites_missing_file(home):
    from autowright import main as backend_main, paths

    payload = json.dumps({"port": 1, "token": "t", "version": "x", "pid": 42})
    paths.backend_json().unlink(missing_ok=True)
    assert backend_main.republish_if_lost(payload) is True
    assert json.loads(paths.backend_json().read_text())["pid"] == 42
    assert (paths.backend_json().stat().st_mode & 0o777) == 0o600


def test_republish_recreates_wiped_home(home):
    import shutil

    from autowright import main as backend_main, paths

    shutil.rmtree(home)
    assert backend_main.republish_if_lost(json.dumps({"port": 1})) is True
    assert paths.backend_json().exists()
    assert paths.automations_dir().is_dir()  # ensure_dirs ran first


def test_republish_rewrites_corrupt_file(home):
    from autowright import main as backend_main, paths

    paths.backend_json().write_text('{"port": 12')  # SIGKILL-style truncation
    assert backend_main.republish_if_lost('{"port": 1}') is True
    assert json.loads(paths.backend_json().read_text()) == {"port": 1}


def test_republish_leaves_any_valid_file_alone(home):
    from autowright import main as backend_main, paths

    # A valid file holding another pid may be the successor's during a
    # service restart — never clobber it.
    paths.backend_json().write_text(json.dumps({"port": 9, "pid": 999}))
    assert backend_main.republish_if_lost('{"port": 1}') is False
    assert json.loads(paths.backend_json().read_text())["port"] == 9


# ------------------------------------------------- §5 log size cap (main.py)

def test_trim_logs_drops_oldest_lines(home, monkeypatch):
    from autowright import main as backend_main, paths

    monkeypatch.setattr(backend_main, "LOG_CAP", 1000)
    monkeypatch.setattr(backend_main, "LOG_TRIM_TO", 500)
    log = paths.app_log()
    lines = [f"line {i:04d}\n".encode() for i in range(200)]  # 2000 bytes
    log.write_bytes(b"".join(lines))
    backend_main.trim_logs()
    kept = log.read_bytes()
    assert len(kept) < 500  # trimmed to the target, minus the partial first line
    assert kept.startswith(b"line ")  # cut at a line boundary
    assert kept.endswith(b"line 0199\n")  # newest lines survive


def test_trim_logs_leaves_small_and_missing_files_alone(home, monkeypatch):
    from autowright import main as backend_main, paths

    monkeypatch.setattr(backend_main, "LOG_CAP", 1000)
    monkeypatch.setattr(backend_main, "LOG_TRIM_TO", 500)
    log = paths.logs_dir() / "backend.out.log"
    log.write_bytes(b"small\n" * 10)
    backend_main.trim_logs()  # backend.err.log missing — must not raise
    assert log.read_bytes() == b"small\n" * 10
