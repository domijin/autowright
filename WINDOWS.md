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
.venv\Scripts\pip install -c backend\constraints.txt -e backend[dev]
.venv\Scripts\python -m pytest -q          # green on Windows: 0 failed, 34 intended skips
cd app && npm ci && npx tsc --noEmit -p tsconfig.test.json && npx vitest run   # fully green
```

The 34 pytest skips are intended per-OS gates: 26 launchd-internals tests (Task Scheduler
tests replace them in step 2), 7 macOS install-surface tests (gated off by `agentInstall`),
1 POSIX-only `tzset` test.

## Port order (each step is buildable/verifiable on the Windows machine)

1. **Backend runtime blockers — SHIPPED into the spec (2026-08-21, on the Windows machine).**
   Everything the audit listed landed, spec first: power behind the layer
   (`hold_execution` + `WindowsPower` SetThreadExecutionState, `keepAwake` true — §2/§3);
   packages/installer routed through `ProcessControl`; `backend.json` protected by the
   `%LOCALAPPDATA%` ACL, documented, no icacls (§3); agent install/sign-in degraded behind
   the new `agentInstall` capability with 409 lines (§19) and renderer manual-install lines
   (§9); harness per-OS fallback bin dirs + PATHEXT-aware executable checks (§19) — cred
   paths verified to need no fork; per-OS §8 prompt delivery (Windows pipes the prompt to
   the CLI's stdin — the 32,767-char argv cap is smaller than any drafting prompt; verified
   live against real `claude.exe` at ~40 K chars). Plus blockers the audit missed, found by
   the on-machine baseline: `tzdata` pinned under `sys_platform == "win32"` (§17 — Windows
   has no system IANA db; ~90 tests and every timezone trigger broke), the §2 UTF-8
   pipe-encoding contract (locale cp1252 pipes crashed the executor on its own `→`), the
   `update-install` no-feed guard in main.cjs (§3), `.cmd`/`.py` test-double twins +
   `AUTOWRIGHT_TEST_PYTHON` (§15), `.gitattributes` CRLF rule for `*.cmd` (§17).
   Still open from this step:
   - cmd.exe **AutoRun pollution**: this machine has an
     `HKLM\...\Command Processor\AutoRun` hook whose output lands on every `.cmd` child's
     stdout. Tests neutralize it (`COMSPEC /d` in conftest), but product probes of
     `.cmd`-shimmed CLIs (npm-installed `gemini`/`opencode`) would see the same garbage —
     when those CLIs land here, spawn resolved `.cmd` binaries as
     `[%COMSPEC%, '/d', '/c', path, …]` in `spawn_env`-carrying call sites.
   - Gemini/Codex/OpenCode Windows stdin forms follow vendor docs only — re-verify each
     live when installed (§8 note).
   - `app/e2e/` literal selectors pin mac copy (`FOUND ON THIS MAC` in app.e2e.ts,
     `Save to Keychain` in agents-secrets.e2e.ts) — make them per-OS via the §9 copy
     helper's values when e2e first runs on Windows.
   - Cosmetic, seen in the live Windows verify draft: the §8 "Syncing the workflow…"
     activity feed showed the manifest and step bullets twice from a single agent call
     (app log confirms one invocation, zero retries). Possibly CRLF-related in the
     streamed-marker scan, possibly a pre-existing mac bug — investigate; harmless.
2. **Windows ServiceManager: Task Scheduler** (decided; spec written into §3's
   "Windows service" block 2026-08-21 — implement in `platform/windows.py` next).
   Semantics to satisfy are §3's launchd contract, mapped as:
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
3. **Shell surface finishing — SHIPPED (2026-08-21, spec'd in §9/§13/§17).** Windows
   chrome via `titleBarStyle: 'hidden'` + `titleBarOverlay` (#090d14 / #c8ccd4 / 40);
   per-OS `window-all-closed` (discriminated on the `dockIcon` capability, live tray
   reference required for residency without a dock); `main.cjs` gates tray/login-item/
   dock/update wiring on `plat.capabilities`; ensure-backend failure copy moved per-OS
   into the platform modules (Gatekeeper line is darwin's); `panelPosition(pt, display,
   height)` re-anchors on every `resize-panel`; Windows tray PNGs (`trayWin*` colored
   variants) checked in, `gen_tray_icon.py` renders them (mac assets verified
   byte-identical after the generator edit). `icon.ico` also shipped (§14/§17:
   PNG-compressed 256→16, rendered by the extended `gen_icon.cjs`, which now skips the
   sips/iconutil icns leg off-macOS; validated via WIC + Win32 + Electron). Windows also
   sets `app.setAppUserModelId('ai.autowright.app')` (§3 identifiers) and the Electron
   profile now nests under the §5 `%LOCALAPPDATA%` data root, not Roaming (§5 note).
4. **Renderer capability gating — SHIPPED; copy sweep — OPEN.**
   - Gating shipped (2026-08-21, §9 platform-gating paragraph): store carries `/health`
     `os`+`capabilities`; iMessage trigger chip, keep-awake row, notifications row hide on
     false; agent Install/Sign-in actions degrade to the §9 manual lines (vendor-linked;
     sign-in wording for installed-but-signed-out).
   - Copy sweep — SHIPPED (2026-08-21): the §9 per-OS copy rule table implemented across
     the renderer (`platformCopy.ts` helper + `usePlatformCopy`), the backend
     (`paths.machine_noun`/`secret_store_name`), and the model-facing §8 prompt text
     (SYSTEM TOOLS header, chat diagnosis rule, and the instruction markdown via the
     `{{MACHINE}}` placeholder resolved at read time — prompts, GET /instructions, and the
     new-automation seed all say "PC" on Windows). iMessage surfaces keep mac wording by
     spec exception. Windows PATH command is the `[Environment]::SetEnvironmentVariable`
     PowerShell form (never setx).
5. **Packaging pipeline — SHIPPED (2026-08-21, spec'd in §3 "Windows packaging & updates"
   + notifier block).** electron-builder NSIS config in `app/package.json` (appId
   `ai.autowright.app`, GUID `3E71053D-7CAA-4BF9-A643-93ABDA35B1F3` — NEVER change it —
   per-user oneClick into `%LOCALAPPDATA%\Programs\autowright` (lowercase, don't hard-code
   the case), generic publish URL); `electron-updater` wired per-OS behind the platform
   layer (`UPDATER` marker; renderer IPC byte-identical, autoDownload+autoInstallOnAppQuit
   off); `scripts/prod.ps1` + `scripts/release.ps1` authored (BOM-guarded — Windows
   PowerShell 5.1 needs it; note the Edit tool strips BOMs); WinRT toast notifier with
   probed `notifications` capability; python-build-standalone `3.14.7+20260807` bundled.
   A real artifact was built (`build\win\Autowright-0.4.1-win32-x86_64.exe`, 141.5 MB,
   loud UNSIGNED warnings) and a full silent install → real service registration on the
   bundled interpreter → healthy backend → service uninstall → NSIS uninstall cycle passed
   on this machine with zero §3 contradictions.
   Still open:
   - `docs/index.html` Windows download CTA + the first `release.ps1` run against a real
     tag (feed goes live under `docs/updates/win32-x86_64/` then). Until the feed is live,
     a packaged app's manual update check answers the plain no-feed error.
   - Signing cert (decision 3): pipeline ready, `publisherName` deliberately unset.
   - Cosmetic: uninstall registry key has empty Publisher/InstallLocation until signing;
     exe `CompanyName` resource reads "GitHub, Inc." (needs `author` in app/package.json —
     touches the shared mac pipeline, David's call).
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
