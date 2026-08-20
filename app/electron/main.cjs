// Electron main: one app window + a tray (menu-bar) panel window (§9, §13).
const { app, autoUpdater, BrowserWindow, Menu, Tray, dialog, nativeImage, ipcMain, shell, screen } = require('electron')
const { execFile } = require('child_process')
const { randomUUID } = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

// Keep Chromium's profile (Cache, Cookies, Local Storage, …) out of the backend's
// data dir — both default to ~/Library/Application Support/Autowright (§5).
// §15: AUTOWRIGHT_HOME relocates the whole app-support root, profile included —
// an isolated dev/test home must never touch the real profile.
app.setPath('userData', path.join(
  process.env.AUTOWRIGHT_HOME || app.getPath('userData'), 'electron'))

// Overlay scrollbars: draw on top of content, zero layout space, so content
// never shifts when a scrollbar appears. Without this, macOS "Automatic"/
// "Always" system settings force classic space-taking bars (§14).
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')

let win = null
let panel = null
let tray = null

// One app process only: a second launch (login item racing a manual open,
// `open -n`) would create a second tray and double-fire §6 app-start triggers.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
// second-instance can fire before whenReady (the exact login-item race above);
// creating a BrowserWindow before ready throws. The ready path opens the
// window itself, so the early signal needs no replay.
app.on('second-instance', () => { if (app.isReady()) showApp() })

// §5 app-support root — the backend's home (AUTOWRIGHT_HOME overrides it, §15).
function appSupportDir() {
  return process.env.AUTOWRIGHT_HOME
    ? process.env.AUTOWRIGHT_HOME
    : path.join(os.homedir(), 'Library', 'Application Support', 'Autowright')
}

function backendInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appSupportDir(), 'backend.json'), 'utf-8'))
  } catch {
    return null
  }
}

function logsDir() {
  return process.env.AUTOWRIGHT_HOME
    ? path.join(process.env.AUTOWRIGHT_HOME, 'logs')
    : path.join(os.homedir(), 'Library', 'Logs', 'Autowright')
}

