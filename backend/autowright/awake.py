"""§4.9 keepAwake — the permanent idle-sleep power assertion (§3).

While the setting is on, the backend holds a `caffeinate -i -w <backend pid>`
subprocess. The `-w <pid>` ties the assertion to this backend process, so a
crashed backend can never leave an orphan keeping the Mac awake. Display
sleep stays allowed; user-forced sleep still wins.
"""
from __future__ import annotations

import os
import subprocess
import threading

_lock = threading.Lock()
_proc: subprocess.Popen | None = None


def reconcile(enabled: bool) -> None:
    """Start or stop the assertion to match the setting. Called at backend
    boot and from every PATCH /settings — idempotent, and a no-op where
    caffeinate doesn't exist (non-macOS test hosts)."""
    global _proc
    with _lock:
        if enabled:
            if _proc is not None and _proc.poll() is None:
                return
            try:
                _proc = subprocess.Popen(
                    ["caffeinate", "-i", "-w", str(os.getpid())],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:  # noqa: BLE001
                _proc = None
        elif _proc is not None:
            _proc.terminate()
            try:
                _proc.wait(timeout=5)  # reap — no zombie until interpreter GC
            except Exception:  # noqa: BLE001
                pass
            _proc = None
