// §3 one-shot first-run CLI install, driven from store.boot(): with cliEnabled
// on (default true) and the ad-cli-installed marker (§15) unset, a `missing`
// shim is installed silently once. Every already-settled disk state
// (installed/foreign) sets the marker without touching disk; a failed
// install leaves the marker unset so the next launch retries — and never
// patches cliEnabled off. Once the marker is set the app never creates the
// shim on its own again (hand-deletion sticks).
//
// The one-shot guard is module-level, so every scenario re-imports the store
// through vi.resetModules() to get a fresh "launch".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateSnapshot } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => true),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('unset'))),
    patchSettings: vi.fn(() => Promise.resolve({})),
  },
}))

// This happy-dom/node combo exposes no working localStorage global; the
// one-shot reads/writes the ad-cli-installed marker there, so stub a minimal one.
const ls = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => { ls.set(k, String(v)) },
    removeItem: (k: string) => { ls.delete(k) },
    clear: () => { ls.clear() },
  },
})

type Cli = { state: 'installed' | 'missing' | 'foreign'; path: string; onPath: boolean }
const USER = '/Users/me/.local/bin/autowright'
const cli = (state: Cli['state']): Cli => ({ state, path: USER, onPath: true })

const cliStatus = vi.fn<() => Promise<Cli>>()
const cliInstall = vi.fn<() => Promise<{ ok: boolean }>>()

const snapshot = (cliEnabled: boolean): StateSnapshot => ({
  version: '0.0.0', automations: [], executions: [], agents: [], secrets: [],
  pendingDraft: null, draftJobs: [],
  settings: {
    login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
    notifications: 'attention', days: 30, keepForever: false, developerMode: false,
    cliEnabled, dataPath: '/tmp', dataSize: '0 B',
  },
})

// One fresh renderer "launch": reset the module registry (new one-shot guard),
// stub the preload bridge, boot against a snapshot with the given cliEnabled.
async function launch(cliEnabled: boolean) {
  vi.resetModules()
  ;(window as unknown as Record<string, unknown>).autowright = {
    cliStatus, cliInstall, trayAlert: () => Promise.resolve(),
  }
  const store = await import('../src/store')
  const apiMod = await import('../src/api')
  vi.mocked(apiMod.connectInfo).mockResolvedValue(true)
  vi.mocked(apiMod.api.state).mockResolvedValue(snapshot(cliEnabled))
  await store.useStore.getState().boot()
  return store
}

beforeEach(() => {
  cliStatus.mockReset()
  cliInstall.mockReset()
  localStorage.clear()
})

describe('one-shot first-run CLI install (§3, via boot)', () => {
  it('enabled + missing + no marker: installs silently and sets the marker', async () => {
    cliStatus.mockResolvedValue(cli('missing'))
    cliInstall.mockResolvedValue({ ok: true })
    await launch(true)
    await vi.waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem('ad-cli-installed')).toBe('1'))
  })

  it('cliEnabled off: never even reads cli-status', async () => {
    await launch(false)
    expect(cliStatus).not.toHaveBeenCalled()
    expect(cliInstall).not.toHaveBeenCalled()
    expect(localStorage.getItem('ad-cli-installed')).toBeNull()
  })

  it('marker already set: no status read, no install — hand-deletion sticks', async () => {
    localStorage.setItem('ad-cli-installed', '1')
    cliStatus.mockResolvedValue(cli('missing'))
    await launch(true)
    expect(cliStatus).not.toHaveBeenCalled()
    expect(cliInstall).not.toHaveBeenCalled()
  })

  it.each(['installed', 'foreign'] as const)(
    'already-settled state %s: marker set, disk untouched', async (state) => {
      cliStatus.mockResolvedValue(cli(state))
      await launch(true)
      await vi.waitFor(() => expect(localStorage.getItem('ad-cli-installed')).toBe('1'))
      expect(cliInstall).not.toHaveBeenCalled()
    })

  it('failed install: marker stays unset (next launch retries), setting never patched off', async () => {
    cliStatus.mockResolvedValue(cli('missing'))
    cliInstall.mockResolvedValue({ ok: false })
    const store = await launch(true)
    await vi.waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('ad-cli-installed')).toBeNull()
    const apiMod = await import('../src/api')
    expect(vi.mocked(apiMod.api.patchSettings)).not.toHaveBeenCalled()
    expect(store.useStore.getState().settings?.cliEnabled).toBe(true)

    // The retry happens at the NEXT launch, not later in this one: a second
    // boot in the same renderer run (backend restart) does not re-fire.
    cliInstall.mockClear()
    await store.useStore.getState().boot()
    expect(cliInstall).not.toHaveBeenCalled()

    // Fresh launch (new module registry) retries and settles.
    cliInstall.mockReset()
    cliInstall.mockResolvedValue({ ok: true })
    await launch(true)
    await vi.waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem('ad-cli-installed')).toBe('1'))
  })

  it('no preload bridge (plain browser): no-op, marker untouched', async () => {
    vi.resetModules()
    delete (window as unknown as Record<string, unknown>).autowright
    const store = await import('../src/store')
    const apiMod = await import('../src/api')
    vi.mocked(apiMod.connectInfo).mockResolvedValue(true)
    vi.mocked(apiMod.api.state).mockResolvedValue(snapshot(true))
    await store.useStore.getState().boot()
    expect(localStorage.getItem('ad-cli-installed')).toBeNull()
  })
})
