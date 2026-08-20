// Component tests for §9.1 needs-fixing surfaces: the amber Needs fixing card
// chip (tooltip lists every §4.1 problem label), and the §5.1 os-mismatch note
// on the import preview and summary modals. AutomationsList renders for real
// (happy-dom) with the store seeded and the api module mocked.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Automation, ImportPreview, ImportSummary } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    triggersPreview: vi.fn(async () => ({ triggers: [] })),
    importFromUrl: vi.fn(() => Promise.reject(new Error('offline'))),
    importConfirm: vi.fn(() => Promise.reject(new Error('offline'))),
  },
}))

let storeMod: typeof import('../src/store')
let mockedApi: Record<string, ReturnType<typeof vi.fn>>
let AutomationsList: typeof import('../src/pages/AutomationsList').default

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  mockedApi = (await import('../src/api')).api as unknown as Record<string, ReturnType<typeof vi.fn>>
  AutomationsList = (await import('../src/pages/AutomationsList')).default
})

const auto = (over: Partial<Automation> = {}): Automation => ({
  id: 'a1', name: 'Job', description: '', version: 1, triggers: [], triggerChip: 'No triggers',
  triggersOff: false, nextAt: null, instructions: '', notes: '', lastStatus: 'succeeded',
  live: [], maxParallel: 1, maxQueued: 0, resultChip: null, resultStatus: null,
  lastExecutionLabel: '', agentId: null, stepAgents: [], allowedSecrets: [], problems: [],
  snapshotSettings: { preVersion: true, preClear: true, preRestore: true }, specMeta: '',
  ...over,
})

const seed = (autos: Automation[]) =>
  storeMod.useStore.setState({ page: 'automations', automations: autos, draftJobs: [], pendingDraft: null })

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  name: 'Shared job', landsAs: 'Shared job', description: '', steps: [], params: [],
  triggers: [], packages: [], agents: [], secrets: [], os: 'macos', osMismatch: false,
  ...over,
})

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  secretsCreated: [], secretsExisting: [], agentsCreated: [], agentsReused: [],
  packages: [], renamedFrom: null, os: 'macos', osMismatch: false,
  ...over,
})

describe('§9.1 Needs fixing chip', () => {
  it('shows with a tooltip listing every problem label', () => {
    seed([auto({ problems: [
      { kind: 'secret-unset', label: 'Secret API_KEY has no value yet — add it on the Secrets page.' },
      { kind: 'os-mismatch', label: 'Built on Windows — its steps may need rewriting before they run on this Mac.' },
    ] })])
    render(<AutomationsList />)
    const chip = screen.getByText('Needs fixing')
    expect(chip.getAttribute('title')).toBe(
      'Secret API_KEY has no value yet — add it on the Secrets page.\n'
      + 'Built on Windows — its steps may need rewriting before they run on this Mac.')
  })

  it('is absent when the problems list is empty', () => {
    seed([auto()])
    render(<AutomationsList />)
    expect(screen.queryByText('Needs fixing')).toBeNull()
  })
})

describe('§5.1/§9.1 import os-mismatch notes', () => {
  it('preview and summary both carry the Built-on warning', async () => {
    mockedApi.importFromUrl.mockResolvedValueOnce({
      token: 't1', preview: preview({ os: 'windows', osMismatch: true }),
    })
    mockedApi.importConfirm.mockResolvedValueOnce({
      automation: { id: 'a-new', name: 'Shared job' },
      summary: summary({ os: 'windows', osMismatch: true }),
    })
    seed([])
    render(<AutomationsList />)
    fireEvent.click(screen.getByText('Import'))
    const urlInput = screen.getByPlaceholderText('https://github.com/… or a direct .autowright link')
    fireEvent.change(urlInput, { target: { value: 'https://x.test/a.autowright' } })
    fireEvent.keyDown(urlInput, { key: 'Enter' })
    // preview step: the amber note leads the footer note block
    await waitFor(() => expect(screen.getByText(
      'Built on Windows — its steps may need rewriting before they run on this Mac.')).toBeTruthy())
    // confirm → summary modal repeats the warning
    const importBtns = screen.getAllByText('Import')
    fireEvent.click(importBtns[importBtns.length - 1])
    await waitFor(() => expect(screen.getByText('Imported “Shared job”')).toBeTruthy())
    expect(screen.getByText(
      'Built on Windows — its steps may need rewriting before they run on this Mac.')).toBeTruthy()
  })

  it('a same-platform preview shows no warning', async () => {
    mockedApi.importFromUrl.mockResolvedValueOnce({ token: 't1', preview: preview() })
    seed([])
    render(<AutomationsList />)
    fireEvent.click(screen.getByText('Import'))
    const urlInput = screen.getByPlaceholderText('https://github.com/… or a direct .autowright link')
    fireEvent.change(urlInput, { target: { value: 'https://x.test/a.autowright' } })
    fireEvent.keyDown(urlInput, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/triggers arrive off/)).toBeTruthy())
    expect(screen.queryByText(/Built on/)).toBeNull()
  })
})
