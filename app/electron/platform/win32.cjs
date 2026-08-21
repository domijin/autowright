// §2 platform layer (shell half), Windows groundwork build. Not a shipped
// port: the values that have one correct answer are real (interpreter layout,
// roots, the §3 .cmd shim, the process-env PATH probe); the surfaces that
// need Windows design or infrastructure (custom chrome, tray assets, update
// feed, managed-install probe) stay explicit placeholders. Never imports
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

// Native frame until a Windows custom-chrome design lands (WINDOWS.md).
function mainWindowChrome() {
  return {}
}

function panelWindowExtras() {
  return {}
}

function panelAfterCreate(_panel) {}

// §13 placement: the Windows taskbar (and its tray) sits at the bottom by
// default, so anchor the panel's bottom edge just above the work area's
// bottom, assuming the panel's max height (640, main.cjs resize clamp).
// Groundwork: a taskbar docked elsewhere still gets a usable on-screen panel.
function panelPosition(pt, display) {
  const x = Math.min(pt.x - 167, display.bounds.x + display.bounds.width - 344)
  const y = Math.max(display.workArea.y + 6,
    display.workArea.y + display.workArea.height - 646)
  return { x: Math.round(x), y: Math.round(y) }
}

// Placeholder: the mac template PNGs render poorly in the Windows
// notification area; real .ico assets are a WINDOWS.md task.
function trayIconSpec(alert) {
  return { file: alert ? 'trayAlert.png' : 'trayTemplate.png', template: false }
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

// ---- §3 updates -------------------------------------------------------------

// No Windows update channel yet (WINDOWS.md): update-check reports a plain
// error state and the §9.4 page shows manual-download guidance.
function updateFeedUrl(_arch) {
  return null
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

// Nothing to capture until a Windows ServiceManager exists (WINDOWS.md).
function serviceDiagnostics(_log) {}

const capabilities = { trayPanel: true, loginItem: true, dockIcon: false, updates: false }

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
  updateFeedUrl,
  managedInstall,
  MANAGED_COPY_ERROR,
  SETTINGS_DEEP_LINK,
  revealPrefersOpen,
  serviceDiagnostics,
  capabilities,
}
