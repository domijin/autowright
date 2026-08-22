// Electron main: one app window + a tray (menu-bar) panel window (§9, §13).
const { app, autoUpdater, BrowserWindow, Menu, Tray, dialog, nativeImage, ipcMain, session, shell, screen } = require('electron')
const { execFile } = require('child_process')
const { randomUUID } = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

// §2 platform layer (shell half): every OS-coupled value/helper comes from
// the composed per-OS module — macOS today, a degraded fallback elsewhere.
const plat = require('./platform/index.cjs')

// §9: the shell asks its own platform module which surfaces exist before
// wiring any of them — a module that declares a capability false is never
// asked for its assets or handlers. `dockIcon` doubles as the §9 close rule's
// discriminator: a platform with a dock keeps the app resident behind it, a
// platform without one has only the tray to stay resident in.
const caps = plat.capabilities

// Keep Chromium's profile (Cache, Cookies, Local Storage, …) out of the backend's
// data dir — both default to ~/Library/Application Support/Autowright (§5).
// §15: AUTOWRIGHT_HOME relocates the whole app-support root, profile included —
// an isolated dev/test home must never touch the real profile.
// §5: the base is the platform module's data root — identical to Electron's
// userData default on macOS, but on Windows getPath('userData') is Roaming
// %APPDATA% while the §5 root is %LOCALAPPDATA%; one root holds all app state.
app.setPath('userData', path.join(
  process.env.AUTOWRIGHT_HOME || plat.dataRootDefault(), 'electron'))

// §3 identifiers: on Windows the window's AppUserModelID must match the
// installer shortcut's (taskbar grouping/pinning + toast identity agree).
if (plat.APP_USER_MODEL_ID) app.setAppUserModelId(plat.APP_USER_MODEL_ID)

// Overlay scrollbars: draw on top of content, zero layout space, so content
// never shifts when a scrollbar appears. Without this, macOS "Automatic"/
// "Always" system settings force classic space-taking bars (§14).
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')

let win = null
// §9 never-paint-blank guard: true once the current main window's renderer has
// loaded successfully — until then every show path stays hidden.
let winLoaded = false
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
    : plat.dataRootDefault()
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
    : plat.logsRootDefault()
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
  const py = plat.bundledPythonPath(process.resourcesPath)
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

