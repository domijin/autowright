// §2 platform layer (shell half), Linux build. The interpreter layout, XDG
// roots, the §3 POSIX shim and login-shell PATH probe (shared with macOS),
// the §9 native-frame chrome, the §13 colored tray assets and any-edge panel
// placement, and the §4.9 XDG-autostart login item are real. What still needs
// infrastructure that does not exist yet (an update feed, a managed-install
// channel) stays an explicit placeholder behind a false capability flag.
// Never imports `electron` (takes app/window objects as arguments) so the
// §15 source guards and stub loaders keep working.
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const roots = require('./roots.cjs')

const OS_TOKEN = 'linux' // §5.1 vocabulary
const OS_NAME = 'Linux' // §4.1 display form

// ---- §5 roots + §3 bundled interpreter layout ------------------------------

function dataRootDefault() { return roots.dataRootDefault('linux') }
function logsRootDefault() { return roots.logsRootDefault('linux') }

// python-build-standalone *-unknown-linux-gnu-install_only layout matches the
// mac one: python/bin/python3 (§3).
function bundledPythonPath(resourcesPath) {
  return path.join(resourcesPath, 'python', 'bin', 'python3')
}

// ---- §9/§13 window chrome, tray, panel -------------------------------------

// §9: native frame for v1 — no custom title bar, no overlay, no vibrancy; the
// OS draws its own bar above the dark client area.
function mainWindowChrome() {
  return {}
}

function panelWindowExtras() {
  return {}
}

function panelAfterCreate(_panel) {}

// §13 placement: Linux panels sit on any screen edge, so anchor to the tray
// click point against the work area — a click in the top half drops the panel
// just below the top edge (the macOS shape); one in the bottom half anchors
// the panel's bottom edge just above the bottom at its *real* height (the
// Windows height-aware shape, re-anchored on every resize-panel). Clamped
// inside the work area horizontally either way.
function panelPosition(pt, display, height) {
  const h = Number.isFinite(height) ? height : 640
  const wa = display.workArea
  const x = Math.max(wa.x + 6, Math.min(pt.x - 167, wa.x + wa.width - 344 - 6))
  const y = pt.y < wa.y + wa.height / 2
    ? wa.y + 6
    : Math.max(wa.y + 6, wa.y + wa.height - h - 6)
  return { x: Math.round(x), y: Math.round(y) }
}

// §13: real colored assets for the StatusNotifier panel (22/44 px) — hosts
// don't recolor template images, so the light glyph ships pre-rendered by
// scripts/gen_tray_icon.py beside the mac and Windows sets.
function trayIconSpec(alert) {
  return { file: alert ? 'trayLinuxAlert.png' : 'trayLinux.png', template: false }
}

function setDockIcon(_app, _iconPath) {}

// ---- §3 CLI shim (POSIX, shared with macOS) --------------------------------

const SHIM_MARKER = '# autowright CLI shim'

function defaultShimPath() {
  return path.join(os.homedir(), '.local', 'bin', 'autowright')
}

function shimText(python) {
  return `#!/bin/sh\n${SHIM_MARKER}\nexec "${python}" -m autowright.cli "$@"\n`
}

