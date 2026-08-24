// §2 CLI-leaf invariant guard over the Electron main layer — main.cjs plus
// the §2 platform modules under electron/platform/ (spec §15). The app
// registers the backend via `python -m autowright.service` and must never
// execute the CLI; §3 shim writes only ever target the user-local location —
// no admin prompt exists, and nothing ever writes to the legacy
// /usr/local/bin (the pre-08-15 bug was a silent best-effort write there).
// main.cjs has no importable module structure, so the guard reads the source.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ELECTRON_DIR = join(__dirname, '..', 'electron')
const src = readFileSync(join(ELECTRON_DIR, 'main.cjs'), 'utf-8')
// The platform modules are part of the same trust surface: every guard that
// scans main.cjs scans them too (union), so a §2 extraction can't smuggle a
// forbidden call out of the guard's sight.
const PLATFORM_DIR = join(ELECTRON_DIR, 'platform')
const platFiles = readdirSync(PLATFORM_DIR).filter((n) => n.endsWith('.cjs'))
const platSrc = platFiles.map((n) => readFileSync(join(PLATFORM_DIR, n), 'utf-8')).join('\n')
const union = `${src}\n${platSrc}`

describe('main.cjs CLI-leaf invariant (§2)', () => {
  it('registers the backend via -m autowright.service', () => {
    expect(src).toContain("'-m', 'autowright.service', 'install'")
  })

  it('quit-all and reset drive -m autowright.service, nothing else', () => {
    // Both explicit service commands share one runner (§3: same interpreter
    // resolution + install interlock), so the verbs are pinned here rather
    // than one literal argv per flow.
    expect(src).toContain("execFile(py, ['-m', 'autowright.service', verb]")
    const verbs = [...src.matchAll(/runServiceVerb\('([a-z]+)'/g)].map((m) => m[1])
    expect(new Set(verbs)).toEqual(new Set(['stop']))
    expect(verbs).toHaveLength(2)
    expect(src).toContain("runServiceVerb('stop', 'quit-all')")
    expect(src).toContain("runServiceVerb('stop', 'reset')")
  })

  it('quit-all gates on live executions unless the renderer forces it (§3)', () => {
    // The §4.9 force-confirm modal's retry passes { force: true }, the one way
    // past the gate — and the gate still runs before the stop for every
    // unforced call.
    expect(src).toContain("ipcMain.handle('quit-all', async (_e, opts) => {")
    expect(src).toMatch(
      /if \(!opts\?\.force && await executionsLive\(\)\) return \{ busy: true \}[\s\S]{0,200}runServiceVerb\('stop', 'quit-all'\)/)
  })

  it('never executes the CLI — autowright.cli appears only inside the shim file text', () => {
    // main.cjs itself never mentions the CLI; the platform modules mention it
    // exactly once each, as the shim file's contents (the shimText run line,
    // §3: POSIX or Windows .cmd form) — never a child-process invocation by
    // the app.
    expect(src).not.toContain('autowright.cli')
    const shimForms = [
      'exec "${python}" -m autowright.cli "$@"', // POSIX shim (darwin/fallback)
      '"${python}" -m autowright.cli %*', // Windows .cmd shim (win32)
    ]
    const lines = union.split('\n').filter((l) => l.includes('autowright.cli'))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const line of lines) {
      expect(shimForms.some((form) => line.includes(form))).toBe(true)
      expect(line).not.toMatch(/execFile|spawn/)
    }
  })

  it('spawns only the service managers, the login shell, and the backend python', () => {
    // Every child-process call site across main.cjs + platform modules:
    // execFile('launchctl'|'systemctl'|shell|py, …). `shell` is the §3
    // login-shell PATH probe (printf $PATH, nothing else); 'launchctl' /
    // 'systemctl' are the §2 serviceDiagnostics captures. The pre-0.6.1 mac
    // update flow's hdiutil/ditto helpers are gone — electron-updater
    // downloads the zip directly (§3). `spawn` is not used at all (the word
    // may appear in comments only).
    const calls = [...union.matchAll(/(?<![.\w])(?:execFile|spawn|exec)\(\s*([^,)]+)/g)].map((m) => m[1].trim())
    for (const first of calls) {
      expect(["'launchctl'", "'systemctl'", 'shell', 'py']).toContain(first)
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(union).not.toContain("'hdiutil'")
    expect(union).not.toContain("'ditto'")
    // …and every python call site runs the service module, nothing else.
    const pyCalls = [...union.matchAll(/execFile\(\s*py\s*,\s*\[([^\]]*)\]/g)].map((m) => m[1])
    expect(pyCalls.length).toBeGreaterThanOrEqual(1)
    for (const args of pyCalls) {
      expect(args).toContain("'-m', 'autowright.service'")
    }
  })

  it('shim writes are user-local only — no admin prompt, no /usr/local/bin write (§3)', () => {
    // No osascript admin flow exists at all.
    expect(union).not.toContain('with administrator privileges')
    expect(union).not.toContain("'osascript'")
    // The silent-failure regression: no direct write targeting the legacy
    // shim location — cli-install writes shimPaths()[0] (user-local), and
    // the heal only rewrites an already-ours file.
    expect(union).not.toMatch(/writeFileSync\(\s*'\/usr\/local\/bin/)
    expect(union).not.toMatch(/writeFileSync\(\s*SYSTEM_SHIM/)
    expect(src).toMatch(/writeFileSync\(shim, shimText\(python\)/)
  })

  it('electron-updater is required lazily, behind the feed gate (§3)', () => {
    // The mac bundle ships only electron-updater's runtime closure, and
    // constructing an updater must never happen at module load (requiring
    // main.cjs must not turn into network machinery). The one require sits
    // inside the constructor helper.
    const hits = union.match(/require\('electron-updater'\)/g) ?? []
    expect(hits).toHaveLength(1)
    expect(src).toMatch(/function genericUpdater\(\) \{[\s\S]{0,200}require\('electron-updater'\)/)
    // …and every path that can reach the helper refuses first without a feed
    // (fetchUpdateState + both handlers open on the UPDATE_FEED gate), so on a
    // feedless platform nothing can reach the require at all.
    const gates = src.match(/if \(!UPDATE_FEED\) return \{ (state: 'error', )?error: NO_UPDATES_ERROR \}/g) ?? []
    expect(gates).toHaveLength(3)
    // The marker decides the class — never a process.platform sniff in
    // main.cjs — and all three OSes go through the same electron-updater map.
    expect(src).toMatch(/\{ mac: MacUpdater, nsis: NsisUpdater, appimage: AppImageUpdater \}\[plat\.UPDATER\]/)
    expect(src).not.toContain("process.platform === 'win32'")
    expect(src).not.toContain("process.platform === 'linux'")
    // The darwin Squirrel hand-off tail is the one per-OS fork, keyed on the
    // marker, and it runs strictly inside the download handler's flow.
    expect(src).toMatch(/if \(plat\.UPDATER === 'mac'\) \{\n\s*const error = await stageWithSquirrel\(updater\)/)
  })

  it('no auto-install: cli-install is reachable only via its IPC handler (§3)', () => {
    // Exactly two mentions of cliInstall: the definition and the IPC handler.
    const hits = src.match(/cliInstall(?!l)/g) ?? []
    expect(hits).toHaveLength(2)
    expect(src).toContain("ipcMain.handle('cli-install', () => cliInstall())")
  })

  it('the /health probe proves the backend is ours, not merely that something answered (§3)', () => {
    // The hole this closes: backend.json can name a stale port some other
    // local server now owns. Counting its 200 as our backend marked
    // ensure-backend 'ok', skipped the service install, and waited forever.
    // The probe now reads the body: our app name, and a version that isn't
    // empty. Anything else (non-JSON throws into the catch) answers null, so
    // ensureBackend falls through to the install branch.
    expect(src).toMatch(/async function backendVersion\(\)[\s\S]{0,400}body\?\.app !== 'Autowright'/)
    expect(src).toMatch(/backendVersion\(\)[\s\S]{0,500}String\(body\.version \?\? ''\) \|\| null/)
    // …and every caller still reads "healthy" off exactly that answer, so the
    // stricter probe can't be routed around.
    expect(src).toContain('return (await backendVersion()) !== null')
    expect(src).toMatch(/const running = await backendVersion\(\)\n\s*if \(running !== null\) \{/)
  })

  it('the ready chain survives a throwing tray (§9/§13)', () => {
    // createTray() used to run first with no try/catch and no .catch on the
    // chain: a bad tray image in a broken package silently killed the §6
    // app-start triggers, the §13 tray poll, the §4.9 settings reconcile and
    // the macOS activate handler with it.
    const ready = src.slice(src.indexOf('app.whenReady()'))
    // The reopen handler is registered before anything that can throw.
    expect(ready.indexOf("app.on('activate'")).toBeLessThan(ready.indexOf('createTray()'))
    expect(ready).toMatch(/if \(caps\.trayPanel\) \{\n\s*try \{\n\s*createTray\(\)\n\s*\} catch \(err\) \{[\s\S]{0,120}appLog\(/)
    // …and the polls/reconcile sit after the catch, so they run either way.
    for (const call of ['void notifyAppStarted()', 'void refreshTrayAlert()', 'void syncShellSettings()']) {
      expect(ready.indexOf(call)).toBeGreaterThan(ready.indexOf('createTray()'))
    }
    // Last resort: nothing in the chain may reject into the void.
    expect(ready).toMatch(/\}\)\.catch\(\(err\) => appLog\(/)
  })

  it('syncShellSettings tells a down backend apart from a shell-side throw', () => {
    // One catch used to swallow both, so a throw out of applyShellSettings
    // (tray create, login item, update timer) read as "backend down" and left
    // no trace anywhere.
    const fn = src.slice(src.indexOf('async function syncShellSettings()'))
      .slice(0, src.slice(src.indexOf('async function syncShellSettings()')).indexOf('\n}\n') + 3)
    expect(fn).toMatch(/catch \{ \/\* backend down/)
    expect(fn).toMatch(/try \{\n\s*applyShellSettings\(settings\)\n\s*\} catch \(err\) \{\n\s*appLog\(/)
  })

  it('cli-uninstall deletes only marker-carrying shims, via its IPC handler (§3)', () => {
    expect(src).toContain("ipcMain.handle('cli-uninstall', () => cliUninstall())")
    // The marker gate sits before the unlink — foreign files are never touched.
    expect(src).toMatch(/if \(!text\.includes\(SHIM_MARKER\)\) return \{ ok: true \}[\s\S]{0,160}unlinkSync/)
  })
})

// ---- IPC argument validation ----------------------------------------------
// main.cjs exports nothing, so the handlers are reached by evaluating the same
// source against a stub `electron` module: `ipcMain.handle` collects them and
// the `shell`/`BrowserWindow` stubs record what a call actually did. Real code,
// real handlers — only the Electron surface underneath is a double.

// The §3 electron-updater double (darwin MacUpdater / win32 NsisUpdater /
// linux AppImageUpdater — one fake serves as all three): electron-updater is
// required lazily by main.cjs, so the stub `require` hands it this fake under
// every class name — the same "patch the layer underneath, run the real
// handler" rule as the electron stub itself. Canned answers live on the
// record so a test can arm them before the handler ever constructs the
// updater. Like the real MacUpdater, downloadUpdate flips
// squirrelDownloadedUpdate, so the darwin hand-off tail settles immediately
// instead of waiting on the stub autoUpdater's silence.
interface UpdaterRecord {
  options: { provider?: string, url?: string } | null
  autoDownload: boolean | null
  autoInstallOnAppQuit: boolean | null
  checks: number
  downloads: number
  installs: number
  check: unknown
  checkError: Error | null
  downloadError: Error | null
  listeners: Map<string, (arg: unknown) => void>
}

// Per-window record: show/focus/load counts plus a way to fire webContents
// events at the real handlers main.cjs registered (§9 never-paint guard).
interface WinRecord {
  shows: number
  focuses: number
  loads: number
  fire: (event: string, ...args: unknown[]) => void
}

interface MainStub {
  invoke: (channel: string, ...args: unknown[]) => unknown
  // Fire an app-level event main.cjs subscribed to (window-all-closed, …).
  emit: (event: string) => void
  opened: string[]
  revealed: string[]
  windows: unknown[]
  wins: WinRecord[]
  trays: unknown[]
  loginItem: boolean[]
  aumids: string[]
  sent: [string, unknown][]
  updater: UpdaterRecord
  quits: number
  home: string
  // §9 watchdog / renderer-death reporting: every dialog.showErrorBox the
  // shell put up, and the app.log lines behind them.
  errors: [string, string][]
  log: () => string
}

const realRequire = createRequire(join(ELECTRON_DIR, 'main.cjs'))
const savedHome = process.env.AUTOWRIGHT_HOME

function loadMain(): MainStub {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
  const appEvents = new Map<string, () => void>()
  const opened: string[] = []
  const revealed: string[] = []
  const windows: unknown[] = []
  const trays: unknown[] = []
  const loginItem: boolean[] = []
  const aumids: string[] = []
  const sent: [string, unknown][] = []
  const errors: [string, string][] = []
  let quits = 0
  const home = mkdtempSync(join(tmpdir(), 'aw-main-'))
  process.env.AUTOWRIGHT_HOME = home

  const updater: UpdaterRecord = {
    options: null, autoDownload: null, autoInstallOnAppQuit: null,
    checks: 0, downloads: 0, installs: 0,
    check: { updateInfo: { version: '9.9.9' } },
    checkError: null, downloadError: null, listeners: new Map(),
  }

  class FakeUpdater {
    autoDownload = true
    autoInstallOnAppQuit = true
    squirrelDownloadedUpdate = false
    logger: unknown = null

    constructor(options: { provider?: string, url?: string }) { updater.options = options }
    on(event: string, fn: (arg: unknown) => void) { updater.listeners.set(event, fn) }

    async checkForUpdates() {
      // Read the flags as the handler left them: an autoDownload that is
      // still true would mean a check downloads (§3 forbids it).
      updater.autoDownload = this.autoDownload
      updater.autoInstallOnAppQuit = this.autoInstallOnAppQuit
      updater.checks += 1
      if (updater.checkError) throw updater.checkError
      return updater.check
    }

    async downloadUpdate() {
      updater.downloads += 1
      if (updater.downloadError) throw updater.downloadError
      // The real MacUpdater sets this once Squirrel staged the bundle; the
      // fake stages "instantly" so main.cjs's stageWithSquirrel resolves.
      this.squirrelDownloadedUpdate = true
      return ['installer.exe']
    }

    quitAndInstall() { updater.installs += 1 }
  }

  const wins: WinRecord[] = []

  class FakeWindow {
    wcListeners = new Map<string, (...a: unknown[]) => void>()
    record: WinRecord = {
      shows: 0, focuses: 0, loads: 0,
      fire: (event, ...args) => { this.wcListeners.get(event)?.({}, ...args) },
    }

    webContents = {
      on: (event: string, fn: (...a: unknown[]) => void) => { this.wcListeners.set(event, fn) },
      once: (event: string, fn: (...a: unknown[]) => void) => { this.wcListeners.set(event, fn) },
      send: (channel: string, payload: unknown) => { sent.push([channel, payload]) },
      setWindowOpenHandler() {},
      isLoading: () => false, getURL: () => '',
    }

    constructor(opts: unknown) { windows.push(opts); wins.push(this.record) }
    loadFile() { this.record.loads += 1 } loadURL() { this.record.loads += 1 }
    on() {} show() { this.record.shows += 1 } focus() { this.record.focuses += 1 } hide() {}
    setSize() {} setPosition() {} isVisible() { return false }
    setVisibleOnAllWorkspaces() {} destroy() {}
  }

  const electron = {
    app: {
      setPath() {},
      getPath: () => home,
      getVersion: () => '0.0.0',
      commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => true,
      on(event: string, fn: () => void) { appEvents.set(event, fn) },
      isReady: () => false,
      quit() { quits += 1 },
      whenReady: () => new Promise(() => {}),
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setAppUserModelId: (id: string) => { aumids.push(id) },
      setLoginItemSettings(s: { openAtLogin: boolean }) { loginItem.push(s.openAtLogin) },
      dock: { setIcon() {} },
    },
    autoUpdater: { on() {}, removeListener() {}, setFeedURL() {}, checkForUpdates() {}, quitAndInstall() {} },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    Tray: class {
      constructor(icon: unknown) { trays.push(icon) }
      setToolTip() {} on() {} setImage() {} destroy() {}
    },
    dialog: {
      showErrorBox: (title: string, body: string) => { errors.push([title, body]) },
    },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    ipcMain: { handle: (name: string, fn: never) => { handlers.set(name, fn) } },
    shell: {
      openPath: (p: string) => { opened.push(p) },
      showItemInFolder: (p: string) => { revealed.push(p) },
      openExternal() {},
    },
    screen: {},
  }

  const load = new Function('require', 'module', 'exports', '__dirname', '__filename', src)
  load(
    (id: string) => {
      if (id === 'electron') return electron
      // One fake under all three class names — main.cjs picks by the §2 marker.
      if (id === 'electron-updater') {
        return { MacUpdater: FakeUpdater, NsisUpdater: FakeUpdater, AppImageUpdater: FakeUpdater }
      }
      return realRequire(id)
    },
    { exports: {} }, {}, ELECTRON_DIR, join(ELECTRON_DIR, 'main.cjs'),
  )

  return {
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return fn({}, ...args)
    },
    emit: (event) => {
      const fn = appEvents.get(event)
      if (!fn) throw new Error(`no app listener for ${event}`)
      fn()
    },
    opened, revealed, windows, wins, trays, loginItem, aumids, sent, updater, home, errors,
    // AUTOWRIGHT_HOME points app.log at this test's own home (§15).
    log: () => {
      try { return readFileSync(join(home, 'logs', 'app.log'), 'utf-8') } catch { return '' }
    },
    get quits() { return quits },
  }
}

describe('main.cjs IPC argument validation', () => {
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
  })

  it('reveal-path shows a path inside the app-support home', async () => {
    const m = loadMain()
    await m.invoke('reveal-path', join(m.home, 'automations', 'demo'))
    expect(m.revealed).toEqual([join(m.home, 'automations', 'demo')])
  })

  it('reveal-path ignores a path outside the known roots', async () => {
    const m = loadMain()
    await m.invoke('reveal-path', '/etc/passwd')
    await m.invoke('reveal-path', join(m.home, '..', '..', 'etc', 'passwd'))
    // A sibling directory whose name merely starts with the root's name.
    await m.invoke('reveal-path', `${m.home}-elsewhere${sep}x`)
    expect(m.revealed).toEqual([])
    expect(m.opened).toEqual([])
  })

  it('reveal-path ignores a non-string argument instead of throwing', async () => {
    const m = loadMain()
    await expect(m.invoke('reveal-path', 42)).resolves.toBeUndefined()
    await expect(m.invoke('reveal-path', null)).resolves.toBeUndefined()
    await expect(m.invoke('reveal-path', undefined)).resolves.toBeUndefined()
    expect(m.revealed).toEqual([])
    expect(m.opened).toEqual([])
  })

  it('open-app ignores a non-string hash — no window is created', () => {
    const m = loadMain()
    m.invoke('open-app', { hash: '/app' })
    m.invoke('open-app', 7)
    expect(m.windows).toEqual([])
    // …and a real deep link still opens the window.
    m.invoke('open-app', '/app?automation=abc')
    expect(m.windows).toHaveLength(1)
  })

  it('resize-panel ignores a non-numeric height instead of throwing', () => {
    const m = loadMain()
    // No panel window exists in this process, so the observable contract is
    // simply that a bad height never reaches Math.round/setSize as a throw.
    expect(() => m.invoke('resize-panel', 'tall')).not.toThrow()
    expect(() => m.invoke('resize-panel', undefined)).not.toThrow()
    expect(() => m.invoke('resize-panel', 240)).not.toThrow()
  })
})

// ---- §9 never paint an unloaded window -------------------------------------
// The main window is created hidden and shows itself only on the renderer's
// first successful load; a failed main-frame load (dead dev-server URL) stays
// hidden and retries every second. Chromium fires did-finish-load even after
// a failed navigation, so the tests replay that exact sequence.

describe('main.cjs §9 never-paint-blank window guard', () => {
  afterEach(() => {
    vi.useRealTimers()
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
  })

  it('created hidden; a failed load never shows and retries after 1 s', () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.invoke('open-app', '/app')
    expect(m.windows).toHaveLength(1)
    expect((m.windows[0] as { show?: boolean }).show).toBe(false)
    const w = m.wins[0]
    expect(w.loads).toBe(1) // createWindow's initial load
    // Dead dev server: did-fail-load, then Chromium's did-finish-load for the
    // same failed navigation — still hidden, and a retry is scheduled.
    w.fire('did-start-loading')
    w.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true)
    w.fire('did-finish-load')
    expect(w.shows).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(w.loads).toBe(2)
  })

  it('shows exactly once on the first successful load — subframe failures don\'t count', () => {
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    w.fire('did-start-loading')
    w.fire('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'http://x/img.png', false) // subframe
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
    expect(w.focuses).toBe(1)
    // A later reload (HMR, navigation) never re-fires the show.
    w.fire('did-start-loading')
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
  })

  it('a slow renderer is shown anyway once the 15 s watchdog fires', () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    // Nothing at all happens: no failure, no finish. Without the watchdog the
    // app would sit here alive with no window for the rest of its life.
    vi.advanceTimersByTime(14_000)
    expect(w.shows).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(w.shows).toBe(1)
    expect(w.focuses).toBe(1)
    expect(m.errors).toEqual([]) // there was something to paint — no error box
    expect(m.log()).toContain('showing it anyway')
    // …and a late did-finish-load doesn't show it a second time.
    w.fire('did-start-loading')
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
  })

  it('a successful load disarms the watchdog — no second show, no error box', () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    w.fire('did-start-loading')
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(w.shows).toBe(1)
    expect(m.errors).toEqual([])
  })

  it('nothing to paint after 15 s: the error box names app.log, the retry keeps running', () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    w.fire('did-start-loading')
    w.fire('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'file:///dist/index.html', true)
    w.fire('did-finish-load')
    vi.advanceTimersByTime(15_000)
    // Never shown blank — the window has nothing in it. The failure is told
    // instead, and it points at the log.
    expect(w.shows).toBe(0)
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0][0]).toBe('Autowright')
    expect(m.errors[0][1]).toContain(join(m.home, 'logs', 'app.log'))
    // The 1 s retry still ran (and would keep running against a real
    // Chromium, which re-fires did-fail-load), so a renderer that arrives late
    // still wins.
    expect(w.loads).toBe(2)
    w.fire('did-start-loading')
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
    // …and the box is a one-shot: the watchdog already fired.
    vi.advanceTimersByTime(60_000)
    expect(m.errors).toHaveLength(1)
  })

  it('a dead renderer reloads once; a second death reports and quits (§9)', () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    expect(w.loads).toBe(1)
    // did-finish-load never comes when the renderer process dies — without a
    // handler the window would stay hidden forever with no error at all.
    w.fire('render-process-gone', { reason: 'oom' })
    expect(w.loads).toBe(2)
    expect(m.quits).toBe(0)
    expect(m.errors).toEqual([])
    expect(m.log()).toContain('renderer process gone (oom)')
    // A second death has nothing left to try: say so and quit rather than
    // staying resident and invisible.
    w.fire('render-process-gone', { reason: 'crashed' })
    expect(w.loads).toBe(2)
    expect(m.errors).toHaveLength(1)
    expect(m.errors[0][1]).toContain(join(m.home, 'logs', 'app.log'))
    expect(m.quits).toBe(1)
    // The watchdog was disarmed with it — no box on top of the box.
    vi.advanceTimersByTime(60_000)
    expect(m.errors).toHaveLength(1)
    expect(w.shows).toBe(0)
  })

  it('showApp on an unloaded window stays hidden; after the load it shows again', () => {
    const m = loadMain()
    m.invoke('open-app', '/app')
    const w = m.wins[0]
    // Deep link while still loading: no blank show.
    m.invoke('open-app', '/app?automation=abc')
    expect(w.shows).toBe(0)
    // First successful load shows it…
    w.fire('did-start-loading')
    w.fire('did-finish-load')
    expect(w.shows).toBe(1)
    // …and from then on showApp shows as before.
    m.invoke('open-app', '/app?automation=abc')
    expect(w.shows).toBe(2)
  })
})

// ---- §9 capability wiring + the per-OS close rule --------------------------
// main.cjs asks its own platform module (`plat.capabilities`) before wiring the
// tray, the login item, the dock icon and the update machinery — so these run
// against whichever module this OS selects, and assert the capability's rule
// rather than one platform's answer.

const platMod = realRequire(join(PLATFORM_DIR, 'index.cjs')) as {
  capabilities: { trayPanel: boolean, loginItem: boolean, dockIcon: boolean, updates: boolean, appMenu: boolean }
  UPDATER: string | null
  updateFeedUrl: (arch: string) => string | null
}
const caps = platMod.capabilities
// §3: every platform with a feed drives electron-updater against the generic
// provider (`mac` on darwin, `nsis` on win32, `appimage` on linux); a
// platform without one (fallback) has no machinery at all. The tests below
// assert the rule for whichever this platform declares.
const HAS_UPDATER = caps.updates

describe('main.cjs platform capability wiring (§2/§9)', () => {
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
  })

  it('tray creation follows trayPanel', () => {
    const m = loadMain()
    m.invoke('apply-settings', { menuBarIcon: true })
    expect(m.trays).toHaveLength(caps.trayPanel ? 1 : 0)
  })

  it('sets the platform AppUserModelID at boot — Windows only (§3 identifiers)', () => {
    const m = loadMain()
    expect(m.aumids).toEqual(
      process.platform === 'win32' ? ['ai.autowright.app'] : [],
    )
  })

  it('login-item reconcile follows loginItem', () => {
    if (process.platform === 'linux') {
      // §4.9 on Linux: the §2 applyLoginItem seam reconciles the XDG
      // autostart .desktop file — Electron's login-item API (a no-op there)
      // is never asked.
      const dir = mkdtempSync(join(tmpdir(), 'autowright-login-'))
      const prevXdg = process.env.XDG_CONFIG_HOME
      process.env.XDG_CONFIG_HOME = dir
      try {
        const m = loadMain()
        m.invoke('apply-settings', { login: true })
        const entry = join(dir, 'autostart', 'ai.autowright.app.desktop')
        expect(existsSync(entry)).toBe(true)
        expect(m.loginItem).toEqual([])
        m.invoke('apply-settings', { login: false })
        expect(existsSync(entry)).toBe(false)
      } finally {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = prevXdg
        rmSync(dir, { recursive: true, force: true })
      }
      return
    }
    const m = loadMain()
    m.invoke('apply-settings', { login: true })
    expect(m.loginItem).toEqual(caps.loginItem ? [true] : [])
  })

  it('the automatic update check arms a timer only where updates is true (§3)', () => {
    const m = loadMain()
    // The immediate check would hit the real feed on a platform that has one.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('offline in tests'))
    const timerSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      m.invoke('apply-settings', { automaticUpdateCheck: true })
      if (!caps.updates) {
        expect(timerSpy).not.toHaveBeenCalled()
        return
      }
      expect(timerSpy).toHaveBeenCalled()
    } finally {
      timerSpy.mockRestore()
      fetchSpy.mockRestore()
      // Don't leave a 24 h interval behind in the test process.
      if (caps.updates) m.invoke('apply-settings', { automaticUpdateCheck: false })
    }
  })

  it('update-check answers the no-updates line as its error detail without a feed (§3)', async () => {
    const m = loadMain()
    if (!caps.updates) {
      // No feed on this platform: the check answers the error state carrying
      // the plain line, so the §9.4 page renders it instead of the generic
      // "Couldn't reach GitHub" network copy.
      expect(await m.invoke('update-check')).toEqual({
        state: 'error', error: 'Updates are not supported on this platform yet.',
      })
      return
    }
    // With a feed, a failed read stays a bare error state — no detail, so
    // the generic network copy still stands, on every platform.
    m.updater.checkError = new Error('offline in tests')
    expect(await m.invoke('update-check')).toEqual({ state: 'error' })
  })

  it('window-all-closed: a dock keeps the app resident; without one, only a live tray does (§9)', () => {
    const m = loadMain()
    m.emit('window-all-closed')
    if (caps.dockIcon) {
      // macOS: a tray-and-dock app never quits on close.
      expect(m.quits).toBe(0)
      return
    }
    // No dock: with no tray icon showing there is no way back — quit the UI.
    expect(m.quits).toBe(1)
    if (!caps.trayPanel) return
    // …and with a tray showing, stay resident. The rule reads the live tray
    // reference, so this only changes after the tray actually exists.
    m.invoke('apply-settings', { menuBarIcon: true })
    m.emit('window-all-closed')
    expect(m.quits).toBe(1)
  })

  it('the ensure-backend failure detail is per-OS copy from the platform module (§9)', () => {
    // main.cjs holds no OS-specific failure copy of its own any more.
    expect(src).toContain('detail: plat.SERVICE_START_FAILED_DETAIL')
    expect(src).not.toContain('may be blocking an unsigned build')
    // …and it still composes it with the §2 serviceDiagnostics capture.
    expect(src).toMatch(/SERVICE_START_FAILED_DETAIL[\s\S]{0,400}plat\.serviceDiagnostics\(appLog\)/)
  })
})

// ---- §3 electron-updater updates (darwin MacUpdater / win32 NsisUpdater /
// linux AppImageUpdater). The whole block runs wherever the platform module
// serves a feed; the real handlers run against the fake updater the stub
// `require` supplies, so nothing here touches the network.

describe.skipIf(!HAS_UPDATER)('main.cjs electron-updater path (§3)', () => {
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
  })

  it('is not constructed at module load — nothing checks until it is asked', async () => {
    const m = loadMain()
    expect(m.updater.options).toBeNull()
    expect(m.updater.checks).toBe(0)
    await m.invoke('update-check')
    // …and only then, against the §2 module's generic-provider feed.
    expect(m.updater.options).toEqual({
      provider: 'generic', url: platMod.updateFeedUrl(process.arch),
    })
    expect(m.updater.checks).toBe(1)
  })

  it('a check only reads the feed: autoDownload and install-on-quit are off (§3)', async () => {
    const m = loadMain()
    await m.invoke('update-check')
    expect(m.updater.autoDownload).toBe(false)
    expect(m.updater.autoInstallOnAppQuit).toBe(false)
    expect(m.updater.downloads).toBe(0)
    expect(m.updater.installs).toBe(0)
  })

  it('maps the feed onto the same {state} shape and §9.4 compare rule', async () => {
    const m = loadMain() // the stub app reports version 0.0.0
    m.updater.check = { updateInfo: { version: '9.9.9' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'available', version: '9.9.9' })
    // …and the remembered version reached the renderer (§3 update-available).
    expect(m.sent).toEqual([])  // no window yet — recorded, not lost
    expect(await m.invoke('update-available')).toBe('9.9.9')

    m.updater.check = { updateInfo: { version: '0.0.0' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'uptodate' })
    expect(await m.invoke('update-available')).toBeNull()

    // Malformed counts as not newer, exactly like the mac feed compare.
    m.updater.check = { updateInfo: { version: 'not-a-version' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'uptodate' })

    m.updater.checkError = new Error('ENOTFOUND raw.githubusercontent.com')
    expect(await m.invoke('update-check')).toEqual({ state: 'error' })
  })

  it('update-download drives determinate progress over the update-progress IPC', async () => {
    const m = loadMain()
    m.invoke('open-app', '/app') // a window to receive the events
    const result = await m.invoke('update-download')
    expect(result).toEqual({ ok: true })
    expect(m.updater.downloads).toBe(1)

    // The handler subscribed to electron-updater's own progress events and
    // forwards percent — null when the download reports no total to divide by
    // (the §9.4 bar goes indeterminate).
    const onProgress = m.updater.listeners.get('download-progress')
    expect(onProgress).toBeTypeOf('function')
    onProgress?.({ percent: 42.4, total: 1000, transferred: 424 })
    onProgress?.({ percent: 0, total: 0, transferred: 0 })
    onProgress?.(undefined)
    expect(m.sent.filter(([channel]) => channel === 'update-progress'))
      .toEqual([['update-progress', 100], ['update-progress', 42],
        ['update-progress', null], ['update-progress', null]])
  })

  it('update-download reports the updater\'s own failure, and never a stale ok', async () => {
    const m = loadMain()
    m.updater.downloadError = new Error('net::ERR_CONNECTION_RESET')
    expect(await m.invoke('update-download')).toEqual({ error: 'net::ERR_CONNECTION_RESET' })

    // Nothing newer in the feed: refuse rather than arm an install of nothing.
    const m2 = loadMain()
    m2.updater.check = { updateInfo: { version: '0.0.0' } }
    expect(await m2.invoke('update-download')).toEqual({ error: 'no update available' })
    expect(m2.updater.downloads).toBe(0)
  })

  it('update-install quits to install, behind the live-execution gate (§3)', async () => {
    const m = loadMain()
    expect(await m.invoke('update-install')).toEqual({ ok: true })
    expect(m.updater.installs).toBe(1)
    // The gate itself is one shared code path for every platform: the busy
    // check runs before either updater is asked to quit.
    expect(src).toMatch(/if \(await executionsLive\(\)\) return \{ busy: true \}[\s\S]{0,400}quitAndInstall\(\)/)
  })
})