function appLog(line) {
  try {
    fs.mkdirSync(logsDir(), { recursive: true })
    fs.appendFileSync(path.join(logsDir(), 'app.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* logging must never break startup */ }
}

// §3 ensure-backend: the app owns backend registration. Probe the backend; if
// unreachable, (re)register the LaunchAgent by running the bundled service
// module (`python -m autowright.service install`) — the same single code path
// headless setups run by hand. The app never invokes the CLI (§3).
// A healthy backend is never touched, so an app launch never interrupts
// running executions; a broken registration (fresh install, app bundle moved,
// plist pointing at a deleted interpreter) self-heals here. Dev launches
// (`electron .`) have no bundled Python — scripts/dev.sh installs the service
// from the repo venv before Electron starts, through the same install code.
function bundledPython() {
  const py = path.join(process.resourcesPath, 'python', 'bin', 'python3')
  return fs.existsSync(py) ? py : null
}

// The backend's running version (from /health), or null when unreachable —
// doubles as the liveness probe and feeds the §3 launch-time version compare.
async function backendVersion() {
  const info = backendInfo()
  if (!info) return null
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    return String((await res.json()).version ?? '')
  } catch {
    return null
  }
}

async function backendHealthy() {
  return (await backendVersion()) !== null
}

// §3: an update install or backend restart must never land mid-execution.
// Tri-state probe: true/false when the backend answered, null when it is
// unreachable — callers decide what unknown means for them.
async function executionsLiveProbe() {
  const info = backendInfo()
  if (!info) return null
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/executions?status=executing`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return (await res.json()).length > 0
  } catch {
    return null
  }
}

// §3 update-install rule: an unreachable backend counts as idle — nothing can
// be executing on it.
async function executionsLive() {
  return (await executionsLiveProbe()) === true
}

// §3 install verification: launchctl can report success while the job never
// spawns (Gatekeeper silently refuses to exec an unsigned, quarantined bundled
// Python as a LaunchAgent — the GUI app's approval does not extend to launchd).
// Poll /health after install; on failure, capture launchd's view into app.log
// and expose the failure to the renderer (backend-status IPC → §9 boot splash).
let ensureStatus = { state: 'idle', detail: '' }

// §3 quit-all interlock: a spawned `service install` child (ensure-backend or
// version-sync) survives app.quit(), so quit-all's `service stop` could
// interleave with it and leave the backend running after the app quit
// claiming it stopped. Every install spawn goes through runServiceInstall so
// quit-all can wait for the in-flight child and block new ones.
let quittingAll = false
let serviceInstallDone = Promise.resolve()

function runServiceInstall(py, cb) {
  if (quittingAll) return
  serviceInstallDone = serviceInstallDone.then(() => new Promise((resolve) => {
    execFile(py, ['-m', 'autowright.service', 'install'], (err, stdout, stderr) => {
      try { cb(err, stdout, stderr) } finally { resolve() }
    })
  }))
}

async function verifyBackendUp() {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    if (await backendHealthy()) {
      ensureStatus = { state: 'ok', detail: '' }
      appLog('ensure-backend: backend is up')
      return
    }
  }
  ensureStatus = {
    state: 'failed',
    detail: 'The backend service was registered but never started — macOS '
      + 'Gatekeeper may be blocking an unsigned build. Details in app.log.',
  }
  appLog('ensure-backend: backend did not come up within 30 s of install')
  execFile('launchctl', ['print', `gui/${process.getuid()}/ai.autowright.backend`],
    (err, stdout, stderr) => {
      appLog(`ensure-backend: launchctl print:\n${String(stdout || stderr || err?.message || '').trim()}`)
    })
}

// §3 launch-time version compare: a healthy but outdated backend (the app
// bundle was swapped by an update, or replaced by hand) restarts onto this
// bundle's interpreter — never mid-execution; live executions drain first.
async function syncBackendVersion(py, running) {
  appLog(`ensure-backend: backend ${running} != app ${app.getVersion()} — `
    + 'restarting service once live executions finish')
  // This backend answered /health moments ago, so a transient probe failure
  // (5 s timeout while its thread pool is busy mid-execution) must NOT read
  // as idle — §3: the service is never restarted mid-execution. Only a
  // backend that stays unreachable AND fails /health is treated as down
  // (nothing can be executing on it) so the install still proceeds.
  let unknown = 0
  while (true) {
    const live = await executionsLiveProbe()
    if (live === false) break
    if (live === null) {
      if (++unknown >= 4 && !(await backendHealthy())) break
    } else {
      unknown = 0
    }
    await new Promise((r) => setTimeout(r, 30_000))
  }
  runServiceInstall(py, (err, stdout, stderr) => {
    if (err) {
      appLog(`ensure-backend: version-sync install failed: ${String(stderr || err.message).trim()}`)
      return
    }
    appLog(`ensure-backend: version-sync: ${String(stdout).trim()}`)
    void verifyBackendUp()
  })
}

async function ensureBackend() {
  const py = bundledPython()
  if (!py) return
  const running = await backendVersion()
  if (running !== null) {
    ensureStatus = { state: 'ok', detail: '' }
    if (running !== app.getVersion()) void syncBackendVersion(py, running)
    return
  }
  ensureStatus = { state: 'installing', detail: '' }
  runServiceInstall(py, (err, stdout, stderr) => {
    if (err) {
      const detail = String(stderr || err.message).trim()
      ensureStatus = { state: 'failed', detail: `Backend install failed: ${detail}` }
      appLog(`ensure-backend: install failed: ${detail}`)
      return
    }
    appLog(`ensure-backend: ${String(stdout).trim()}`)
    void verifyBackendUp()
  })
}

// §6 app-start firing: tell the backend this app process launched, once. The
// backend may still be coming up — re-read backend.json and retry every 2 s
// for up to 60 s, then let the occurrence lapse (no queue).
async function notifyAppStarted() {
  // One id for this app process (§19): the retry below cannot tell "the backend
  // never fired" from "it fired and the reply was lost", so the backend dedupes
  // on this instead of firing every app-start automation twice.
  const launchId = randomUUID()
  for (let i = 0; i < 30; i++) {
    const info = backendInfo()
    if (info) {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/app-started`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ launchId }),
        })
        if (res.ok) return
      } catch { /* backend not answering yet — retry */ }
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// §9.4 external-URL policy: the only schemes we hand to the OS. Result HTML is
// AI-authored and can echo attacker-controlled text from an incoming Discord or
// iMessage message, so a `file:` link in a result must not be able to launch a
// local app when the user clicks it. The one deep link is the §9 permission
// checklist's Settings pane.
const OPENABLE_SCHEMES = ['https:', 'http:', 'mailto:']
const SETTINGS_DEEP_LINK = 'x-apple.systempreferences:'

