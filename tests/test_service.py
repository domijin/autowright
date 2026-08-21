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
    # The single §3 shim location, redirected into the per-test home.
    shim = home / "bin" / "autowright"
    monkeypatch.setattr(service, "shim_paths", lambda: [shim])

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

    return SimpleNamespace(mod=service, plist=plist,
                           shim=shim,
                           calls=calls, results=results, actions=actions,
                           registered=registered)


def _gui_domain():
    return f"gui/{os.getuid()}"


# ---------------------------------------------------------------- install

def test_install_writes_plist_and_reloads(svc):
    out = svc.mod.install()
    assert str(svc.plist) in out and out.startswith("installed and started")

    with open(svc.plist, "rb") as f:
        plist = plistlib.load(f)
    assert plist["Label"] == "ai.autowright.backend"
    assert plist["ProgramArguments"] == [sys.executable, "-m", "autowright.main"]
    assert plist["RunAtLoad"] is True
    assert plist["KeepAlive"] is True

    # stop-then-start, in that order: modern bootout/bootstrap against the
    # per-user gui domain (the legacy verbs are fallbacks, not tried when the
    # modern ones succeed).
    assert svc.actions() == [
        ["launchctl", "bootout", f"{_gui_domain()}/{svc.mod.LABEL}"],
        ["launchctl", "bootstrap", _gui_domain(), str(svc.plist)],
    ]


def test_wedged_launchctl_times_out_into_a_plain_failure(svc, monkeypatch):
    """§3: every launchctl call is time-boxed — the app's ensure-backend step
    waits on this, so a wedged launchctl must report an ordinary failure line
    (exit 1) rather than hanging or raising TimeoutExpired at the caller."""
    import subprocess

    def wedged(cmd, **kw):
        assert kw["timeout"] == svc.mod.LAUNCHCTL_TIMEOUT_S  # bounded, every call
        raise subprocess.TimeoutExpired(cmd, kw["timeout"])

    monkeypatch.setattr(svc.mod.subprocess, "run", wedged)
    out = svc.mod.install()
    assert out == "install failed: launchctl timed out"
    assert svc.mod.result_code(out) == 1
    # and the read-only actions degrade instead of raising
    assert svc.mod.status() == "stopped (plist present) — returns at next login or app launch"
    assert svc.mod.restart() == "restart failed: launchctl timed out"


# ---------------------------------------------------------------- CLI shim

def test_install_never_creates_shim(svc):
    # §3: creation is the Electron shell's explicit privileged flow —
    # `service install` only heals. No shim → a manual-invocation note, and
    # registration itself still succeeds.
    out = svc.mod.install()
    assert out.startswith("installed and started")
    assert "CLI not installed" in out
    assert f"{sys.executable} -m autowright.cli" in out
    assert not svc.shim.exists()


def test_install_heals_existing_shim(svc):
    # A moved bundle or dev↔prod switch heals through re-install (§3): our
    # marker + user-writable → rewritten in place onto this interpreter.
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(f"#!/bin/sh\n{svc.mod.SHIM_MARKER}\n"
                        f'exec "/old/gone/python3" -m autowright.cli "$@"\n')
    out = svc.mod.install()
    assert f"CLI at {svc.shim}" in out
    text = svc.shim.read_text()
    assert text == svc.mod.shim_text()
    assert f'exec "{sys.executable}" -m autowright.cli "$@"' in text
    assert svc.shim.stat().st_mode & 0o111  # executable


def test_install_reports_current_shim(svc):
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(svc.mod.shim_text())
    assert f"CLI at {svc.shim}" in svc.mod.install()


def test_install_reports_unwritable_shim(svc):
    # Ours, wrong interpreter, not writable: reported with the module-form
    # fallback, never fatal (§3).
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(f"#!/bin/sh\n{svc.mod.SHIM_MARKER}\n"
                        f'exec "/old/gone/python3" -m autowright.cli "$@"\n')
    svc.shim.chmod(0o555)
    svc.shim.parent.chmod(0o555)
    try:
        out = svc.mod.install()
    finally:
        svc.shim.parent.chmod(0o755)
        svc.shim.chmod(0o755)
    assert out.startswith("installed and started")
    assert f"CLI shim at {svc.shim} not rewritable" in out
    assert f"{sys.executable} -m autowright.cli" in out


