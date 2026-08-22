// §2 platform layer (shell half), degraded build for Linux (and any unknown
// platform — win32 routes to win32.cjs). Not an implementation: explicit
// placeholders so a non-macOS dev launch degrades in plain words (native
// window frame, no vibrancy, no update feed) instead of crashing on mac-only
// Electron options. Replacing this with a real linux.cjs with the same
// surface as darwin.cjs is the entire shell-side port surface — main.cjs
// won't change.
const { execFile } = require('child_process')
const os = require('os')
const path = require('path')

const roots = require('./roots.cjs')

const OS_TOKEN = process.platform === 'win32' ? 'windows' : 'linux' // §5.1 vocabulary
const OS_NAME = process.platform === 'win32' ? 'Windows' : 'Linux' // §4.1 display form

function dataRootDefault() { return roots.dataRootDefault(process.platform) }
function logsRootDefault() { return roots.logsRootDefault(process.platform) }

function bundledPythonPath(resourcesPath) {
  return path.join(resourcesPath, 'python', 'bin', 'python3')
}

// Native frame and decorations — no custom chrome off macOS yet.
function mainWindowChrome() {
  return {}
}

function panelWindowExtras() {
  return {}
}

function panelAfterCreate(_panel) {}

// Top-of-display placeholder placement; a real port anchors to the tray.
function panelPosition(pt, display) {
  const x = Math.min(pt.x - 167, display.bounds.x + display.bounds.width - 344)
  return { x: Math.round(x), y: display.workArea.y + 6 }
}

// The template PNG renders poorly off macOS; a real port ships per-OS assets.
function trayIconSpec(alert) {
  return { file: alert ? 'trayAlert.png' : 'trayTemplate.png', template: false }
}

function setDockIcon(_app, _iconPath) {}

// POSIX shim — right for Linux (the Windows .cmd shim lives in win32.cjs).
const SHIM_MARKER = '# autowright CLI shim'

function defaultShimPath() {
  return path.join(os.homedir(), '.local', 'bin', 'autowright')
}

function shimText(python) {
  return `#!/bin/sh\n${SHIM_MARKER}\nexec "${python}" -m autowright.cli "$@"\n`
}

function readLoginShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh'
    execFile(shell, ['-l', '-c', 'printf %s "$PATH"'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

// Login item: no mechanism here — the capability flag is false, so main.cjs
// never asks; the no-op keeps the module surfaces identical.
function applyLoginItem(_app, _enabled) {}

// No update machinery at all here — the capability flag is false, so main.cjs
// never asks; the marker exists only to keep the module surfaces identical.
const UPDATER = null
const APP_USER_MODEL_ID = null

// No update channel yet: update-check reports a plain error state.
function updateFeedUrl(_arch) {
  return null
}

function managedInstall() {
  return Boolean(process.env.AUTOWRIGHT_CASKROOM
    && require('fs').existsSync(process.env.AUTOWRIGHT_CASKROOM))
}

const MANAGED_COPY_ERROR = 'This copy is managed by Homebrew.'

const SETTINGS_DEEP_LINK = null

function revealPrefersOpen(_abs, isDir) {
  return isDir
}

// §9 failure copy: the Gatekeeper line is macOS copy (darwin.cjs) — off macOS
// the plain line is all we can honestly say.
const SERVICE_START_FAILED_DETAIL =
  'The backend service failed to start. Details in app.log.'

function serviceDiagnostics(_log) {}

const capabilities = { trayPanel: false, loginItem: false, dockIcon: false, updates: false, appMenu: true }

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
