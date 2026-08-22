// §2 platform layer (shell half): the per-OS values main.cjs consumes but
// can't be asked for on this machine — window chrome (§9), panel placement
// (§13), tray assets (§13) and the ensure-backend failure copy (§9). The
// modules never import `electron`, so every one of them loads on any OS and
// each platform's shape is pinned here regardless of where the suite runs.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(__filename)
const ELECTRON_DIR = join(__dirname, '..', 'electron')
const darwin = require('../electron/platform/darwin.cjs')
const win32 = require('../electron/platform/win32.cjs')

// A 1920×1080 display with a 48 px taskbar docked at the bottom.
const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
}

describe('§9 window chrome is per-OS', () => {
  it('Windows: hidden title bar + a native titleBarOverlay, no mac-only options', () => {
    const chrome = win32.mainWindowChrome()
    expect(chrome).toEqual({
      titleBarStyle: 'hidden',
      // color = --bg-content (the pane under the overlay), symbolColor = the
      // §14 --text-2 hex, height = the content drag strip.
      titleBarOverlay: { color: '#0d1118', symbolColor: '#c8ccd4', height: 40 },
    })
    // trafficLightPosition is a macOS-only option and must never leak in.
    expect(chrome).not.toHaveProperty('trafficLightPosition')
  })

  it('macOS keeps its pinned traffic lights and no overlay', () => {
    const chrome = darwin.mainWindowChrome()
    expect(chrome).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 14 },
    })
  })
})

describe('§13 panel placement is per-OS', () => {
  it('Windows hugs the work area bottom at the panel\'s real height', () => {
    // 420 px panel: bottom edge 6 px above the taskbar, never at the 640 cap.
    expect(win32.panelPosition({ x: 900, y: 1050 }, DISPLAY, 420))
      .toEqual({ x: 733, y: 1032 - 420 - 6 })
    // It re-anchors as the panel grows — the bottom edge stays put.
    expect(win32.panelPosition({ x: 900, y: 1050 }, DISPLAY, 560))
      .toEqual({ x: 733, y: 1032 - 560 - 6 })
    // No measurement yet: the 640 px window cap stands in.
    expect(win32.panelPosition({ x: 900, y: 1050 }, DISPLAY))
      .toEqual(win32.panelPosition({ x: 900, y: 1050 }, DISPLAY, 640))
    // A panel taller than the work area is clamped on screen, not pushed off.
    expect(win32.panelPosition({ x: 900, y: 1050 }, DISPLAY, 5000).y)
      .toBe(DISPLAY.workArea.y + 6)
  })

  it('macOS anchors under the menu bar, height-independent', () => {
    const top = { x: 733, y: 6 }
    expect(darwin.panelPosition({ x: 900, y: 10 }, DISPLAY)).toEqual(top)
    expect(darwin.panelPosition({ x: 900, y: 10 }, DISPLAY, 420)).toEqual(top)
    expect(darwin.panelPosition({ x: 900, y: 10 }, DISPLAY, 640)).toEqual(top)
  })
})

describe('§13 tray assets are per-OS', () => {
  it('Windows uses the checked-in colored PNGs, never the mac template images', () => {
    expect(win32.trayIconSpec(false)).toEqual({ file: 'trayWin.png', template: false })
    expect(win32.trayIconSpec(true)).toEqual({ file: 'trayWinAlert.png', template: false })
    for (const name of ['trayWin', 'trayWinAlert']) {
      expect(existsSync(join(ELECTRON_DIR, `${name}.png`))).toBe(true)
      expect(existsSync(join(ELECTRON_DIR, `${name}@2x.png`))).toBe(true)
    }
  })

  it('macOS keeps the template image for the normal state', () => {
    expect(darwin.trayIconSpec(false)).toEqual({ file: 'trayTemplate.png', template: true })
    expect(darwin.trayIconSpec(true)).toEqual({ file: 'trayAlert.png', template: false })
  })
})