// One authenticated call against the live backend — the same shape the probes
// above use (port + bearer token from backend.json, a timeout, never a throw).
// Resolves to the Response, or null when the backend is unreachable; callers
// decide what unreachable means for them.
async function backendFetch(route, init = {}, timeoutMs = 10_000) {
  const info = backendInfo()
  if (!info) return null
  try {
    return await fetch(`http://127.0.0.1:${info.port}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${info.token}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
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
    // §2 spawn policy: never show a console window for a shell child.
    execFile(py, ['-m', 'autowright.service', 'install'], { windowsHide: true }, (err, stdout, stderr) => {
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
  // §9: the failure line is per-OS copy from the platform module (the mac one
  // names Gatekeeper; Windows says plainly that the service failed to start),
  // composed with the §2 serviceDiagnostics capture below.
  ensureStatus = { state: 'failed', detail: plat.SERVICE_START_FAILED_DETAIL }
  appLog('ensure-backend: backend did not come up within 30 s of install')
  plat.serviceDiagnostics(appLog)
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
const SETTINGS_DEEP_LINK = plat.SETTINGS_DEEP_LINK // null where no deep link exists

function docKey(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}` } catch { return null }
}

function openExternalSafely(url) {
  if (typeof url !== 'string') return
  if (SETTINGS_DEEP_LINK && url.startsWith(SETTINGS_DEEP_LINK)) { shell.openExternal(url); return }
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
    // §2 platform chrome: hidden title bar + pinned traffic lights on macOS
    // (§9 — one fixed spot for every window state, never re-derived from
    // layout), native frame elsewhere.
    ...plat.mainWindowChrome(),
    backgroundColor: '#090d14',
    // §9 never paint an unloaded window: shown on the first successful
    // renderer load below, never as an empty frame.
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  })
  // §9: a failed main-frame load (a dead §15 AUTOWRIGHT_RENDERER_URL — a
  // packaged dist file load doesn't fail) keeps the window hidden and retries
  // every second until the renderer is really there. Chromium fires
  // did-finish-load even after a failed navigation, so the per-attempt flag
  // is what separates the two. Logged once per failure streak, not per retry.
  winLoaded = false
  let failed = false
  let failStreak = 0
  win.webContents.on('did-start-loading', () => { failed = false })
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    failed = true
    failStreak += 1
    if (failStreak === 1) appLog(`window: renderer load failed (${code} ${desc}) — retrying every 1 s`)
    setTimeout(() => { if (win) load(win, hash || '/app') }, 1000)
  })
  win.webContents.on('did-finish-load', () => {
    if (failed) return
    if (failStreak) {
      appLog(`window: renderer loaded after ${failStreak} failed attempt(s)`)
      failStreak = 0
    }
    if (!winLoaded) {
      winLoaded = true
      if (win) { win.show(); win.focus() }
    }
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
  // §9: an unloaded window stays hidden — it shows itself on the first
  // successful load (createWindow's guard), never as an empty frame.
  if (winLoaded) { win.show(); win.focus() }
}

function trayIcon(alert) {
  // §13: red alert dot when any automation failed. Asset + template flag come
  // from the platform module (on macOS the alert variant is a pre-rendered
  // non-template PNG so the dot stays red on light and dark menu bars).
  const spec = plat.trayIconSpec(alert)
  const icon = nativeImage.createFromPath(path.join(__dirname, spec.file))
  icon.setTemplateImage(spec.template)
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
    // §13: failed or §4.1 overdue only — same predicate as the renderer's.
    tray.setImage(trayIcon(autos.some((a) => a.lastStatus === 'failed'
      || (a.problems || []).some((p) => p.kind === 'overdue'))))
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
  // §4.9 login reconcile is per-OS (§2 applyLoginItem): the Electron login
  // item on macOS/Windows, the XDG-autostart .desktop file on Linux.
  if (caps.loginItem && typeof s?.login === 'boolean') plat.applyLoginItem(app, s.login)
  if (caps.trayPanel && typeof s?.menuBarIcon === 'boolean') {
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
  if (caps.updates && typeof s?.automaticUpdateCheck === 'boolean') {
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
// §13 re-anchor: the point the panel was opened from (cursor + display) and
// its current height. `resize-panel` re-runs the platform placement with the
// real new height, so a bottom-anchored panel (Windows) keeps hugging the
// taskbar as it grows; a top-anchored one (macOS) lands on the same pixels.
let panelAnchor = null
let panelHeight = 420

function repositionPanel() {
  if (!panel || !panelAnchor) return
  const pos = plat.panelPosition(panelAnchor.pt, panelAnchor.display, panelHeight)
  panel.setPosition(pos.x, pos.y)
}

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
      // §2 platform chrome: transparency + vibrancy on macOS, plain elsewhere.
      ...plat.panelWindowExtras(),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
    })
    // §13 (macOS): menu-bar panels follow the user across Spaces — without
    // this, opening the panel over a fullscreen app switches Spaces.
    plat.panelAfterCreate(panel)
    load(panel, '/menubar')
    attachContextMenu(panel)
    hardenWindow(panel)
    panel.on('blur', () => { panelHiddenAt = Date.now(); panel.hide() })
    panel.on('closed', () => { panel = null })
  }
  const pt = screen.getCursorScreenPoint()
  panelAnchor = { pt, display: screen.getDisplayNearestPoint(pt) }
  repositionPanel()
  panel.show()
}

// §3 CLI on PATH: the shell owns shim *creation* — explicit (the §4.9 card's
// Install button), silent, and always into the user-owned ~/.local/bin — the
// only shim location; no admin prompt anywhere, and never automatic.
// Interpreter comes from backend.json's `python`, so dev and prod run the
// same code. AUTOWRIGHT_SHIM is the §15 test knob (mirrored in service.py):
// it overrides the location and skips the PATH probe.
const SHIM_MARKER = plat.SHIM_MARKER
const shimText = plat.shimText