// ---- §3 Homebrew-managed detection ----------------------------------------
// brewManaged() probes the Caskroom dir fresh on every call; the tests pin the
// probe to a known path via the AUTOWRIGHT_CASKROOM escape hatch so they never
// depend on what's brew-installed on the machine running them.

describe('main.cjs Homebrew-managed updates (§3)', () => {
  const savedCaskroom = process.env.AUTOWRIGHT_CASKROOM

  afterEach(() => {
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
    if (savedCaskroom === undefined) delete process.env.AUTOWRIGHT_CASKROOM
    else process.env.AUTOWRIGHT_CASKROOM = savedCaskroom
  })

  it('update-brew-managed answers whether the Caskroom dir exists — probed per call', async () => {
    const m = loadMain()
    process.env.AUTOWRIGHT_CASKROOM = m.home // any existing dir stands in for the Caskroom
    if (process.platform !== 'darwin') {
      // §2: only darwin has a managed-install channel — every other platform
      // module answers false regardless of the escape hatch.
      expect(await m.invoke('update-brew-managed')).toBe(false)
      return
    }
    expect(await m.invoke('update-brew-managed')).toBe(true)
    // Fresh probe, not a cached launch-time answer: the same loaded main flips
    // with the dir (a brew install/uninstall while the app runs).
    process.env.AUTOWRIGHT_CASKROOM = join(m.home, 'not-there')
    expect(await m.invoke('update-brew-managed')).toBe(false)
  })

  it('update-download and update-install refuse on a brew-managed copy', async () => {
    const m = loadMain()
    process.env.AUTOWRIGHT_CASKROOM = m.home
    if (process.platform !== 'darwin') {
      // §2: only darwin has a managed-install channel, so the escape hatch
      // changes nothing here. Without a feed both actions answer the plain
      // no-updates line; with one (win32/linux) they run the real update path.
      if (!caps.updates) {
        expect(await m.invoke('update-download')).toEqual({ error: 'Updates are not supported on this platform yet.' })
        expect(await m.invoke('update-install')).toEqual({ error: 'Updates are not supported on this platform yet.' })
        return
      }
      expect(await m.invoke('update-download')).toEqual({ ok: true })
      expect(await m.invoke('update-install')).toEqual({ ok: true })
      return
    }
    expect(await m.invoke('update-download')).toEqual({ error: 'This copy is managed by Homebrew.' })
    expect(await m.invoke('update-install')).toEqual({ error: 'This copy is managed by Homebrew.' })
  })

  it('probes only the two Caskroom locations, inside the platform managedInstall()', () => {
    const hits = union.match(/Caskroom\/autowright/g) ?? []
    expect(hits).toHaveLength(2)
    const darwinSrc = readFileSync(join(PLATFORM_DIR, 'darwin.cjs'), 'utf-8')
    expect(darwinSrc).toMatch(/function managedInstall\(\)[\s\S]{0,300}\/opt\/homebrew\/Caskroom\/autowright[\s\S]{0,120}\/usr\/local\/Caskroom\/autowright/)
  })
})
