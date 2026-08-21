"""§2 platform layer — `current()` composes the per-OS Platform object.

macOS is the only implemented platform (darwin.py); Linux and Windows get the
explicit degraded build (fallback.py) so nothing crashes on a missing OS tool.
A future port adds a real per-OS module here and touches no call sites.

Import rule: cross-package imports (paths, and the consumers' imports of this
package) happen at module top — the §6.1 executor replaces
sys.modules["autowright"] with the step-SDK shim, and a real module that
defers a `from . import x` past that swap resolves it against the shim and
fails. Intra-package imports (`from . import darwin`) stay safe either way.
"""
from __future__ import annotations

import functools

from .. import paths
from .base import Capabilities, Platform  # noqa: F401 (re-exported surface)


@functools.cache
def current() -> Platform:
    token = paths.current_os()
    if token == "macos":
        from . import darwin

        return darwin.build()
    from . import fallback

    return fallback.build(token, paths.os_display_name(token))
