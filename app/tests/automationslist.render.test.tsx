// Component tests for §9.1 needs-fixing surfaces: the amber Needs fixing card
// chip (tooltip lists every §4.1 problem label), the Import entry point, and
// the §5.1 match/no-match reporting on the import preview and summary modals
// (badges, the amber no-match note, and the os-mismatch warning).
// AutomationsList renders for real (happy-dom) with the store seeded and the
// api module mocked.
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
  allTriggersOff: false, nextAtMs: null, instructions: '', notes: '', lastStatus: 'succeeded',
  live: [], maxParallel: 1, maxQueued: 0, resultChip: null, resultStatus: null,
  lastExecutionLabel: '', agentId: null, stepAgents: [], allowedSecrets: [], problems: [],
  unresolvedReferences: {},
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
  secretsMatched: [], agentsMatched: [], unresolved: [],
  packages: [], renamedFrom: null, os: 'macos', osMismatch: false,
  ...over,
})

// Opens the import modal and drives the URL field through to the preview step.
const openPreview = async () => {
  fireEvent.click(screen.getByText('Import'))
  const urlInput = screen.getByPlaceholderText('https://github.com/… or a direct .autowright link')
  fireEvent.change(urlInput, { target: { value: 'https://x.test/a.autowright' } })
  fireEvent.keyDown(urlInput, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText(/triggers arrive off/)).toBeTruthy())
}

// The preview step's primary is the last Import on screen — the list page's
// own header button stays mounted behind the modal.
const confirmImport = async () => {
  const importBtns = screen.getAllByText('Import')
  fireEvent.click(importBtns[importBtns.length - 1])
  await waitFor(() => expect(screen.getByText('Imported “Shared job”')).toBeTruthy())
}

describe('§9.1 Needs fixing chip', () => {
  it('shows with a tooltip listing every problem label', () => {
    seed([auto({ problems: [
      { kind: 'secret-unset', label: 'Secret API_KEY has no value yet — add it on the Secrets page.' },
      { kind: 'os-mismatch', label: 'Built on Windows — its steps may need rewriting before they run on this Mac.' },
    ] })])
    render(<AutomationsList />)
    const chip = screen.getByText('Needs fixing')
    expect(chip.closest('[title]')?.getAttribute('title')).toBe(
      'Secret API_KEY has no value yet — add it on the Secrets page.\n'
      + 'Built on Windows — its steps may need rewriting before they run on this Mac.')
  })

  it('is absent when the problems list is empty', () => {
    seed([auto()])
    render(<AutomationsList />)
    expect(screen.queryByText('Needs fixing')).toBeNull()
  })
})

describe('§9.1 import entry point', () => {
  it('the Import button opens the import modal', () => {
    seed([auto()])
    render(<AutomationsList />)
    fireEvent.click(screen.getByText('Import'))
    expect(screen.getByText('Import automation')).toBeTruthy()
    expect(screen.getByPlaceholderText(
      'https://github.com/… or a direct .autowright link')).toBeTruthy()
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
    // preview step: the amber note leads the footer note block
    await openPreview()
    expect(screen.getByText(
      'Built on Windows — its steps may need rewriting before they run on this Mac.')).toBeTruthy()
    // confirm → summary modal repeats the warning
    await confirmImport()
    expect(screen.getByText(
      'Built on Windows — its steps may need rewriting before they run on this Mac.')).toBeTruthy()
  })

  it('a same-platform preview shows no warning', async () => {
    mockedApi.importFromUrl.mockResolvedValueOnce({ token: 't1', preview: preview() })
    seed([])
    render(<AutomationsList />)
    await openPreview()
    expect(screen.queryByText(/Built on/)).toBeNull()
  })
})