function shimPaths() {
  return process.env.AUTOWRIGHT_SHIM ? [process.env.AUTOWRIGHT_SHIM] : [plat.defaultShimPath()]
}

// §3: GUI apps inherit a stripped PATH, so ask the login shell whether
// ~/.local/bin is reachable. Cached per app run; any failure = not on PATH.
// Only feeds the §4.9 card's PATH hint — install goes to ~/.local/bin anyway.
let userBinOnPath = null
async function userBinOnLoginPath() {
  if (process.env.AUTOWRIGHT_SHIM) return true
  if (userBinOnPath !== null) return userBinOnPath
  const loginPath = await plat.readLoginShellPath()
  userBinOnPath = loginPath !== null
    && loginPath.split(path.delimiter).includes(path.dirname(shimPaths()[0]))
  return userBinOnPath
}

async function cliStatus() {
  const python = backendInfo()?.python
  const onPath = await userBinOnLoginPath()
  const shim = shimPaths()[0]
  let current
  try {
    current = fs.readFileSync(shim, 'utf-8')
  } catch {
    return { state: 'missing', path: shim, onPath }
  }
  if (!current.includes(SHIM_MARKER)) return { state: 'foreign', path: shim, onPath }
  if (!python || current === shimText(python)) return { state: 'installed', path: shim, onPath }
  // Ours but pointing elsewhere: heal in place (§3 — a user-owned file
  // rewrites without a directory write). A failed rewrite only logs: the
  // next status read retries it.
  try {
    fs.writeFileSync(shim, shimText(python), { mode: 0o755 })
  } catch (e) {
    appLog(`cli-status: couldn't heal ${shim}: ${e?.message || e}`)
  }
  return { state: 'installed', path: shim, onPath }
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

// §3 cli-uninstall (§4.9 disable confirm): remove the ours-marker shim;
// foreign files never touched. A failed delete reports an error message the
// §4.9 card toasts.
function cliUninstall() {
  const p = shimPaths()[0]
  let text
  try {
    text = fs.readFileSync(p, 'utf-8')
  } catch {
    return { ok: true }
  }
  if (!text.includes(SHIM_MARKER)) return { ok: true }
  try {
    fs.unlinkSync(p)
    appLog(`cli-uninstall: removed ${p}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, hint: `Couldn’t delete ${p} — ${e?.message || e}` }
  }
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
  if (!panel) return
  panelHeight = Math.min(Math.max(Math.round(h), 120), 640)
  panel.setSize(334, panelHeight)
  // §13: re-anchor at the real new height — a bottom-anchored panel would
  // otherwise drift off the taskbar as its content grows.
  repositionPanel()
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
  // §2 platform rule: reveal shows a location, never starts something — on
  // macOS an extension-carrying directory is a bundle and openPath on one
  // *launches* it, so only extension-less plain dirs open in place.
  if (plat.revealPrefersOpen(abs, isDir)) void shell.openPath(abs)
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
  osName: plat.OS_NAME, // §4.1 display form — the §9.5 OS line never hardcodes it
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
// Null where the platform declares no update capability, or has one but no
// channel yet: every §3 update path checks it and answers the degraded line,
// so the IPC surface stays byte-identical for the renderer either way.
const UPDATE_FEED = caps.updates ? plat.updateFeedUrl(process.arch) : null

// §3: the one line every update path answers when this platform serves no feed
// — check carries it as its error detail (the §9.4 page renders it instead of
// the generic network copy), download and install refuse with it.
const NO_UPDATES_ERROR = 'Updates are not supported on this platform yet.'

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

// §3 per-OS update machinery, chosen by the §2 module's marker — never by
// sniffing process.platform here. `squirrel` is Electron's built-in
// autoUpdater (macOS, the flow below); `nsis` and `appimage` are
// electron-updater's NsisUpdater (Windows) and AppImageUpdater (Linux), both
// against the generic provider. The renderer-facing IPC surface is identical
// every way, so no renderer code forks.
const USE_GENERIC = Boolean(UPDATE_FEED)
  && (plat.UPDATER === 'nsis' || plat.UPDATER === 'appimage')

// Built on first use and never at module load: requiring main.cjs must not
// turn into a feed fetch, and electron-updater checks nothing until asked.
let generic = null

function genericUpdater() {
  if (generic) return generic
  const { NsisUpdater, AppImageUpdater } = require('electron-updater')
  const Updater = plat.UPDATER === 'nsis' ? NsisUpdater : AppImageUpdater
  // No publisherName until a certificate exists (§3 footgun): with one set,
  // electron-updater verifies the downloaded installer's Authenticode
  // identity, and every update against an unsigned artifact fails.
  const u = new Updater({ provider: 'generic', url: UPDATE_FEED })
  // §3 manual-only rule: a check just reads latest.yml, downloads and installs
  // are user-initiated, and nothing may install itself on quit — the
  // update-install handler's live-execution gate is the only way in.
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  const log = (m) => appLog(`update: ${String(m?.stack || m?.message || m)}`)
  u.logger = { info: log, warn: log, error: log, debug: () => {} }
  // §3 determinate progress on the same update-progress IPC the mac flow
  // pushes: percent, or null (indeterminate bar) when the server sent no
  // total to divide by.
  u.on('download-progress', (p) => {
    const percent = p?.total && Number.isFinite(p?.percent)
      ? Math.min(100, Math.round(p.percent))
      : null
    win?.webContents.send('update-progress', percent)
  })
  generic = u
  return generic
}

// §3 electron-updater check (win32/linux): the feed read, mapped onto the
// same `{ state }` shape and the same §9.4 version-compare rule as the mac
// path — electron-updater's own "is this newer" answer is never consulted, so
// every platform agrees on what counts as an update.
async function fetchUpdateStateGeneric() {
  try {
    const result = await genericUpdater().checkForUpdates()
    const version = String(result?.updateInfo?.version ?? '')
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

// §3 electron-updater download (win32/linux): it streams the binary and emits
// real progress events, so there is no temp file, no loopback server and no
// re-implemented percent math here. The check runs first — with autoDownload
// off it only reads the feed yml — which is both the mac flow's "re-fetch the
// feed" step and what arms downloadUpdate.
async function downloadUpdateGeneric() {
  try {
    const updater = genericUpdater()
    const result = await updater.checkForUpdates()
    const version = String(result?.updateInfo?.version ?? '')
    if (!isNewerVersion(version, app.getVersion())) return { error: 'no update available' }
    await updater.downloadUpdate(result?.cancellationToken)
    win?.webContents.send('update-progress', 100)
    return { ok: true }
  } catch (err) {
    return { error: String(err?.message || err) }
  }
}

async function fetchUpdateState() {
  // §3: no feed on this platform — answer the error state carrying the plain
  // no-updates line, so the §9.4 page never tells the user to retry something
  // that cannot succeed. A real feed failure carries no detail (generic copy).
  if (!UPDATE_FEED) return { state: 'error', error: NO_UPDATES_ERROR }
  if (USE_GENERIC) return fetchUpdateStateGeneric()
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

// §3 managed-install detection (Homebrew on macOS): probed fresh on every
// query — never cached — so a brew install/uninstall while the app runs
// reflects without a restart. The probe lives in the platform module;
// AUTOWRIGHT_CASKROOM replaces its list (test escape hatch).
function brewManaged() {
  return plat.managedInstall()
}

ipcMain.handle('update-check', () => fetchUpdateState())
ipcMain.handle('update-available', () => availableVersion)
ipcMain.handle('update-brew-managed', () => brewManaged())

// Squirrel's autoUpdater emits no download-progress events, so the DMG is
// downloaded here first — streamed to a temp file, percent pushed to the
// renderer as update-progress events — then unpacked into the zip Squirrel
// consumes and handed over through a one-shot loopback feed (§3). No dev
// fork: an unsigned build takes the same path and surfaces Squirrel's real
// signature error.
ipcMain.handle('update-download', async () => {
  if (brewManaged()) return { error: plat.MANAGED_COPY_ERROR }
  if (!UPDATE_FEED) return { error: NO_UPDATES_ERROR }
  if (USE_GENERIC) return downloadUpdateGeneric()
  const sendPercent = (percent) => win?.webContents.send('update-progress', percent)
  const stamp = randomUUID()
  const tmpDmg = path.join(app.getPath('temp'), `autowright-update-${stamp}.dmg`)
  const tmpZip = path.join(app.getPath('temp'), `autowright-update-${stamp}.zip`)
  const mount = path.join(app.getPath('temp'), `autowright-update-${stamp}.mount`)
  const run = (cmd, args) => new Promise((res, rej) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) rej(new Error(String(stderr || err?.message || err).trim()))
      else res(stdout)
    })
  })
  let attached = false
  const detach = async () => {
    if (!attached) return
    // -force second: a Finder or Spotlight peek at the volume must not strand
    // the mount (and its temp dir) for the rest of the app's life.
    await run('hdiutil', ['detach', mount]).catch(() => run('hdiutil', ['detach', mount, '-force']))
      .catch(() => {})
    attached = false
  }
  let server = null
  const cleanup = () => {
    // closeAllConnections first: close() alone only stops new connections, so
    // a kept-alive Squirrel socket would hold the loopback server open for the
    // rest of the app's life.
    server?.closeAllConnections?.()
    server?.close()
    detach().then(() => fs.rm(mount, { recursive: true, force: true }, () => {}))
    fs.rm(tmpDmg, { force: true }, () => {})
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
    const dmgRes = await fetch(entry.updateTo.url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!dmgRes.ok || !dmgRes.body) throw new Error(`update download: HTTP ${dmgRes.status}`)
    const total = Number(dmgRes.headers.get('content-length')) || 0
    const out = fs.createWriteStream(tmpDmg)
    let got = 0
    let lastPercent = -1
    for await (const chunk of dmgRes.body) {
      got += chunk.length
      const percent = total ? Math.min(100, Math.round((got / total) * 100)) : null
      if (percent !== lastPercent) { lastPercent = percent; sendPercent(percent) }
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
    }
    await new Promise((res, rej) => { out.on('error', rej); out.end(res) })
    sendPercent(100)

    // §3: Squirrel consumes zips, not DMGs — build the zip it needs from the
    // downloaded DMG: attach read-only, zip the single .app, detach.
    fs.mkdirSync(mount, { recursive: true })
    await run('hdiutil', ['attach', tmpDmg, '-nobrowse', '-readonly', '-mountpoint', mount])
    attached = true
    const appName = fs.readdirSync(mount).find((name) => name.endsWith('.app'))
    if (!appName) throw new Error('the downloaded update holds no app')
    await run('ditto', ['-c', '-k', '--keepParent', path.join(mount, appName), tmpZip])
    await detach()

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
  if (brewManaged()) return { error: plat.MANAGED_COPY_ERROR }
  // §3: no feed → nothing can be staged; quitAndInstall with nothing staged
  // must never quit the app for no swap (unreachable on macOS, real on win32).
  if (!UPDATE_FEED) return { error: NO_UPDATES_ERROR }
  if (await executionsLive()) return { busy: true }
  appLog('update: quitting to install')
  // §3: the same busy-gated, user-initiated install on every platform — only
  // the machinery that performs the swap differs (ShipIt vs. the NSIS
  // installer vs. the AppImage swap electron-updater staged).
  if (USE_GENERIC) genericUpdater().quitAndInstall()
  else autoUpdater.quitAndInstall()
  return { ok: true }
})

// §3: the explicit service command the shell runs — `stop` for the §4.9 QUIT
// and RESET flows. One shared path: the same interpreter resolution as
// ensure-backend and the same install interlock (block new `service install`
// spawns and wait out any in-flight one, so the stop can't be undone by a
// racing install child). Resolves to null on success or the failure text; a
// caller that keeps the app up resets `quittingAll` itself, since future
// ensure/version-sync installs may run.
async function runServiceVerb(verb, label) {
  // Dev launches have no bundled Python — backend.json publishes the
  // interpreter that runs the backend (§3 discovery fields), same code path.
  const py = bundledPython() || backendInfo()?.python
  if (!py) return 'No backend interpreter found'
  quittingAll = true
  await serviceInstallDone
  return new Promise((resolve) => {
    // §2 spawn policy: never show a console window for a shell child.
    execFile(py, ['-m', 'autowright.service', verb], { windowsHide: true }, (e, stdout, stderr) => {
      appLog(`${label}: ${String(stdout || stderr || '').trim()}`)
      resolve(e ? String(stdout || stderr || e.message).trim() : null)
    })
  })
}

// §3 explicit-quit exception (§4.9 QUIT card): stop the backend LaunchAgent
// (bootout plus the stray-process sweep — plist and shim stay; it returns at
// next login or app launch), then quit the app. On any stop failure the app
// stays up — never quit the UI while the backend it promised to stop keeps
// running. `force` (the §4.9 force-confirm modal's retry) skips the
// live-execution gate: the backend's graceful shutdown and the stop's sweep
// end the running execution.
ipcMain.handle('quit-all', async (_e, opts) => {
  if (!opts?.force && await executionsLive()) return { busy: true }
  const err = await runServiceVerb('stop', 'quit-all')
  if (err) {
    // The app stays up (§3), so future ensure/version-sync installs may run.
    quittingAll = false
    return { error: err }
  }
  appLog('quit-all: backend stopped, quitting app')
  app.quit()
  return { ok: true }
})

// §3 reset steps ------------------------------------------------------------

// §3 reset step 2: the executions dir is user-movable (§4.9) and may live
// outside the data root, so its location is captured from the live backend
// before anything stops it. null when unreachable or unanswered — the
// deletions below then only cover the §5 roots.
async function captureDataPath() {
  const res = await backendFetch('/settings')
  if (!res?.ok) return null
  try {
    const s = await res.json()
    return typeof s?.dataPath === 'string' && s.dataPath ? s.dataPath : null
  } catch {
    return null
  }
}

// §3 reset step 3: only the backend's keyring reaches the Keychain /
// Credential Manager, so the sweep has to run while it is still up. A failure (the §19 unreadable-store 409 included) is logged and the flow
// proceeds: value deletion is best-effort per entry (§4.8), and an unreadable
// secrets.yaml means those ids were unreachable this session anyway.
async function deleteSecrets(label) {
  const res = await backendFetch('/secrets', { method: 'DELETE' }, 30_000)
  if (res?.ok) return
  appLog(`${label}: DELETE /secrets failed `
    + `(${res ? `HTTP ${res.status}` : 'backend unreachable'}) — continuing`)
}

// §3 reset step 5: on Windows a reported service stop precedes the backend's
// file handles actually closing (the §3 stop-verification gap — executions.db
// and the backend's own log file), so a failed delete is retried briefly, up
// to ~10 s. A failure that survives the retries is logged and the flow
// continues — a leftover file must not strand the app mid-reset. The platform
// module names the OS (§2: main.cjs never sniffs process.platform).
async function deletePath(target, label) {
  const deadline = Date.now() + (plat.OS_TOKEN === 'windows' ? 10_000 : 0)
  for (;;) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true })
      return
    } catch (e) {
      if (Date.now() >= deadline) {
        appLog(`${label}: couldn't delete ${target}: ${e?.message || e}`)
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

function containsPath(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  return c === p || c.startsWith(p + path.sep)
}

// §3 reset step 5: the executions dir, the logs root, and every entry of the
// data root **except** the live Chromium profile — Chromium holds open handles
// on it, so deleting it would fail (on Windows a sharing violation outright).
// The profile is cleared instead, which is what
// matters: every §15 localStorage marker (`ad-cli-installed` among them) goes.
// Its residual Chromium internals are accepted residue (§3).
async function deleteAllData(dataPath, label) {
  const root = appSupportDir()
  const profile = path.join(root, 'electron')
  // A relocated executions dir may sit anywhere; only a configured location
  // that would take the live profile with it is left to the entry sweep below.
  if (dataPath && !containsPath(dataPath, profile)) await deletePath(dataPath, label)
  await deletePath(logsDir(), label)
  let entries = []
  try {
    entries = fs.readdirSync(root)
  } catch { /* no data root at all — nothing to sweep */ }
  for (const name of entries) {
    if (path.join(root, name) === profile) continue
    await deletePath(path.join(root, name), label)
  }
  try {
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
  } catch (e) {
    appLog(`${label}: couldn't clear the browser profile: ${e?.message || e}`)
  }
}

// §3 reset (§4.9 RESET card): erase every §5 file and every secret, then
// relaunch into onboarding. The service registration, the CLI shim and the app
// itself deliberately survive — only data is erased.
ipcMain.handle('reset-all', async () => {
  // §3 step 1: the same live-execution gate as quit-all/update-install; an
  // unreachable backend counts as idle.
  if (await executionsLive()) return { busy: true }
  const dataPath = await captureDataPath()
  // §3: each destructive step announces itself as it starts — fire-and-forget
  // stage tokens for the §4.9 reset progress overlay.
  const stage = (s) => win?.webContents.send('reset-progress', s)
  stage('secrets')
  await deleteSecrets('reset')
  stage('service')
  const err = await runServiceVerb('stop', 'reset')
  if (err) {
    // §3 step 4: a stop failure aborts the reset — the app stays up and
    // nothing has been deleted beyond step 3's secrets.
    quittingAll = false
    return { error: err }
  }
  stage('data')
  await deleteAllData(dataPath, 'reset')
  appLog('reset: data erased, relaunching')
  // §3 step 6: the relaunched app finds no backend.json and an empty data root
  // — ensure-backend re-registers and §10 onboarding runs as on a fresh install.
  stage('relaunch')
  app.relaunch()
  app.exit(0)
  return { ok: true }
})

app.whenReady().then(() => {
  if (!gotLock) return
  // Dev launches via `electron .`, which ships the default Electron dock icon —
  // replace it with the AW mark (§14 checked-in icon assets; a no-op on
  // platforms without a dock).
  if (caps.dockIcon) plat.setDockIcon(app, path.join(__dirname, 'icon', 'icon.png'))
  // §9: a platform without an application menu (Linux — the native frame
  // would draw Electron's stock File/Edit/View/Window bar) has it suppressed
  // before any window exists; editing shortcuts are Chromium-native.
  if (!caps.appMenu) Menu.setApplicationMenu(null)
  void ensureBackend()
  createWindow()
  if (caps.trayPanel) createTray()
  void notifyAppStarted()
  void refreshTrayAlert()
  void syncShellSettings()
  setInterval(() => { void refreshTrayAlert(); void syncShellSettings() }, 60_000)
  // The hidden tray panel is also a BrowserWindow, so count only the main
  // window — `getAllWindows().length` would block reopening from the Dock.
  // §9: a not-yet-loaded window stays hidden even on an explicit reopen — it
  // shows itself on the first successful load.
  app.on('activate', () => { if (win === null) createWindow(); else if (winLoaded) { win.show(); win.focus() } })
})

// §9 close rule, per-OS. §3 holds either way: quitting the app never stops the
// backend — we are always a client (the one exception is the explicit quit-all
// IPC above, which stops the backend first and then quits).
//   • With a dock (macOS): never quit. The app is a tray-and-dock app and stays
//     resident; `activate` reopens the window from the dock.
//   • Without one (Windows): the tray icon is the only way back, so the app
//     stays resident exactly while one is showing and otherwise quits the UI.
//     The check reads the live `tray` reference — never the stored §4.9
//     `menuBarIcon` setting — so a tray that failed to appear can't strand an
//     invisible app with no way to reach it.
app.on('window-all-closed', () => {
  if (caps.dockIcon) return
  if (!tray) app.quit()
})
