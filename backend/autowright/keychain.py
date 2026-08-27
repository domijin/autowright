"""Secret values (§4.8): the OS secret store via `keyring` — macOS login
Keychain, Windows Credential Manager, or the Linux Secret Service (§2).

The keyring account string is the secret's §4.8 id — the one reference
identity — so metadata edits never touch the Keychain and no rename path
is needed.
"""
from __future__ import annotations

import keyring

SERVICE = "Autowright"


def get_secret(sid: str) -> str | None:
    return keyring.get_password(SERVICE, sid)


def set_secret(sid: str, value: str) -> None:
    keyring.set_password(SERVICE, sid, value)


def delete_secret(sid: str) -> None:
    try:
        keyring.delete_password(SERVICE, sid)
    except Exception:  # noqa: BLE001 — no entry, locked keychain, denied prompt
        # Deleting is best-effort: the metadata row goes either way, and a
        # value left behind is unreachable (referenced by id only).
        pass