function docKey(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}` } catch { return null }
}

function openExternalSafely(url) {
  if (typeof url !== 'string') return
  if (url.startsWith(SETTINGS_DEEP_LINK)) { shell.openExternal(url); return }
  let scheme
  try { scheme = new URL(url).protocol } catch { return }
  if (OPENABLE_SCHEMES.includes(scheme)) shell.openExternal(url)
}

// §9.4: both windows deny popups (routing allowed URLs to the browser) and
// refuse top-frame navigation. The preload hands the renderer the backend
// bearer token, which grants the full local API — it must never become
// reachable from a remote origin that navigated into one of our windows.
function hardenWindow(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    // Same document (origin + path) is our own renderer — hash routing lives
    // there. Anything else is a real navigation away and is refused; if it is
    // a normal web link, hand it to the browser instead of silently dropping it.
    const here = docKey(w.webContents.getURL())
    if (here && docKey(url) === here) return
    e.preventDefault()
    openExternalSafely(url)
  })
}

function load(w, hash) {
  // AUTOWRIGHT_RENDERER_URL (§15): serve the same renderer source from a dev
  // server (HMR) instead of the built bundle. Configuration only — same code.
  const devUrl = process.env.AUTOWRIGHT_RENDERER_URL
  if (devUrl) {
    const u = new URL(devUrl)
    u.hash = hash
    w.loadURL(u.toString())
  } else {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash })
  }
}

// Right-click copy for selected text; text fields get the full edit menu.
function attachContextMenu(w) {
  w.webContents.on('context-menu', (_e, params) => {
    const items = params.isEditable
      ? [
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll' },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : []
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w })
  })
}

function createWindow(hash) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    titleBarStyle: 'hidden',
    // §9: lights pinned at one fixed spot for every window state — never moved
    // or re-derived from layout, so they can't jitter between states.
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#090d14',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  })
  load(win, hash || '/app')
  attachContextMenu(win)
  win.on('closed', () => { win = null })
  hardenWindow(win)
}

function showApp(hash) {
  // Fresh window: load straight at the target. Existing window: hand the
  // target over IPC — a reload would drop the WS and all renderer state. A
  // still-loading window hasn't registered its listener yet, so the send is
  // deferred to did-finish-load or it would be silently dropped.
  if (!win) createWindow(hash)
  else if (hash) {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => { if (win) win.webContents.send('open-target', hash) })
    } else {
      win.webContents.send('open-target', hash)
    }
  }
  win.show()
  win.focus()
}

function trayIcon(alert) {
  // §13: red alert dot when any automation failed. The alert variant is a
  // pre-rendered non-template PNG (neutral gray glyph + red dot) so the dot
  // stays red on light and dark menu bars; the normal icon is a template.
  const name = alert ? 'trayAlert.png' : 'trayTemplate.png'
  const icon = nativeImage.createFromPath(path.join(__dirname, name))
  icon.setTemplateImage(!alert)
  return icon
}

function createTray() {
  tray = new Tray(trayIcon(false))
  tray.setToolTip('Autowright')
  tray.on('click', () => togglePanel())
}

// §13: the renderer feeds the alert dot over IPC while it's alive, but the app
// can sit tray-only with no renderer at all (window closed, panel never
// opened) — main polls the backend itself so a scheduled failure still lights
// the dot and a later success clears it.
async function refreshTrayAlert() {
  if (!tray) return
  const info = backendInfo()
  if (!info) return
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/automations`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    const autos = await res.json()
    tray.setImage(trayIcon(autos.some((a) => a.lastStatus === 'failed')))
  } catch { /* backend down — keep the current icon */ }
}

// §4.9: the shell owns two OS-side settings effects — the macOS login item
// (`login`) and the tray icon (`menuBarIcon`). Reconciled from the backend's
// stored settings at startup and on the periodic poll (a tray-only app must
// follow CLI changes too); the renderer pushes the same shape on every
// settings change.
let automaticUpdateTimer = null

// §5 executions data dir. Relocatable, so its location is only known from the
// backend's settings — the periodic sync above carries it (the renderer's
// apply-settings push never does). Feeds the reveal-path root check below.
let dataRoot = null

