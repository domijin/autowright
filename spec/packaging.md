# Autowright SPEC — Packaging & process lifecycle

Part of the Autowright spec. Index and § map: [SPEC.md](../SPEC.md). § numbers are global across spec files.

## 3. Packaging & process lifecycle (decided)

**The Python backend runs as a per-user launchd LaunchAgent, independent of the Electron app.**
Primary use case: a Mac left running unattended for days must keep firing triggers with no UI
open.

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
  on failure the main process also captures `launchctl print gui/<uid>/com.autowright.backend`
  into `app.log` and records a failed ensure-backend status. The renderer reads that status over
  the preload bridge (`backend-status` IPC: `{ state: 'idle'|'installing'|'ok'|'failed', detail }`)
  and the §9 boot splash shows the failure detail instead of waiting silently. The renderer keeps
  retrying regardless — a late backend still connects.
- **Bundled Python (decided):** the app ships its own relocatable CPython (python-build-standalone
  builds) inside the bundle (`Contents/Resources/python/`). The backend, the engine, and every
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
  is the backend's real interpreter). The command name is `autowright` (no short alias for now).
  **One install location:** `~/.local/bin/autowright` — user-owned, so no privilege and no
  password, ever. There is no admin-prompt (osascript) flow anywhere anymore, and the app
  **never auto-installs**: creation happens only when the user clicks Install on the §4.9
  COMMAND LINE card. `~/.local/bin` may be absent from the user's PATH — the shell checks the
  **login-shell** PATH (GUI apps inherit a stripped one, so it asks
  `$SHELL -l -c 'printf %s "$PATH"'` with a ~2 s timeout, caches the answer per app run, and
  counts any failure as not-on-PATH) and the card shows the one-line fix
  (`export PATH="$HOME/.local/bin:$PATH"`) after install rather than editing anyone's
  dotfiles. `/usr/local/bin/autowright` is **legacy-only**: shims created there by earlier
  builds are still recognized, healed, and uninstalled, but never created. Status, heal, and
  uninstall consider **both** locations; the user-local file wins when both exist. Ownership
  of the two halves is split:
  - **Creation is the Electron shell's job — explicit and silent.** The shell exposes two
    IPCs on the preload bridge: `cli-status` (reads both candidate shims; the effective one
    is the first that exists, user-local first; states `installed` — marker present and exec
    line points at the current backend interpreter from `backend.json` — `stale` — marker
    present, different interpreter, and the file is not user-writable so the heal below
    can't fix it; only possible at the legacy `/usr/local/bin`, since a user-local file is
    always writable — `missing`, and `foreign` — the effective file exists without the
    marker; never touched. The result also carries `path` — the effective shim path (the
    install destination when missing) — and `onPath` — whether `~/.local/bin` is on the
    login-shell PATH — so the §4.9 card can name the location and show the PATH hint) and
    `cli-install` (plain unprivileged writes to `~/.local/bin/autowright`: `mkdir -p`, write
    the shim, `chmod 755`. No dialog, no password. A `stale` legacy shim is not rewritten by
    it — the card's fix is a fresh user-local install plus the manual
    `sudo rm /usr/local/bin/autowright`, and the card says so).
    The interpreter path comes from `backend.json`'s `python` field, so the same code works
    in dev (repo venv) and prod (bundled interpreter) — no dev-only path.
  - **Healing is `service install`'s job — silent and sudo-free** (§3 has no sudo anywhere in
    the plumbing): for **every** candidate location whose shim exists, carries the marker, is
    user-writable, and whose exec line names a different interpreter (moved bundle, dev↔prod
    switch, update), install rewrites it in place — rewriting a user-owned file needs no
    directory write. It never *creates* a shim (creation is the shell flow above) and never
    touches a foreign file (no marker). The install result line reports the shim state either
    way.
  `service uninstall` removes our shim from every location where the marker identifies it as
  ours and the file is deletable (deleting from a root-owned directory isn't — then the result
  line prints the manual `sudo rm` command instead). Users who skip the shim always have the
  module form: `<python> -m autowright.cli`.
- launchd keeps it alive: `RunAtLoad` + `KeepAlive` (restart on crash). launchd also guarantees a
  single backend instance — the UI and CLI are always clients, never owners.
- Step processes die with their backend: graceful shutdown hard-kills every live step group,
  and startup recovery SIGKILLs any group a crashed backend orphaned (via the record's
  persisted `pgid`, §4.5, with a pid-reuse guard) before marking its record interrupted —
  otherwise the orphan keeps writing `memory/` while the next cron tick starts a second copy.
- Quitting the Electron app (window and menu bar) never stops the backend; the scheduler keeps
  running. The §4.9 `login` setting controls only whether the UI starts at login — the backend
  service stays registered regardless once onboarding completes.
  **One explicit exception:** the Settings page's "Quit Autowright entirely" action (§4.9 QUIT
  card). It runs `python -m autowright.service stop` — bootout only; the plist and the CLI shim
  stay on disk — and then quits the Electron app. The action is gated on no live executions
  (same rule as update-install; busy → the renderer toasts and nothing stops). If the stop
  fails, the app does **not** quit — the error is surfaced instead; the app must never quit its
  UI while the backend it promised to stop keeps running. A stopped backend returns at next
  login (`RunAtLoad`) or next app launch (ensure-backend re-heals) — stopped, never
  uninstalled.
