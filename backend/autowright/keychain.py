"""Secret values (§4.8): macOS login Keychain via `keyring`."""
from __future__ import annotations

import keyring

SERVICE = "Autowright"


def get_secret(name: str) -> str | None:
    return keyring.get_password(SERVICE, name)


def set_secret(name: str, value: str) -> None:
    keyring.set_password(SERVICE, name, value)


def delete_secret(name: str) -> None:
    try:
        keyring.delete_password(SERVICE, name)
    except Exception:  # noqa: BLE001 — no entry, locked keychain, denied prompt
        # Deleting is best-effort: the metadata row goes either way, and a
        # value left behind is unreachable (referenced by name only).
        pass