describe('§9 ensure-backend failure copy is per-OS', () => {
  it('macOS names Gatekeeper; Windows says plainly that the service failed to start', () => {
    expect(darwin.SERVICE_START_FAILED_DETAIL)
      .toBe('The backend service was registered but never started — macOS '
        + 'Gatekeeper may be blocking an unsigned build. Details in app.log.')
    expect(win32.SERVICE_START_FAILED_DETAIL)
      .toBe('The backend service failed to start. Details in app.log.')
    expect(win32.SERVICE_START_FAILED_DETAIL).not.toContain('Gatekeeper')
  })

  it('every platform module answers the whole shell surface', () => {
    // A missing export is a silent `undefined` in main.cjs, so the modules are
    // pinned to one another's shape.
    const fallback = require('../electron/platform/fallback.cjs')
    const keys = Object.keys(darwin).sort()
    expect(Object.keys(win32).sort()).toEqual(keys)
    expect(Object.keys(fallback).sort()).toEqual(keys)
  })
})

describe('§9 capability flags', () => {
  it('macOS declares every shell surface; Windows has everything but a dock', () => {
    expect(darwin.capabilities)
      .toEqual({ trayPanel: true, loginItem: true, dockIcon: true, updates: true })
    expect(win32.capabilities)
      .toEqual({ trayPanel: true, loginItem: true, dockIcon: false, updates: true })
  })

  it('every module\'s updates flag and updateFeedUrl agree', () => {
    // The two must not drift apart: a feed URL nobody is allowed to fetch, or
    // a declared capability with no feed behind it, are both dead ends.
    const fallback = require('../electron/platform/fallback.cjs')
    for (const mod of [darwin, win32, fallback]) {
      expect(mod.capabilities.updates).toBe(mod.updateFeedUrl('x64') !== null)
    }
  })
})