def test_install_leaves_foreign_shim_alone(svc):
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text("#!/bin/sh\necho someone else's autowright\n")
    out = svc.mod.install()
    assert f"foreign {svc.shim} left alone" in out
    assert "someone else" in svc.shim.read_text()


def test_install_leaves_undecodable_foreign_file_alone(svc):
    # §3: a non-UTF-8 file named autowright (some other tool's compiled
    # binary) can't carry the marker; install leaves it alone and still
    # succeeds, never a traceback (same tolerance as uninstall).
    payload = b"\x00\x80\xff not utf-8"
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_bytes(payload)
    out = svc.mod.install()
    assert out.startswith("installed and started")
    assert svc.shim.read_bytes() == payload


def test_shim_paths_env_knob(monkeypatch, home):
    # AUTOWRIGHT_SHIM (§15) overrides the location — tests and dev never
    # touch the real ~/.local/bin. Uses the real shim_paths (the svc fixture
    # replaces it, so no fixture here).
    from pathlib import Path

    from autowright import service

    monkeypatch.setenv("AUTOWRIGHT_SHIM", str(home / "elsewhere" / "aw"))
    assert service.shim_paths() == [home / "elsewhere" / "aw"]
    monkeypatch.delenv("AUTOWRIGHT_SHIM")
    assert service.shim_paths() == [Path.home() / ".local" / "bin" / "autowright"]


def test_install_heals_shim(svc):
    # Ours, pointing at another interpreter → rewritten in place (§3).
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(f"#!/bin/sh\n{svc.mod.SHIM_MARKER}\n"
                        f'exec "/old/gone/python3" -m autowright.cli "$@"\n')
    out = svc.mod.install()
    assert f"CLI at {svc.shim}" in out
    assert svc.shim.read_text() == svc.mod.shim_text()


def test_uninstall_removes_own_shim(svc):
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(svc.mod.shim_text())
    svc.mod.uninstall()
    assert not svc.shim.exists()


def test_uninstall_reports_undeletable_shim(svc):
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(svc.mod.shim_text())
    svc.shim.parent.chmod(0o555)  # deletion needs a directory write
    try:
        out = svc.mod.uninstall()
    finally:
        svc.shim.parent.chmod(0o755)
    assert f"CLI shim left at {svc.shim}" in out and "couldn't delete" in out
    assert svc.shim.exists()


def test_uninstall_leaves_foreign_shim_alone(svc):
    # No marker → not ours → never touched (§3).
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text("#!/bin/sh\necho someone else's autowright\n")
    svc.mod.uninstall()
    assert svc.shim.exists()


# ------------------------------------------- `python -m autowright.service`

def test_main_dispatches_and_prints(svc, capsys):
    assert svc.mod.main(["install"]) == 0
    assert "installed and started" in capsys.readouterr().out


def test_main_rejects_bad_usage(svc, capsys):
    assert svc.mod.main([]) == 2
    assert svc.mod.main(["frobnicate"]) == 2
    assert "usage:" in capsys.readouterr().err


def test_main_exit_code_on_failure(svc, capsys):
    svc.results["bootstrap"] = SimpleNamespace(returncode=5, stdout="",
                                               stderr="Bootstrap failed: 5\n")
    svc.results["load"] = SimpleNamespace(returncode=1, stdout="",
                                          stderr="Load failed: 5\n")
    assert svc.mod.main(["install"]) == 1


def test_result_code_from_real_action_output(svc, capsys):
    # §3/§20: result_code is the one exit-code rule, shared by main() and the
    # CLI `service` wrapper; probe it against real action output.
    assert svc.mod.result_code(svc.mod.stop()) == 1       # no plist: not installed
    assert svc.mod.result_code(svc.mod.install()) == 0
    assert svc.mod.result_code(svc.mod.status()) == 0     # plist present: stopped, not a failure


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
        "1234\t0\tai.autowright.backend\n")
    from autowright import paths

    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "t"}))
    assert svc.mod.status() == "active (pid 1234) · port 5151"


