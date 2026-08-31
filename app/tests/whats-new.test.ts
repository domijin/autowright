// §9.4 post-update auto-open, driven from store.boot(): the renderer keeps the
// last version it ran under the localStorage key ad-last-seen-version (§15) and
// compares it with the version the boot snapshot reports. A differing value
// opens the What's-new modal; an equal one does nothing; a missing one is an
// upgrade from a pre-changelog version when ad-onboarded is set and a fresh
// install when it is not. The key is written in every branch except the §13
// menu-bar panel, which is exempt from the check entirely.
//
// The check is one-shot per launch through a module-level guard, so every
// scenario re-imports the store through vi.resetModules() to get a fresh
// "launch".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateSnapshot } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => true),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('unset'))),
  },
}))

// This happy-dom/node combo exposes no working localStorage global; the check
// reads/writes the ad-last-seen-version key there, so stub a minimal one.
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

const snapshot = (version: string): StateSnapshot => ({
  version, automations: [], executions: [], executionsTotal: 0, agents: [], secrets: [],
  pendingDraft: null, draftJobs: [],
  settings: {
    login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
    notifications: 'attention', days: 30, keepForever: false, developerMode: false,
    cliEnabled: false, dataPath: '/tmp', dataSize: '0 B',
  },
})

// One fresh renderer "launch": reset the module registry (new one-shot guard),
// stub the preload bridge, boot against a snapshot reporting the given version.
// The hash is the window identity — '#menubar' is the §13 panel.
async function launch(version: string, hash = '#/app') {
  vi.resetModules()
  location.hash = hash
  ;(window as unknown as Record<string, unknown>).autowright = {
    trayAlert: () => Promise.resolve(),
  }
  const store = await import('../src/store')
  const apiMod = await import('../src/api')
  vi.mocked(apiMod.connectInfo).mockResolvedValue(true)
  vi.mocked(apiMod.api.state).mockResolvedValue(snapshot(version))
  await store.useStore.getState().boot()
  return store
}

beforeEach(() => { localStorage.clear() })

describe('§9.4 post-update auto-open (via boot)', () => {
  it('a stored version differing from the booted one opens the modal and rewrites the key', async () => {
    localStorage.setItem('ad-last-seen-version', '0.7.0')
    const store = await launch('0.8.0')
    expect(store.useStore.getState().whatsNewOpen).toBe(true)
    expect(localStorage.getItem('ad-last-seen-version')).toBe('0.8.0')
  })

  it('a stored version equal to the booted one shows nothing', async () => {
    localStorage.setItem('ad-last-seen-version', '0.8.0')
    const store = await launch('0.8.0')
    expect(store.useStore.getState().whatsNewOpen).toBe(false)
    expect(localStorage.getItem('ad-last-seen-version')).toBe('0.8.0')
  })

  it('no stored version with ad-onboarded set is an upgrade — opens and writes', async () => {
    localStorage.setItem('ad-onboarded', '1')
    const store = await launch('0.8.0')
    expect(store.useStore.getState().whatsNewOpen).toBe(true)
    expect(localStorage.getItem('ad-last-seen-version')).toBe('0.8.0')
  })

  it('no stored version and no ad-onboarded is a fresh install — writes silently', async () => {
    const store = await launch('0.8.0')
    // Onboarding owns the first launch; a fresh install has no "what's new".
    expect(store.useStore.getState().whatsNewOpen).toBe(false)
    expect(localStorage.getItem('ad-last-seen-version')).toBe('0.8.0')
  })

  it('§13: the menu-bar panel neither opens the modal nor spends the key', async () => {
    localStorage.setItem('ad-onboarded', '1')
    const store = await launch('0.8.0', '#menubar')
    expect(store.useStore.getState().whatsNewOpen).toBe(false)
    // Writing it here would cost the main window its one showing.
    expect(localStorage.getItem('ad-last-seen-version')).toBeNull()
  })

  it('one check per launch: a second boot in the same renderer run never re-opens', async () => {
    localStorage.setItem('ad-last-seen-version', '0.7.0')
    const store = await launch('0.8.0')
    store.useStore.setState({ whatsNewOpen: false })   // as if the user closed it
    await store.useStore.getState().boot()             // backend restart, same launch
    expect(store.useStore.getState().whatsNewOpen).toBe(false)
  })
})
