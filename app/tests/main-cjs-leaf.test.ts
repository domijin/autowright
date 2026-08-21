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
import { afterEach, describe, expect, it } from 'vitest'

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

  it('quit-all stops the backend via -m autowright.service stop', () => {
    expect(src).toContain("'-m', 'autowright.service', 'stop'")
  })

  it('never executes the CLI — autowright.cli appears only inside the shim file text', () => {
    // main.cjs itself never mentions the CLI; the platform modules mention it
    // exactly once each, as the shim file's contents (an exec line in
    // shimText) — never a child-process invocation by the app.
    expect(src).not.toContain('autowright.cli')
    const lines = union.split('\n').filter((l) => l.includes('autowright.cli'))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const line of lines) {
      expect(line).toContain('exec "${python}" -m autowright.cli')
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

interface MainStub {
  invoke: (channel: string, ...args: unknown[]) => unknown
  opened: string[]
  revealed: string[]
  windows: unknown[]
  home: string
}

const realRequire = createRequire(join(ELECTRON_DIR, 'main.cjs'))
const savedHome = process.env.AUTOWRIGHT_HOME

function loadMain(): MainStub {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
  const opened: string[] = []
  const revealed: string[] = []
  const windows: unknown[] = []
  const home = mkdtempSync(join(tmpdir(), 'aw-main-'))
  process.env.AUTOWRIGHT_HOME = home

  class FakeWindow {
    webContents = {
      on() {}, once() {}, send() {}, setWindowOpenHandler() {},
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
      on() {}, isReady: () => false, quit() {},
      whenReady: () => new Promise(() => {}),
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings() {},
      dock: { setIcon() {} },
    },
    autoUpdater: { on() {}, removeListener() {}, setFeedURL() {}, checkForUpdates() {}, quitAndInstall() {} },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    Tray: class { setToolTip() {} on() {} setImage() {} destroy() {} },
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
    (id: string) => (id === 'electron' ? electron : realRequire(id)),
    { exports: {} }, {}, ELECTRON_DIR, join(ELECTRON_DIR, 'main.cjs'),
  )

  return {
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return fn({}, ...args)
    },
    opened, revealed, windows, home,
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
    expect(await m.invoke('update-brew-managed')).toBe(true)
    // Fresh probe, not a cached launch-time answer: the same loaded main flips
    // with the dir (a brew install/uninstall while the app runs).
    process.env.AUTOWRIGHT_CASKROOM = join(m.home, 'not-there')
    expect(await m.invoke('update-brew-managed')).toBe(false)
  })

  it('update-download and update-install refuse on a brew-managed copy', async () => {
    const m = loadMain()
    process.env.AUTOWRIGHT_CASKROOM = m.home
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
