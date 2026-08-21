"""§2 platform layer — the Windows groundwork build.

Not a shipped port: service, notifications, and keepAwake stay the explicit
degraded placeholders (fallback.py), but process control is real — the engine
must be able to spawn and stop step trees before anything else on Windows can
be exercised. Windows has no signalable process groups, so "group" operations
act on the process tree rooted at the child's pid (`taskkill /T`), and the
§4.5 persisted group id stays the child's pid — same pid == group invariant
as POSIX own-session spawns.
"""
from __future__ import annotations

import subprocess

from . import fallback
from .base import Capabilities, Platform

# Windows-only in CPython's subprocess module; the numeric value is part of
# the Win32 ABI. The getattr keeps this module importable (and its §15 tests
# runnable) on POSIX hosts.
_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)


class WindowsProcessControl:
    """§3 process-tree control via taskkill. No graceful cross-tree signal
    exists on Windows, so both grades (`sig` set or None) kill the tree hard —
    the §7 term-then-kill escalation collapses to one kill."""

    def session_kwargs(self) -> dict:
        """Own process group per child, so the persisted group id (== pid)
        stays meaningful and Ctrl events can't propagate from a console."""
        return {"creationflags": _NEW_PROCESS_GROUP}

    def signal_group(self, proc, sig: int | None = None) -> None:
        self.kill_group(proc.pid)
        # Belt-and-braces for a tree taskkill couldn't address (already-gone
        # pid raced by a fresh child): kill the direct child if still alive.
        if proc.poll() is None:
            proc.kill()

    def kill_group(self, pgid: int) -> None:
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pgid)],
                           capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass

    def group_has_command(self, pgid: int, marker: str) -> bool:
        """§3 pid-reuse guard: needs pid + creation-time identity on Windows;
        until that lands, answer False — never kill what can't be verified
        (orphan recovery becomes a no-op, same as an unreadable process
        table on POSIX)."""
        return False


def build(os_display: str) -> Platform:
    return Platform(
        os_token="windows",
        service=fallback.UnsupportedService(os_display),
        notifier=fallback.NullNotifier(),
        power=fallback.NullPower(),
        processes=WindowsProcessControl(),
        capabilities=Capabilities(imessage=False, notifications=False,
                                  keep_awake=False, service=False),
    )
