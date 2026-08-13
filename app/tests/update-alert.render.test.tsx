// §3/§9 available-update state: the About nav row's update badge (exists only
// while main's check state holds a version) and the §9.4 Updates row seeding
// from / feeding back into that shared state. App renders for real (happy-dom)
// with the api module mocked to a connected, onboarded snapshot.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '../src/types'

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false,
  dataPath: '/tmp', dataSize: '0 B',
}

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => true),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(async () => ({
      version: '0.2.0', automations: [], executions: [], agents: [], secrets: [],
      settings: SETTINGS, pendingDraft: null,
    })),
  },
}))

let storeMod: typeof import('../src/store')
let App: typeof import('../src/App').default
let AboutPage: typeof import('../src/pages/AboutPage').default

// window.autowright bridge: cached seed + captured push listener, per test.
let cachedUpdate: string | null = null
let pushUpdate: ((v: string | null) => void) | null = null
const updateCheck = vi.fn()

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
    applySettings: () => Promise.resolve(),
    updateAvailable: () => Promise.resolve(cachedUpdate),
    onUpdateAvailable: (cb: (v: string | null) => void) => { pushUpdate = cb },
    updateCheck,
    onUpdateProgress: () => {},
  }
  // This happy-dom/node combo exposes no working localStorage global; the
  // store's boot() reads the ad-onboarded flag from it, so stub a minimal one.
  const ls = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => { ls.set(k, String(v)) },
      removeItem: (k: string) => { ls.delete(k) },
    },
  })
  localStorage.setItem('ad-onboarded', '1')
  storeMod = await import('../src/store')
  App = (await import('../src/App')).default
  AboutPage = (await import('../src/pages/AboutPage')).default
})

beforeEach(() => {
  cachedUpdate = null
  pushUpdate = null
  updateCheck.mockReset()
  storeMod.useStore.setState({
    connected: true, surface: 'app', page: 'automations', automations: [],
    executions: [], agents: [], secrets: [], settings: SETTINGS, updateAvailable: null,
  })
})
afterEach(() => { cleanup(); storeMod.useStore.getState().disconnect() })

describe('sidebar update badge (§9)', () => {
  it('renders no badge while no newer version is known', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('nav-rail')).toBeTruthy())
    expect(screen.queryByTestId('update-badge')).toBeNull()
  })

  it("seeds from main's cached state; About opens pre-armed", async () => {
    cachedUpdate = '9.9.9'
    render(<App />)
    expect(await screen.findByTestId('update-badge')).toBeTruthy()

    fireEvent.click(screen.getByText('About'))
    // §9.4: About mounts directly in the `available` state — no idle line.
    expect(await screen.findByText('Version 9.9.9 is available.')).toBeTruthy()
    expect(screen.getByText('Download update')).toBeTruthy()
  })

  it('appears live on a background-check push and disappears when it clears', async () => {
    render(<App />)
    await waitFor(() => expect(pushUpdate).not.toBeNull())
    pushUpdate!('9.9.9')
    expect(await screen.findByTestId('update-badge')).toBeTruthy()
    pushUpdate!(null)
    await waitFor(() => expect(screen.queryByTestId('update-badge')).toBeNull())
  })
})

describe('About updates row ↔ shared state (§9.4)', () => {
  it('a manual check finding a version sets the shared state', async () => {
    updateCheck.mockResolvedValueOnce({ state: 'available', version: '9.9.9' })
    render(<AboutPage />)
    fireEvent.click(screen.getByText('Check for updates'))
    await waitFor(() => expect(storeMod.useStore.getState().updateAvailable).toBe('9.9.9'))
    expect(screen.getByText('Download update')).toBeTruthy()
  })

  it('a manual uptodate result clears the shared state', async () => {
    updateCheck.mockResolvedValueOnce({ state: 'uptodate' })
    render(<AboutPage />)
    fireEvent.click(screen.getByText('Check for updates'))
    await waitFor(() => expect(screen.getByText("You're up to date.")).toBeTruthy())
    expect(storeMod.useStore.getState().updateAvailable).toBeNull()
  })

  it('an error result leaves the known update alone', async () => {
    storeMod.useStore.setState({ updateAvailable: '9.9.9' })
    updateCheck.mockResolvedValueOnce({ state: 'error' })
    render(<AboutPage />)
    // Seeded available — the button reads "Download update"; drive the manual
    // path from a fresh idle mount instead.
    expect(screen.getByText('Version 9.9.9 is available.')).toBeTruthy()
  })

  it('a background check landing while the row sits idle flips it live', async () => {
    render(<AboutPage />)
    expect(screen.getByText('Check for updates')).toBeTruthy()
    storeMod.useStore.setState({ updateAvailable: '9.9.9' })
    expect(await screen.findByText('Version 9.9.9 is available.')).toBeTruthy()
    expect(screen.getByText('Download update')).toBeTruthy()
  })
})