def test_status_loaded_not_active(svc):
    svc.results["list"] = _list_result("-\t0\tai.autowright.backend\n")
    assert svc.mod.status() == "loaded, not active (pid -)"


def test_status_not_installed(svc):
    svc.results["list"] = _list_result("1\t0\tcom.apple.other\n")
    assert svc.mod.status() == "not installed"


def test_status_stopped_with_plist_present(svc, capsys):
    # §3: unloaded job + plist on disk = stopped on purpose (`service stop`),
    # not "not installed" — and not a failure (exit 0).
    svc.results["list"] = _list_result("1\t0\tcom.apple.other\n")
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    assert svc.mod.status().startswith("stopped (plist present)")
    assert svc.mod.main(["status"]) == 0
    capsys.readouterr()


def test_status_not_installed_exits_nonzero(svc, capsys):
    svc.results["list"] = _list_result("1\t0\tcom.apple.other\n")
    assert svc.mod.main(["status"]) == 1
    capsys.readouterr()


def test_status_tolerates_stale_or_garbage_backend_json(svc):
    svc.results["list"] = _list_result("42\t0\tai.autowright.backend\n")
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


# ---------------------------------------------------------------- stop

def test_stop_unloads_but_keeps_plist_and_shim(svc):
    # §3 quit-entirely backend half: bootout only — plist and shim survive,
    # the service returns at next login or app launch.
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    svc.shim.parent.mkdir(parents=True)
    svc.shim.write_text(svc.mod.shim_text())
    out = svc.mod.stop()
    assert out.startswith("stopped")
    assert svc.plist.exists()
    assert svc.shim.exists()
    assert svc.actions() == [["launchctl", "bootout", f"{_gui_domain()}/{svc.mod.LABEL}"]]


def test_stop_when_not_installed(svc, capsys):
    assert svc.mod.stop().startswith("not installed")
    assert svc.actions() == []  # nothing to unload
    assert svc.mod.main(["stop"]) == 1
    capsys.readouterr()


def test_main_dispatches_stop(svc, capsys):
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    assert svc.mod.main(["stop"]) == 0
    assert "stopped" in capsys.readouterr().out


def test_stop_failed_when_still_registered(svc, monkeypatch, capsys):
    # launchd refuses both bootout and legacy unload and keeps the job:
    # stop must report failure (exit 1) — the app then must not quit (§3).
    monkeypatch.setattr(svc.mod.time, "sleep", lambda _s: None)
    svc.plist.parent.mkdir(parents=True, exist_ok=True)
    svc.plist.write_bytes(b"<plist/>")
    svc.registered["job"] = True
    svc.results["bootout"] = SimpleNamespace(returncode=1, stdout="", stderr="")
    svc.results["unload"] = SimpleNamespace(returncode=1, stdout="", stderr="")
    assert svc.mod.stop() == "stop failed: launchd still reports the job"
    assert svc.mod.main(["stop"]) == 1
    capsys.readouterr()


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


# ------------------------------------------------- §2 CLI leaf invariant

def test_no_backend_module_imports_the_cli():
    """§2: the CLI is a pure leaf — the UI and the backend must never depend on
    or invoke it. Pin the import direction: no module in the autowright package
    besides cli.py itself may import autowright.cli. (service.py's shim_text
    mentions `-m autowright.cli` as the shim file's *contents* — a string, not
    an import — which this scan correctly ignores.)"""
    import ast
    from pathlib import Path

    import autowright

    pkg = Path(autowright.__file__).parent
    offenders = []
    for py in pkg.rglob("*.py"):
        if py.name == "cli.py":
            continue
        tree = ast.parse(py.read_text(), filename=str(py))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                if any(a.name == "autowright.cli" or a.name.startswith("autowright.cli.")
                       for a in node.names):
                    offenders.append(f"{py.name}:{node.lineno}")
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if (mod == "autowright.cli" or mod.startswith("autowright.cli.")
                        or (node.level >= 1 and (mod == "cli" or mod.startswith("cli.")))
                        or (node.level >= 1 and mod == ""
                            and any(a.name == "cli" for a in node.names))):
                    offenders.append(f"{py.name}:{node.lineno}")
    assert not offenders, f"backend modules import the CLI (§2 leaf invariant): {offenders}"
