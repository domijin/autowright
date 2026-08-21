"""§2 platform layer — shared POSIX process-group control (macOS and Linux).

The bodies here are the engine/harness group-kill semantics, moved to one
place; the spawn sites stay in their owning modules (engine, harness,
packages — the §15 suites patch `<module>.subprocess`) and take their session
policy from `session_kwargs()`. packages.py and installer.py keep their own
inline killpg copies for now: their §15 suites pin `<module>.os.killpg`
directly, so relocating those bodies would silently defeat the tests.
"""
from __future__ import annotations

import os
import signal
import subprocess


class PosixProcessControl:
    def session_kwargs(self) -> dict:
        """Own session per child: timeout/cancel/skip kill the whole group,
        and pgid == pid (§4.5 persisted-pgid invariant)."""
        return {"start_new_session": True}

    def signal_group(self, proc, sig: int | None = None) -> None:
        """Signal a child's whole session group; falls back to the direct
        child when the group is gone. `sig=None` means kill hard (SIGKILL,
        not importable on Windows)."""
        if sig is None:
            sig = signal.SIGKILL
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            if proc.poll() is None:
                (proc.kill if sig == signal.SIGKILL else proc.terminate)()

    def kill_group(self, pgid: int) -> None:
        """SIGKILL a bare persisted group id (its Popen is long gone)."""
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def group_has_command(self, pgid: int, marker: str) -> bool:
        """§3 pid-reuse guard: whether the group still contains a process
        whose command line carries `marker`. An unreadable process table
        answers False — never kill what can't be verified."""
        try:
            out = subprocess.run(["ps", "-axo", "pgid=,command="],
                                 capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            return False
        for line in out.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and parts[0] == str(pgid) and marker in parts[1]:
                return True
        return False
