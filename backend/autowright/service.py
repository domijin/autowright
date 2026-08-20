"""launchd LaunchAgent management (§3): install/uninstall/status/restart.

Writes a per-user plist to ~/Library/LaunchAgents/ pointing at this interpreter.
The one registration path: the app's ensure-backend step runs
`python -m autowright.service install` at launch (the __main__ dispatch below —
the app never invokes the CLI), and headless setups run the same functions via
the §20 `autowright service` wrapper — install rewrites and adopts an existing
registration.
"""
from __future__ import annotations

import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

from . import paths

LABEL = "ai.autowright.backend"
LEGACY_LABEL = "com.autowright.backend"  # builds ≤ 0.3.5 (§3 migration)
SHIM_MARKER = "# autowright CLI shim"


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def legacy_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LEGACY_LABEL}.plist"


def shim_paths() -> list[Path]:
    """§3 candidate shim locations, user-local first. AUTOWRIGHT_SHIM is the
    §15 test knob (mirrored in electron/main.cjs): it forces a single one."""
    forced = os.environ.get("AUTOWRIGHT_SHIM")
    if forced:
        return [Path(forced)]
    return [Path.home() / ".local" / "bin" / "autowright",
            Path("/usr/local/bin/autowright")]


def shim_text() -> str:
    """Shim contents for this interpreter, module form (pip's bin/ entry
    scripts carry staging-path shebangs)."""
    return (f'#!/bin/sh\n{SHIM_MARKER}\n'
            f'exec "{sys.executable}" -m autowright.cli "$@"\n')


def _heal_one(p: Path) -> str | None:
    """Heal a single candidate location; None when nothing is there. An
    undecodable (binary) file can't carry the marker: foreign, left alone,
    never a traceback (same tolerance as _remove_shim)."""
    try:
        current = p.read_text()
    except (OSError, UnicodeDecodeError):
        return None
    if SHIM_MARKER not in current:
        return f"foreign {p} left alone"
    wanted = shim_text()
    if current == wanted:
        return f"CLI at {p}"
    try:
        p.write_text(wanted)
        p.chmod(0o755)
        return f"CLI at {p}"
    except OSError as e:
        return (f"CLI shim stale, not rewritable ({e}) — "
                f"use `{sys.executable} -m autowright.cli`")


def _heal_shim() -> str:
    """§3: healing only, never creation. Creating a shim belongs to the
    Electron shell's cli-install flow (silent in ~/.local/bin, admin-prompted
    + chown-to-user in /usr/local/bin). Here: every candidate location whose
    shim is ours, user-writable, and points at another interpreter (moved
    bundle, dev↔prod switch, update) is rewritten in place — sudo-free, since
    a user-owned file rewrites without a directory write."""
    notes = [n for n in (_heal_one(p) for p in shim_paths()) if n]
    if not notes:
        return f"CLI not installed — use `{sys.executable} -m autowright.cli`"
    return " · ".join(notes)


def _remove_shim() -> str | None:
    """Delete shims only where the marker says they're ours (§3). Deleting
    from a root-owned /usr/local/bin fails sudo-free — then report the
    manual command instead."""
    notes = []
    for p in shim_paths():
        try:
            if SHIM_MARKER not in p.read_text():
                continue
        except (OSError, UnicodeDecodeError):
            continue
        try:
            p.unlink()
        except OSError:
            notes.append(f"CLI shim left at {p} — remove with `sudo rm {p}`")
    return " · ".join(notes) if notes else None


def _registered(label: str = LABEL) -> bool:
    """Whether launchd currently knows the job (running or not)."""
    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"],
                       capture_output=True)
    return r.returncode == 0


def _purge_legacy() -> None:
    """§3 migration: builds ≤ 0.3.5 registered the job as com.autowright.backend.
    Boot that registration out and delete its plist before loading the current
    label, or an update leaves two KeepAlive backends running."""
    if _registered(LEGACY_LABEL):
        subprocess.run(["launchctl",
                        "bootout", f"gui/{os.getuid()}/{LEGACY_LABEL}"],
                       capture_output=True)
        for _ in range(40):
            if not _registered(LEGACY_LABEL):
                break
            time.sleep(0.25)
    legacy_plist_path().unlink(missing_ok=True)


