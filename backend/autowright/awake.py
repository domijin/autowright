"""macOS idle-sleep power assertions (§3) — both of them.

This module is the macOS `PowerAssertion` implementation of the §2 platform
layer (platform/darwin.py delegates here; it keeps the caffeinate state as
module attributes, which the §15 suites pin): the permanent §4.9 keepAwake
assertion (`reconcile`) and the §3 per-execution hold (`hold_execution`,
acquired by the engine for the duration of an execution). Unsupported
platforms compose no-ops instead.

Each assertion is its own `caffeinate -i -w <backend pid>` subprocess. The
`-w <pid>` ties it to this backend process, so a crashed backend can never
leave an orphan keeping the Mac awake. Display sleep stays allowed;
user-forced sleep still wins.
"""
from __future__ import annotations

import os
import subprocess
import threading
from collections.abc import Callable

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
            try:
                _proc.terminate()
                _proc.wait(timeout=5)  # reap — no zombie until interpreter GC
            except Exception:  # noqa: BLE001
                pass
            _proc = None


def hold_execution() -> Callable[[], None]:
    """§3 per-execution hold: a caffeinate of its own for the duration of one
    execution. Returns the release callable the engine calls when the
    execution finishes — safe to call twice. Neither half ever raises: a
    platform without caffeinate (or a spawn that fails) simply holds
    nothing."""
    try:
        proc = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa: BLE001
        return lambda: None

    released = threading.Event()

    def release() -> None:
        if released.is_set():
            return
        released.set()
        try:
            proc.terminate()
            proc.wait(timeout=5)  # reap — no zombie until interpreter GC
        except Exception:  # noqa: BLE001
            pass

    return release
