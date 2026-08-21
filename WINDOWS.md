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
2. **Windows ServiceManager: Task Scheduler** (decided; implement in
   `platform/windows.py`). Semantics to satisfy are §3's launchd contract, mapped as:
   - Task name `ai.autowright.backend` (same reverse-DNS label as the LaunchAgent). Action:
     the bundled `pythonw.exe -m autowright.main` (`pythonw` so no console window flashes;
     python-build-standalone ships it beside `python.exe`).
   - Register via the PowerShell ScheduledTasks cmdlets, not bare `schtasks.exe`:
     restart-on-failure (`New-ScheduledTaskSettingsSet -RestartCount -RestartInterval`, the
     KeepAlive equivalent) is not expressible from the schtasks CLI. Logon trigger
     (RunAtLoad equivalent) + start it immediately on install (`Start-ScheduledTask`, the
     `launchctl kickstart` equivalent).
   - Verb mapping: `install` = register (or update in place) + start + §3 health-poll
     verification; `uninstall` = stop + `Unregister-ScheduledTask`; `status` =
     `Get-ScheduledTask` state line; `stop` = `Stop-ScheduledTask` only, task stays
     registered and returns at next logon (mirrors §3 "bootout only"); `restart` = stop +
     start. Each verb answers a §3-style result line so `service.result_code` keeps working.
   - Log routing: Task Scheduler does not capture stdout/stderr (launchd does). `main.py`
     must open/rotate its own `backend.log` on Windows, and the writer must not keep the
     handle open across the `main.py:38` trim (sharing violation).
   - Then flip `capabilities.service` true and add the `.cmd` shim-heal half to `service.py`
     (§3 says healing is `service install`'s job).
   Notifier (separate, small): Windows toasts via a PowerShell toast-XML invocation or a
   small dependency; flip `capabilities.notifications` when it works.
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
5. **Packaging pipeline: NSIS + electron-updater** (decided; `scripts/` additions are all
   new files and scripts/ stays developer-only)
   - **Build tool:** use electron-builder for the *Windows target only* (`--win nsis`),
     driven by a new `prod.ps1`; macOS keeps `@electron/packager` + `prod.sh` untouched.
     Rationale: hand-rolling what electron-updater consumes (NSIS script, `latest.yml`,
     blockmap, the in-app `app-update.yml`) re-implements electron-builder badly, and
     electron-builder also gives the sign-later hook for free. `prod.ps1` order mirrors
     `prod.sh`: sync `VERSION`, vite build, download python-build-standalone
     `x86_64-pc-windows-msvc-install_only` (flat layout: `python\python.exe`), pip install
     with `-c constraints.txt` before packaging, ship the interpreter via `extraResources`
     into `resources\python`, then electron-builder produces the installer.
   - **Installer shape:** per-user NSIS (`perMachine: false`, no admin prompt - same
     no-privilege principle as §3), install dir under `%LOCALAPPDATA%\Programs`, appId
     `ai.autowright.app`, and a **stable NSIS GUID** pinned in config from day one (an
     upgrade must always find the previous install; this is also what lets a future signed
     build upgrade an unsigned install in place). Needs `icon.ico` generated beside the
     existing icns/png (§14 assets).
   - **Updater:** `electron-updater` (NsisUpdater) as an app dependency, used only on win32.
     main.cjs's update block becomes per-OS behind the platform layer: darwin keeps the
     Squirrel.Mac JSON feed + loopback-proxy flow unchanged; win32 uses the generic provider
     pointed at `https://autowright.ai/updates/win32-x86_64/` (`win32.cjs` `updateFeedUrl`
     returns that base URL once live). Feed = `latest.yml` + installer + blockmap:
     yml rewritten under `docs/updates/win32-x86_64/` by the release script, binaries on the
     GitHub release, mirroring the mac hosting split. The renderer-facing IPC surface
     (`update-check`/`update-download`/`update-install` states) must stay byte-identical so
     no renderer code forks. Manual-install rule (§3: a check only ever reads the feed;
     downloads are user-initiated) carries over: call `checkForUpdates` with autoDownload
     off.
   - **Signing (cert later, ready now):** the build signs when cert config is present
     (electron-builder `CSC_LINK`/`CSC_KEY_PASSWORD` env, or a signtool thumbprint) and
     otherwise builds unsigned while printing a loud UNSIGNED warning line in the build
     output - never silently. Keep GUID, install path, and appId stable so the
     unsigned-to-signed transition is a normal update. When the cert arrives: set
     `publisherName` in the updater config (electron-updater then verifies the downloaded
     installer's Authenticode identity), sign both the app exe and the installer, and flip
     the spec to always-signed. Do not set `publisherName` before signing starts - it would
     make updates fail against unsigned artifacts.
   - `docs/index.html` download CTA is mac-only (darwin feed + DMG naming); add a Windows
     download path once artifacts exist.
   - `VERSION` sync + `release.sh` are bash with BSD `sed -i ''`; run mac releases from
     macOS as today. Windows artifacts get their own `release.ps1` (build, publish installer
     + blockmap to the same GitHub release, rewrite `docs/updates/win32-x86_64/latest.yml`);
     a release that ships both platforms is two script runs against one tag/version.
6. **iMessage stays off** (`capabilities.imessage` false): `listeners.py:475` already gates
   the chat.db watcher; the trigger-kind UI hides via step 4.

## Decisions (settled with David, 2026-08-21)

These are decided; do not re-litigate them on the Windows machine. They move into spec §3 as
the implementations ship.

1. **Installer + updater: NSIS + electron-updater.** Squirrel.Windows is out (dormant
   project; the name-sharing Squirrel.Mac stays on macOS - it is part of Electron and the
   shipped mac pipeline is untouched). Consequences worked into step 5 below: per-user NSIS
   installer, `latest.yml` generic-provider feed on autowright.ai mirroring the mac feed
   hosting, `electron-updater` becomes an app dependency used only on win32.
2. **Service mechanism: Task Scheduler.** Closest match to launchd `RunAtLoad` + `KeepAlive`
   (logon trigger + restart-on-failure) with no extra supervisor process. Consequences
   worked into step 2 below.
3. **Code signing: certificate later, pipeline ready now.** Windows builds are allowed to be
   unsigned for the moment (unlike the mac "no ad-hoc fallback" rule); SmartScreen warnings
   are accepted until a cert exists. The pipeline must be shaped so adding the cert is a
   config change, not a redesign - see the signing notes in step 5. Once the cert is in use,
   flip the Windows spec rule to match the mac one (always signed, no fallback).