function applyShellSettings(s) {
  if (typeof s?.dataPath === 'string' && s.dataPath) dataRoot = s.dataPath
  if (typeof s?.login === 'boolean'
      && app.getLoginItemSettings().openAtLogin !== s.login) {
    app.setLoginItemSettings({ openAtLogin: s.login })
  }
  if (typeof s?.menuBarIcon === 'boolean') {
    if (s.menuBarIcon && !tray) {
      createTray()
      void refreshTrayAlert()
    } else if (!s.menuBarIcon && tray) {
      if (panel) panel.hide()
      tray.destroy()
      tray = null
    }
  }
  // §3 automatic update check (§4.9, on by default): off→on — which includes a
  // launch with the setting on — checks immediately, then every 24 h; on→off
  // clears the timer. Nothing about past checks is persisted. Failures are
  // silent, and an automatic check never starts a download.
  if (typeof s?.automaticUpdateCheck === 'boolean') {
    if (s.automaticUpdateCheck && !automaticUpdateTimer) {
      void fetchUpdateState()
      automaticUpdateTimer = setInterval(() => { void fetchUpdateState() }, 24 * 60 * 60_000)
    } else if (!s.automaticUpdateCheck && automaticUpdateTimer) {
      clearInterval(automaticUpdateTimer)
      automaticUpdateTimer = null
    }
  }
}

async function syncShellSettings() {
  const info = backendInfo()
  if (!info) return
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/settings`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) applyShellSettings(await res.json())
  } catch { /* backend down — keep the current state */ }
}

// Tray-click toggle guard: on macOS the focused panel blurs (and hides)
// before the tray click arrives, so a bare isVisible() check would always
// re-show. A click landing right after a blur-hide means "close" — swallow it.
let panelHiddenAt = 0
function togglePanel() {
  if (panel && panel.isVisible()) { panel.hide(); return }
  if (Date.now() - panelHiddenAt < 250) return
  if (!panel) {
    panel = new BrowserWindow({
      width: 334,
      height: 420,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      // §13: the default app menu stays active, so Cmd+W/Cmd+M would destroy
      // or minimize the focused panel and strand the tray toggle on a dead
      // reference — the panel opts out of both (and fullscreen).
      closable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      vibrancy: 'menu',
      visualEffectState: 'active',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
    })
    // §13: menu-bar panels follow the user across Spaces — without this,
    // opening the panel over a fullscreen app switches Spaces.
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    load(panel, '/menubar')
    attachContextMenu(panel)
    hardenWindow(panel)
    panel.on('blur', () => { panelHiddenAt = Date.now(); panel.hide() })
    panel.on('closed', () => { panel = null })
  }
  const pt = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(pt)
  const x = Math.min(pt.x - 167, display.bounds.x + display.bounds.width - 344)
  panel.setPosition(Math.round(x), display.workArea.y + 6)
  panel.show()
}

// §3 CLI on PATH: the shell owns shim *creation* — explicit (the §4.9 card's
// Install button), silent, and always into the user-owned ~/.local/bin; no
// admin prompt anywhere, and never automatic. /usr/local/bin is legacy-only:
// shims created there by earlier builds are recognized and healed, never
// created. `service install` heals user-owned shims wherever they are.
// Interpreter comes from backend.json's `python`, so dev and prod run the
// same code. AUTOWRIGHT_SHIM is the §15 test knob (mirrored in service.py):
// it forces a single location and skips the PATH probe.
const SHIM_MARKER = '# autowright CLI shim'
const USER_SHIM = path.join(os.homedir(), '.local', 'bin', 'autowright')
const SYSTEM_SHIM = '/usr/local/bin/autowright'

function shimPaths() {
  return process.env.AUTOWRIGHT_SHIM ? [process.env.AUTOWRIGHT_SHIM] : [USER_SHIM, SYSTEM_SHIM]
}

function shimText(python) {
  return `#!/bin/sh\n${SHIM_MARKER}\nexec "${python}" -m autowright.cli "$@"\n`
}