// §3: GUI apps inherit a stripped PATH, so ask the login shell for the real
// one. Resolves to the PATH string, or null on any failure (= not on PATH).
function readLoginShellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh'
    execFile(shell, ['-l', '-c', 'printf %s "$PATH"'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

// ---- §4.9 login item (XDG autostart) ---------------------------------------

// Electron's setLoginItemSettings is a no-op on Linux — the §4.9 `login`
// setting reconciles a marker-carrying .desktop file in ~/.config/autostart/
// instead (§4.9: written on enable, rewritten when the Exec line drifts,
// deleted on disable; foreign files — no marker — are never touched, the §3
// CLI-shim ownership rules).
const AUTOSTART_MARKER = 'X-Autowright-Login-Item=true'

function autostartPath() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(cfg, 'autostart', 'ai.autowright.app.desktop')
}

function autostartText() {
  // A packaged AppImage relaunches through the AppImage itself (the mount
  // point's binary is gone after exit); dev launches use the electron binary.
  const target = process.env.APPIMAGE || process.execPath
  // Desktop-entry Exec quoting: backslash and quote escaped, % is a
  // field-code introducer.
  const exec = `"${target.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
  return ['[Desktop Entry]', 'Type=Application', 'Name=Autowright',
    `Exec=${exec}`, AUTOSTART_MARKER, ''].join('\n')
}

function applyLoginItem(_app, enabled) {
  const p = autostartPath()
  let current = null
  try { current = fs.readFileSync(p, 'utf-8') } catch { /* absent */ }
  try {
    if (enabled) {
      if (current !== null && !current.includes(AUTOSTART_MARKER)) return // foreign
      const wanted = autostartText()
      if (current !== wanted) {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, wanted)
      }
    } else if (current !== null && current.includes(AUTOSTART_MARKER)) {
      fs.unlinkSync(p)
    }
  } catch { /* best-effort — reconciled again on the next settings poll */ }
}

// ---- §3 updates -------------------------------------------------------------

// §3 Linux updates: electron-updater's AppImageUpdater against the generic
// provider. The marker is what main.cjs discriminates on — the modules stay
// electron-free, so they name the machinery rather than construct it.
const UPDATER = 'appimage'
const APP_USER_MODEL_ID = null

// §3: the generic provider is pointed at a *directory* (latest-linux.yml + the
// AppImage + its blockmap live under it), never at a single file — the yml is
// rewritten under the repo-root release/linux-x86_64/ by
// linux-scripts/release.sh and fetched raw from GitHub, like the mac and
// Windows feeds. x86-64 is the only Linux arch that ships, so the base URL
// carries no arch switch.
function updateFeedUrl(_arch) {
  return 'https://raw.githubusercontent.com/hansololz/autowright/main/release/linux-x86_64/'
}

// No managed-install channel (distro package) exists for Autowright yet.
function managedInstall() {
  return false
}

const MANAGED_COPY_ERROR = 'This copy is managed by a package manager.'

// ---- §9.4 external links + §5 reveal ----------------------------------------

// No Linux equivalent of the §9 permission-checklist Settings pane is needed
// (iMessage capability is false), so no deep link is allowed.
const SETTINGS_DEEP_LINK = null

// Same rule as macOS: plain data directories open in the file manager;
// anything carrying an extension is revealed, never launched.
function revealPrefersOpen(abs, isDir) {
  return isDir && !path.extname(abs)
}

// ---- §3 ensure-backend diagnostics -------------------------------------------

// §9 failure copy: no Gatekeeper on Linux — a plain line, and the detail
// lives in app.log (whatever serviceDiagnostics captures).
const SERVICE_START_FAILED_DETAIL =
  'The backend service failed to start. Details in app.log.'

// After a failed install verification, capture systemd's view of the unit.
function serviceDiagnostics(log) {
  execFile('systemctl', ['--user', '--no-pager', 'status', 'ai.autowright.backend'],
    (err, stdout, stderr) => {
      log(`ensure-backend: systemctl status:\n${String(stdout || stderr || err?.message || '').trim()}`)
    })
}

// §13: the tray is best-effort on Linux (stock GNOME needs a user extension
// for StatusNotifier items) — the flag stays true so the icon is attempted;
// the §3 window-all-closed discriminator covers a host with no tray.
// §9: no application menu — the native frame would draw Electron's stock
// File/Edit/View/Window bar, which nothing in the app uses, so the shell
// suppresses it (editing shortcuts are Chromium-native and survive).
const capabilities = { trayPanel: true, loginItem: true, dockIcon: false, updates: true, appMenu: false }

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
