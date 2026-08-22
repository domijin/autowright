# Autowright SPEC — Packaging & process lifecycle

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 3. Packaging & process lifecycle (decided)

**The Python backend runs as a per-user OS service, independent of the Electron app** — a
launchd LaunchAgent on macOS, a Task Scheduler task on Windows (its block below). Primary use
case: a machine left running unattended for days must keep firing triggers with no UI open.

Everything OS-coupled in this section sits behind the §2 platform layer. launchd is the
macOS `ServiceManager` (`service.py` is its implementation module); Task Scheduler is the
Windows one (the **Windows service** block below); on Linux the `service` actions answer a
plain "not supported on <OS> yet" failure line (exit 1 via the result-code rule below)
instead of crashing on a missing `launchctl`. Future per-OS decisions are recorded in the
port plan, not here, until they ship.

**Implementation status:** the launchd/CLI/discovery half is implemented (`service.py`, `cli.py`,
`backend.json`), and so is app-launch registration (the ensure-backend step below). The
distributable build is implemented (`./scripts/prod.sh`, §18):
`Autowright.app` with the bundled relocatable Python in `Contents/Resources/python/` plus a DMG,
always Developer-ID-signed with hardened runtime and notarized — there is no ad-hoc fallback.
(An ad-hoc build is not distributable: on a downloaded, quarantined copy, Gatekeeper silently
refuses to spawn the unsigned bundled Python as a LaunchAgent — see the install-verification
note below.) The identity comes from `CODESIGN_IDENTITY`, or is auto-detected as the single
"Developer ID Application" identity in the Keychain; the script aborts up front if neither
yields one. Notarization: `prod.sh` submits a zip of the signed app via
`xcrun notarytool submit --wait` (Keychain credentials profile named by `NOTARY_PROFILE`, default
`autowright-notary`), staples the ticket to the app, builds the DMG from the stapled app, signs
the DMG, then submits and staples the DMG as well — so both artifacts pass Gatekeeper offline.
The launch-time version-compare/re-register flow and the in-app updater are implemented (see
the update bullets below).

