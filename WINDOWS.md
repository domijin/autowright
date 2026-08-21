# Windows x86-64 port worksheet

Temporary working notes (SPEC §17): the audited port surface for building Autowright on
Windows, ordered by dependency. Each item moves into the spec as it ships; delete this file
when the port lands. Written on macOS 2026-08-21 from a full-repo audit; verify line numbers
before editing, they will drift.

## Done (groundwork commit, made on macOS)

- Backend platform layer: `backend/autowright/platform/windows.py` composes on any
  Windows host via `platform.current()`. Real process control: spawn policy
  `creationflags = CREATE_NEW_PROCESS_GROUP`, tree kill via `taskkill /F /T /PID`, pid-reuse
  guard answers False (orphan recovery no-ops). Service/notifier/power stay degraded,
  capabilities all false. Tests: `tests/test_platform.py` (runnable on any OS).
- Shell platform layer: `app/electron/platform/win32.cjs` selected by `index.cjs` on win32.
  Correct values: `python\python.exe` interpreter layout, `%LOCALAPPDATA%\Autowright` roots
  (`roots.cjs` was already right), `.cmd` CLI shim at `%LOCALAPPDATA%\Autowright\bin\`
  (marker `rem autowright CLI shim`; main.cjs's status/heal/install/uninstall logic works
  unchanged because it compares whole-file shimText), PATH probe reads `process.env.PATH`.
  Placeholders: native window frame, mac tray PNGs, no update feed, no managed-install probe.
- `signal.SIGKILL` no longer appears at any platform-layer call site (drafting.py passes
  `sig=None`, the kill-hard form; the name does not exist on Windows).
- `backend/constraints.txt` pins `pywin32-ctypes` under `sys_platform == "win32"` (keyring's
  Credential Locker backend; secrets work on Windows through the same `keyring` code).
- Guards updated for a second platform: `app/tests/main-cjs-leaf.test.ts` accepts the `.cmd`
  shim form; `app/e2e/harness.ts` resolves `.venv\Scripts\python.exe` on win32.

## Dev setup on Windows (no scripts/ equivalents exist yet)

`scripts/*.sh` are bash and developer-only. Manual equivalents:

```
py -3.14 -m venv .venv
.venv\Scripts\pip install -c backend\constraints.txt -e backend
.venv\Scripts\python -m pytest -q          # expect the known failures listed below
cd app && npm ci && npx tsc --noEmit -p tsconfig.test.json && npx vitest run
```

Known test failures on a Windows host (fix as part of the port, they assert the mac host):
- `tests/test_platform.py::test_darwin_build_composes_full_capabilities` and
  `test_health_serves_os_and_capabilities` assert `os == "macos"` / all-true capabilities.
  Make them assert against `platform.current()` per-OS expectations.
- `tests/conftest.py` prepends `tests/bin/` (shebang shell doubles: fake `claude`, fake
  `osascript`). Windows needs `.cmd` doubles beside them (PATHEXT resolves them).
- Anything spawning the engine relies on the groundwork process control; if a suite hangs,
  suspect `taskkill` semantics first.

## Port order (each step is buildable/verifiable on the Windows machine)

1. **Backend runtime blockers outside the layer**
   - `packages.py:236,242` and `installer.py:106,136,142`: inline `start_new_session=True` +
     `os.killpg` (kept inline because their suites pin `<module>.os.killpg`, see
     `platform/posixproc.py` header). Route through `platform.current().processes` and
     repoint the tests; `start_new_session=True` raises ValueError on Windows Popen.
   - `engine.py:754-758,1027-1030` per-execution `caffeinate` is inline (degrades silently);
     `main.py:115` and `api.py:1882` call `awake.reconcile` directly instead of
     `platform.current().power.reconcile`. Close the layering hole, then implement
     `PowerAssertion` via `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
   - `yamlio.py:47` `chmod 0o600` does not restrict access on Windows and `backend.json`
     holds the bearer token: restrict via an ACL (icacls or pywin32) or keep the file inside
     the per-user `%LOCALAPPDATA%` root and document the boundary.
   - `harness.py`: `_FALLBACK_BIN_DIRS` (88-93) are POSIX paths (add `%LOCALAPPDATA%\Programs`,
     `%APPDATA%\npm`); OpenCode config at `~/.config` (474,479) is `%APPDATA%` on Windows;
     Ollama discovery via `/Applications` (533-536); `os.access(X_OK)` (543) can't detect
     executables on Windows (use PATHEXT); Gemini/OpenCode cred paths (688,702).
   - `installer.py` agent-install surface is macOS-only end to end (curl|bash, osascript
     Terminal sign-in, /Applications, `SHELL` env at 207,229): needs per-OS install commands
     or an explicit "install by hand" degradation behind a capability flag.
2. **Windows ServiceManager** (`platform/windows.py`): keep the backend alive headless.
   Candidate: Task Scheduler (`schtasks /Create /SC ONLOGON` + restart-on-failure) or a
   startup-registration + watchdog pair; must satisfy §3 semantics (install/uninstall/status/
   stop/restart result lines, RunAtLoad + KeepAlive equivalent, log file routing that
   `main.py:38` truncation can live with: the parent must not hold the log handle open).
   Then flip `capabilities.service` true and add the `.cmd` shim-heal half to `service.py`
   (§3 says healing is `service install`'s job).
   Notifier: Windows toasts (e.g. PowerShell BurntToast-less XML or a small dependency);
   flip `capabilities.notifications`.
3. **Shell surface finishing** (`win32.cjs` + `main.cjs`)
   - `main.cjs:944` `window-all-closed` never quits (mac tray-app rule): decide Windows
     behavior with the tray present.
   - `main.cjs` never consults `plat.capabilities` (declared but unread): gate tray/login-item/
     dock/update wiring on it.
   - Tray needs real `.ico`/colored assets (`scripts/gen_tray_icon.py` renders the mac PNGs);
     app icon needs `icon.ico` beside `icon.icns` (§14 assets in `app/electron/icon/`).
   - `main.cjs:160-161` failure copy names Gatekeeper; make it per-OS.
   - Custom window chrome (`mainWindowChrome`) if the native frame clashes with the §14 look.
   - Panel placement: `win32.cjs` anchors assuming max panel height 640; ideally re-anchor on
     `resize-panel` so the panel hugs the taskbar.
4. **Renderer capability gating + copy sweep**
   - `/health` `os` + `capabilities` are served (§19) but the renderer never reads them: hide
     iMessage trigger UI, keep-awake card, notification promises when false. This is also
     mac-verifiable work.
   - Copy sweep (~60 strings): "this Mac"/"your Mac" (Onboarding, AutomationsList,
     AgentNewPage, AboutPage, types.ts), "Keychain" (SecretModal, SecretsPage, steps.tsx,
     SectionCards, TriggerEditor, cli.py, api.py) should say Credential Manager on Windows,
     "Show in Finder" (result.tsx, SettingsPage), `PATH_CMD` zsh one-liner
     (`SettingsPage.tsx:23-24`) needs a setx/PowerShell form, About page's Homebrew fork,
     `storage.py:1844-1849` os-mismatch label. Use `/health.os` display name, not platform
     sniffing.
5. **Packaging pipeline** (`scripts/`, all new files; scripts/ stays developer-only)
   - A `prod.ps1` (or cross-platform node script) mirroring `prod.sh`: download
     python-build-standalone `x86_64-pc-windows-msvc-install_only` (flat layout), pip install
     with constraints, `@electron/packager --platform=win32 --arch=x64 --icon=icon.ico`, copy
     python into `resources\python`, Authenticode signing (signtool), installer artifact
     (NSIS or Squirrel.Windows; pick one together with the updater story).
   - Updater: `win32.cjs` `updateFeedUrl` returns null today. Electron's built-in autoUpdater
     on Windows is Squirrel.Windows (different artifacts + feed format from the mac JSON
     feed); decide Squirrel.Windows vs electron-updater+NSIS, then extend `release.sh` (or a
     sibling) to publish `docs/updates/win32-x86_64` artifacts and teach `main.cjs`'s
     download flow (it currently proxies a Squirrel.Mac JSON feed through a loopback server).
   - `docs/index.html` download CTA is mac-only (darwin feed + DMG naming); add a Windows
     download path once artifacts exist.
   - `VERSION` sync + `release.sh` are bash with BSD `sed -i ''`; run releases from macOS for
     now (they can build only the mac artifacts anyway).
6. **iMessage stays off** (`capabilities.imessage` false): `listeners.py:475` already gates
   the chat.db watcher; the trigger-kind UI hides via step 4.

## Decisions to make with David before building far

- Installer + updater technology (NSIS + electron-updater vs Squirrel.Windows) - drives
  packaging, feed format, and the §3 update spec section.
- Windows service mechanism (Task Scheduler vs startup entry + supervisor).
- Code-signing: is an Authenticode cert available? Unsigned builds trip SmartScreen.
