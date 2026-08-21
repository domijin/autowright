"""Filesystem locations (§5). Two per-OS roots (data + logs) picked from the
platform token — the §5 root table; every other location hangs off them.
AUTOWRIGHT_HOME overrides both for dev/tests (logs go to <home>/logs).
macOS is the only shipped platform; the Linux/Windows rows are the §5 reserved
decisions, implemented here so a future port changes no call sites. The
Electron shell resolves the same two roots in electron/platform/ — the tables
must never drift (§15 guard)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "Autowright"


def current_os() -> str:
    """§5.1 platform token (macos | windows | linux) — the archive manifest's
    `os` vocabulary, compared against §4.1 `originOs`."""
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


OS_DISPLAY = {"macos": "macOS", "windows": "Windows", "linux": "Linux"}


def os_display_name(token: str | None) -> str:
    """§4.1 display form of a §5.1 platform token — "macOS" / "Windows" /
    "Linux". An unrecognized stored token shows verbatim. Shared by every
    surface that names a platform (the §4.1 `os-mismatch` label, the §20 CLI
    import summary), so they never drift apart."""
    return OS_DISPLAY.get(token or "", token or "")


def _default_data_root() -> Path:
    """§5 per-OS data root (the platform-token row of the §5 table)."""
    token = current_os()
    if token == "macos":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if token == "windows":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        return base / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "autowright"


def _default_logs_root() -> Path:
    """§5 per-OS logs root (the platform-token row of the §5 table)."""
    token = current_os()
    if token == "macos":
        return Path.home() / "Library" / "Logs" / APP_NAME
    if token == "windows":
        return _default_data_root() / "Logs"
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "autowright" / "log"


def app_support() -> Path:
    env = os.environ.get("AUTOWRIGHT_HOME")
    if env:
        return Path(env).expanduser()
    return _default_data_root()


def automations_dir() -> Path:
    return app_support() / "automations"


def settings_file() -> Path:
    return app_support() / "settings.yaml"


def agents_file() -> Path:
    return app_support() / "agents.yaml"


def secrets_file() -> Path:
    return app_support() / "secrets.yaml"


def backend_json() -> Path:
    return app_support() / "backend.json"


def default_data_path() -> Path:
    return app_support() / "executions"


def pending_draft_dir() -> Path:
    """§4.4: the single pending create-mode draft slot — created when the
    create flow opens, deleted when Create or Start over settles it."""
    return app_support() / "draft"


def import_spool_dir() -> Path:
    """§5.2: parked import archives, one file per preview token. Transient and
    disposable — deleted on confirm/eviction/expiry, and the whole directory is
    cleared at backend startup (a crashed process leaves its files behind)."""
    return app_support() / "import-spool"


def harness_workspace(provider_id: str) -> Path:
    """Empty per-provider cwd for provider CLI children — keeps their startup
    project scans out of TCC-protected folders (§6), so macOS never prompts.
    Created on demand by `harness._neutral_cwd`."""
    return app_support() / "harness" / provider_id / "workspace"


def logs_dir() -> Path:
    env = os.environ.get("AUTOWRIGHT_HOME")
    if env:
        return Path(env).expanduser() / "logs"
    return _default_logs_root()


def app_log() -> Path:
    return logs_dir() / "app.log"


def ensure_dirs() -> None:
    app_support().mkdir(parents=True, exist_ok=True)
    automations_dir().mkdir(parents=True, exist_ok=True)
    default_data_path().mkdir(parents=True, exist_ok=True)
    logs_dir().mkdir(parents=True, exist_ok=True)
