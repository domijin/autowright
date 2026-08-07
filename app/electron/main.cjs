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

function backendInfo() {
  const home = process.env.AUTOWRIGHT_HOME
    ? process.env.AUTOWRIGHT_HOME
    : path.join(os.homedir(), 'Library', 'Application Support', 'Autowright')
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'backend.json'), 'utf-8'))
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
// unreachable, (re)register the LaunchAgent by running the bundled CLI's
// `service install` — the same single code path headless setups run by hand.
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

// §3: an update install or backend restart must never land mid-execution. An
// unreachable backend counts as idle — nothing can be executing on it.
async function executionsLive() {
  const info = backendInfo()
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/executions?status=executing`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    return (await res.json()).length > 0
  } catch {
    return false
  }
}

// §3 install verification: launchctl can report success while the job never
// spawns (Gatekeeper silently refuses to exec an unsigned, quarantined bundled
// Python as a LaunchAgent — the GUI app's approval does not extend to launchd).
// Poll /health after install; on failure, capture launchd's view into app.log
// and expose the failure to the renderer (backend-status IPC → §9 boot splash).
let ensureStatus = { state: 'idle', detail: '' }

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
  execFile('launchctl', ['print', `gui/${process.getuid()}/com.autowright.backend`],
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
  while (await executionsLive()) {
    await new Promise((r) => setTimeout(r, 30_000))
  }
  execFile(py, ['-m', 'autowright.cli', 'service', 'install'], (err, stdout, stderr) => {
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
  execFile(py, ['-m', 'autowright.cli', 'service', 'install'], (err, stdout, stderr) => {
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
    // §9: one fixed position in every state — 12px lights centered on the nav
    // toggle's y=20 midline (top 6 + 28/2), nudged right of the macOS default.
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0b0e12',
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
    })
    if (!res.ok) return
    const autos = await res.json()
    tray.setImage(trayIcon(autos.some((a) => a.lastStatus === 'failed')))
  } catch { /* backend down — keep the current icon */ }
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

ipcMain.handle('backend-info', () => backendInfo())
ipcMain.handle('backend-status', () => ensureStatus)
ipcMain.handle('open-app', (_e, hash) => { showApp(hash); if (panel) panel.hide() })
ipcMain.handle('resize-panel', (_e, h) => {
  if (panel) panel.setSize(334, Math.min(Math.max(Math.round(h), 120), 640))
})
ipcMain.handle('reveal-path', (_e, p) => {
  const abs = p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
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
  fs.writeFileSync(r.filePath, Buffer.from(data))
  return r.filePath
})
ipcMain.handle('open-archive', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Autowright automation', extensions: ['autowright'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return { name: path.basename(r.filePaths[0]), data: fs.readFileSync(r.filePaths[0]) }
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
ipcMain.handle('set-login-item', (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on }))
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

ipcMain.handle('update-check', async () => {
  try {
    const res = await fetch(UPDATE_FEED, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { state: 'error' }
    const version = String((await res.json()).currentRelease ?? '')
    return isNewerVersion(version, app.getVersion())
      ? { state: 'available', version }
      : { state: 'uptodate' }
  } catch {
    return { state: 'error' }
  }
})

// Squirrel's autoUpdater emits no download-progress events, so the zip is
// downloaded here first — streamed to a temp file, percent pushed to the
// renderer as update-progress events — then handed to Squirrel through a
// one-shot loopback feed (§3). No dev fork: an unsigned build takes the same
// path and surfaces Squirrel's real signature error.
ipcMain.handle('update-download', async () => {
  const sendPct = (pct) => win?.webContents.send('update-progress', pct)
  const tmpZip = path.join(app.getPath('temp'), `autowright-update-${randomUUID()}.zip`)
  let server = null
  const cleanup = () => {
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
    let lastPct = -1
    for await (const chunk of zipRes.body) {
      got += chunk.length
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null
      if (pct !== lastPct) { lastPct = pct; sendPct(pct) }
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
    }
    await new Promise((res, rej) => { out.on('error', rej); out.end(res) })
    sendPct(100)

    // Loopback hand-off: serve the feed (updateTo.url rewritten to this
    // server's own zip route) and the staged zip; Squirrel re-downloads
    // locally, verifies, and stages as usual.
    const port = await new Promise((res, rej) => {
      server = http.createServer((req, resp) => {
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
          fs.createReadStream(tmpZip).pipe(resp)
        } else {
          resp.statusCode = 404
          resp.end()
        }
      })
      server.on('error', rej)
      server.listen(0, '127.0.0.1', () => res(server.address().port))
    })

    return await new Promise((resolve) => {
      const settle = (result) => {
        autoUpdater.removeListener('update-downloaded', onDone)
        autoUpdater.removeListener('update-not-available', onNone)
        autoUpdater.removeListener('error', onErr)
        cleanup()
        resolve(result)
      }
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
  setInterval(() => void refreshTrayAlert(), 60_000)
  // The hidden tray panel is also a BrowserWindow, so count only the main
  // window — `getAllWindows().length` would block reopening from the Dock.
  app.on('activate', () => { if (win === null) createWindow(); else { win.show(); win.focus() } })
})

// §3: quitting the app never stops the backend — we are always a client.
app.on('window-all-closed', () => { /* stay alive in the tray */ })