def _unload(p: Path) -> None:
    """Stop the agent whatever the bootstrap context: modern `bootout
    gui/<uid>` first, legacy `unload` as the fallback. Booting out a running
    job is asynchronous — wait for launchd to finish removing it, or the
    immediate re-bootstrap in install()/restart() races the teardown, fails,
    and leaves no registration at all (§3)."""
    r = subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"],
                       capture_output=True)
    if r.returncode != 0:
        subprocess.run(["launchctl", "unload", str(p)], capture_output=True)
    for _ in range(40):
        if not _registered():
            return
        time.sleep(0.25)


def _load(p: Path) -> str | None:
    """Start the agent; returns an error string or None. `launchctl load`
    fails from a non-Aqua bootstrap context (SSH — the §3 headless path), so
    try modern `bootstrap gui/<uid>` first and legacy `load` second. Either
    can exit 0 without actually loading (legacy `load` swallows errors), so
    success is only ever the job existing in launchd afterwards (§3) — never
    report an unregistered service as installed."""
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(p)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        r2 = subprocess.run(["launchctl", "load", str(p)], capture_output=True, text=True)
        if r2.returncode != 0:
            return (r.stderr.strip() or r2.stderr.strip()
                    or f"launchctl exited {r.returncode}")
    if not _registered():
        return "launchctl accepted the plist but the job is not registered"
    return None


def install() -> str:
    _purge_legacy()
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "autowright.main"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(paths.logs_dir() / "backend.out.log"),
        "StandardErrorPath": str(paths.logs_dir() / "backend.err.log"),
    }
    paths.logs_dir().mkdir(parents=True, exist_ok=True)  # launchd won't create it for the log paths
    p = plist_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        plistlib.dump(plist, f)
    _unload(p)
    if err := _load(p):
        return f"install failed: {err}"
    return f"installed and started ({p}) · {_heal_shim()}"


def uninstall() -> str:
    p = plist_path()
    _unload(p)
    shim_note = _remove_shim()
    if p.exists():
        p.unlink()
        out = "service unloaded and removed"
    else:
        out = "service was not installed"
    return f"{out} · {shim_note}" if shim_note else out


def status() -> str:
    r = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if LABEL in line:
            pid = line.split()[0]
            alive = pid != "-"
            bj = paths.backend_json()
            port = ""
            if bj.exists():
                import json

                # A SIGKILL'd backend leaves a stale (possibly truncated)
                # backend.json — status must report, not crash.
                try:
                    port = f" · port {json.loads(bj.read_text())['port']}"
                except (OSError, ValueError, KeyError, TypeError):
                    port = " · stale backend.json"
            return ("active" if alive else "loaded, not active") + f" (pid {pid}){port}"
    # §3: an unloaded job with its plist still on disk is "stopped", not
    # "not installed" — it returns at next login or `service install`.
    if plist_path().exists():
        return "stopped (plist present) — returns at next login or app launch"
    return "not installed"


def stop() -> str:
    """§3 quit-entirely backend half: unload the job, keep plist and shim."""
    p = plist_path()
    if not p.exists():
        return "not installed — nothing to stop"
    _unload(p)
    if _registered():
        return "stop failed: launchd still reports the job"
    return "stopped — returns at next login or app launch"


def restart() -> str:
    p = plist_path()
    if not p.exists():
        return "not installed — use `autowright service install` first"
    _unload(p)
    err = _load(p)
    return "restarted" if err is None else f"restart failed: {err}"


ACTIONS = {"install": install, "uninstall": uninstall,
           "status": status, "restart": restart, "stop": stop}


def result_code(out: str) -> int:
    """§3 exit code for an action's result line: 1 for a failed action or a
    missing install, 0 otherwise. Shim notes after "·" are informational.
    Shared by main() below and the §20 `autowright service` wrapper, so both
    entry points exit alike."""
    head = out.split("·")[0]
    return 1 if ("failed" in head or head.startswith("not installed")) else 0


def main(argv: list[str]) -> int:
    """`python -m autowright.service <action>` — the §3 registration entry the
    app's ensure-backend step execs (the UI never invokes the CLI). The §20
    `autowright service` group wraps the same ACTIONS."""
    if len(argv) != 1 or argv[0] not in ACTIONS:
        print(f"usage: python -m autowright.service {{{'|'.join(ACTIONS)}}}",
              file=sys.stderr)
        return 2
    out = ACTIONS[argv[0]]()
    print(out)
    return result_code(out)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
