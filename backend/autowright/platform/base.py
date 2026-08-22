"""§2 platform layer — the capability Protocols and the composed Platform.

Composition over inheritance: one narrow Protocol per OS-coupled capability,
plain per-OS implementations, one frozen `Platform` object composed by
`platform.current()`. Shared logic lives in plain functions the
implementations import (posixproc.py), never in a superclass.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class ServiceManager(Protocol):
    """§3 service lifecycle — the five verbs, each answering the §3 result
    line whose exit code `service.result_code` derives."""

    def install(self) -> str: ...
    def uninstall(self) -> str: ...
    def status(self) -> str: ...
    def stop(self) -> str: ...
    def restart(self) -> str: ...


class Notifier(Protocol):
    """§6 OS notifications — best-effort, silent degrade, never raises."""

    def post(self, title: str, body: str) -> None: ...


class PowerAssertion(Protocol):
    """§3/§4.9 idle-sleep assertions — both of them. `reconcile` is the
    permanent keepAwake assertion (idempotent, called at boot and from
    PATCH /settings). `hold_execution` is the §3 per-execution hold: the
    engine acquires one for the duration of an execution and calls the
    returned release when it finishes. Neither acquiring nor releasing may
    ever raise — a platform with no mechanism composes no-ops."""

    def reconcile(self, enabled: bool) -> None: ...
    def hold_execution(self) -> Callable[[], None]: ...


class ProcessControl(Protocol):
    """§3 process-group control. The spawn sites themselves stay in their
    owning modules — the §15 suites patch `<module>.subprocess` — and take
    only their session *policy* from `session_kwargs()`. POSIX-shaped for now
    (pgids and signals, persisted per §4.5 with the own-session → pgid == pid
    invariant); a Windows implementation will widen this surface (job
    objects, pid + creation time instead of pgid) when that port lands."""

    def session_kwargs(self) -> dict: ...
    def signal_group(self, proc, sig: int | None = None) -> None: ...
    def kill_group(self, pgid: int) -> None: ...
    def group_has_command(self, pgid: int, marker: str) -> bool: ...


@dataclass(frozen=True)
class Capabilities:
    """What this OS can honor. Served on §19 GET /health so clients gate
    features here — never by sniffing the platform at a call site."""

    imessage: bool
    notifications: bool
    keep_awake: bool
    service: bool
    agent_install: bool

    def as_dict(self) -> dict:
        return {"imessage": self.imessage, "notifications": self.notifications,
                "keepAwake": self.keep_awake, "service": self.service,
                "agentInstall": self.agent_install}


@dataclass(frozen=True)
class Platform:
    os_token: str  # §5.1 vocabulary: macos | windows | linux
    service: ServiceManager
    notifier: Notifier
    power: PowerAssertion
    processes: ProcessControl
    capabilities: Capabilities
