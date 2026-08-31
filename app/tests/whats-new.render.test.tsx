// §9.4 What's new: the About page's UPDATES row (sub-line + View button, no
// external release-notes link any more) and the shell-mounted modal it opens —
// the repo-root CHANGELOG.md rendered through the same raw import and first-H1
// strip as the LEGAL doc modals. App renders for real (happy-dom) with the api
// module mocked to a connected, onboarded snapshot.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Settings } from '../src/types'

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false, cliEnabled: false,
  dataPath: '/tmp', dataSize: '0 B',
}

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => true),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(async () => ({
      version: '0.8.2', automations: [], executions: [], agents: [], secrets: [],
      settings: SETTINGS, pendingDraft: null,
    })),
  },
}))

let storeMod: typeof import('../src/store')
let App: typeof import('../src/App').default
let AboutPage: typeof import('../src/pages/AboutPage').default

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
    applySettings: () => Promise.resolve(),
    updateAvailable: () => Promise.resolve(null),
    onUpdateAvailable: () => {},
    updateCheck: () => Promise.resolve({ state: 'uptodate' }),
    updateBrewManaged: () => Promise.resolve(false),
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
  // The §9.4 auto-open is one-shot per launch and would race these renders —
  // seed the key at the booted version so this launch has nothing to show.
  localStorage.setItem('ad-last-seen-version', '0.8.2')
  storeMod = await import('../src/store')
  App = (await import('../src/App')).default
  AboutPage = (await import('../src/pages/AboutPage')).default
})

beforeEach(() => {
  storeMod.useStore.setState({
    connected: true, surface: 'app', page: 'automations', automations: [],
    executions: [], agents: [], secrets: [], settings: SETTINGS,
    updateAvailable: null, whatsNewOpen: false, version: '0.8.2',
  })
})
afterEach(() => { cleanup(); storeMod.useStore.getState().disconnect() })

// The row's View button is the one between the What's-new title and the next
// row's title in DOM order (the LEGAL rows carry View buttons of their own).
const whatsNewViewButton = () =>
  screen.getAllByRole('button', { name: 'View' }).find((b) =>
    screen.getByText('What’s new').compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    && !(screen.getByText('Privacy policy').compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING))

describe('About What’s-new row (§9.4)', () => {
  it('shows the in-app sub-line and no external release-notes link', () => {
    render(<AboutPage />)
    expect(screen.getByText('What changed in each version of Autowright.')).toBeTruthy()
    // The GitHub releases page keeps its auto-generated notes and is not linked.
    expect(screen.queryByText(/Release notes/)).toBeNull()
    const releaseLinks = screen.getAllByRole('link')
      .filter((a) => (a as HTMLAnchorElement).href.includes('/releases'))
    expect(releaseLinks).toEqual([])
  })

  it('View opens the shell-mounted modal through the shared store flag', () => {
    render(<AboutPage />)
    fireEvent.click(whatsNewViewButton()!)
    expect(storeMod.useStore.getState().whatsNewOpen).toBe(true)
  })
})

describe('What’s-new modal (§9.4)', () => {
  const openModal = async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('nav-rail')).toBeTruthy())
    storeMod.useStore.setState({ whatsNewOpen: true })
    return await screen.findByRole('dialog')
  }

  it('renders the repo-root CHANGELOG.md with its H1 stripped', async () => {
    const dialog = await openModal()
    expect(within(dialog).getByRole('heading', { level: 2, name: 'What’s new' })).toBeTruthy()
    // The file's `# Changelog` H1 is stripped — the modal title already says it.
    await waitFor(() => expect(within(dialog).queryByText('Loading…')).toBeNull())
    expect(within(dialog).queryByRole('heading', { level: 1 })).toBeNull()
    expect(within(dialog).queryByText("Couldn't load the document.")).toBeNull()
    // …so the newest version's section heading is the top of the body.
    const [, top] = within(dialog).getAllByRole('heading', { level: 2 })
    expect(top.textContent).toMatch(/^v\d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}$/)
  })

  it('Close clears the shared flag and unmounts the modal', async () => {
    const dialog = await openModal()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    // Modal acts on onClose only after the overlay's exit animation — happy-dom
    // runs no animations, so end it by hand.
    fireEvent.animationEnd(dialog.parentElement!)
    await waitFor(() => expect(storeMod.useStore.getState().whatsNewOpen).toBe(false))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