- **Identifiers (decided):** reverse-DNS of the product domain `autowright.ai` — app bundle id
  `ai.autowright.app` (set by `prod.sh` at packaging time; the same string is the Windows
  appId and AppUserModelID — the Electron main process calls
  `app.setAppUserModelId('ai.autowright.app')` on Windows so taskbar grouping/pinning and
  the §3 toast identity all agree with the installer's Start-menu shortcut), backend
  LaunchAgent label / Task Scheduler task name `ai.autowright.backend`. The Keychain
  service name is the plain string `Autowright` (§4.8), not reverse-DNS.
- The backend ships inside the Electron `.app` bundle
  (`Contents/Resources/python/`). **Ensure-backend:** at every app launch, the Electron main
  process probes the backend (`backend.json` + unauthenticated `GET /health`, short timeout); if
  unreachable, it runs the bundled service module — `Contents/Resources/python/bin/python3 -m
  autowright.service install` — which writes the LaunchAgent plist and bootstraps it via
  `launchctl`. `service.py` owns this and is directly runnable (`python -m autowright.service
  install|uninstall|status|restart`); the §20 CLI's `autowright service …` group is a thin
  wrapper over the same functions. **The UI and the backend never invoke the CLI** — the CLI is
  a pure client leaf (it calls the backend API and the service module; nothing calls it). The
  app may *install* the CLI shim (the CLI-on-PATH bullet below) but never executes it. This is
  the same single `service install` code path headless setups run by hand; there is no separate
  registration mechanism (`SMAppService` was considered and dropped — it would need a native
  helper for no gain). No sudo required. A healthy backend is never touched, so an app launch
  never interrupts running executions. Registration output/errors append to `app.log`
  (visible in the §9.3 developer log overlay). Dev launches (`electron .` from the repo) have no
  bundled Python, so the ensure step is a no-op there — `scripts/dev.sh` installs the service
  from the repo venv before launching Electron, through the same `service install` code.
  **Install verification:** `launchctl` can report success while the job never spawns (observed:
  Gatekeeper silently refuses to exec an unsigned, quarantined bundled Python as a LaunchAgent —
  the GUI app's user approval does not extend to launchd). So after a `service install`, the main
  process polls `/health` every 2 s for up to 30 s. Success and failure both append to `app.log`;
  on failure the main process also captures `launchctl print gui/<uid>/ai.autowright.backend`
  into `app.log` and records a failed ensure-backend status. The renderer reads that status over
  the preload bridge (`backend-status` IPC: `{ state: 'idle'|'installing'|'ok'|'failed', detail }`)
  and the §9 boot splash shows the failure detail instead of waiting silently. The renderer keeps
  retrying regardless — a late backend still connects.
- **Bundled Python (decided):** the app ships its own relocatable CPython (python-build-standalone
  builds) inside the bundle (`Contents/Resources/python/`; on Windows the packaged layout is
  `resources\python\` and the interpreter sits flat at `python\python.exe` — the
  `*-pc-windows-msvc-install_only` builds have no `bin/` directory — resolved per-OS by the §2
  platform layer's `bundledPythonPath`). The backend, the engine, and every
  step script execute on this one interpreter. The system/user Python is never used, never required,
  and never installed — users install nothing, and every Mac gets the identical interpreter
  version. The launchd plist points at the bundled interpreter by absolute path (`sys.executable`
  at install time; python-build-standalone resolves its own home relative to the binary, so no
  `PYTHONHOME` is needed). Moving the app bundle breaks that path — launchd then can't start the
  backend, and the next app launch's ensure-backend step re-registers with the new path.
  pip-generated `bin/` entry-point scripts carry absolute staging-path shebangs from the build,
  so nothing may invoke them inside the bundle — the backend/CLI always run as
  `python3 -m autowright.main` / `-m autowright.cli`. **Signing procedure:** every Mach-O gets a
  hardened-runtime, timestamped Developer ID signature, signed inside-out and explicitly — never
  `codesign --deep`, which leaves Electron Framework's nested dylibs (libEGL, libGLESv2,
  libffmpeg, libvk_swiftshader…) unsigned/un-timestamped and breaks the outer seal (notarization
  rejects with "signature of the binary is invalid"). Order: (1) all `.so`/`.dylib` + executables
  in the Python tree, (2) every Mach-O inside `Contents/Frameworks`, detected by file content
  rather than name/location — executables hide in odd places (Squirrel's `Resources/ShipIt`,
  Electron's `Helpers/chrome_crashpad_handler`),
  (3) each `.framework` bundle, (4) each helper `.app` with the Electron entitlements,
  (5) the main app bundle with the same entitlements. Entitlements (required for Electron/V8
  under hardened runtime, generated by `prod.sh`): `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`. The bundled-interpreter smoke test
  must run **before** signing (and with `PYTHONDONTWRITEBYTECODE=1`): importing packages writes
  `.pyc` files into `Resources/python`, and any write after signing breaks the bundle's resource
  seal — notarization then rejects the main binary even though the pre-write local verify passed.
  The seal is re-verified immediately before submission.
- **CLI on PATH (decided):** the CLI ships only inside the bundle — never via pip/PyPI (a second
  channel would reintroduce a user-provided Python and version skew between CLI and backend,
  which the one-`VERSION` design excludes by construction). The command is a shim script named
  `autowright`: `#!/bin/sh` with an `# autowright CLI shim` marker line, then
  `exec "<python>" -m autowright.cli "$@"` (module form per the shebang rule above; `<python>`
  is the backend's real interpreter). On Windows (§2 groundwork, defined by `win32.cjs`) the
  shim is a batch file `autowright.cmd`: `@echo off`, a `rem autowright CLI shim` marker line,
  then `"<python>" -m autowright.cli %*`, CRLF line endings, installed at
  `%LOCALAPPDATA%\Autowright\bin\autowright.cmd` (user-owned, same no-privilege rule; the
  backend `service install` healing half below stays macOS-shaped until the Windows
  ServiceManager lands). The command name is `autowright` (no short alias for now).
  **One install location per OS:** `~/.local/bin/autowright` (macOS/Linux) /
  `%LOCALAPPDATA%\Autowright\bin\autowright.cmd` (Windows) — user-owned, so no privilege and no
  password, ever. There is no admin-prompt (osascript) flow anywhere anymore. Creation happens
  in exactly two ways, both silent and user-local: the §4.9 COMMAND LINE card (its `cliEnabled`
  toggle, or the missing-row Reinstall button) and a **one-shot first-run install**. The
  one-shot runs at renderer boot once the settings snapshot has loaded and the preload bridge
  exists: if `cliEnabled` (default true, §4.9) is on and the `ad-cli-installed` localStorage
  marker (§15) is unset, the renderer reads `cli-status` and fires `cli-install` when the
  state is `missing`. The marker records "first run settled": it is set on install success and
  when the state is already `installed` or `foreign` (foreign files are never
  touched); a failed install leaves it unset so the next launch
  retries, and, unlike the toggle flow, never patches the setting to false (a transient
  failure must not become a permanent opt-out). Successful card installs set the marker too.
  Once the marker is set the app never creates a shim on its own again: a hand-deleted shim
  stays deleted (the §4.9 missing row is the explicit way back). Turning the toggle off also
  deletes the shim, behind the §4.9 disable confirm — never silently. The preference itself
  is the stored
  `cliEnabled` setting (§4.9); the shim files on disk stay the truth about what's installed. `~/.local/bin` may be absent from the user's PATH — the shell checks the
  **login-shell** PATH (GUI apps inherit a stripped one, so it asks
  `$SHELL -l -c 'printf %s "$PATH"'` with a ~2 s timeout, caches the answer per app run, and
  counts any failure as not-on-PATH) and the card shows the one-line fix
  (`export PATH="$HOME/.local/bin:$PATH"`) after install rather than editing anyone's
  dotfiles. On Windows the PATH check reads the process environment's `PATH` instead (GUI
  apps there inherit the full user PATH — no login shell exists to ask). The per-OS location
  above is the **only** shim location — nothing outside the
  user's profile is ever read, written, or deleted. Ownership of the two halves is split:
  - **Creation is the Electron shell's job — explicit and silent.** The shell exposes two
    IPCs on the preload bridge: `cli-status` (reads the shim; states `installed` — marker
    present and exec line points at the current backend interpreter from `backend.json`
    (an ours shim pointing at another interpreter is healed in place right here — a
    user-owned file rewrites without a directory write) — `missing`, and `foreign` — the
    file exists without the marker; never touched. The result also carries `path` — the
    shim path — and `onPath` — whether `~/.local/bin` is on the
    login-shell PATH — so the §4.9 card can name the location and show the PATH hint) and
    `cli-install` (plain unprivileged writes to `~/.local/bin/autowright`: `mkdir -p`, write
    the shim, `chmod 755`. No dialog, no password). A third IPC, `cli-uninstall`
    (fired by the §4.9 disable confirm), removes the ours-marker shim — same
    rules as `service uninstall` below: marker required, foreign files never touched, and a
    failed delete is reported back as an error message the §4.9 card toasts.
    The interpreter path comes from `backend.json`'s `python` field, so the same code works
    in dev (repo venv) and prod (bundled interpreter) — no dev-only path.
  - **Healing is `service install`'s job — silent and sudo-free** (§3 has no sudo anywhere in
    the plumbing): when the shim exists, carries the marker, and its exec line names a
    different interpreter (moved bundle, dev↔prod
    switch, update), install rewrites it in place — rewriting a user-owned file needs no
    directory write. It never *creates* a shim (creation is the shell flow above) and never
    touches a foreign file (no marker). The install result line reports the shim state either
    way.
  `service uninstall` removes the shim when the marker identifies it as
  ours (a failed delete puts the error on the result
  line). Users who skip the shim always have the
  module form: `<python> -m autowright.cli`.
- launchd keeps it alive: `RunAtLoad` + `KeepAlive` (restart on crash). launchd also guarantees a
  single backend instance — the UI and CLI are always clients, never owners.
- **Windows service (decided): Task Scheduler**, implemented in `platform/windows.py` —
  the closest match to `RunAtLoad` + `KeepAlive` (logon trigger + restart-on-failure) with no
  extra supervisor process. The launchd contract above maps as:
  - Task name `ai.autowright.backend` (the same reverse-DNS label as the LaunchAgent).
    Action: the backend interpreter's `pythonw.exe -m autowright.main` — `pythonw.exe` sits
    beside `python.exe` in both the venv and the python-build-standalone layouts, and it
    keeps a console window from flashing at every logon.
  - Registration goes through the PowerShell ScheduledTasks cmdlets, never bare
    `schtasks.exe`: restart-on-failure (`New-ScheduledTaskSettingsSet -RestartCount
    -RestartInterval`, the KeepAlive equivalent) is not expressible from the schtasks CLI.
    Logon trigger (`New-ScheduledTaskTrigger -AtLogOn`, the RunAtLoad equivalent); install
    starts the task immediately (`Start-ScheduledTask`, the `launchctl kickstart`
    equivalent).
  - Verb mapping: `install` = register (or update in place) + start + the same health-poll
    verification as macOS; `uninstall` = stop + `Unregister-ScheduledTask`; `status` =
    `Get-ScheduledTask` state line; `stop` = `Stop-ScheduledTask` only — the task stays
    registered and returns at next logon (mirrors the macOS "bootout only" rule); `restart`
    = stop + start. Every verb answers a §3-style result line so `service.result_code`
    keeps working, and every PowerShell invocation carries a timeout with a plain-word
    failure on expiry (the same never-hang rule as `launchctl`'s 30 s cap).
  - Log routing: Task Scheduler does not capture stdout/stderr the way launchd does — on
    Windows the backend opens and rotates its own log file under the §5 logs root
    (`main.py`), and the writer must never keep the handle open across the startup trim
    (a held handle turns the trim into a sharing violation).
  - With this shipped, `capabilities.service` is true on Windows and the §3 shim-heal half
    of `service install` covers the `.cmd` shim.
  - **Windows notifier (decided, ships with the packaging step):** toasts via a PowerShell
    WinRT invocation (`ToastNotificationManager` + toast XML, no extra dependency), posted
    under the AppUserModelID `ai.autowright.app`. An unpackaged app cannot own an AUMID —
    Windows requires a Start-menu shortcut carrying it, which the §3 NSIS installer
    creates — so the notifier ships with the packaging step, degrades silently when the
    AUMID isn't registered (dev runs), and `capabilities.notifications` flips true only in
    the packaged build's environment (probed, not assumed).
  - **Semantics that differ from launchd, accepted:** `Stop-ScheduledTask` terminates the
    task's process tree outright — Windows has no SIGTERM-to-the-job analogue — so the
    graceful-shutdown pass (hard-killing live step groups, cancelling drafting jobs,
    unlinking `backend.json`) never runs on a Windows stop/restart/uninstall. A stale
    `backend.json` therefore survives a stop until the next boot rewrites it — covered by
    the stale-file readers above, and never a crash. Stop verification is the manager's
    view (task state left `Running`), which flips ~1.5 s before the process tree is fully
    gone; install's stop→register→start sequence outlasts that gap. `status` has no pid to
    print (`Get-ScheduledTask` exposes none): the Windows lines are `active (task
    running)`, `stopped (task present) — returns at next logon or app launch` (exit 0), and
    `not installed` (exit 1) — same three states as macOS, pid replaced by the task view.
    Windows `stop` runs the same stray-process sweep as macOS (quit-entirely bullet below)
    after `Stop-ScheduledTask` verifies: `kill_matching` enumerates `Win32_Process` command
    lines via `Get-CimInstance` with plain `.Contains()` marker matches (never `-like`
    wildcards, so marker paths need no escaping), skips rows with a NULL `CommandLine`
    (never kill what can't be verified), and excludes both the enumerating PowerShell
    (`$PID` — its own command line embeds the marker literals) and the sweeping python's
    pid; each match dies by the `taskkill /F /T /PID` tree kill, both TERM/KILL grades
    collapsing to it as everywhere on Windows. The sweep is the compensation for the
    graceful pass never running here: it clears the own-process-group children the tree
    kill orphans (pip, executors, stray CLI invocations).
- Step processes die with their backend: graceful shutdown hard-kills every live step group,
  and startup recovery SIGKILLs any group a crashed backend orphaned (via the record's
  persisted `pgid`, §4.5, with a pid-reuse guard) before marking its record interrupted —
  otherwise the orphan keeps writing `memory/` while the next cron tick starts a second copy.
  Graceful shutdown is time-boxed: uvicorn runs with `timeout_graceful_shutdown` set to the
  `main.py` `SHUTDOWN_GRACE_S` constant (5 s), because the renderer keeps its §19 `/ws`
  socket open during quit-all and reset, and an unbounded shutdown waits on open WebSockets
  forever, blowing the stop's 10 s deregistration wait. At the bound uvicorn force-closes
  the connections and the lifespan shutdown still runs. Every piece of the backend's
  shutdown work lives in that lifespan: uvicorn re-raises the captured SIGTERM once its
  `run()` returns, killing the process before any code after `run()` (a `finally` in
  `main()` included) can execute, so `main()` registers its cleanup (stopping the
  discovery-guard thread, the scheduler, and the listeners, then unlinking its own
  `backend.json`) with the api module via `api.register_shutdown`, and the lifespan runs
  those callbacks, each once and error-tolerant, after the kill passes. A signal-driven
  stop therefore removes `backend.json` on macOS; the Windows tree kill still leaves it
  (the stale-file caveat in the Windows block).
  §8 drafting harnesses die with the backend too: graceful shutdown cancels every
  still-building drafting job and SIGKILLs its harness session group outright (the process is
  exiting, so cancel's term-then-kill grace thread would never get to fire). Unlike step
  groups they leave no persisted record, so crash recovery cannot sweep one; a harness
  orphaned by a backend crash simply runs to its own completion. The mirror case — a
  client that dies or navigates away while the backend lives on — is not an orphan at
  all: the job keeps building and its outcome is held for the §11 re-attach (§19
  background continuation), bounded by the §8 idle window and wall-clock hard cap.
- Quitting the Electron app (window and menu bar) never stops the backend; the scheduler keeps
  running. The §4.9 `login` setting controls only whether the UI starts at login — the backend
  service stays registered regardless once onboarding completes.
  **One explicit exception:** the Settings page's "Quit Autowright entirely" action (§4.9 QUIT
  card). It runs `python -m autowright.service stop` and then quits the Electron app; the
  plist and the CLI shim stay on disk. `stop` is bootout **plus a stray-process sweep**: after
  launchd deregisters the job (or the 10 s deregistration wait expires), the stop TERM-then-KILLs
  every remaining process whose command line carries an Autowright marker (the §2
  `kill_matching` primitive), always excluding the stop process itself and its own process
  group (the Electron caller). The markers come from `paths.sweep_markers()`: the module
  invocation `-m autowright.` (survives interpreter-path resolution in `ps`, which shows a
  venv python's resolved framework binary in dev), the current interpreter path
  (`sys.executable`, which in the packaged app is the in-bundle python and so also matches
  pip children), the `bin/autowright*` entry scripts beside it, and on Windows the console
  sibling from `paths.console_python()`. Never the realpath'd interpreter: in dev that is a
  shared system python and would match unrelated processes. The invariant this buys:
  immediately after a successful quit-all, no process holds the app bundle open, so the user
  can move Autowright.app to the Trash with no "in use" alert. A sweep that ended processes
  appends an informational `· ended N lingering process(es)` note to the success line (after
  `·`, so `service.result_code` is unchanged). The live-execution gate is a confirmation, not
  a hard block: a busy answer makes the renderer ask whether to shut everything down anyway
  (§4.9 force-confirm modal) and, on confirm, retry the `quit-all` IPC with `force: true`,
  which skips the gate; the backend's graceful shutdown (`kill_all_live`) plus the sweep end
  the running execution. If the stop fails, the app does **not** quit — the error is surfaced
  instead; the app must never quit its UI while the backend it promised to stop keeps running.
  A stopped backend returns at next login (`RunAtLoad`) or next app launch (ensure-backend
  re-heals) — stopped, never uninstalled.
- **Reset — delete all data and start over (§4.9 RESET card, decided).** The renderer confirm
  fires a `reset-all` IPC; the Electron main process orchestrates, in order:
  1. The same live-execution gate as quit-all/update-install (busy → `{ busy: true }`,
     nothing touched; an unreachable backend counts as idle).
  2. Capture `GET /settings`' `dataPath` while the backend is still up — the executions dir
     is user-movable (§4.9) and may live outside the data root.
  3. `DELETE /secrets` on the live backend (§19) — only the backend's keyring can reach the
     Keychain / Credential Manager. A failure here (the §19 unreadable-store 409 included) is
     logged to `app.log` and the reset **proceeds**: value deletion is already best-effort per
     entry (§4.8), and an unreadable `secrets.yaml` means those ids were unreachable this
     session anyway.
  4. `service stop` through the same interpreter resolution and install-interlock as
     quit-all. A stop failure aborts the reset with `{ error }` — the app stays up, and at
     that point nothing has been deleted beyond step 3's secrets.
  5. Delete the executions dir (the captured `dataPath`), the logs root, and every entry of
     the data root **except** the live Chromium profile `electron/` — Chromium holds open
     handles on it, so deleting it would fail (on Windows, a sharing violation outright). A
     `dataPath` that itself contains the live profile (a user pointed it at the data root) is
     not deleted wholesale — the per-entry sweep still covers everything else, preserving the
     except-the-live-profile invariant. The
     profile is cleared with `session.defaultSession.clearStorageData()` plus `clearCache()`
     instead — every §15 localStorage marker (`ad-cli-installed` among them) goes, which is
     what matters — and the directory's residual Chromium internals are accepted residue
     (same acceptance as the updater-cache bullet below). On Windows every deletion retries
     briefly (up to ~10 s total): the stop-verification gap above means the backend's file
     handles (`executions.db`, its own log file) can outlive a reported stop by a moment.
     Deletion failures that survive the retries are logged and the flow continues — a
     leftover file must not strand the app mid-reset. Step 4's stray-process sweep means
     the backend's file handles are normally gone before deletion starts, leaving the
     retry loop to cover the Windows stop-verification gap alone.
  6. `app.relaunch()` + `app.exit(0)`. The relaunched app finds no `backend.json` and an
     empty data root: ensure-backend re-registers the service, the backend recreates the §5
     layout with defaults, and §10 onboarding runs as on a fresh install. In a dev launch
     the §18 harness supervises past this relaunch — the relaunched process inherits
     `AUTOWRIGHT_RENDERER_URL` and has no bundled Python, so dev.sh/dev.ps1 keep Vite alive
     and re-ensure the stopped backend; the §9 never-paint rule keeps the relaunched window
     hidden (never blank) until the dev server answers.

  Each destructive step announces itself to the main window as it starts — a
  `reset-progress` renderer push carrying a stage token: `secrets` (step 3), `service`
  (step 4), `data` (step 5), `relaunch` (step 6). Fire-and-forget, no renderer ack —
  these drive the §4.9 reset progress overlay's stage line; the busy gate and the
  `dataPath` capture push nothing (the overlay shows "Preparing…" until the first token).

  **The service registration, the CLI shim, and the app itself deliberately survive a
  reset** — only data is erased. The wiped first-run marker just lets the §3 one-shot settle
  again (shim already `installed` → marker re-set, no write). Headless parity is composition,
  not a new verb: `autowright secret delete --all` (§20), `autowright service stop`, then
  deleting the §5 roots by hand. There is no in-app uninstall — removing the app itself is
  the OS's job (or Homebrew's, whose cask `zap` covers the data directories, cask bullet
  above); `service uninstall` remains the headless way to deregister the backend and remove
  the shim.
- Discovery: the backend listens on localhost and writes its port + auth token to
  `backend.json` in the §5 data root — `~/Library/Application Support/Autowright/` on macOS,
  written 0600; `%LOCALAPPDATA%\Autowright\` on Windows, where POSIX mode bits restrict
  nothing and the protection is the profile's inherited ACL (`%LOCALAPPDATA%` grants access
  only to the user's account, SYSTEM, and Administrators — the same trust boundary 0600
  draws on macOS, where root reads anything; documented, no explicit icacls write). UI and
  CLI read it to connect.
  Fields: `port`, `token`, `version`, `pid`, and `python` — the backend's `sys.executable`,
  read by the shell's CLI-on-PATH machinery (above) so the shim always execs the interpreter
  that actually runs the backend, dev and prod alike. One per-OS mapping: on Windows the
  service runs the backend under `pythonw.exe` (§3 Windows service block — no console
  window), but the published `python` field is the console `python.exe` beside it when one
  exists — the field exists for the CLI and shim, which need console output, and both
  binaries resolve the same interpreter home. This also keeps the shell's shim writes and
  `service install`'s heal agreeing on one exec line.
  The backend binds its socket first and only then publishes `backend.json` (uvicorn serves on
  the already-bound socket) — the file never points clients (token included) at a port the
  backend doesn't own. A stale/truncated `backend.json` (SIGKILL leftovers) makes the CLI and
  `service status` report it as such — never crash. The same rule covers a well-formed
  `backend.json` whose backend is gone: a CLI request that can't connect (connection refused,
  timeout) exits with the same restart guidance, never a traceback.
  Every backend start binds a fresh port and token, so the renderer re-reads `backend.json`
  (via the preload bridge) before each WebSocket reconnect attempt — a backend restart never
  strands the UI on a dead address.
  The backend also guards its own discovery file: every 10 s it re-publishes `backend.json` if
  the file is missing or unreadable (recreating the §5 directories first) — an externally wiped
  Application Support dir must not strand clients on a healthy backend that launchd `KeepAlive`
  will never restart. A well-formed file holding a different pid is left alone: during a service
  restart it may already be the successor's.
- **One app process** (`requestSingleInstanceLock`): a second launch (a login item racing a
  manual open, `open -n`) quits immediately and focuses the existing window via the
  `second-instance` event — never a second tray icon, never a second §6 `POST /app-started`.
- **In-app updates (decided):** the app checks for updates automatically by default — §4.9
  `automaticUpdateCheck`, default true; PRIVACY.md names the daily check and its off switch.
  Turning the toggle off restores strict manual-only checking (no background or launch
  checks; everything starts from the About page's "Check for updates" button). Downloads and
  installs are always manual, both modes — a check only ever reads the feed. Machinery
  is Squirrel.Mac via Electron's built-in `autoUpdater` (its `ShipIt` helper
  already ships in the bundle). The repo and its releases must stay public — the update zip is
  downloaded unauthenticated.
  - **Automatic check:** `applyShellSettings` reconciles §4.9 `automaticUpdateCheck`
    exactly like `login`/`menuBarIcon` (startup, 60 s poll, renderer push). On the off→on
    transition (which includes a launch with the setting on — the default) it runs the same
    feed fetch as `update-check` immediately, then every 24 h on a timer; on→off clears the
    timer. Nothing is persisted about past checks — each launch with the toggle on checks
    once at startup. Automatic-check failures are silent (no nav row, no toast — the manual
    button still reports errors), and an automatic check never starts a download.
  - **update-available event:** any check — manual `update-check` or automatic — that finds a
    newer version records it in the main process and pushes an `update-available`
    IPC event (the version string) to the main window; an `update-available` invoke handler
    answers the remembered version (or `null`), so a renderer that boots after the check still
    learns it — the §9 store subscribes to the event and asks the handler once at boot,
    keeping `updateAvailable`. It feeds the §9 "Update available" nav row and the §9.4
    pre-armed row.
    A later check answering up-to-date clears the remembered version and pushes `null` (the
    feed rolled back, or the user updated by hand); an `error` check leaves it alone.
    Otherwise it clears only with the app restart that installs the update.
  - **Artifacts:** `prod.sh` emits, next to the DMG, a zip of the signed + stapled app
    (`ditto -c -k --keepParent` → `Autowright-<version>-darwin-<arch>.zip`; the DMG is named
    `Autowright-<version>-darwin-<arch>.dmg`) — Squirrel.Mac consumes
    zips, not DMGs. `release.sh` uploads both to the GitHub release.
  - **Feed:** one static Squirrel.Mac JSON feed per arch at
    `https://autowright.ai/updates/darwin-<arch>.json` (`arm64` | `x86_64`; the files live in
    §17 `docs/updates/`, served by GitHub Pages). After publishing the release, `release.sh`
    rewrites the built arch's feed — `currentRelease` plus a single `releases[]` entry whose
    `updateTo.url` is the release zip's `github.com/<owner>/<repo>/releases/download/…` URL —
    and commits + pushes it (plain git commit, not `commit.sh`).
  - **Flow** (Electron main; the renderer drives it over IPC, §9.4 renders it):
    `update-check` fetches the feed (10 s timeout, no cache) and compares `currentRelease`
    against `app.getVersion()` with the §9.4 rule (numeric on dot-split parts, leading `v`
    ignored, malformed = not newer) → `{ state: 'uptodate' | 'available' | 'error', … }`.
    `update-download` downloads the zip itself so the UI can show determinate progress —
    Squirrel's `autoUpdater` emits no progress events. It re-fetches the feed, streams the
    `updateTo.url` zip to a temp file, and pushes progress to the main window as
    `update-progress` IPC events (percent from `Content-Length`; `null` when the header is
    missing — the §9.4 bar goes indeterminate). It then hands the staged zip to Squirrel
    through a one-shot loopback HTTP server (`127.0.0.1`, ephemeral port) serving the feed
    JSON — rewritten so `updateTo.url` points at the server's own zip route — and the zip
    file; `autoUpdater.setFeedURL` targets that local feed (`serverType: 'json'`),
    `checkForUpdates()` runs, and the handler resolves `{ ok: true }` on `update-downloaded`
    or `{ error }` on the first `error` event; if Squirrel emits neither within 10 minutes
    the handler settles with a plain-word error instead of hanging the §9.4 flow forever.
    Server and temp zip are cleaned up on every
    outcome. There is no dev fork: an unsigned dev build takes
    the same path and surfaces Squirrel's real signature error in the UI.
    `update-install` asks the backend for live executions
    (`GET /executions?status=executing`) and answers `{ busy: true }` while any is running —
    swapping the bundle mid-execution risks a step lazily importing mixed versions; an
    unreachable backend counts as idle. Otherwise it calls `autoUpdater.quitAndInstall()`.
    ShipIt swaps the bundle at the same path, so the LaunchAgent's absolute interpreter path
    stays valid. On a platform whose §2 module serves no update feed URL, **every** update
    path answers the same plain "Updates are not supported on this platform yet." line up
    front: `update-check` answers `state: 'error'` carrying that line as its error detail —
    the §9.4 page renders the carried detail, never the generic "Couldn't reach
    autowright.ai" network copy, so the user is never told to retry something that cannot
    succeed — and `update-download` / `update-install` refuse with the same line (defense
    in depth — the §9.4 UI never offers them without a feed, and `quitAndInstall` with
    nothing staged must never quit the app for no swap).
  - **Homebrew-managed detection:** the install counts as brew-managed when the Caskroom
    metadata directory exists: the main process probes `/opt/homebrew/Caskroom/autowright`
    and `/usr/local/Caskroom/autowright` with `fs.existsSync`, fresh on every query and
    never cached, so switching channels (brew install or uninstall while the app runs)
    needs no restart. The `AUTOWRIGHT_CASKROOM` environment variable replaces the probe
    list with its single path (test/dev escape hatch, same pattern as `AUTOWRIGHT_HOME` /
    `AUTOWRIGHT_SHIM`). An `update-brew-managed` invoke handler answers the boolean to the
    renderer. Checks (manual and automatic) behave identically in both modes; when
    brew-managed, `update-download` and `update-install` refuse immediately with
    `{ error: 'This copy is managed by Homebrew.' }` (defense in depth; the §9.4 UI never
    offers those actions in brew mode and instead shows the `brew upgrade` command).
  - **Backend handoff:** the swap leaves the old backend process running; the next app
    launch's version-compare flow (next bullet) restarts it onto the new bundle.
- **Launch-time backend version compare (implemented, in ensure-backend):** when the probe
  finds a healthy backend, the main process compares `/health`'s `version` with its own
  `app.getVersion()` (one §17 version source, so app and bundled backend versions agree by
  construction). On mismatch it waits for live executions to drain
  (`GET /executions?status=executing`, polled every 30 s — the service is never restarted
  mid-execution), then runs the same `service install` path, which rewrites the plist and
  restarts the service on the current bundle's interpreter. Outcome lines append to `app.log`.
- Sleep: the service manager does not prevent sleep. Two idle-sleep assertions exist, both
  owned by the §2 platform layer's `PowerAssertion` (engine and settings code call the layer —
  `hold_execution()` / `reconcile(enabled)` — never an OS mechanism directly; a platform with
  no implementation composes a no-op and `keepAwake: false`):
  - **Per-execution:** held for the duration of an active execution (prevents idle sleep
    mid-execution; forced sleep — lid close, low battery — can still suspend an execution).
    `hold_execution()` returns a release callable the engine calls when the execution
    finishes; acquiring and releasing never raise. Outside executions, normal OS energy
    settings apply and missed occurrences follow the §6 missed-execution policy.
  - **Permanent (§4.9 `keepAwake`, on by default):** for the always-on use case (a machine
    left running to catch schedules and §6 message triggers), the setting makes the backend
    hold a permanent idle-sleep assertion — started at backend boot when the setting is on
    and started/stopped live from `PATCH /settings` (`reconcile`, idempotent) — no restart.
    Display sleep stays allowed; user-forced sleep still wins. This covers sleep only —
    logging out of the OS session still stops the service (and on macOS locks the Keychain,
    headless bullets below); for an unattended machine, stay logged in (screen lock is fine)
    or enable auto-login.

  Per-OS mechanisms. **macOS** (`awake.py`, delegated to by `platform/darwin.py`): each
  assertion is its own `caffeinate -i -w <backend pid>` subprocess — the `-w` ties it to the
  backend process, so a crashed backend can never leave an orphan keeping the Mac awake.
  **Windows** (`WindowsPower` in `platform/windows.py`): one thread-owned
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` behind a counted set of
  holds — the permanent keepAwake hold plus one per active execution; the state is set while
  the count is positive and cleared (`ES_CONTINUOUS` alone) when it reaches zero, always from
  the single dedicated thread that owns it (execution state is per-thread). Never
  `ES_DISPLAY_REQUIRED` — display sleep stays allowed. Windows clears a thread's execution
  state when its process dies, so a crashed backend can never leave an orphan — the same
  guarantee `-w` gives on macOS.

- **Homebrew cask (decided):** a second install channel beside the DMG download, distributed
  from the project's own tap `hansololz/homebrew-tap` (repository `homebrew-tap`, cask file
  `Casks/autowright.rb`, token `autowright`) — `brew install --cask hansololz/tap/autowright`.
  Homebrew 6 refuses to load a cask from a third-party tap until the user trusts it, so the
  tap's README documents `brew tap hansololz/tap` + `brew trust --tap hansololz/tap` before the
  install; after the tap is added the bare token `autowright` resolves.
  Not submitted to `Homebrew/homebrew-cask`: that requires notability (75 stars / 30 forks /
  30 watchers) the project does not have, and the only thing it would buy is dropping the tap
  prefix. The cask installs the same signed + notarized DMG from the GitHub release, so
  Gatekeeper needs no override and there is no second artifact to build or verify. Its shape
  follows from this section: `depends_on arch: :arm64` and `depends_on macos: :monterey` (the
  bundle's `LSMinimumSystemVersion`); no `auto_updates` stanza: Homebrew is the update manager
  for this channel. The in-app updater never installs onto a brew-managed copy (the
  Homebrew-managed detection bullet above), so Homebrew's recorded version stays accurate and
  a plain `brew upgrade` upgrades the cask, no `--greedy` needed. One-time caveat: a copy that
  brew-installed under the old `auto_updates true` cask and then updated in-app carries a
  stale brew record; its first `brew upgrade` after this change reinstalls the latest DMG,
  harmlessly. `uninstall launchctl:` before `quit:`, since
  launchd would otherwise keep restarting a backend whose bundled interpreter was just removed;
  and `zap trash:` covering the §5 data directory, the logs directory, the LaunchAgent plist
  and preferences/saved-state, and the `~/.local/bin/autowright` shim — never the
  Keychain secrets (§4.8), which the user removes by hand.
  A `livecheck` block reads `currentRelease` from the same arch feed the updater uses, so the
  cask stays checkable by `brew livecheck` and would be autobump-eligible if it ever moved to
  core. Version bumps are `release.sh`'s job (§18), never a manual edit.

**Windows packaging & updates (decided — NSIS + electron-updater).** The Windows
distributable is built by **electron-builder for the Windows target only** (`--win nsis`),
driven by a new `windows-scripts/prod.ps1`; macOS keeps `@electron/packager` + `prod.sh` untouched.
Rationale: hand-rolling what electron-updater consumes (the NSIS script, `latest.yml`, the
blockmap, the in-app `app-update.yml`) would re-implement electron-builder badly, and
electron-builder also provides the sign-later hook for free. Squirrel.Windows was considered
and dropped (dormant project; the name-sharing Squirrel.Mac stays on macOS unchanged).

- **`prod.ps1` order mirrors `prod.sh`:** sync `VERSION`, vite build, download
  python-build-standalone `x86_64-pc-windows-msvc-install_only` (flat layout:
  `python\python.exe`), pip install the backend into it with `-c constraints.txt` before
  packaging, ship the interpreter via `extraResources` into `resources\python`, then
  electron-builder produces the installer. The bundled-interpreter smoke test runs before
  packaging with `PYTHONDONTWRITEBYTECODE=1` (same principle as the macOS seal rule).
- **Installer shape:** per-user NSIS (`perMachine: false` — no admin prompt, the same
  no-privilege principle as the rest of §3), install dir under `%LOCALAPPDATA%\Programs`,
  appId `ai.autowright.app`, and a **stable NSIS GUID pinned in config from day one** — an
  upgrade must always find the previous install, and the stable GUID + path + appId are
  what let a future signed build upgrade an unsigned install in place. Needs `icon.ico`
  generated beside the existing icns/png (§14 assets, `scripts/gen_icon.cjs`).
- **Updater:** `electron-updater` (NsisUpdater) as an app dependency, used only on win32.
  main.cjs's update block is per-OS behind the §2 platform layer: darwin keeps the
  Squirrel.Mac JSON feed + loopback-proxy flow byte-identical; win32 uses the generic
  provider pointed at `https://autowright.ai/updates/win32-x86_64/` (`win32.cjs`
  `updateFeedUrl` returns that base once the feed is live). Feed = `latest.yml` + installer
  + blockmap: the yml is rewritten under `docs/updates/win32-x86_64/` by the release
  script; binaries ride the GitHub release — the same hosting split as the mac feed. The
  renderer-facing IPC surface (`update-check`/`update-download`/`update-install` states and
  progress events) stays byte-identical so no renderer code forks. The §3 manual-install
  rule carries over: a check only ever reads the feed — `checkForUpdates` runs with
  autoDownload off and `autoInstallOnAppQuit` off (installs happen only through the
  explicit `update-install` flow with its live-execution gate, never as a quit side
  effect); downloads and installs stay user-initiated.
- **Signing (cert later, pipeline ready now — decided):** Windows builds may ship unsigned
  for the moment (unlike the mac no-ad-hoc rule); SmartScreen warnings are accepted until a
  certificate exists. The build signs whenever cert config is present (electron-builder
  `CSC_LINK`/`CSC_KEY_PASSWORD`, or a signtool thumbprint) and otherwise builds unsigned
  while printing a loud UNSIGNED warning line — never silently. GUID, install path, and
  appId stay stable so the unsigned→signed transition is a normal update. When the cert
  arrives: sign the app exe and the installer, set `publisherName` in the updater config
  (electron-updater then verifies the downloaded installer's Authenticode identity), and
  flip this rule to always-signed. **Never set `publisherName` before signing starts** — it
  would make updates fail against unsigned artifacts. Known cosmetics until the cert lands:
  the uninstall registry entry carries empty Publisher/InstallLocation values, and the exe's
  `CompanyName` version resource reads electron-builder's default ("GitHub, Inc.") because
  `app/package.json` sets no `author` field — adding one would fix it but touches the shared
  mac pipeline, so it is deliberately deferred to the signing change.
- **Updater cache residue (known, accepted):** the NSIS install caches a byte copy of the
  installer at `%LOCALAPPDATA%\autowright-updater\` (electron-updater's
  `updaterCacheDirName` — the baseline its differential downloads diff against), and the
  uninstaller does not remove it (~150 MB). Accepted as electron-updater's standard
  behavior; a user who wants it gone deletes the directory by hand. No Autowright code may
  depend on it existing.
- **Release:** Windows artifacts get their own `windows-scripts/release.ps1` (build via `prod.ps1`,
  publish installer + blockmap to the same GitHub release as the mac artifacts, rewrite
  `docs/updates/win32-x86_64/latest.yml`); `release.sh` stays bash/BSD-sed and runs on
  macOS. A release that ships both platforms is two script runs against one tag/version.
  The `docs/index.html` download CTA is mac-only until Windows artifacts exist; then it
  gains a Windows download path.

**Headless mode (decided).** The backend and CLI must work with no GUI ever launched — the §20
CLI is enabled, so the full surface below is live:

- **API parity** — every operation the UI performs goes through the backend API; the UI holds no
  private logic. The CLI is a second client of the same API and can reach full coverage without
  backend changes.
- **Bootstrap** — `autowright service install` registers the backend by writing a launchd plist to
  `~/Library/LaunchAgents/` directly (the very same code the app's ensure-backend step runs at
  launch — one registration path; install rewrites and adopts an existing registration).
  `service uninstall`, `service status`, `service restart`, and `service stop` accompany it.
  `stop` unloads the job **and sweeps stray Autowright processes** (the quit-entirely bullet
  above: `kill_matching` over `paths.sweep_markers()`, run after the unload so nothing
  KeepAlive-respawns) but leaves the plist and shim on disk ("stopped until next login or
  app launch" — the §4.9 quit-entirely action's backend half). The sweep is also the
  escalation for a backend that outlived the unload wait: its command line carries
  `-m autowright.main`, so killing it lets launchd finish the pending removal, and after a
  sweep that ended anything the stop re-polls registration (up to 5 s) before judging.
  It reports failure (exit 1) when launchd still lists the job afterwards. With no plist:
  a sweep that ended processes answers `stopped — service was not installed; ended N
  lingering process(es)` (exit 0 — this is how quit-all succeeds against a directly-spawned
  dev backend), and a sweep that found nothing keeps `not installed — nothing to stop`
  (exit 1). `install` and `restart` never sweep — they run during version-sync while
  executions may legitimately be live. `status`
  distinguishes the states: job unloaded but plist present → "stopped (plist present)", exit 0
  (stopped on purpose is not a failure); no plist → "not installed", exit 1.
  Two launchd realities the install/restart path must handle: (a) booting out a *running* job is
  asynchronous — an immediate re-bootstrap races the teardown and fails, so after `bootout` the
  code polls `launchctl print` until the job is gone (up to 10 s) before loading; (b) legacy
  `launchctl load` (the non-Aqua fallback) can exit 0 without loading anything, so after any load
  the code verifies the job actually exists in launchd and reports failure otherwise — install
  must never claim success for an unregistered service; (c) a wedged `launchctl` must never hang
  the caller (the app's ensure-backend step waits on it), so every `launchctl` invocation carries
  a 30-second timeout and a timed-out call reports the same plain-word failure as a non-zero
  exit ("launchctl timed out"), never a traceback.
- **Keychain constraint** — secrets live in the login Keychain, which is locked until the user
  session unlocks. Headless operation requires a logged-in (auto-login acceptable) session on the
  Mac; pure SSH-only operation without a login session cannot read secrets. Documented, not worked
  around.

