// §2 platform layer (shell half), Windows build. The interpreter layout,
// roots, the §3 .cmd shim and the process-env PATH probe are real; so are the
// §9 window chrome, the §13 panel placement and tray assets, the §9
// ensure-backend failure copy and the §3 update feed (electron-updater's
// generic provider). What still needs infrastructure that does not exist yet
// (a managed-install channel, service diagnostics) stays an explicit
// placeholder behind a false capability flag. Never imports
// `electron` (takes app/window objects as arguments) so the §15 source
// guards and stub loaders keep working.
const os = require('os')
const path = require('path')

const roots = require('./roots.cjs')

const OS_TOKEN = 'windows' // §5.1 vocabulary
const OS_NAME = 'Windows' // §4.1 display form

// ---- §5 roots + §3 bundled interpreter layout ------------------------------

function dataRootDefault() { return roots.dataRootDefault('win32') }
function logsRootDefault() { return roots.logsRootDefault('win32') }

// python-build-standalone *-pc-windows-msvc-install_only layout is flat:
// python.exe at the root, no bin/ directory (§3).
function bundledPythonPath(resourcesPath) {
  return path.join(resourcesPath, 'python', 'python.exe')
}

// §9 window chrome: hidden title bar with a native `titleBarOverlay` — the OS
// draws minimize/maximize/close at the top-right over the app's own background,
// so the §14 look survives without hand-rolled frameless buttons. `color` is
// `--bg-content` (the top-right corner belongs to the content pane, so this is
// what makes the strip invisible), `symbolColor` the §14 `--text-2` hex, and
// `height` matches the content drag strip exactly. No trafficLightPosition
// anywhere: that option is macOS-only and lives in darwin.cjs.
function mainWindowChrome() {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1118', symbolColor: '#c8ccd4', height: 40 },
  }
}

function panelWindowExtras() {
  return {}
}

function panelAfterCreate(_panel) {}

// §13 placement: the Windows taskbar (and its tray) sits at the bottom by
// default, so anchor the panel's bottom edge just above the work area's
// bottom — at the panel's *real* height, which main.cjs re-anchors on every
// resize-panel, never at the 640 px cap. Clamped to the work area's top so a
// taskbar docked elsewhere still gets a fully on-screen panel. `height` is
// optional (the panel's current height); the 640 px window cap stands in when
// a caller has no measurement yet.
function panelPosition(pt, display, height) {
  const h = Number.isFinite(height) ? height : 640
  const x = Math.min(pt.x - 167, display.bounds.x + display.bounds.width - 344)
  const y = Math.max(display.workArea.y + 6,
    display.workArea.y + display.workArea.height - h - 6)
  return { x: Math.round(x), y: Math.round(y) }
}

// §13: real colored assets for the Windows notification area — a light glyph
// legible on the dark taskbar, never the mac black template images (which
// disappear there). Rendered by scripts/gen_tray_icon.py beside the mac PNGs;
// @2x picked up by nativeImage for 200 % DPI.
function trayIconSpec(alert) {
  return { file: alert ? 'trayWinAlert.png' : 'trayWin.png', template: false }
}

function setDockIcon(_app, _iconPath) {}

// ---- §3 CLI shim (.cmd form) ------------------------------------------------

const SHIM_MARKER = 'rem autowright CLI shim'

function defaultShimPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Autowright', 'bin', 'autowright.cmd')
}

function shimText(python) {
  return `@echo off\r\n${SHIM_MARKER}\r\n"${python}" -m autowright.cli %*\r\n`
}

// §3: Windows GUI apps inherit the full user PATH — no login shell exists to
// ask, so the probe reads the process environment directly.
function readLoginShellPath() {
  return Promise.resolve(process.env.PATH || null)
}

// ---- §4.9 login item --------------------------------------------------------

// §4.9 login reconcile: the OS login item via Electron. Registration is only
// valid from a packaged run: an unpackaged (dev-harness) run would enroll the
// bare Electron dev binary as the login item, not Autowright. Off is asserted
// unconditionally, never guarded by the OS reading (which can be stale or
// describe a different copy), so any run with the toggle off clears a stale
// registration for its own binary; on writes only when the OS view differs.
function applyLoginItem(app, enabled) {
  if (!enabled) {
    app.setLoginItemSettings({ openAtLogin: false })
  } else if (app.isPackaged && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true })
  }
}

// ---- §3 updates -------------------------------------------------------------

// §3 Windows updates: electron-updater's NsisUpdater against the generic
// provider. The marker is what main.cjs discriminates on — the modules stay
// electron-free, so they name the machinery rather than construct it.
const UPDATER = 'nsis'
// §3 identifiers: matches the installer shortcut's AUMID and the appId.
const APP_USER_MODEL_ID = 'ai.autowright.app'

// §3: the generic provider is pointed at a *directory* (latest.yml + the
// installer + its blockmap live under it), never at a single file — the yml
// is rewritten under the repo-root release/win32-x86_64/ by
// windows-scripts/release.ps1 and fetched raw from GitHub, like the mac feeds.
// x86_64 is the only Windows arch that ships, so the base URL carries no arch
// switch.
function updateFeedUrl(_arch) {
  return 'https://raw.githubusercontent.com/hansololz/autowright/main/release/win32-x86_64/'
}

// No managed-install channel (winget/Chocolatey) exists for Autowright yet.
function managedInstall() {
  return false
}

const MANAGED_COPY_ERROR = 'This copy is managed by a package manager.'

// ---- §9.4 external links + §5 reveal ----------------------------------------

// No Windows equivalent of the §9 permission-checklist Settings pane is
// needed (iMessage capability is false), so no deep link is allowed.
const SETTINGS_DEEP_LINK = null

// Same rule as macOS: plain data directories open in Explorer; anything
// carrying an extension is revealed, never launched.
function revealPrefersOpen(abs, isDir) {
  return isDir && !path.extname(abs)
}

// ---- §3 ensure-backend diagnostics -------------------------------------------

// §9 failure copy: no Gatekeeper on Windows — a plain line, and the detail
// lives in app.log (whatever serviceDiagnostics captures).
const SERVICE_START_FAILED_DETAIL =
  'The backend service failed to start. Details in app.log.'

// No extra diagnostics to capture: the §3 service result lines already land in app.log.
function serviceDiagnostics(_log) {}

const capabilities = { trayPanel: true, loginItem: true, dockIcon: false, updates: true, appMenu: true }

module.exports = {
  OS_TOKEN,
  OS_NAME,
  dataRootDefault,
  logsRootDefault,
  bundledPythonPath,
  mainWindowChrome,
  panelWindowExtras,
  panelAfterCreate,
  panelPosition,
  trayIconSpec,
  setDockIcon,
  SHIM_MARKER,
  defaultShimPath,
  shimText,
  readLoginShellPath,
  applyLoginItem,
  UPDATER,
  APP_USER_MODEL_ID,
  updateFeedUrl,
  managedInstall,
  MANAGED_COPY_ERROR,
  SETTINGS_DEEP_LINK,
  revealPrefersOpen,
  SERVICE_START_FAILED_DETAIL,
  serviceDiagnostics,
  capabilities,
}
