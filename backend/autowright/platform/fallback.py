"""§2 platform layer — degraded builds for the platforms we don't ship yet.

Not implementations: explicit placeholders so an unsupported OS degrades in
plain words instead of crashing on a missing `launchctl` or `caffeinate`.
Replacing one of these with a real module (systemd/Task Scheduler service
manager, notify-send/toast notifier, …) is the entire per-OS port surface —
no call sites change.
"""
from __future__ import annotations

from . import posixproc
from .base import Capabilities, Platform


class UnsupportedService:
    """§3: every verb answers a plain failure line ("… failed: not supported
    on <OS> yet"), so `service.result_code` maps it to exit 1 — never a
    traceback on a missing launchctl."""

    def __init__(self, os_display: str) -> None:
        self._why = f"not supported on {os_display} yet"

    def install(self) -> str:
        return f"install failed: {self._why}"

    def uninstall(self) -> str:
        return f"uninstall failed: {self._why}"

    def status(self) -> str:
        return f"status failed: {self._why}"

    def stop(self) -> str:
        return f"stop failed: {self._why}"

    def restart(self) -> str:
        return f"restart failed: {self._why}"


class NullNotifier:
    """Notifications silently degrade (same contract as the darwin notifier's
    catch-all: best-effort, never raises, never blocks)."""

    def post(self, title: str, body: str) -> None:
        return None


class NullPower:
    """keepAwake is a no-op where no assertion mechanism is wired up."""

    def reconcile(self, enabled: bool) -> None:
        return None


def build(os_token: str, os_display: str) -> Platform:
    return Platform(
        os_token=os_token,
        service=UnsupportedService(os_display),
        notifier=NullNotifier(),
        power=NullPower(),
        # POSIX process control is real on Linux; on Windows these calls
        # raise on use (os.killpg does not exist) — acceptable until the
        # Windows port lands a job-object implementation.
        processes=posixproc.PosixProcessControl(),
        capabilities=Capabilities(imessage=False, notifications=False,
                                  keep_awake=False, service=False),
    )