- Discovery: the backend listens on localhost and writes its port + auth token to
  `~/Library/Application Support/Autowright/backend.json` (0600); UI and CLI read it to connect.
  Fields: `port`, `token`, `version`, `pid`, and `python` — the backend's `sys.executable`,
  read by the shell's CLI-on-PATH machinery (above) so the shim always execs the interpreter
  that actually runs the backend, dev and prod alike.
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
    or `{ error }` on the first `error` event. Server and temp zip are cleaned up on either
    outcome. There is no dev fork: an unsigned dev build takes
    the same path and surfaces Squirrel's real signature error in the UI.
    `update-install` asks the backend for live executions
    (`GET /executions?status=executing`) and answers `{ busy: true }` while any is running —
    swapping the bundle mid-execution risks a step lazily importing mixed versions; an
    unreachable backend counts as idle. Otherwise it calls `autoUpdater.quitAndInstall()`.
    ShipIt swaps the bundle at the same path, so the LaunchAgent's absolute interpreter path
    stays valid.
  - **Backend handoff:** the swap leaves the old backend process running; the next app
    launch's version-compare flow (next bullet) restarts it onto the new bundle.
- **Launch-time backend version compare (implemented, in ensure-backend):** when the probe
  finds a healthy backend, the main process compares `/health`'s `version` with its own
  `app.getVersion()` (one §17 version source, so app and bundled backend versions agree by
  construction). On mismatch it waits for live executions to drain
  (`GET /executions?status=executing`, polled every 30 s — the service is never restarted
  mid-execution), then runs the same `service install` path, which rewrites the plist and
  restarts the service on the current bundle's interpreter. Outcome lines append to `app.log`.
- Sleep: launchd does not prevent sleep. The backend holds a power assertion for the duration of
  an active execution, implemented as a `caffeinate -i -w <backend pid>` subprocess (prevents
  idle sleep mid-execution; the `-w` ties the assertion to the backend process — like the
  permanent `keepAwake` one below — so a crashed backend can never leave a per-execution
  orphan keeping the Mac awake;
  forced sleep — lid close, low battery — can still suspend an execution); outside executions, normal macOS energy settings
  apply and missed occurrences follow the §6 missed-execution policy. For the always-on use case
  (a Mac left running to catch schedules and §6 message triggers), the §4.9 `keepAwake` setting
  makes the backend hold a **permanent** idle-sleep assertion: a `caffeinate -i -w <backend pid>`
  subprocess (`awake.py`), started at backend boot when the setting is on and started/stopped
  live from `PATCH /settings` — no restart. The `-w <pid>` ties the assertion to the backend
  process, so a crashed backend can never leave an orphan keeping the Mac awake. Display sleep
  stays allowed; user-forced sleep still wins. On by default. This covers sleep only — logging
  out of the macOS session still stops the LaunchAgent and locks the Keychain (headless bullets
  below); for an unattended Mac, stay logged in (screen lock is fine) or enable auto-login.

**Headless mode (decided).** The backend and CLI must work with no GUI ever launched — the §20
CLI is enabled, so the full surface below is live:

- **API parity** — every operation the UI performs goes through the backend API; the UI holds no
  private logic. The CLI is a second client of the same API and can reach full coverage without
  backend changes.
- **Bootstrap** — `autowright service install` registers the backend by writing a launchd plist to
  `~/Library/LaunchAgents/` directly (the very same code the app's ensure-backend step runs at
  launch — one registration path; install rewrites and adopts an existing registration).
  `service uninstall`, `service status`, `service restart`, and `service stop` accompany it.
  `stop` unloads the job but leaves the plist and shim on disk ("stopped until next login or
  app launch" — the §4.9 quit-entirely action's backend half); it reports failure (exit 1) when
  launchd still lists the job afterwards, and "not installed" (exit 1) with no plist. `status`
  distinguishes the states: job unloaded but plist present → "stopped (plist present)", exit 0
  (stopped on purpose is not a failure); no plist → "not installed", exit 1.
  Two launchd realities the install/restart path must handle: (a) booting out a *running* job is
  asynchronous — an immediate re-bootstrap races the teardown and fails, so after `bootout` the
  code polls `launchctl print` until the job is gone (up to 10 s) before loading; (b) legacy
  `launchctl load` (the non-Aqua fallback) can exit 0 without loading anything, so after any load
  the code verifies the job actually exists in launchd and reports failure otherwise — install
  must never claim success for an unregistered service.
- **Keychain constraint** — secrets live in the login Keychain, which is locked until the user
  session unlocks. Headless operation requires a logged-in (auto-login acceptable) session on the
  Mac; pure SSH-only operation without a login session cannot read secrets. Documented, not worked
  around.

