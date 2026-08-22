// §2 CLI-leaf invariant guard over the Electron main layer — main.cjs plus
// the §2 platform modules under electron/platform/ (spec §15). The app
// registers the backend via `python -m autowright.service` and must never
// execute the CLI; §3 shim writes only ever target the user-local location —
// no admin prompt exists, and nothing ever writes to the legacy
// /usr/local/bin (the pre-08-15 bug was a silent best-effort write there).
// main.cjs has no importable module structure, so the guard reads the source.
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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

  it('spawns only launchctl, the login shell, and the backend python', () => {
    // Every child-process call site across main.cjs + platform modules:
    // execFile('launchctl'|shell|py, …). `shell` is the §3 login-shell PATH
    // probe (printf $PATH, nothing else). `spawn` is not used at all (the
    // word may appear in comments only).
    const calls = [...union.matchAll(/(?<![.\w])(?:execFile|spawn|exec)\(\s*([^,)]+)/g)].map((m) => m[1].trim())
    for (const first of calls) {
      expect(["'launchctl'", 'shell', 'py']).toContain(first)
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
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

  it('electron-updater is required lazily, inside the nsis-only path (§3)', () => {
    // prod.sh ships no node_modules in the mac bundle, so a top-level require
    // would break every macOS launch. The one require sits inside the
    // constructor helper, which only the `nsis` branches ever call.
    const hits = union.match(/require\('electron-updater'\)/g) ?? []
    expect(hits).toHaveLength(1)
    expect(src).toMatch(/function nsisUpdater\(\) \{[\s\S]{0,200}require\('electron-updater'\)/)
    // …and every entry point into that path is behind the USE_NSIS gate, so
    // on macOS nothing can reach the require at all.
    for (const call of ['fetchUpdateStateNsis()', 'downloadUpdateNsis()',
      'nsisUpdater().quitAndInstall()']) {
      const uses = src.split('\n')
        .filter((l) => l.includes(call) && !/^(async )?function /.test(l.trim()))
      expect(uses).toHaveLength(1)
      expect(uses[0]).toContain('if (USE_NSIS)')
    }
    // The marker decides it — never a process.platform sniff in main.cjs.
    expect(src).toContain("plat.UPDATER === 'nsis'")
    expect(src).not.toContain("process.platform === 'win32'")
  })

  it('no auto-install: cli-install is reachable only via its IPC handler (§3)', () => {
    // Exactly two mentions of cliInstall: the definition and the IPC handler.
    const hits = src.match(/cliInstall(?!l)/g) ?? []
    expect(hits).toHaveLength(2)
    expect(src).toContain("ipcMain.handle('cli-install', () => cliInstall())")
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

// The §3 win32 updater double: electron-updater is required lazily by
// main.cjs, so the stub `require` hands it this fake NsisUpdater — the same
// "patch the layer underneath, run the real handler" rule as the electron
// stub itself. Canned answers live on the record so a test can arm them
// before the handler ever constructs the updater.
interface NsisRecord {
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

interface MainStub {
  invoke: (channel: string, ...args: unknown[]) => unknown
  // Fire an app-level event main.cjs subscribed to (window-all-closed, …).
  emit: (event: string) => void
  opened: string[]
  revealed: string[]
  windows: unknown[]
  trays: unknown[]
  loginItem: boolean[]
  aumids: string[]
  sent: [string, unknown][]
  nsis: NsisRecord
  quits: number
  home: string
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
  let quits = 0
  const home = mkdtempSync(join(tmpdir(), 'aw-main-'))
  process.env.AUTOWRIGHT_HOME = home

  const nsis: NsisRecord = {
    options: null, autoDownload: null, autoInstallOnAppQuit: null,
    checks: 0, downloads: 0, installs: 0,
    check: { updateInfo: { version: '9.9.9' } },
    checkError: null, downloadError: null, listeners: new Map(),
  }

  class FakeNsisUpdater {
    autoDownload = true
    autoInstallOnAppQuit = true
    logger: unknown = null

    constructor(options: { provider?: string, url?: string }) { nsis.options = options }
    on(event: string, fn: (arg: unknown) => void) { nsis.listeners.set(event, fn) }

    async checkForUpdates() {
      // Read the flags as the handler left them: an autoDownload that is
      // still true would mean a check downloads (§3 forbids it).
      nsis.autoDownload = this.autoDownload
      nsis.autoInstallOnAppQuit = this.autoInstallOnAppQuit
      nsis.checks += 1
      if (nsis.checkError) throw nsis.checkError
      return nsis.check
    }

    async downloadUpdate() {
      nsis.downloads += 1
      if (nsis.downloadError) throw nsis.downloadError
      return ['installer.exe']
    }

    quitAndInstall() { nsis.installs += 1 }
  }

  class FakeWindow {
    webContents = {
      on() {}, once() {}, send(channel: string, payload: unknown) { sent.push([channel, payload]) },
      setWindowOpenHandler() {},
      isLoading: () => false, getURL: () => '',
    }

    constructor(opts: unknown) { windows.push(opts) }
    loadFile() {} loadURL() {} on() {} show() {} focus() {} hide() {}
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
    dialog: {},
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
      if (id === 'electron-updater') return { NsisUpdater: FakeNsisUpdater }
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
    opened, revealed, windows, trays, loginItem, aumids, sent, nsis, home,
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

// ---- §9 capability wiring + the per-OS close rule --------------------------
// main.cjs asks its own platform module (`plat.capabilities`) before wiring the
// tray, the login item, the dock icon and the update machinery — so these run
// against whichever module this OS selects, and assert the capability's rule
// rather than one platform's answer.

const platMod = realRequire(join(PLATFORM_DIR, 'index.cjs')) as {
  capabilities: { trayPanel: boolean, loginItem: boolean, dockIcon: boolean, updates: boolean }
  UPDATER: string | null
}
const caps = platMod.capabilities
// §3: which update machinery this host's module drives — `squirrel` (the mac
// loopback-proxy flow) or `nsis` (electron-updater). The tests below assert
// the rule for whichever one this platform declares.
const USE_NSIS = caps.updates && platMod.UPDATER === 'nsis'

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
      // "Couldn't reach autowright.ai" network copy.
      expect(await m.invoke('update-check')).toEqual({
        state: 'error', error: 'Updates are not supported on this platform yet.',
      })
      return
    }
    if (USE_NSIS) {
      // With a feed, a failed read stays a bare error state — no detail, so
      // the generic network copy still stands (same shape as darwin's).
      m.nsis.checkError = new Error('offline in tests')
      expect(await m.invoke('update-check')).toEqual({ state: 'error' })
      return
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline in tests'))
    try {
      expect(await m.invoke('update-check')).toEqual({ state: 'error' })
    } finally {
      fetchSpy.mockRestore()
    }
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

// ---- §3 win32 updates (electron-updater / NsisUpdater) ---------------------
// The whole block runs only where the platform module names `nsis`; the real
// handlers run against the fake NsisUpdater the stub `require` supplies, so
// nothing here touches the network.

describe.skipIf(!USE_NSIS)('main.cjs win32 updater (§3)', () => {
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AUTOWRIGHT_HOME
    else process.env.AUTOWRIGHT_HOME = savedHome
  })

  it('is not constructed at module load — nothing checks until it is asked', async () => {
    const m = loadMain()
    expect(m.nsis.options).toBeNull()
    expect(m.nsis.checks).toBe(0)
    await m.invoke('update-check')
    // …and only then, against the §2 module's generic-provider feed.
    expect(m.nsis.options).toEqual({
      provider: 'generic', url: 'https://autowright.ai/updates/win32-x86_64/',
    })
    expect(m.nsis.checks).toBe(1)
  })

  it('a check only reads the feed: autoDownload and install-on-quit are off (§3)', async () => {
    const m = loadMain()
    await m.invoke('update-check')
    expect(m.nsis.autoDownload).toBe(false)
    expect(m.nsis.autoInstallOnAppQuit).toBe(false)
    expect(m.nsis.downloads).toBe(0)
    expect(m.nsis.installs).toBe(0)
  })

  it('maps the feed onto the same {state} shape and §9.4 compare rule', async () => {
    const m = loadMain() // the stub app reports version 0.0.0
    m.nsis.check = { updateInfo: { version: '9.9.9' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'available', version: '9.9.9' })
    // …and the remembered version reached the renderer (§3 update-available).
    expect(m.sent).toEqual([])  // no window yet — recorded, not lost
    expect(await m.invoke('update-available')).toBe('9.9.9')

    m.nsis.check = { updateInfo: { version: '0.0.0' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'uptodate' })
    expect(await m.invoke('update-available')).toBeNull()

    // Malformed counts as not newer, exactly like the mac feed compare.
    m.nsis.check = { updateInfo: { version: 'not-a-version' } }
    expect(await m.invoke('update-check')).toEqual({ state: 'uptodate' })

    m.nsis.checkError = new Error('ENOTFOUND autowright.ai')
    expect(await m.invoke('update-check')).toEqual({ state: 'error' })
  })

  it('update-download drives determinate progress over the update-progress IPC', async () => {
    const m = loadMain()
    m.invoke('open-app', '/app') // a window to receive the events
    const result = await m.invoke('update-download')
    expect(result).toEqual({ ok: true })
    expect(m.nsis.downloads).toBe(1)

    // The handler subscribed to electron-updater's own progress events and
    // forwards percent — null when the download reports no total to divide by
    // (the §9.4 bar goes indeterminate).
    const onProgress = m.nsis.listeners.get('download-progress')
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
    m.nsis.downloadError = new Error('net::ERR_CONNECTION_RESET')
    expect(await m.invoke('update-download')).toEqual({ error: 'net::ERR_CONNECTION_RESET' })

    // Nothing newer in the feed: refuse rather than arm an install of nothing.
    const m2 = loadMain()
    m2.nsis.check = { updateInfo: { version: '0.0.0' } }
    expect(await m2.invoke('update-download')).toEqual({ error: 'no update available' })
    expect(m2.nsis.downloads).toBe(0)
  })

  it('update-install quits to install, behind the live-execution gate (§3)', async () => {
    const m = loadMain()
    expect(await m.invoke('update-install')).toEqual({ ok: true })
    expect(m.nsis.installs).toBe(1)
    // The gate itself is one shared code path for both platforms: the busy
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
      // no-updates line; with one (win32) they run the real update path.
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