describe('§3 update machinery is per-OS', () => {
  it('Windows serves the generic-provider feed directory and names NsisUpdater', () => {
    // §3: latest.yml + installer + blockmap live under this directory — the
    // generic provider takes the base URL, never a single file. x86_64 is the
    // only Windows arch that ships, so the answer carries no arch switch.
    const url = 'https://autowright.ai/updates/win32-x86_64/'
    expect(win32.updateFeedUrl('x64')).toBe(url)
    expect(win32.updateFeedUrl('arm64')).toBe(url)
    expect(url.endsWith('/')).toBe(true)
    expect(win32.UPDATER).toBe('nsis')
  })

  it('macOS keeps the per-arch Squirrel.Mac JSON feed', () => {
    expect(darwin.updateFeedUrl('x64')).toBe('https://autowright.ai/updates/darwin-x86_64.json')
    expect(darwin.updateFeedUrl('arm64')).toBe('https://autowright.ai/updates/darwin-arm64.json')
    expect(darwin.UPDATER).toBe('squirrel')
  })

  it('a platform with no feed names no machinery either', () => {
    const fallback = require('../electron/platform/fallback.cjs')
    expect(fallback.UPDATER).toBeNull()
  })

  it('the §3 publisherName footgun is set nowhere', () => {
    // Setting it before a certificate exists makes every update fail against
    // the unsigned artifacts electron-updater would then try to verify.
    // The name may be *mentioned* (the rule is written down where it bites);
    // what must not exist is a key or assignment that sets it.
    const pkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
    const mainSrc = readFileSync(join(ELECTRON_DIR, 'main.cjs'), 'utf-8')
    for (const src of [pkg, mainSrc, readFileSync(join(ELECTRON_DIR, 'platform', 'win32.cjs'), 'utf-8')]) {
      expect(src).not.toMatch(/["']?publisherName["']?\s*[:=]/)
    }
  })
})

describe('§3 uninstall machinery is per-OS', () => {
  it('each module names its uninstall finish, the way UPDATER names updates', () => {
    // §3: the marker main.cjs discriminates on — the modules stay
    // electron-free, so they name the machinery rather than construct it.
    expect(darwin.UNINSTALL).toBe('trash')
    expect(win32.UNINSTALL).toBe('nsis')
  })

  it('a platform with no finish names none — the §4.9 card hides there', () => {
    const fallback = require('../electron/platform/fallback.cjs')
    expect(fallback.UNINSTALL).toBeNull()
  })
})

describe('§3 Windows packaging config (electron-builder)', () => {
  const build = (require('../package.json') as { build: unknown }).build as {
    appId: string
    productName: string
    artifactName: string
    directories: { output: string }
    publish: { provider: string, url: string }[]
    files: string[]
    extraResources: { from: string, to: string }[]
    win: { target: { target: string, arch: string[] }[], icon: string }
    nsis: Record<string, unknown>
  }

  it('is Windows-target-only, so the mac pipeline never sees it', () => {
    // prod.sh keeps @electron/packager; nothing here may declare a mac or
    // linux target that a stray `electron-builder` run could act on.
    expect(build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(Object.keys(build)).not.toContain('mac')
    expect(Object.keys(build)).not.toContain('linux')
  })

  it('carries the §3 identifiers, artifact name and generic feed', () => {
    expect(build.appId).toBe('ai.autowright.app')
    expect(build.productName).toBe('Autowright')
    expect(build.artifactName).toBe('Autowright-${version}-win32-x86_64.${ext}')
    // The publish entry is what puts app-update.yml (this URL) in the package,
    // so it must be the same base the §2 win32 module serves.
    expect(build.publish).toEqual([
      { provider: 'generic', url: win32.updateFeedUrl('x64') },
    ])
  })

  it('pins the per-user NSIS shape and the stable GUID', () => {
    // §3: no admin prompt, install dir under %LOCALAPPDATA%\Programs (the
    // per-user one-click default), and a GUID that must NEVER change — an
    // upgrade finds the previous install by it, unsigned→signed included.
    expect(build.nsis.perMachine).toBe(false)
    expect(build.nsis.oneClick).toBe(true)
    expect(build.nsis.guid).toBe('3E71053D-7CAA-4BF9-A643-93ABDA35B1F3')
    // §3 Windows notifier: the AUMID only exists while a Start-menu shortcut
    // carries it, so this flag is load-bearing, not cosmetic.
    expect(build.nsis.createStartMenuShortcut).toBe(true)
    expect(build.nsis.shortcutName).toBe('Autowright')
  })

  it('ships the renderer, the shell and the staged interpreter — and no more', () => {
    expect(build.files).toContain('dist/**/*')
    expect(build.files).toContain('electron/**/*')
    // The renderer's own dependencies are bundled into dist/ by vite, so the
    // heavy ones are excluded from the package (electron-builder still ships
    // electron-updater's runtime closure, which main.cjs requires at runtime).
    for (const dep of ['@fontsource', '@fortawesome', 'react', 'react-dom',
      'react-markdown', 'remark-gfm', 'zustand']) {
      expect(build.files).toContain(`!node_modules/${dep}/**`)
    }
    expect(build.files).not.toContain('!node_modules/electron-updater/**')
    // §3 bundled Python: the staged interpreter lands at resources\python,
    // where the §2 win32 module's bundledPythonPath looks for it.
    expect(build.extraResources).toEqual([{ from: '../build/python', to: 'python' }])
    expect(win32.bundledPythonPath('X:/app/resources').replace(/\\/g, '/'))
      .toBe('X:/app/resources/python/python.exe')
    expect(build.win.icon).toBe('electron/icon/icon.ico')
    expect(existsSync(join(ELECTRON_DIR, 'icon', 'icon.ico'))).toBe(true)
  })
})

describe('§13/§17 the Windows tray assets and their generator agree', () => {
  it('scripts/gen_tray_icon.py renders the four checked-in Windows PNGs', () => {
    const gen = readFileSync(join(__dirname, '..', '..', 'scripts', 'gen_tray_icon.py'), 'utf-8')
    for (const name of ['trayWin.png', 'trayWin@2x.png', 'trayWinAlert.png', 'trayWinAlert@2x.png']) {
      expect(gen).toContain(`"${name}"`)
    }
  })
})