// §3: GUI apps inherit a stripped PATH, so ask the login shell whether
// ~/.local/bin is reachable. Cached per app run; any failure = not on PATH.
// Only feeds the §4.9 card's PATH hint — install goes to ~/.local/bin anyway.
let userBinOnPath = null
function userBinOnLoginPath() {
  if (process.env.AUTOWRIGHT_SHIM) return Promise.resolve(true)
  if (userBinOnPath !== null) return Promise.resolve(userBinOnPath)
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-l', '-c', 'printf %s "$PATH"'], { timeout: 2000 }, (err, stdout) => {
      userBinOnPath = !err && String(stdout).split(':').includes(path.dirname(USER_SHIM))
      resolve(userBinOnPath)
    })
  })
}

async function cliStatus() {
  const python = backendInfo()?.python
  const onPath = await userBinOnLoginPath()
  // Effective shim: first existing file among the candidates, user-local
  // first (it wins over the legacy /usr/local/bin when both exist, §3).
  const effective = shimPaths().find((p) => fs.existsSync(p)) ?? null
  if (effective === null) return { state: 'missing', path: shimPaths()[0], onPath }
  let current
  try {
    current = fs.readFileSync(effective, 'utf-8')
  } catch {
    return { state: 'missing', path: shimPaths()[0], onPath }
  }
  if (!current.includes(SHIM_MARKER)) return { state: 'foreign', path: effective, onPath }
  if (!python || current === shimText(python)) return { state: 'installed', path: effective, onPath }
  // Ours but pointing elsewhere: heal in place when user-owned (§3 — a file
  // rewrite needs no directory write); only an unwritable legacy shim is
  // 'stale' (the card's fix: fresh user-local install + manual sudo rm).
  try {
    fs.writeFileSync(effective, shimText(python), { mode: 0o755 })
    return { state: 'installed', path: effective, onPath }
  } catch {
    return { state: 'stale', path: effective, onPath }
  }
}

