// §9/§9.5 report bug: the permanent nav row (directly above About, below the
// update row) and the report modal — prefill URL assembly, info-block toggle,
// AI draft gating + job flow. App renders for real (happy-dom) with the api
// module mocked to a connected, onboarded snapshot.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '../src/types'

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false,
  dataPath: '/tmp', dataSize: '0 B',
}

const postReportDraft = vi.fn()
const getReportDraft = vi.fn()
const cancelReportDraft = vi.fn(async () => ({}))

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => true),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(async () => ({
      version: '0.3.0', automations: [], executions: [], agents: [], secrets: [],
      settings: SETTINGS, pendingDraft: null,
    })),
    postReportDraft: (...a: unknown[]) => postReportDraft(...a),
    getReportDraft: (...a: unknown[]) => getReportDraft(...a),
    cancelReportDraft: (...a: unknown[]) => cancelReportDraft(...a),
  },
}))

let storeMod: typeof import('../src/store')
let App: typeof import('../src/App').default

const AGENT = { id: 'a1', name: 'A', description: '', harness: 'Claude Code', mode: 'default', model: null }

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
    applySettings: () => Promise.resolve(),
    updateAvailable: () => Promise.resolve(null),
    onUpdateAvailable: () => {},
    updateCheck: () => Promise.resolve({ state: 'uptodate' }),
    onUpdateProgress: () => {},
    backendStatus: () => Promise.resolve({ state: 'ok', detail: '' }),
    platformInfo: () => Promise.resolve({ platform: 'darwin', release: '15.5', arch: 'arm64' }),
  }
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
})

beforeEach(() => {
  postReportDraft.mockReset()
  getReportDraft.mockReset()
  storeMod.useStore.setState({
    connected: true, surface: 'app', page: 'automations', automations: [],
    executions: [], agents: [], secrets: [], settings: SETTINGS,
    updateAvailable: null, reportOpen: false, version: '0.3.0',
  })
})
afterEach(() => { cleanup(); storeMod.useStore.getState().disconnect() })

const openModal = async () => {
  render(<App />)
  fireEvent.click(await screen.findByTestId('nav-report-bug'))
  return await screen.findByTestId('report-modal')
}
const openHref = () => (screen.getByTestId('report-open') as HTMLAnchorElement).href

describe('report bug nav row (§9)', () => {
  it('always renders, directly above About and below the update row', async () => {
    storeMod.useStore.setState({ updateAvailable: '9.9.9' })
    render(<App />)
    const rail = await screen.findByTestId('nav-rail')
    const rows = Array.from(rail.querySelectorAll('button')).map((b) => b.textContent ?? '')
    const iUpdate = rows.findIndex((t) => t.includes('Update available'))
    const iReport = rows.findIndex((t) => t.includes('Report bug'))
    const iAbout = rows.findIndex((t) => t.includes('About'))
    expect(iUpdate).toBeGreaterThan(-1)
    expect(iReport).toBe(iUpdate + 1)
    expect(iAbout).toBe(iReport + 1)
  })

  it('opens the modal without navigating', async () => {
    await openModal()
    expect(storeMod.useStore.getState().page).toBe('automations')
    expect(storeMod.useStore.getState().reportOpen).toBe(true)
  })
})

describe('report modal (§9.5)', () => {
  it('assembles the prefill URL: bug label, text, environment block', async () => {
    await openModal()
    fireEvent.change(screen.getByPlaceholderText('What did you expect, and what happened instead?'),
      { target: { value: 'it broke' } })
    const href = openHref()
    expect(href).toContain('github.com/hansololz/autowright/issues/new')
    expect(href).toContain('labels=bug')
    const body = new URL(href).searchParams.get('body')!
    expect(body).toContain('### What happened')
    expect(body).toContain('it broke')
    expect(body).toContain('### Environment')
    expect(body).toContain('Autowright v0.3.0')
  })

  it('feature toggle switches the label; info toggle drops the environment', async () => {
    await openModal()
    fireEvent.click(screen.getByText('Feature request'))
    expect(openHref()).toContain('labels=enhancement')
    fireEvent.click(screen.getByTitle('Include app info'))
    expect(new URL(openHref()).searchParams.get('body')).not.toContain('### Environment')
  })

  it('Draft with AI is disabled with zero agents', async () => {
    await openModal()
    expect((screen.getByTestId('report-draft') as HTMLButtonElement).disabled).toBe(true)
  })

  it('drafts via the job endpoints and lands editable fields', async () => {
    postReportDraft.mockResolvedValueOnce({ jobId: 'j1' })
    getReportDraft.mockResolvedValue({
      status: 'done', draft: { title: 'Drafted title here', body: 'Drafted body here' }, error: null,
    })
    await openModal()
    // after boot()'s /state snapshot lands (agents: []) — set the agent now so
    // the refresh can't clobber it
    storeMod.useStore.setState({ agents: [AGENT] as never })
    await waitFor(() =>
      expect((screen.getByTestId('report-draft') as HTMLButtonElement).disabled).toBe(false))
    const btn = screen.getByTestId('report-draft') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(postReportDraft).toHaveBeenCalled())
    expect(postReportDraft.mock.calls[0][0].kind).toBe('bug')
    expect(postReportDraft.mock.calls[0][0].info).toContain('Autowright v0.3.0')
    // §19 poll (1 s interval) lands the draft as editable fields
    expect(await screen.findByDisplayValue('Drafted title here', {}, { timeout: 3000 })).toBeTruthy()
    const href = openHref()
    expect(new URL(href).searchParams.get('title')).toBe('Drafted title here')
    expect(new URL(href).searchParams.get('body')).toBe('Drafted body here')
  })
})
