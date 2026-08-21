"""OS notifications (§6): dispatch to the §2 platform notifier.

`post` stays the one patchable seam (the §15 autouse no-op fixture patches
this module attribute); the osascript implementation lives in
platform/darwin.py, and unsupported platforms compose a silent no-op.
The platform import is at module top on purpose: the §6.1 executor replaces
sys.modules["autowright"] with the step-SDK shim, so a real module must
finish its cross-module imports before that swap.
"""
from __future__ import annotations

from . import platform


def post(title: str, body: str) -> None:
    platform.current().notifier.post(title, body)