function cliInstall() {
  const python = backendInfo()?.python
  if (!python) return { ok: false, error: 'The backend is not running yet — try again in a moment.' }
  // §3: plain writes into the user-owned dir — no dialog, no password.
  const shim = shimPaths()[0]
  try {
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.writeFileSync(shim, shimText(python), { mode: 0o755 })
    appLog(`cli-install: CLI installed at ${shim}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// §3 cli-uninstall (§4.9 Delete): remove ours-marker shims from every
// candidate; foreign files never touched. An undeletable one (root-owned
// legacy dir) reports the manual command instead of an error.
function cliUninstall() {
  const hints = []
  for (const p of shimPaths()) {
    let text
    try {
      text = fs.readFileSync(p, 'utf-8')
    } catch {
      continue
    }
    if (!text.includes(SHIM_MARKER)) continue
    try {
      fs.unlinkSync(p)
      appLog(`cli-uninstall: removed ${p}`)
    } catch {
      hints.push(`sudo rm ${p}`)
    }
  }
  return hints.length ? { ok: false, hint: `Remove it with: ${hints.join(' && ')}` } : { ok: true }
}

ipcMain.handle('backend-info', () => backendInfo())
ipcMain.handle('backend-status', () => ensureStatus)
ipcMain.handle('cli-status', () => cliStatus())
ipcMain.handle('cli-install', () => cliInstall())
ipcMain.handle('cli-uninstall', () => cliUninstall())
// IPC arguments come from the renderer and are validated here, at the trust
// boundary: a bad type is a no-op, never a throw (read-request-log's basename
// check is the precedent).
ipcMain.handle('open-app', (_e, hash) => {
  if (hash !== undefined && typeof hash !== 'string') return
  showApp(hash)
  if (panel) panel.hide()
})
ipcMain.handle('resize-panel', (_e, h) => {
  if (!Number.isFinite(h)) return
  if (panel) panel.setSize(334, Math.min(Math.max(Math.round(h), 120), 640))
})

// §5 reveal roots: the only trees a reveal may point into — the app-support
// home (memory, drafts, harness workspaces), the logs dir, and the executions
// data dir. Result HTML is AI-authored and can echo attacker-controlled text
// (§9.4), so a path it hands us must not be able to reach an arbitrary file,
// and openPath on the wrong directory would *launch* something.
function revealRoots() {
  return [appSupportDir(), logsDir(), ...(dataRoot ? [dataRoot] : [])]
}

function insideRevealRoots(abs) {
  return revealRoots().some((root) => {
    const r = path.resolve(root)
    return abs === r || abs.startsWith(r + path.sep)
  })
}

ipcMain.handle('reveal-path', async (_e, p) => {
  if (typeof p !== 'string' || !p) return
  // `..` is collapsed here, so a traversal cannot dress itself up as a path
  // under one of the roots.
  const abs = path.resolve(p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p)
  if (!insideRevealRoots(abs)) {
    // The data dir moves (§5), so a miss may just mean our cached copy is one
    // poll behind — refresh once, then give up.
    await syncShellSettings()
    if (!insideRevealRoots(abs)) return
  }
  let isDir = false
  try { isDir = fs.statSync(abs).isDirectory() } catch { /* fall through */ }
  // A macOS bundle (.app, .pkg, …) is a directory, and openPath on one *launches*
  // it — reveal is meant to show a location, never to start something. Bundles
  // all carry an extension; plain data dirs (the ones this is for) do not.
  if (isDir && !path.extname(abs)) void shell.openPath(abs)
  else shell.showItemInFolder(abs)
})
ipcMain.handle('pick-folder', async (_e, defaultPath) => {
  const opts = { properties: ['openDirectory', 'createDirectory'] }
  if (defaultPath) opts.defaultPath = defaultPath
  const r = await dialog.showOpenDialog(win, opts)
  return r.canceled ? null : r.filePaths[0]
})
// §5.1 transfer archives: native save/open dialogs live in main; the renderer
// moves the bytes to/from the backend itself (§19).
ipcMain.handle('save-file', async (_e, defaultName, data) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
  })
  if (r.canceled || !r.filePath) return null
  // Async IO: archives run to 64 MB (§5.1) and the target can be a network
  // volume — a sync write here would stall the whole main process.
  await fs.promises.writeFile(r.filePath, Buffer.from(data))
  return r.filePath
})
ipcMain.handle('open-archive', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Autowright automation', extensions: ['autowright'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return { name: path.basename(r.filePaths[0]), data: await fs.promises.readFile(r.filePaths[0]) }
})
// §9.3 developer log overlay: tail of each existing log file. Polled by the
// renderer while the overlay is open — no watchers, nothing runs while closed.
const LOG_FILES = ['app.log', 'backend.out.log', 'backend.err.log', 'vite.log']
ipcMain.handle('tail-logs', () => {
  const dir = logsDir()
  const out = []
  for (const name of LOG_FILES) {
    let fd
    try { fd = fs.openSync(path.join(dir, name), 'r') } catch { continue }
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - 64 * 1024)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      let text = buf.toString('utf-8')
      if (start > 0) {
        const nl = text.indexOf('\n')
        if (nl !== -1) text = text.slice(nl + 1)
      }
      out.push({ name, text })
    } catch { /* unreadable mid-rotation — skip this poll */ } finally {
      fs.closeSync(fd)
    }
  }
  return out
})
// §9.3 Requests tab: §5 request-log files under <logs>/requests — name list
// (descending ≙ newest first, the timestamp prefix makes name order
// chronological) + one-file read. `name` must be a plain basename.
ipcMain.handle('list-request-logs', () => {
  try {
    return fs.readdirSync(path.join(logsDir(), 'requests'))
      .filter((n) => n.endsWith('.log')).sort().reverse()
  } catch { return [] }
})
ipcMain.handle('read-request-log', (_e, name) => {
  if (typeof name !== 'string' || name !== path.basename(name)) return null
  try { return fs.readFileSync(path.join(logsDir(), 'requests', name), 'utf-8') } catch { return null }
})
// §9.5 report modal: OS details for the info block — the renderer has no
// other source (getSystemVersion is the marketing macOS version, not the
// Darwin kernel release).
ipcMain.handle('platform-info', () => ({
  platform: process.platform,
  release: process.getSystemVersion(),
  arch: process.arch,
  // Bundle version — the §9.5 fallback while the store's /state version
  // hasn't landed (the block must never show a bare "v").
  version: app.getVersion(),
}))
ipcMain.handle('apply-settings', (_e, s) => applyShellSettings(s))
ipcMain.handle('tray-alert', (_e, on) => {
  if (tray) tray.setImage(trayIcon(!!on))
})

// §3 in-app updates (Squirrel.Mac): manual-only — nothing here runs until the
// §9.4 "Check for updates" button calls update-check. One static JSON feed per
// arch on the docs/ GitHub Pages site, rewritten by release.sh each release.
const UPDATE_FEED = 'https://autowright.ai/updates/darwin-'
  + `${process.arch === 'x64' ? 'x86_64' : 'arm64'}.json`

// §9.4 compare: numeric on dot-split parts, ignoring a leading `v`; a
// malformed version counts as not newer.
function isNewerVersion(remote, current) {
  const a = String(remote).replace(/^v/, '').split('.').map(Number)
  const b = String(current).split('.').map(Number)
  if (a.some((n) => !Number.isFinite(n))) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

// §3 update-available: any check — manual or automatic — that finds a newer
// version remembers it here and tells the main window; an invoke handler
// answers the remembered value so a renderer that boots after the check still
// learns it. A later up-to-date answer clears it (feed rolled back, or the
// user updated by hand); errors leave it alone; otherwise it lives until the
// restart that installs.
let availableVersion = null

function recordAvailable(version) {
  if (availableVersion === version) return
  availableVersion = version
  win?.webContents.send('update-available', version)
}

async function fetchUpdateState() {
  try {
    const res = await fetch(UPDATE_FEED, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { state: 'error' }
    const version = String((await res.json()).currentRelease ?? '')
    if (!isNewerVersion(version, app.getVersion())) {
      recordAvailable(null)
      return { state: 'uptodate' }
    }
    recordAvailable(version)
    return { state: 'available', version }
  } catch {
    return { state: 'error' }
  }
}

ipcMain.handle('update-check', () => fetchUpdateState())
ipcMain.handle('update-available', () => availableVersion)

// Squirrel's autoUpdater emits no download-progress events, so the zip is
// downloaded here first — streamed to a temp file, percent pushed to the
// renderer as update-progress events — then handed to Squirrel through a
// one-shot loopback feed (§3). No dev fork: an unsigned build takes the same
// path and surfaces Squirrel's real signature error.
ipcMain.handle('update-download', async () => {
  const sendPercent = (percent) => win?.webContents.send('update-progress', percent)
  const tmpZip = path.join(app.getPath('temp'), `autowright-update-${randomUUID()}.zip`)
  let server = null
  const cleanup = () => {
    // closeAllConnections first: close() alone only stops new connections, so
    // a kept-alive Squirrel socket would hold the loopback server open for the
    // rest of the app's life.
    server?.closeAllConnections?.()
    server?.close()
    fs.rm(tmpZip, { force: true }, () => {})
  }
  try {
    const feedRes = await fetch(UPDATE_FEED, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!feedRes.ok) throw new Error(`update feed: HTTP ${feedRes.status}`)
    const feed = await feedRes.json()
    const entry = (Array.isArray(feed?.releases) ? feed.releases : [])
      .find((r) => r?.version === feed?.currentRelease)
    if (!entry?.updateTo?.url) throw new Error('update feed has no download URL')

    // Percent from Content-Length; null (indeterminate bar) when absent.
    const zipRes = await fetch(entry.updateTo.url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!zipRes.ok || !zipRes.body) throw new Error(`update download: HTTP ${zipRes.status}`)
    const total = Number(zipRes.headers.get('content-length')) || 0
    const out = fs.createWriteStream(tmpZip)
    let got = 0
    let lastPercent = -1
    for await (const chunk of zipRes.body) {
      got += chunk.length
      const percent = total ? Math.min(100, Math.round((got / total) * 100)) : null
      if (percent !== lastPercent) { lastPercent = percent; sendPercent(percent) }
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
    }
    await new Promise((res, rej) => { out.on('error', rej); out.end(res) })
    sendPercent(100)

    // Loopback hand-off: serve the feed (updateTo.url rewritten to this
    // server's own zip route) and the staged zip; Squirrel re-downloads
    // locally, verifies, and stages as usual.
    const port = await new Promise((res, rej) => {
      server = http.createServer((req, resp) => {
        // A request landing after cleanup (kept-alive socket, temp zip gone,
        // server closing) must get an error response, never a throw: an
        // uncaught exception here would crash the main process.
        try {
          if (req.url === '/feed.json') {
            const localFeed = {
              ...feed,
              releases: [{ ...entry, updateTo: { ...entry.updateTo, url: `http://127.0.0.1:${server.address().port}/update.zip` } }],
            }
            resp.setHeader('Content-Type', 'application/json')
            resp.end(JSON.stringify(localFeed))
          } else if (req.url === '/update.zip') {
            resp.setHeader('Content-Type', 'application/zip')
            resp.setHeader('Content-Length', String(fs.statSync(tmpZip).size))
            const zip = fs.createReadStream(tmpZip)
            zip.on('error', () => resp.destroy())
            zip.pipe(resp)
          } else {
            resp.statusCode = 404
            resp.end()
          }
        } catch {
          try { resp.statusCode = 500; resp.end() } catch { resp.destroy() }
        }
      })
      server.on('error', rej)
      server.listen(0, '127.0.0.1', () => res(server.address().port))
    })

    return await new Promise((resolve) => {
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        clearTimeout(giveUp)
        autoUpdater.removeListener('update-downloaded', onDone)
        autoUpdater.removeListener('update-not-available', onNone)
        autoUpdater.removeListener('error', onErr)
        cleanup()
        resolve(result)
      }
      // Squirrel can emit none of the three events (a hand-off it silently
      // drops). Without this the loopback server and the staged zip leak and
      // the §9.4 About page waits on this promise forever.
      const giveUp = setTimeout(() => settle({ error: 'the updater stopped responding' }), 10 * 60_000)
      const onDone = () => settle({ ok: true })
      const onNone = () => settle({ error: 'no update available' })
      const onErr = (err) => settle({ error: String(err?.message || err) })
      autoUpdater.on('update-downloaded', onDone)
      autoUpdater.on('update-not-available', onNone)
      autoUpdater.on('error', onErr)
      try {
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${port}/feed.json`, serverType: 'json' })
        autoUpdater.checkForUpdates()
      } catch (err) {
        settle({ error: String(err?.message || err) })
      }
    })
  } catch (err) {
    cleanup()
    return { error: String(err?.message || err) }
  }
})

// ShipIt swaps the bundle at the same path (the LaunchAgent's interpreter path
// stays valid); the old backend keeps running until the next launch's
// version-compare flow restarts it.
ipcMain.handle('update-install', async () => {
  if (await executionsLive()) return { busy: true }
  appLog('update: quitting to install')
  autoUpdater.quitAndInstall()
  return { ok: true }
})

// §3 explicit-quit exception (§4.9 QUIT card): stop the backend LaunchAgent
// (bootout only — plist and shim stay; it returns at next login or app
// launch), then quit the app. On any stop failure the app stays up — never
// quit the UI while the backend it promised to stop keeps running.
ipcMain.handle('quit-all', async () => {
  if (await executionsLive()) return { busy: true }
  // Dev launches have no bundled Python — backend.json publishes the
  // interpreter that runs the backend (§3 discovery fields), same code path.
  const py = bundledPython() || backendInfo()?.python
  if (!py) return { error: 'No backend interpreter found' }
  // §3: block new `service install` spawns and wait out any in-flight one
  // before stopping, so the stop can't be undone by a racing install child.
  quittingAll = true
  await serviceInstallDone
  const err = await new Promise((resolve) => {
    execFile(py, ['-m', 'autowright.service', 'stop'], (e, stdout, stderr) => {
      appLog(`quit-all: ${String(stdout || stderr || '').trim()}`)
      resolve(e ? String(stdout || stderr || e.message).trim() : null)
    })
  })
  if (err) {
    // The app stays up (§3), so future ensure/version-sync installs may run.
    quittingAll = false
    return { error: err }
  }
  appLog('quit-all: backend stopped, quitting app')
  app.quit()
  return { ok: true }
})

app.whenReady().then(() => {
  if (!gotLock) return
  // Dev launches via `electron .`, which ships the default Electron dock icon —
  // replace it with the AW mark (§14 checked-in icon assets).
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icon', 'icon.png'))
  }
  void ensureBackend()
  createWindow()
  createTray()
  void notifyAppStarted()
  void refreshTrayAlert()
  void syncShellSettings()
  setInterval(() => { void refreshTrayAlert(); void syncShellSettings() }, 60_000)
  // The hidden tray panel is also a BrowserWindow, so count only the main
  // window — `getAllWindows().length` would block reopening from the Dock.
  app.on('activate', () => { if (win === null) createWindow(); else { win.show(); win.focus() } })
})

// §3: quitting the app never stops the backend — we are always a client.
// (The one exception is the explicit quit-all IPC above, which stops the
// backend first and then quits.)
app.on('window-all-closed', () => { /* stay alive in the tray */ })