describe('§5.1/§9.1 import preview match badges', () => {
  // The §5.1 ladders run dry: an exact match, a renaming match, and a
  // reference that would land unresolved.
  const mixed = preview({
    secrets: [
      { name: 'MAIL_PASSWORD', description: '', matchedTo: 'MAIL_PASSWORD', matchedBy: 'name' },
      { name: 'CRM_KEY', description: 'the CRM token', matchedTo: 'CRM_TOKEN', matchedBy: 'similarity' },
      { name: 'STRIPE_KEY', description: 'billing', matchedTo: null, matchedBy: null },
    ],
    agents: [
      { name: 'Writer', harness: 'Claude Code', mode: 'default', model: null, matchedTo: 'Writer', matchedBy: 'name' },
      { name: 'Coder', harness: 'Codex', mode: 'default', model: null, matchedTo: 'Local coder', matchedBy: 'configuration' },
      { name: 'Researcher', harness: 'Gemini CLI', mode: 'default', model: null, matchedTo: null, matchedBy: null },
    ],
    packages: [{ pip: 'requests', import: 'requests', why: 'http' }],
  })

  it('badges each row ON THIS MAC / USES x / NO MATCH and warns about the gaps', async () => {
    mockedApi.importFromUrl.mockResolvedValueOnce({ token: 't1', preview: mixed })
    seed([])
    render(<AutomationsList />)
    await openPreview()
    // exact matches on both sides
    expect(screen.getAllByText('ON THIS MAC').length).toBe(2)
    // renaming matches name the local record
    expect(screen.getByText('USES CRM_TOKEN')).toBeTruthy()
    expect(screen.getByText('USES Local coder')).toBeTruthy()
    // one secret + one agent would land unresolved
    expect(screen.getAllByText('NO MATCH').length).toBe(2)
    expect(screen.getByText(
      'Some agents or secrets have no match on this Mac - '
      + 'the automation arrives needing attention.')).toBeTruthy()
    // §6.2 packages line, singular form
    expect(screen.getByText('1 package installs with the import.')).toBeTruthy()
  })

  it('all references matched → no NO MATCH badge and no amber note', async () => {
    mockedApi.importFromUrl.mockResolvedValueOnce({
      token: 't1',
      preview: preview({
        secrets: [{ name: 'MAIL_PASSWORD', description: '', matchedTo: 'MAIL_PASSWORD', matchedBy: 'name' }],
        agents: [{ name: 'Coder', harness: 'Codex', mode: 'default', model: null, matchedTo: 'Local coder', matchedBy: 'configuration' }],
        packages: [{ pip: 'requests', import: 'requests', why: '' }, { pip: 'pandas', import: 'pandas', why: '' }],
      }),
    })
    seed([])
    render(<AutomationsList />)
    await openPreview()
    expect(screen.queryByText('NO MATCH')).toBeNull()
    expect(screen.queryByText(/have no match on this Mac/)).toBeNull()
    expect(screen.getByText('2 packages install with the import.')).toBeTruthy()
  })
})

describe('§5.1/§9.1 import summary sections', () => {
  const done = summary({
    secretsMatched: [
      { name: 'MAIL_PASSWORD', matchedTo: 'MAIL_PASSWORD', matchedBy: 'name' },
      { name: 'CRM_KEY', matchedTo: 'CRM_TOKEN', matchedBy: 'similarity' },
    ],
    agentsMatched: [
      { name: 'Writer', matchedTo: 'Writer', matchedBy: 'name', ready: true },
      { name: 'Coder', matchedTo: 'Local coder', matchedBy: 'configuration', ready: false },
    ],
    unresolved: [
      { kind: 'secret', name: 'STRIPE_KEY', description: 'billing token' },
      { kind: 'agent', name: 'Researcher', description: 'reads the web' },
    ],
    packages: [{ pip: 'requests', import: 'requests', why: '' }],
  })

  const drive = async (s: ImportSummary) => {
    mockedApi.importFromUrl.mockResolvedValueOnce({ token: 't1', preview: preview() })
    mockedApi.importConfirm.mockResolvedValueOnce({
      automation: { id: 'a-new', name: 'Shared job' }, summary: s,
    })
    seed([])
    render(<AutomationsList />)
    await openPreview()
    await confirmImport()
  }

  it('lists what matched and what needs attention', async () => {
    await drive(done)
    expect(screen.getByText('MATCHED ON THIS MAC')).toBeTruthy()
    // matched rows read as the archive name; a renaming match names the local one
    expect(screen.getByText('MAIL_PASSWORD')).toBeTruthy()
    expect(screen.getByText('CRM_KEY')).toBeTruthy()
    expect(screen.getByText('uses CRM_TOKEN')).toBeTruthy()
    expect(screen.getByText('uses Local coder')).toBeTruthy()
    // §12 badge: the matched agent's harness isn't ready yet
    expect(screen.getByText('Needs setup')).toBeTruthy()
    // needs-attention rows carry the archive description and the amber caption
    expect(screen.getByText('NEEDS ATTENTION')).toBeTruthy()
    expect(screen.getByText('STRIPE_KEY')).toBeTruthy()
    expect(screen.getByText('billing token')).toBeTruthy()
    expect(screen.getByText('Researcher')).toBeTruthy()
    expect(screen.getByText('reads the web')).toBeTruthy()
    expect(screen.getByText(
      'No match was found on this Mac - pick a replacement on the edit page.')).toBeTruthy()
    expect(screen.getByText('1 package is installing in the background.')).toBeTruthy()
  })

  it('a clean import shows neither section', async () => {
    await drive(summary({
      secretsMatched: [], agentsMatched: [], unresolved: [],
      packages: [{ pip: 'requests', import: 'requests', why: '' }, { pip: 'pandas', import: 'pandas', why: '' }],
    }))
    expect(screen.queryByText('MATCHED ON THIS MAC')).toBeNull()
    expect(screen.queryByText('NEEDS ATTENTION')).toBeNull()
    expect(screen.queryByText('Needs setup')).toBeNull()
    expect(screen.getByText('2 packages are installing in the background.')).toBeTruthy()
  })
})
