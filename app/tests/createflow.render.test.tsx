// Component tests for the §11 create/edit page: grant checkboxes keeping
// unchecked agents/secrets out of every drafting-job payload (§8), the Build &
// test panel, blockers thread entries, applying chat responses, the footer
// action block, and the left-column cards. CreateFlow renders for real
// (happy-dom) in edit mode with the store seeded and the api module mocked;
// payload assertions read the exact POST /drafts bodies.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Agent, Automation, SecretMeta } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    instructions: vi.fn(async () => ({ framework: '# Framework', defaultBuild: '- rules' })),
    postDraftJob: vi.fn(async () => ({ jobId: 'j1' })),
    patchAutomation: vi.fn(async () => ({})),
    getDraftJob: vi.fn(() => new Promise(() => { /* poll never answers in tests */ })),
    cancelDraftJob: vi.fn(async () => ({})),
    // §19 background continuation: the editor consumes settled outcomes
    ackDraftJob: vi.fn(async () => ({})),
    // §19 one draft-container surface (owner = automation id | 'pending')
    putDraft: vi.fn(async () => ({})),
    deleteDraft: vi.fn(async () => ({})),
    getDraft: vi.fn(async () => ({ draft: null, agentId: null })),
    openDraft: vi.fn(async () => ({})),
    // §19/§4.4 chat-thread surface — the thread outlives the draft
    getChat: vi.fn(async () => ({ chat: [] })),
    putChat: vi.fn(async () => ({})),
    checkPackages: vi.fn(async () => ({ packages: [] })),
    outdatedPackages: vi.fn(async () => ({ packages: [] })),
    postTest: vi.fn(async () => ({ executionId: 'e1' })),
    analyzeExec: vi.fn(async () => ({})),
    getAutomation: vi.fn(async () => ({})),
    // §4.4/§19 delete an old version (editor version menu)
    deleteVersion: vi.fn(async () => ({ automation: {} })),
    state: vi.fn(async () => ({})),
    // §19 trigger previews — labels echo enough shape for the chip/tab renders
    triggersPreview: vi.fn(async (triggers: Array<Record<string, unknown>>) => ({
      triggers: triggers.map((t) => ({
        valid: true, label: String(t.expression ?? t.channel ?? t.from ?? t.kind),
        short: String(t.kind), nextAt: null,
      })),
    })),
  },
}))

let storeMod: typeof import('../src/store')
let CreateFlow: typeof import('../src/pages/CreateFlow').default
let mockedApi: typeof import('../src/api').api

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  CreateFlow = (await import('../src/pages/CreateFlow')).default
  mockedApi = (await import('../src/api')).api
})

const AGENTS: Agent[] = [
  { id: 'g1', name: 'Cloud writer', harness: 'Claude Code', mode: 'default', model: null, default: true },
  { id: 'g2', name: 'Fast local', harness: 'OpenCode', mode: 'ollama', model: 'qwen3:8b' },
]
// §4.8: secrets carry uuids — grants and step references key on them
const MAIL_ID = '11111111-1111-1111-1111-111111111111'
const CRM_ID = '22222222-2222-2222-2222-222222222222'
const SECRETS: SecretMeta[] = [
  { id: MAIL_ID, name: 'MAIL_PASSWORD', description: '', set: true, usedBy: [] },
  { id: CRM_ID, name: 'CRM_API_KEY', description: '', set: true, usedBy: [] },
]
const AUTO = {
  id: 'a1', name: 'My auto', description: '', version: 1,
  triggers: [], triggerChip: 'No triggers', triggersOff: false, nextAt: null,
  instructions: '- keep it simple',
  lastStatus: 'none', live: [], resultChip: null, resultStatus: null, lastExecutionLabel: '',
  agentId: 'g1', stepAgents: ['g1', 'g2'], allowedSecrets: [MAIL_ID, CRM_ID],
  snapshotSettings: { preVersion: true, preClear: true, preRestore: true },
  specMeta: '', params: [],
  steps: [{ file: '01-a.py', name: 'Fetch pages', description: '', code: 'log("a")' }],
  spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Does things.' }],
  packages: [], versions: [], draft: null,
} as unknown as Automation

beforeEach(() => {
  vi.clearAllMocks()
  storeMod.useStore.setState({
    surface: 'create', createFrom: 'edit', page: 'automations', automationId: 'a1',
    automations: [AUTO], agents: AGENTS, secrets: SECRETS,
    executions: [], executionFull: {}, execLogs: {}, toast: null, test: null,
  })
})
afterEach(() => cleanup())

const draftBody = (call: number) =>
  (mockedApi.postDraftJob as ReturnType<typeof vi.fn>).mock.calls[call][0] as Record<string, unknown>

// The ui.tsx Collapse always keeps its children mounted (happy-dom renders
// them), so "collapsed" is asserted through the .ad-collapse open class.
const collapseOf = (el: Element) => el.closest('.ad-collapse')!
// A review card is the nearest ancestor carrying the shared cardStyle radius.
const cardOf = (el: Element): HTMLElement => {
  let n = el.parentElement
  while (n && n.style.borderRadius !== '12px') n = n.parentElement
  return n!
}
// §11 status-aware collapsed lines preview the granted names / first doc line,
// duplicating row text — target the element inside an .ad-hover-row (checklist
// rows), never the preview line (clicking that would toggle the card).
const rowText = (text: string) =>
  screen.getAllByText(text).find((el) => el.closest('.ad-hover-row'))!
// Same ambiguity for markdown card bodies: pick the rendered list item.
const bodyLi = (text: string) =>
  screen.getAllByText(text).find((el) => el.tagName === 'LI')!
// Spinner renders a bare span animated with adSpin — the only way to find it.
const spinnersIn = (el: Element) =>
  [...el.querySelectorAll('span')].filter((s) => ((s as HTMLElement).style.animation || '').includes('adSpin'))
// Reset getDraftJob to the never-answering default before each of the newer
// suites — a prior test's mockResolvedValue would otherwise leak through
// vi.clearAllMocks (which clears calls, not implementations). Also make
// getAutomation echo the seeded automation: the mount-time loadAuto stores its
// response verbatim, and the default `{}` would erase the auto (no id match)
// the moment the test awaits anything.
const armPendingPoll = () => {
  ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => { /* poll never answers */ }))
  ;(mockedApi.getAutomation as ReturnType<typeof vi.fn>).mockImplementation(async () => storeMod.useStore.getState().automations[0] ?? {})
}

const BLOCKED_SYNC = {
  id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
  mode: 'sync', blockedAt: 'steps',
  blockers: [{ reason: 'Needs a channel id.', fix: 'Name it in the spec.' }],
}

describe('CreateFlow grant checkboxes → drafting payloads (§8/§11)', () => {
  it('unchecking an agent and a secret keeps both out of the sync job', async () => {
    render(<CreateFlow />)
    expect(screen.getByText('2 of 2 enabled')).toBeTruthy()
    expect(screen.getByText('2 of 2 allowed')).toBeTruthy()

    fireEvent.click(screen.getByText('Fast local'))     // uncheck agent g2
    expect(screen.getByText('1 of 2 enabled')).toBeTruthy()
    fireEvent.click(screen.getByText('CRM_API_KEY'))    // disallow the secret
    expect(screen.getByText('1 of 2 allowed')).toBeTruthy()

    // grant toggles alone never mark the workflow out of sync (§11) — the
    // panel still offers the on-demand sync
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    expect(body.mode).toBe('sync')
    expect(body.automationId).toBe('a1')
    expect(body.enabledAgents).toEqual(['g1'])                    // g2 gone
    expect(body.allowedSecrets).toEqual([MAIL_ID])        // CRM_API_KEY gone
    // the serialized in-editor draft carries the same trimmed grants
    const current = body.current as { stepAgents: string[]; allowedSecrets: string[] }
    expect(current.stepAgents).toEqual(['g1'])
    expect(current.allowedSecrets).toEqual([MAIL_ID])
  })

  it('unchecking everything sends explicit empty arrays, not missing keys', async () => {
    render(<CreateFlow />)
    fireEvent.click(rowText('Cloud writer'))
    fireEvent.click(rowText('Fast local'))
    fireEvent.click(rowText('MAIL_PASSWORD'))
    fireEvent.click(rowText('CRM_API_KEY'))
    expect(screen.getByText('0 of 2 enabled')).toBeTruthy()
    expect(screen.getByText('0 of 2 allowed')).toBeTruthy()

    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    // §19: [] means "unchecked" — absent keys would fall back to stored grants
    expect(body.enabledAgents).toEqual([])
    expect(body.allowedSecrets).toEqual([])
    expect('enabledAgents' in body && 'allowedSecrets' in body).toBe(true)
  })

  it('the chat job carries the live checkbox state too', async () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('CRM_API_KEY'))    // disallow one secret

    const input = screen.getByPlaceholderText('Change something, or ask a question…')
    fireEvent.change(input, { target: { value: 'Also check on weekends' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    expect(body.mode).toBe('chat')
    expect(body.text).toBe('Also check on weekends')
    expect(body.enabledAgents).toEqual(['g1', 'g2'])              // agents untouched
    expect(body.allowedSecrets).toEqual([MAIL_ID])        // unchecked secret gone
    // §19: the recent thread rides the body (empty on a fresh editor)
    expect(Array.isArray(body.chat)).toBe(true)
    // the message renders as a user entry in the thread
    expect(screen.getByText('Also check on weekends')).toBeTruthy()
  })

  it('re-checking a grant restores it in the next payload (check/uncheck is a no-op)', async () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Fast local'))     // uncheck…
    fireEvent.click(screen.getByText('Fast local'))     // …and re-check
    expect(screen.getByText('2 of 2 enabled')).toBeTruthy()

    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    expect(draftBody(0).enabledAgents).toEqual(['g1', 'g2'])
  })
})

describe('CreateFlow Build & test panel (§11)', () => {
  it('out of sync (grant gap): Sync now shows, Test disables with the sync-first hint', async () => {
    // an agent step pinned to g2 — unchecking g2 opens a derived grant gap
    storeMod.useStore.setState({
      automations: [{
        ...AUTO,
        steps: [{ file: '01-a.py', name: 'Judge', description: '', code: 'log("a")', agent: true, why: 'w', agents: [{ id: 'g2' }] }],
      } as unknown as Automation],
    })
    render(<CreateFlow />)
    // the step tag renders the same name — target the checkbox row through its
    // model line ('qwen3:8b' is unique to it); the click bubbles to the row
    const agentRow = () => screen.getByText('qwen3:8b')
    fireEvent.click(agentRow())     // uncheck the agent the step calls
    expect(screen.getByText('Sync now')).toBeTruthy()
    expect(screen.getByText(/steps call an agent that isn’t enabled/)).toBeTruthy()
    // the Test button stays visible but disabled, with the §11 hint
    const testBtn = screen.getByText('Test draft').closest('button')!
    expect(testBtn.disabled).toBe(true)
    expect(screen.getByText('Sync first — a test executes the steps as generated from the spec.')).toBeTruthy()
    // re-checking the grant clears the gap instantly — Test re-enables
    fireEvent.click(agentRow())
    expect(screen.getByText('Sync spec')).toBeTruthy()
    expect((screen.getByText('Test draft').closest('button')!).disabled).toBe(false)
  })

  it('in sync: quiet panel — no indicator dot, no accent button, one test row', () => {
    render(<CreateFlow />)
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    // §11 quiet posture: the in-sync build zone is gone (no green dot, no status
    // line) — the panel is a single test row with the ghost sync escape hatch
    expect(within(panel).getByText(/In sync with the spec/)).toBeTruthy()
    expect(panel.querySelector('.ad-btn-primary')).toBeNull()
    // §11 button treatment: compact borderless text buttons — main action
    // muted, the sync escape hatch faint; never bordered or filled boxes
    const testBtn = within(panel).getByText('Test draft').closest('button')!
    expect(testBtn.disabled).toBe(false)
    expect(testBtn.classList.contains('ad-btn-text')).toBe(true)
    const syncBtn = within(panel).getByText('Sync spec').closest('button')!
    expect(syncBtn.classList.contains('ad-btn-text')).toBe(true)
    expect(syncBtn.classList.contains('dim')).toBe(true)
  })

  it('Test draft is a disclosure: setup shows every option at once, only Run test starts it', async () => {
    armPendingPoll()
    storeMod.useStore.setState({
      automations: [{
        ...AUTO,
        params: [{ name: 'city', kind: 'text', label: 'City', help: '', value: 'Oslo' }],
        triggers: [{ kind: 'discord', channel: '#general', secret: 'DISCORD_TOKEN', enabled: true }],
      } as unknown as Automation],
    })
    render(<CreateFlow />)
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    // collapsed: no setup section, no Run test
    expect(within(panel).queryByText('Run test')).toBeNull()
    expect(within(panel).queryByText('PARAMETER VALUES · THIS TEST ONLY')).toBeNull()
    // the toggle expands the setup — it never starts a test
    fireEvent.click(within(panel).getByText('Test draft'))
    expect(mockedApi.postTest).not.toHaveBeenCalled()
    // both option groups render together — no nested toggles
    expect(within(panel).getByText('PARAMETER VALUES · THIS TEST ONLY')).toBeTruthy()
    expect(within(panel).getByText('TRIGGER MESSAGE · THIS TEST ONLY')).toBeTruthy()
    // Run test is the only control that starts a test
    fireEvent.click(within(panel).getByText('Run test'))
    await waitFor(() => expect(mockedApi.postTest).toHaveBeenCalledTimes(1))
    const body = (mockedApi.postTest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(body.paramValues).toEqual({ city: 'Oslo' })
    expect(body.triggerMock).toBeUndefined() // empty message → no payload
    // starting the test collapsed the setup section
    expect(within(panel).queryByText('Run test')).toBeNull()
  })

  it('drafted §8 test_values drive a closed-section run and seed the setup editors', async () => {
    armPendingPoll()
    storeMod.useStore.setState({
      automations: [{
        ...AUTO,
        params: [{ name: 'city', kind: 'text', label: 'City', help: '', value: 'Oslo' }],
      } as unknown as Automation],
    })
    render(<CreateFlow />)
    // a sync delivers steps + params + the drafted best-effort test values
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'sync',
      draft: {
        steps: [{ file: '01-a.py', name: 'Fetch', description: '', code: 'log("a")' }],
        params: [{ name: 'city', kind: 'text', label: 'City', help: '', default: '' }],
        packages: [],
        testValues: { city: 'Bergen' },
      },
    })
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(screen.getByText('Steps synced with the spec.')).toBeTruthy(), { timeout: 3000 })
    // §11 turn action row: the Test-the-draft pill starts the test with the
    // setup section never opened — the drafted values still ride the run
    const row = screen.getByTestId('chat-turn-actions')
    fireEvent.click(within(row).getByText('Test draft'))
    await waitFor(() => expect(mockedApi.postTest).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const body = (mockedApi.postTest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(body.paramValues).toEqual({ city: 'Bergen' })
    // §11 setup seeding: the drafted value lands over the stored/default base
    await waitFor(() => expect(storeMod.useStore.getState().test).toBeTruthy())
    storeMod.useStore.setState({ test: null })
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    await waitFor(() => expect(within(panel).getByText('Test draft')).toBeTruthy())
    fireEvent.click(within(panel).getByText('Test draft'))
    expect(within(panel).getByDisplayValue('Bergen')).toBeTruthy()
  })

  it('a diagnosed blocked sync lands a thread blockers entry with the build-failure headline', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'sync', blockedAt: 'steps', diagnosed: true,
      blockers: [{ reason: 'The build failed validation.', fix: 'Simplify the spec.' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(
      () => expect(screen.getByText('The build failed — your AI suggests these fixes')).toBeTruthy(),
      { timeout: 3000 },
    )
    // same agent-output rendering + apply action as an agent-refusal blocker
    expect(screen.getByText('The build failed validation.')).toBeTruthy()
    expect(screen.getByText('Apply to the spec & sync')).toBeTruthy()
  })

  it('an undiagnosed blocked sync keeps the agent-refusal headline', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'sync', blockedAt: 'steps',
      blockers: [{ reason: 'Needs a channel id.', fix: 'Name it in the spec.' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(
      () => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(),
      { timeout: 3000 },
    )
  })

  it('a blocked sync carrying §8 blocker notes applies them with a "Notes updated." chip', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...BLOCKED_SYNC, draft: { spec: null, notes: '- the feed needs auth' },
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // the notes land like a chat notes rewrite — chip after the blockers entry
    expect(screen.getByText('Notes updated.')).toBeTruthy()
  })
})

describe('CreateFlow blockers thread entries (§11)', () => {
  beforeEach(armPendingPoll)

  it('Apply gates while a job is busy and ungates when it settles; text renders as agent output', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BLOCKED_SYNC)
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // the blocked job's activity glyph is the amber check (§11 outcome glyph)
    const glyph = document.querySelector('[data-testid="chat-thread"] .fa-check') as HTMLElement
    expect(glyph.style.color).toBe('var(--amber)')
    // sync-source explainer + the blocker text as read-only agent output (no textareas)
    expect(screen.getByText('It couldn’t sync the steps with the spec.')).toBeTruthy()
    expect(screen.getByText('Name it in the spec.')).toBeTruthy()
    expect(screen.queryByDisplayValue('Name it in the spec.')).toBeNull()
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(false)
    // a second sync (never answering) disables the primary
    fireEvent.click(screen.getByText('Sync spec'))
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(true)
    // the composer Cancel settles the job — the primary ungates
    fireEvent.click(screen.getByText('Cancel'))
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(false)
  })

  it('viewing an old version disables Apply; Dismiss still collapses the entry', async () => {
    storeMod.useStore.setState({
      automations: [{
        ...AUTO, version: 2,
        versions: [{ version: 1, when: 'Jul 1', note: null, spec: AUTO.spec, steps: AUTO.steps, instructions: '', notes: '', params: [], packages: [] }],
      } as unknown as Automation],
    })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BLOCKED_SYNC)
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // browse v1 from the version menu — the thread survives, Apply gated
    fireEvent.click(screen.getByText('Draft'))
    fireEvent.click(screen.getByText('v1'))
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(true)
    expect((screen.getByPlaceholderText('Back to the draft to edit or ask.') as HTMLTextAreaElement).disabled).toBe(true)
    // Dismiss is never gated — the entry collapses to the one-line summary
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
  })

  it('version menu: only older rows carry delete; confirming calls the DELETE and toasts', async () => {
    const edited = {
      ...AUTO, version: 2,
      versions: [{ version: 1, when: 'created Jul 1, 2026', note: null, spec: AUTO.spec, steps: AUTO.steps, instructions: '', notes: '', params: [], packages: [] }],
    } as unknown as Automation
    storeMod.useStore.setState({ automations: [edited] })
    ;(mockedApi.getAutomation as ReturnType<typeof vi.fn>).mockResolvedValue({ ...edited, versions: [] })
    render(<CreateFlow />)
    fireEvent.click(screen.getByTestId('version-menu'))
    // §4.4: the current version is an inert header, never a selectable option
    expect(screen.getByText('v2 · current')).toBeTruthy()
    expect(screen.getByText(/Your draft builds on this/)).toBeTruthy()
    // §4.4: hidden, not disabled — the Draft row and the header carry no trash
    expect(screen.getByTestId('delete-version-1')).toBeTruthy()
    expect(screen.queryByTestId('delete-version-2')).toBeNull()
    fireEvent.click(screen.getByTestId('delete-version-1'))
    // danger ConfirmModal; confirming fires the §19 DELETE and reloads the automation
    expect(screen.getByText('Delete v1?')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete v1', { exact: true }))
    await waitFor(() => expect(mockedApi.deleteVersion).toHaveBeenCalledWith('a1', 1))
    await waitFor(() => expect(mockedApi.getAutomation).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(storeMod.useStore.getState().toast).toBe('v1 deleted.'))
  })

  it('a fresh draft’s blocked first message: the reply is an ordinary chat message', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'chat', blockedAt: 'chat',
      blockers: [{ reason: 'Which folder?', fix: 'Name the folder to watch.' }],
    })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // chat-source explainer, no primary button — the composer is the answer path
    expect(screen.getByText('Reply below — your answer is sent back and the spec is rewritten.')).toBeTruthy()
    expect(screen.queryByText('Answer & rewrite the spec')).toBeNull()
    expect(screen.queryByText('Apply to the spec & sync')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'The Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    // entry auto-dismisses, the reply lands as a user entry, another chat job
    // starts — the thread's CONVERSATION context carries the clarification
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
    expect(screen.getByText('The Downloads folder')).toBeTruthy()
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2))
    const body = draftBody(1)
    expect(body.mode).toBe('chat')
    expect(body.text).toBe('The Downloads folder')
  })

  it('chat blockers auto-dismiss when the reply goes out as a chat message', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...BLOCKED_SYNC, mode: 'chat', blockedAt: 'chat' })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: 'Send it to Discord too' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Reply below — your answer is sent back and the spec is rewritten.')).toBeTruthy()
    expect(screen.queryByText('Answer & rewrite the spec')).toBeNull()
    // the blocked job settled — the reply goes out through the composer
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: 'Channel 42' } })
    fireEvent.click(screen.getByText('Send'))
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2))
    const body = draftBody(1)
    expect(body.mode).toBe('chat')
    expect(body.text).toBe('Channel 42')
  })

  it('a fresh draft’s blocked chained sync keeps the landed spec out of sync', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    const spec = [{ kind: 'h1', text: 'Folder watcher' }, { kind: 'p', text: 'Watches things.' }]
    // the chat job lands the spec + sync action, then the chained sync blocks
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'j1', status: 'done', stage: null, detail: null, error: null,
        mode: 'chat', draft: { spec, actions: { sync: true } },
      })
      .mockResolvedValue({
        id: 'j1', status: 'blocked', stage: null, detail: null, error: null,
        mode: 'sync', blockedAt: 'steps', draft: null,
        blockers: [{ reason: 'Needs a channel id.', fix: 'Name it in the spec.' }],
      })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText('It couldn’t sync the steps with the spec.')).toBeTruthy()
    expect(screen.getByText('Apply to the spec & sync')).toBeTruthy()
    // the chat rewrite landed the spec and the workflow is out of sync
    expect(screen.getByText('Watches things.')).toBeTruthy()
    expect(screen.getByText('The workflow is out of sync — these steps still match the old spec.')).toBeTruthy()
  })

  it('a markdown link in a blocker renders as a clickable anchor', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...BLOCKED_SYNC,
      blockers: [{ reason: 'Transmission isn’t installed.',
        fix: 'Download it from [transmissionbt.com](https://transmissionbt.com) and install it.' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    const a = screen.getByText('transmissionbt.com').closest('a')!
    expect(a.getAttribute('href')).toBe('https://transmissionbt.com')
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('a user-action blocker offers Dismiss only under the needs-you headline', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...BLOCKED_SYNC,
      blockers: [{ reason: 'Transmission isn’t installed.',
        fix: 'Install Transmission, then run the automation again.', kind: 'user-action' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    await waitFor(
      () => expect(screen.getByText('Your AI needs you to do something first')).toBeTruthy(),
      { timeout: 3000 },
    )
    // no source explainer, no Apply — the Mac isn't ready, nothing to amend
    expect(screen.queryByText('It couldn’t sync the steps with the spec.')).toBeNull()
    expect(screen.queryByText('Apply to the spec & sync')).toBeNull()
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
  })
})

describe('CreateFlow per-stage activity entries (§11)', () => {
  beforeEach(armPendingPoll)

  it('a fresh draft’s first turn settles each finished stage as its own activity entry', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    const spec = [{ kind: 'h1', text: 'Watcher' }, { kind: 'p', text: 'Watches.' }]
    const specEvent = { time: 1, text: 'Thinking about the spec…', stage: 'Updating the documents' }
    const stepsEvent = { time: 2, text: 'Writing the manifest…', stage: 'Syncing the workflow' }
    // the chat job walks request → documents and lands the spec + sync action;
    // the chained sync job walks the workflow phase and delivers the steps
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'j1', status: 'building', stage: 'Updating the documents', detail: null,
        error: null, mode: 'chat', draft: null, events: [specEvent],
      })
      .mockResolvedValueOnce({
        id: 'j1', status: 'done', stage: 'Updating the documents', detail: null,
        error: null, mode: 'chat', draft: { spec, actions: { sync: true } },
        events: [specEvent],
      })
      .mockResolvedValue({
        id: 'j1', status: 'done', stage: 'Syncing the workflow', detail: null,
        error: null, mode: 'sync',
        draft: { steps: [], params: [], packages: [] },
        events: [stepsEvent],
      })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my folder' } })
    fireEvent.click(screen.getByText('Send'))
    const thread = () => document.querySelector('[data-testid="chat-thread"]') as HTMLElement
    await waitFor(
      () => expect(within(thread()).getByText('Steps synced with the spec.')).toBeTruthy(),
      { timeout: 5000 },
    )
    // every displayed stage survives as a settled entry — the seeded neutral
    // deciding phase (with its canned bullet) first, then documents, then
    // the chained sync's workflow phase — each with its own slice of the feed
    const t = thread()
    const neutralEntry = within(t).getByText('Working on the request…')
    expect(within(t).getByText('• Choosing what to do')).toBeTruthy()
    const specEntry = within(t).getByText('Updating the documents…')
    const stepsEntry = within(t).getByText('Syncing the workflow…')
    expect(neutralEntry.compareDocumentPosition(specEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(specEntry.compareDocumentPosition(stepsEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // §11 operation blocks: feed lines render as flush-left `• ` bullets
    const feedSpec = within(t).getByText('• Thinking about the spec…')
    const feedSteps = within(t).getByText('• Writing the manifest…')
    expect(specEntry.compareDocumentPosition(feedSpec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(feedSpec.compareDocumentPosition(stepsEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stepsEntry.compareDocumentPosition(feedSteps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // all settled with a green check, no spinner left
    expect(spinnersIn(t).length).toBe(0)
  })
})

describe('CreateFlow chat response application (§11)', () => {
  beforeEach(armPendingPoll)

  const done = (draft: Record<string, unknown>) => ({
    id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'chat', draft,
  })
  const send = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: text } })
    fireEvent.click(screen.getByText('Send'))
  }

  it('answer renders before the spec rewrite, which dirties the draft and toasts', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Now with weekends.' }],
      answer: 'Sure — done.',
    }))
    render(<CreateFlow />)
    send('Also weekends')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    // §11 order: the answer entry lands before the rewrite entry
    const answer = screen.getByText('Sure — done.')
    const rewrite = screen.getByText('Spec updated.')
    expect(answer.compareDocumentPosition(rewrite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the rewrite applied to the spec card and marked the workflow out of sync
    expect(screen.getByText('Now with weekends.')).toBeTruthy()
    expect(screen.getByText('The workflow is out of sync — these steps still match the old spec.')).toBeTruthy()
    expect(storeMod.useStore.getState().toast)
      .toBe('Spec updated — the workflow is out of sync. Sync the steps before saving.')
  })

  it('answer headers: The plan beside rewrites, Question for you on a question (§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Now with weekends.' }],
      answer: 'Here is what I changed.',
    }))
    render(<CreateFlow />)
    send('Also weekends')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    // a reply arriving with a rewrite is the plan
    expect(screen.getByText('The plan')).toBeTruthy()
    // an agent-declared question (§19 answerKind) gets the question header
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      answer: 'Which folder should I watch?', answerKind: 'question',
    }))
    send('Watch stuff')
    await waitFor(() => expect(screen.getByText('Which folder should I watch?')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Question for you')).toBeTruthy()
  })

  it('a reply merely ending with ? stays From your AI — no answerKind, no question header (§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      answer: 'It runs daily at 8. Does that answer your question?',
    }))
    render(<CreateFlow />)
    send('When does it run?')
    await waitFor(() => expect(screen.getByText(/Does that answer your question/)).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('From your AI')).toBeTruthy()
    expect(screen.queryByText('Question for you')).toBeNull()
  })

  it('the plan lands mid-job at the flip; the settle updates it in place (§8/§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'j1', status: 'building', stage: 'Updating the documents', detail: null,
        error: null, mode: 'chat', draft: null, events: [],
        plan: 'I will add weekends to the schedule.',
      })
      .mockResolvedValue(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Now with weekends.' }],
        answer: 'I will add weekends and Fridays.',
      }))
    render(<CreateFlow />)
    send('Also weekends')
    // §11: "The plan" message block renders while the job is still building
    await waitFor(() => expect(screen.getByText('I will add weekends to the schedule.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('The plan')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    // the settle appended no second answer entry — the shown plan's text was
    // updated in place to the settled payload's answer (repair-round prose)
    expect(screen.getAllByText('The plan').length).toBe(1)
    expect(screen.queryByText('I will add weekends to the schedule.')).toBeNull()
    expect(screen.getByText('I will add weekends and Fridays.')).toBeTruthy()
  })

  it('turn action row: Test draft when in sync; Sync now + Undo after a rewrite (§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({ answer: 'All good.' }))
    render(<CreateFlow />)
    send('Anything to improve?')
    await waitFor(() => expect(screen.getByText('All good.')).toBeTruthy(), { timeout: 3000 })
    // in sync with steps → the Test pill; no sync or undo to offer
    const row = screen.getByTestId('chat-turn-actions')
    expect(within(row).queryByText('Sync now')).toBeNull()
    expect(within(row).queryByText('Undo this change')).toBeNull()
    // the pill starts a draft test right away (§11) — same run as Run test
    fireEvent.click(within(row).getByText('Test draft'))
    await waitFor(() => expect(mockedApi.postTest).toHaveBeenCalledTimes(1), { timeout: 3000 })
    // let the tracked test settle out of the way before the rewrite half
    storeMod.useStore.setState({ test: null })
    // a rewrite pulls the workflow out of sync → Sync now + Undo, Test hidden
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten.' }],
    }))
    send('Rewrite it')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    const row2 = screen.getByTestId('chat-turn-actions')
    expect(within(row2).getByTestId('chat-sync-now')).toBeTruthy()
    expect(within(row2).getByText('Undo this change')).toBeTruthy()
    expect(within(row2).queryByText('Test draft')).toBeNull()
  })

  it('a settled job persists its event feed as an activity entry before the outcome', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...done({ answer: 'Looked into it.' }),
      events: [{ time: 1, text: 'Reading https://example.com/docs…' }, { time: 2, text: 'Writing the reply…' }],
    })
    render(<CreateFlow />)
    send('Check the docs')
    await waitFor(() => expect(screen.getByText('Looked into it.')).toBeTruthy(), { timeout: 3000 })
    // the stage label survives the job with a check where the spinner was
    expect(screen.getByText('Working on the request…')).toBeTruthy()
    expect(spinnersIn(document.body).length).toBe(0)
    expect(document.querySelector('[data-testid="chat-thread"] .fa-check')).toBeTruthy()
    // the feed lines survive too, dim `• ` bullets above the answer (§11)
    const feedLine = screen.getByText('• Reading https://example.com/docs…')
    expect(screen.getByText('• Writing the reply…')).toBeTruthy()
    expect(feedLine.compareDocumentPosition(screen.getByText('Looked into it.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a failed job’s activity entry settles into a red X, not a check (§11 outcome glyph)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'failed', stage: null, detail: null, error: 'The harness crashed.',
      mode: 'chat', draft: null,
      events: [{ time: 1, text: 'Reading the spec…' }],
    })
    render(<CreateFlow />)
    send('Change it')
    await waitFor(() => expect(screen.getByText('The harness crashed.')).toBeTruthy(), { timeout: 3000 })
    // the trail survives with the failed glyph; the feed line is kept
    const thread = document.querySelector('[data-testid="chat-thread"]')!
    expect(thread.querySelector('.fa-xmark')).toBeTruthy()
    expect(thread.querySelector('.fa-check')).toBeNull()
    expect(screen.getByText('• Reading the spec…')).toBeTruthy()
  })

  it('a notes rewrite applies without marking the workflow out of sync (§4.1)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: null, notes: '- The site rate-limits at 10 rpm',
    }))
    render(<CreateFlow />)
    send('Remember the rate limit')
    await waitFor(() => expect(screen.getByText('Notes updated.')).toBeTruthy(), { timeout: 3000 })
    expect(bodyLi('The site rate-limits at 10 rpm')).toBeTruthy() // NOTES card content
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
    expect(screen.queryByText(/out of sync/)).toBeNull()
  })

  it('actions.sync chains a sync job right after the rewrite lands', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Synced spec.' }],
      answer: 'Rewrote it.', actions: { sync: true },
    }))
    render(<CreateFlow />)
    send('Rewrite and sync')
    await waitFor(() => expect(screen.getByText('Steps synced with the spec.')).toBeTruthy(), { timeout: 5000 })
    expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2)
    expect(draftBody(0).mode).toBe('chat')
    expect(draftBody(1).mode).toBe('sync')
    // the chained sync cleared the dirty flag again
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
  })

  it('actions.test is dropped with the system chip when the chained sync blocks', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Test me.' }],
        actions: { test: true },
      }))
      .mockResolvedValue(BLOCKED_SYNC)
    render(<CreateFlow />)
    send('Change it and test it')
    await waitFor(
      () => expect(screen.getByText('Test skipped — the steps aren’t in sync with the spec.')).toBeTruthy(),
      { timeout: 5000 },
    )
    // the armed test chained a sync first; its block kept the steps stale
    expect(draftBody(1).mode).toBe('sync')
    expect(mockedApi.postTest).not.toHaveBeenCalled()
  })

  it('a chat rename into a taken name is skipped with the system chip (§4.1)', async () => {
    storeMod.useStore.setState({ automations: [AUTO, { ...AUTO, id: 'a2', name: 'Other auto' }] })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      answer: 'Renaming it.', actions: { name: 'OTHER auto' },
    }))
    render(<CreateFlow />)
    send('rename it to Other auto')
    await waitFor(() => expect(
      screen.getByText('Rename to “OTHER auto” skipped — an automation with that name already exists.'),
    ).toBeTruthy(), { timeout: 3000 })
    // the skipped rename never rides the PATCH and the title keeps the old name
    expect(mockedApi.patchAutomation).not.toHaveBeenCalled()
    expect(screen.getAllByText('My auto').length).toBeGreaterThan(0)
    expect(screen.queryByText('OTHER auto')).toBeNull()
  })
})

describe('CreateFlow chat staged actions (§8 param_values / triggers ops)', () => {
  beforeEach(armPendingPoll)

  const done = (draft: Record<string, unknown>) => ({
    id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'chat', draft,
  })
  const send = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: text } })
    fireEvent.click(screen.getByText('Send'))
  }
  // The §4.4 debounced draft PUT is the observable for staged editor state —
  // its payload is exactly what a kept draft (and a save) carries.
  const lastDraftPut = async () => {
    await waitFor(() => expect(mockedApi.putDraft).toHaveBeenCalled(), { timeout: 3000 })
    return (mockedApi.putDraft as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as {
      triggers: Array<Record<string, unknown>>
      paramValues?: Record<string, unknown>
      params: Array<Record<string, unknown>>
    }
  }

  const TRIGGERED = {
    ...AUTO,
    triggers: [
      { id: 't1', kind: 'cron', expression: '0 8 * * *', enabled: true, source: 'spec', label: 'Daily at 8:00', short: 'Daily 8:00' },
      { id: 't2', kind: 'discord', channel: '123', secret: 'CRM_API_KEY', enabled: true, label: 'Discord · 123', short: 'Discord' },
    ],
    params: [{ name: 'greeting', kind: 'text', label: 'Greeting', help: 'What to say.', default: 'hello', value: 'hello' }],
  } as unknown as Automation
  beforeEach(() => storeMod.useStore.setState({ automations: [TRIGGERED] }))

  it('an add matching an existing trigger is a no-op — chip lands, list unchanged', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      answer: 'That schedule is already set up.',
      actions: { triggers: [{ op: 'add', trigger: { kind: 'cron', expression: '0 8 * * *', enabled: true, source: 'user' } }] },
    }))
    render(<CreateFlow />)
    send('add an 8am schedule')
    await waitFor(() => expect(screen.getByText('That trigger already exists.')).toBeTruthy(), { timeout: 3000 })
    const d = await lastDraftPut()
    expect(d.triggers.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('adding a new trigger keeps every existing trigger untouched', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      actions: { triggers: [{ op: 'add', trigger: { kind: 'cron', expression: '0 21 * * *', enabled: true, source: 'user' } }] },
    }))
    render(<CreateFlow />)
    send('also run at 9pm')
    await waitFor(() => expect(screen.getByText('Trigger added.')).toBeTruthy(), { timeout: 3000 })
    // TRIGGERS card shows the old chips and the new one (preview-mock labels
    // re-fetch async after the list changes)
    await waitFor(() => expect(screen.getByText('0 21 * * *')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('0 8 * * *')).toBeTruthy()
    expect(screen.getByText('123')).toBeTruthy()
    const d = await lastDraftPut()
    expect(d.triggers.map((t) => [t.id, t.enabled])).toEqual([['t1', true], ['t2', true], [undefined, true]])
    expect(d.triggers[2]).toMatchObject({ kind: 'cron', expression: '0 21 * * *', source: 'user' })
  })

  it('an enable op flips only the trigger it names — the others keep their state', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      actions: { triggers: [{ op: 'enable', index: 2, enabled: false }] },
    }))
    render(<CreateFlow />)
    send('pause the discord trigger')
    await waitFor(() => expect(screen.getByText('Trigger 2 turned off.')).toBeTruthy(), { timeout: 3000 })
    const d = await lastDraftPut()
    expect(d.triggers.map((t) => [t.id, t.enabled])).toEqual([['t1', true], ['t2', false]])
  })

  it('a disabled trigger renders its chip grayed out — enabled ones keep the accent pair', async () => {
    storeMod.useStore.setState({
      automations: [{
        ...TRIGGERED,
        triggers: [TRIGGERED.triggers[0], { ...TRIGGERED.triggers[1], enabled: false }],
      } as unknown as Automation],
    })
    render(<CreateFlow />)
    await waitFor(() => expect(screen.getByText('123')).toBeTruthy(), { timeout: 3000 })
    const off = screen.getByText('123') as HTMLElement
    expect(off.style.color).toBe('var(--text-faint)')
    expect(off.style.background).toBe('var(--hairline-dim)')
    const on = screen.getByText('0 8 * * *') as HTMLElement
    expect(on.style.color).toBe('var(--accent)')
    expect(on.style.background).toBe('var(--accent-chip-bg)')
  })

  it('param_values stage in the draft only — no PATCH, stored defs untouched, save carries the map', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      actions: { paramValues: { greeting: 'hi' } },
    }))
    render(<CreateFlow />)
    send('set greeting to hi')
    await waitFor(() => expect(screen.getByText('Parameter “greeting” staged — applies when you save.')).toBeTruthy(), { timeout: 3000 })
    // Parameters card marks the unsaved value and shows the staged summary
    expect(screen.getByText('STAGED')).toBeTruthy()
    expect(screen.getByText('hi')).toBeTruthy()
    // §4.2: staged is draft state only — the automation is never PATCHed now
    expect(mockedApi.patchAutomation).not.toHaveBeenCalled()
    const d = await lastDraftPut()
    expect(d.paramValues).toEqual({ greeting: 'hi' })
    // the param definitions (what versions store) keep their old value
    expect(d.params[0]).toMatchObject({ name: 'greeting', value: 'hello' })
    // and the live automation in the store still holds the stored value
    expect((storeMod.useStore.getState().automations[0].params[0] as { value?: string }).value).toBe('hello')
  })

  it('hold-and-flush: a sync-arming response lands its staged chip beneath the sync trail (§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'With greeting.' }],
        actions: { paramValues: { greeting: 'hi' }, sync: true },
      }))
      .mockResolvedValue(done({}))
    render(<CreateFlow />)
    send('set greeting to hi and sync')
    await waitFor(() => expect(screen.getByText('Steps synced with the spec.')).toBeTruthy(), { timeout: 5000 })
    // the workflow chip group sits contiguously beneath the sync trail — the
    // staged chip was held through the chained sync and flushed after it
    const synced = screen.getByText('Steps synced with the spec.')
    const staged = screen.getByText('Parameter “greeting” staged — applies when you save.')
    expect(synced.compareDocumentPosition(staged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the staging itself applied at response time regardless
    const d = await lastDraftPut()
    expect(d.paramValues).toEqual({ greeting: 'hi' })
  })

  it('the derived out-of-sync line closes an unsynced rewrite turn and clears when a sync lands (§11)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten.' }],
        actions: { paramValues: { greeting: 'hi' } },
      }))
      .mockResolvedValue(done({}))
    render(<CreateFlow />)
    send('rewrite it, stage greeting')
    await waitFor(() => expect(screen.getByTestId('chat-outofsync-note')).toBeTruthy(), { timeout: 3000 })
    // no sync armed → the staged chip landed at apply time, the amber line after it
    const staged = screen.getByText('Parameter “greeting” staged — applies when you save.')
    const note = screen.getByTestId('chat-outofsync-note')
    expect(staged.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // a sync clears it — the line is derived, never persisted
    fireEvent.click(screen.getByTestId('chat-sync-now'))
    await waitFor(() => expect(screen.getByText('Steps synced with the spec.')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByTestId('chat-outofsync-note')).toBeNull()
  })

  it('a concurrency action stages in the draft only — chip, STAGED row, no PATCH, PUT carries the object', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      actions: { concurrency: { maxParallel: 2 } },
    }))
    render(<CreateFlow />)
    // CONCURRENCY card always renders its two rows — defaults before staging
    expect(screen.getByText('Max parallel executions')).toBeTruthy()
    expect(screen.getByText('Max queued executions')).toBeTruthy()
    send('let two run at once')
    await waitFor(() => expect(screen.getByText('Concurrency staged — applies when you save.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('STAGED')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    // §8: staged is draft state only — the automation is never PATCHed now
    expect(mockedApi.patchAutomation).not.toHaveBeenCalled()
    const d = await lastDraftPut()
    expect((d as { concurrency?: Record<string, number> }).concurrency).toEqual({ maxParallel: 2 })
  })
})

describe('CreateFlow draft undo (§11)', () => {
  beforeEach(armPendingPoll)

  const done = (draft: Record<string, unknown>) => ({
    id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'chat', draft,
  })
  const send = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: text } })
    fireEvent.click(screen.getByText('Send'))
  }

  it('one Undo reverts everything one response rewrote — spec, instructions, and notes', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten body.' }],
      instructions: '- be bold',
      notes: '- Learned a quirk',
    }))
    render(<CreateFlow />)
    send('Change everything')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Rewritten body.')).toBeTruthy()
    expect(bodyLi('be bold')).toBeTruthy()
    expect(bodyLi('Learned a quirk')).toBeTruthy()
    // the standalone undo row is the page's only undo affordance
    const undos = screen.getAllByText('Undo this change')
    expect(undos).toHaveLength(1)
    fireEvent.click(undos[0])
    // every rewritten document came back, and the dirty flag with them
    expect(screen.getByText('Does things.')).toBeTruthy()
    expect(bodyLi('keep it simple')).toBeTruthy()
    expect(screen.queryByText(/Learned a quirk/)).toBeNull()
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
    expect(screen.queryByText('Undo this change')).toBeNull() // single-level: the snapshot cleared
    // the thread records the rollback for the agent's CONVERSATION context
    expect(screen.getByText('Last change undone — the rewrites above no longer apply.')).toBeTruthy()
    expect(storeMod.useStore.getState().toast).toBe('Last change undone.')
  })

  it('an instructions-only response renders the undo row beneath its system chip', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: null, instructions: '- be bold',
    }))
    render(<CreateFlow />)
    send('Toughen the rules')
    await waitFor(() => expect(screen.getByText('Build instructions updated.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText(/out of sync/)).toBeTruthy()
    const undos = screen.getAllByText('Undo this change')
    expect(undos).toHaveLength(1)
    // the row sits directly beneath the anchoring chip
    const chip = screen.getByText('Build instructions updated.')
    expect(chip.compareDocumentPosition(undos[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(undos[0])
    expect(bodyLi('keep it simple')).toBeTruthy()
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
  })

  it('a notes-only undo restores the notes and stays in sync', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: null, notes: '- The site rate-limits at 10 rpm',
    }))
    render(<CreateFlow />)
    send('Remember the rate limit')
    await waitFor(() => expect(screen.getByText('Notes updated.')).toBeTruthy(), { timeout: 3000 })
    expect(bodyLi('The site rate-limits at 10 rpm')).toBeTruthy()
    const undos = screen.getAllByText('Undo this change')
    expect(undos).toHaveLength(1)
    fireEvent.click(undos[0])
    expect(screen.queryByText(/rate-limits at 10 rpm/)).toBeNull()
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
  })

  it('undo after a chained sync restores the pre-request steps too', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Synced body.' }],
        actions: { sync: true },
      }))
      .mockResolvedValue({
        id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'sync',
        draft: {
          steps: [{ file: '01-new.py', name: 'Fetch feeds', description: '', code: 'log("new")' }],
          params: [], packages: [], triggers: [],
        },
      })
    render(<CreateFlow />)
    send('Rewrite and sync')
    await waitFor(() => expect(screen.getByText('Steps synced with the spec.')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getByText(/Fetch feeds/)).toBeTruthy() // the sync replaced the steps
    // the completed sync kept the snapshot — Undo reverts the whole request —
    // and re-anchored the row below its own "Steps synced" chip
    const undos = screen.getAllByText('Undo this change')
    expect(undos).toHaveLength(1)
    const synced = screen.getByText('Steps synced with the spec.')
    expect(synced.compareDocumentPosition(undos[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(undos[0])
    expect(screen.getByText('Does things.')).toBeTruthy()
    expect(screen.getByText(/Fetch pages/)).toBeTruthy()
    expect(screen.queryByText(/Fetch feeds/)).toBeNull()
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
  })

  it('the agent triggers the restore via the §8 undo action; a repeat finds nothing', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(done({
        spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten body.' }],
      }))
      .mockResolvedValue(done({ answer: 'Rolling the draft back.', actions: { undo: true } }))
    render(<CreateFlow />)
    send('Change it')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Rewritten body.')).toBeTruthy()
    send('undo that')
    await waitFor(
      () => expect(screen.getByText('Last change undone — the rewrites above no longer apply.')).toBeTruthy(),
      { timeout: 3000 },
    )
    // same restore as the button: draft back, snapshot consumed, row gone
    expect(screen.getByText('Does things.')).toBeTruthy()
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
    expect(screen.queryByText('Undo this change')).toBeNull()
    expect(storeMod.useStore.getState().toast).toBe('Last change undone.')
    send('undo that again')
    await waitFor(() => expect(screen.getByText('Nothing to undo.')).toBeTruthy(), { timeout: 3000 })
  })

  it('a manual spec Save clears the snapshot — no Undo over newer manual work', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten body.' }],
    }))
    render(<CreateFlow />)
    send('Change it')
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getAllByText('Undo this change')).toHaveLength(1)
    const specCard = cardOf(screen.getByText('SPEC'))
    fireEvent.click(within(specCard).getByText('Edit'))
    fireEvent.change(screen.getByDisplayValue(/Rewritten body\./),
      { target: { value: '# My auto\nHand-tuned body.' } })
    fireEvent.click(within(specCard).getByText('Save'))
    expect(screen.getByText('Hand-tuned body.')).toBeTruthy()
    expect(screen.queryByText('Undo this change')).toBeNull()
  })
})

describe('CreateFlow thread progress entry + input lock (§11)', () => {
  beforeEach(armPendingPoll)

  it('chat job: the thread shows the stage with the only spinner; Cancel in the composer (a1354db)', () => {
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: 'Do a thing' } })
    fireEvent.click(screen.getByText('Send'))
    // thread progress entry + the header save hint share the §11 label
    expect(screen.getAllByText('Working on the request…').length).toBe(2)
    const thread = screen.getByTestId('chat-thread')
    expect(within(thread).getByText('Working on the request…')).toBeTruthy()
    expect(spinnersIn(document.body).length).toBe(1)
    expect(spinnersIn(thread).length).toBe(1) // the progress entry's
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    expect(spinnersIn(panel).length).toBe(0)
    expect(within(panel).queryByText('Cancel')).toBeNull()
    expect(screen.getAllByText('Cancel').length).toBe(1) // the composer's
  })

  it('sync job: thread and panel share the sync line; spinner in the thread, Cancel in the composer', () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync spec'))
    // the same live line renders in the thread, as the panel's status text,
    // and as the Save hint (one unified stage vocabulary; no agent · model
    // attribution — the composer's picker names the agent)
    expect(screen.getAllByText('Syncing the workflow…').length).toBe(3)
    // §11: never an empty section — the live entry shows the stage's canned
    // description bullet until the stream produces a feed
    expect(screen.getByText('• Building the steps from the spec')).toBeTruthy()
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    expect(spinnersIn(document.body).length).toBe(1)
    expect(spinnersIn(screen.getByTestId('chat-thread')).length).toBe(1)
    expect(spinnersIn(panel).length).toBe(0)
    expect(within(panel).queryByText('Cancel')).toBeNull()
    expect(screen.getAllByText('Cancel').length).toBe(1)
    // the panel's sync button disables instead of turning into a cancel
    expect((within(panel).getByText('Sync spec').closest('button')!).disabled).toBe(true)
  })

  it('first turn: the unified stage walk — request → documents → chained sync, installs as bullets', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    const spec = [{ kind: 'h1', text: 'Folder watcher' }, { kind: 'p', text: 'Watches.' }]
    const building = (mode: string, stage: string, detail: string | null) => ({
      id: 'j1', status: 'building', stage, detail, error: null, mode, draft: null,
    })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(building('chat', 'Updating the documents', 'Writing the spec · 3 lines'))
      .mockResolvedValueOnce({
        id: 'j1', status: 'done', stage: 'Updating the documents', detail: null,
        error: null, mode: 'chat', draft: { spec, actions: { sync: true } },
      })
      .mockResolvedValue(building('sync', 'Syncing the workflow', 'Installing requests…'))
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    // the chat job opens at the neutral deciding stage (the pre-poll default)
    expect(screen.getByTestId('chat-progress').textContent).toContain('Working on the request…')
    // the documents phase shows the finer detail line as a bullet
    await waitFor(() => expect(screen.getByText('• Writing the spec · 3 lines')).toBeTruthy(), { timeout: 3000 })
    // §8: installs are bullets under the chained sync's workflow stage, never
    // a stage label of their own
    await waitFor(() => expect(screen.getByText('• Installing requests…')).toBeTruthy(), { timeout: 5000 })
    expect(screen.getAllByText('Syncing the workflow…').length).toBeGreaterThan(0)
    expect(screen.queryByText('Installing the packages…')).toBeNull()
  })

  it('Esc cancels a chat job like the composer Cancel and returns the prompt to the input', () => {
    render(<CreateFlow />)
    const input = () => screen.getByPlaceholderText('Change something, or ask a question…') as HTMLTextAreaElement
    fireEvent.change(input(), { target: { value: 'Do a thing' } })
    fireEvent.click(screen.getByText('Send'))
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(input().value).toBe('')
    fireEvent.keyDown(document, { key: 'Escape' })
    // job settled: Send is back and the request text returned to the input,
    // which takes focus with the caret at the end (§11 composer cancel)
    expect(screen.queryByText('Cancel')).toBeNull()
    expect(screen.getByText('Send')).toBeTruthy()
    expect(input().value).toBe('Do a thing')
    expect(document.activeElement).toBe(input())
    expect(input().selectionStart).toBe('Do a thing'.length)
    expect(input().selectionEnd).toBe('Do a thing'.length)
  })

  it('the composer Cancel button also refocuses the input with the caret at the end', () => {
    render(<CreateFlow />)
    const input = () => screen.getByPlaceholderText('Change something, or ask a question…') as HTMLTextAreaElement
    fireEvent.change(input(), { target: { value: 'Another thing' } })
    fireEvent.click(screen.getByText('Send'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(input().value).toBe('Another thing')
    expect(document.activeElement).toBe(input())
    expect(input().selectionStart).toBe('Another thing'.length)
  })

  it('Esc cancels a running sync; idle Esc is inert', async () => {
    render(<CreateFlow />)
    fireEvent.keyDown(document, { key: 'Escape' }) // no job — nothing happens
    expect(screen.getByText('Send')).toBeTruthy()
    fireEvent.click(screen.getByText('Sync spec'))
    expect(screen.getByText('Cancel')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Cancel')).toBeNull()
    // the cancel landed while the POST was in flight — the gen-guard cancels
    // the freshly created job once the POST resolves
    await waitFor(() => expect(mockedApi.cancelDraftJob).toHaveBeenCalled())
  })

  it('a live test disables the input with the wait placeholder', () => {
    storeMod.useStore.setState({
      test: { executionId: 'e9' },
      executions: [{
        id: 'e9', automationId: 'a1', automationName: 'My auto', automationDeleted: false, ver: 'v1',
        status: 'executing', trigger: 'Test', triggerSender: null, test: true,
        duration: '', started: '', startedMs: 1, endedMs: 0, queuedMs: 0, note: null, error: null,
      }] as never,
    })
    render(<CreateFlow />)
    const input = screen.getByPlaceholderText('Wait for the test to finish.') as HTMLTextAreaElement
    expect(input.disabled).toBe(true)
    expect((screen.getByText('Send').closest('button')!).disabled).toBe(true)
  })
})

describe('CreateFlow clear chat (§11)', () => {
  beforeEach(armPendingPoll)
  const done = (draft: Record<string, unknown>) => ({
    id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'chat', draft,
  })
  const send = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'), { target: { value: text } })
    fireEvent.click(screen.getByText('Send'))
  }
  const clearBtn = () => screen.getByTestId('chat-clear') as HTMLButtonElement

  it('disabled on an empty thread and while a job runs; confirm empties the thread and the undo snapshot', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'Rewritten body.' }],
    }))
    render(<CreateFlow />)
    expect(clearBtn().disabled).toBe(true) // empty thread
    send('Change it')
    expect(clearBtn().disabled).toBe(true) // job in flight
    await waitFor(() => expect(screen.getByText('Spec updated.')).toBeTruthy(), { timeout: 3000 })
    expect(clearBtn().disabled).toBe(false)
    expect(screen.getAllByText('Undo this change')).toHaveLength(1)
    // confirm step — cancelling keeps the thread
    fireEvent.click(clearBtn())
    expect(screen.getByText('Clear this conversation?')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByText('Spec updated.')).toBeTruthy()
    // confirming empties the thread; the undo row's snapshot clears with it
    fireEvent.click(clearBtn())
    fireEvent.click(document.querySelector('.ad-btn-danger-ghost') as HTMLButtonElement)
    await waitFor(() => expect(screen.queryByText('Spec updated.')).toBeNull())
    expect(screen.queryByText('Undo this change')).toBeNull()
    expect(clearBtn().disabled).toBe(true) // empty again
    // the draft itself is untouched: still out of sync from the rewrite
    expect(screen.getByText('The workflow is out of sync — these steps still match the old spec.')).toBeTruthy()
    // the composer still works
    expect((screen.getByPlaceholderText('Change something, or ask a question…') as HTMLTextAreaElement).disabled).toBe(false)
  })
})

describe('CreateFlow left-column cards + test-failure repair (§11)', () => {
  beforeEach(armPendingPoll)

  it('agents and secrets cards default collapsed with counts; warnings force them open', () => {
    storeMod.useStore.setState({
      automations: [{
        ...AUTO,
        steps: [{ file: '01-a.py', name: 'Judge', description: '', code: `x = secrets["${CRM_ID}"]`, agent: true, why: 'w', agents: [{ id: 'g2' }] }],
      } as unknown as Automation],
    })
    render(<CreateFlow />)
    expect(screen.getByText('2 of 2 enabled')).toBeTruthy()
    expect(screen.getByText('2 of 2 allowed')).toBeTruthy()
    expect(collapseOf(screen.getByText('Cloud writer')).classList.contains('open')).toBe(false)
    expect(collapseOf(screen.getByText('MAIL_PASSWORD')).classList.contains('open')).toBe(false)
    // unchecking the called agent opens the card on its warning…
    fireEvent.click(screen.getByText('qwen3:8b'))
    expect(collapseOf(rowText('Cloud writer')).classList.contains('open')).toBe(true)
    expect(screen.getByText(/isn’t enabled here/)).toBeTruthy()
    // …and re-checking collapses it again (never sticky)
    fireEvent.click(screen.getByText('qwen3:8b'))
    expect(collapseOf(rowText('Cloud writer')).classList.contains('open')).toBe(false)
    // same for a disallowed secret the steps use (the step tag renders the
    // name too — target the card's own checkbox row)
    const secCard = cardOf(screen.getByText('SECRETS · ALLOWED FOR STEPS'))
    fireEvent.click(within(secCard).getByText('CRM_API_KEY'))
    expect(collapseOf(rowText('MAIL_PASSWORD')).classList.contains('open')).toBe(true)
    expect(screen.getByText(/isn’t allowed here/)).toBeTruthy()
  })

  it('NOTES card: collapsed by default, view/edit works, and never marks the workflow out of sync', () => {
    storeMod.useStore.setState({
      automations: [{ ...AUTO, notes: '- Site rate-limits at 10 rpm' } as unknown as Automation],
    })
    render(<CreateFlow />)
    const body = bodyLi('Site rate-limits at 10 rpm')
    expect(collapseOf(body).classList.contains('open')).toBe(false)
    fireEvent.click(screen.getByText('NOTES'))
    expect(collapseOf(body).classList.contains('open')).toBe(true)
    const card = cardOf(screen.getByText('NOTES'))
    fireEvent.click(within(card).getByText('Edit'))
    fireEvent.change(card.querySelector('textarea')!, { target: { value: '- Pruned' } })
    fireEvent.click(within(card).getByText('Save'))
    expect(bodyLi('Pruned')).toBeTruthy()
    // §4.1: notes never mark the workflow out of sync or block saving
    expect(screen.getByText(/In sync with the spec/)).toBeTruthy()
    expect(screen.queryByText(/out of sync/)).toBeNull()
    expect((screen.getByText('Save as v2').closest('button')!).disabled).toBe(false)
  })

  it('Analyze failure posts the canned chat message with the run id', async () => {
    const failed = {
      id: 'e9', automationId: 'a1', automationName: 'My auto', automationDeleted: false, ver: 'v1',
      status: 'failed', trigger: 'Test', triggerSender: null, test: true,
      duration: '1s', started: '', startedMs: 1, endedMs: 2, queuedMs: 0, note: null,
      error: { step: 'Fetch pages', message: 'boom', reason: null }, steps: [],
    }
    storeMod.useStore.setState({
      test: { executionId: 'e9' }, executions: [failed] as never, executionFull: { e9: failed } as never,
    })
    render(<CreateFlow />)
    expect(screen.getByText('Test failed.')).toBeTruthy()
    fireEvent.click(screen.getByText('Analyze failure'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    expect(body.mode).toBe('chat')
    expect(body.executionId).toBe('e9')
    expect(body.text).toBe('The test failed at step Fetch pages — figure out why. If the automation is at fault, fix it; if it’s something I need to do on this Mac, tell me what to do and how instead.')
    // the canned message lands as a user entry in the thread
    expect(screen.getByText(body.text as string)).toBeTruthy()
    // §11: while the chat job runs the button disables — never hidden
    const analyze = screen.getByText('Analyze failure').closest('button')!
    expect(analyze.disabled).toBe(true)
  })

  it('NOTES card: Edit is offered even while the notes are empty', () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('NOTES'))
    const card = cardOf(screen.getByText('NOTES'))
    expect(within(card).getAllByText(/No notes yet/).length).toBeGreaterThan(0)
    fireEvent.click(within(card).getByText('Edit'))
    // §11: the editor caps at the Build-instructions 440px and scrolls inside
    const ta = card.querySelector('textarea')!
    expect(ta.style.maxHeight).toBe('440px')
    fireEvent.change(ta, { target: { value: '- Added by hand' } })
    fireEvent.click(within(card).getByText('Save'))
    expect(bodyLi('Added by hand')).toBeTruthy()
  })

  it('rename pencils hide on the create empty state and show once a revision exists', () => {
    storeMod.useStore.setState({ createFrom: 'app', automationId: null })
    render(<CreateFlow />)
    expect(screen.getByText('New automation')).toBeTruthy()
    expect(screen.queryByTitle('Rename')).toBeNull()
    expect(screen.queryByTitle('Edit the description')).toBeNull()
    cleanup()
    // edit mode viewing the draft: a revision exists — both pencils render
    storeMod.useStore.setState({ createFrom: 'edit', automationId: 'a1' })
    render(<CreateFlow />)
    expect(screen.getByTitle('Rename')).toBeTruthy()
    expect(screen.getByTitle('Edit the description')).toBeTruthy()
  })

  it('title rename into another automation’s name shows the inline error and posts nothing (§4.1)', () => {
    storeMod.useStore.setState({ automations: [AUTO, { ...AUTO, id: 'a2', name: 'Other auto' }] })
    render(<CreateFlow />)
    fireEvent.click(screen.getByTitle('Rename'))
    const input = screen.getByDisplayValue('My auto')
    // case-insensitive and trimmed — padding can't dodge the check
    fireEvent.change(input, { target: { value: ' other AUTO ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('An automation named other AUTO already exists — pick a different name.')).toBeTruthy()
    expect(mockedApi.patchAutomation).not.toHaveBeenCalled()
    // the input stayed open; typing clears the error and a free name commits
    fireEvent.change(input, { target: { value: 'Fresh name' } })
    expect(screen.queryByText(/already exists/)).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockedApi.patchAutomation).toHaveBeenCalledWith('a1', { name: 'Fresh name' })
  })

  it('zero agents: edit mode redirects to Agents with the toast', () => {
    storeMod.useStore.setState({ agents: [] })
    render(<CreateFlow />)
    const s = storeMod.useStore.getState()
    expect(s.surface).toBe('app')
    expect(s.page).toBe('agents')
    expect(s.toast).toBe('No agent yet — add one here first. Creating and editing automations needs an AI.')
  })

  it('drafting-agent picker: selecting toasts, a busy rewrite disables it', () => {
    render(<CreateFlow />)
    const pick = screen.getByTitle('The agent that writes the spec and generates the steps') as HTMLButtonElement
    expect(pick.textContent).toContain('Cloud writer · Default model')
    fireEvent.click(pick)
    fireEvent.click(within(pick.parentElement!).getByText('Fast local'))
    expect(storeMod.useStore.getState().toast).toBe('Fast local · qwen3:8b now writes the spec and steps here.')
    expect(pick.textContent).toContain('Fast local · qwen3:8b')
    // a running sync locks the picker
    fireEvent.click(screen.getByText('Sync spec'))
    expect(pick.disabled).toBe(true)
  })
})

describe('CreateFlow boundary markers + history-inert thread (§4.4/§11)', () => {
  beforeEach(armPendingPoll)
  const getChatMock = () => mockedApi.getChat as ReturnType<typeof vi.fn>

  it('renders the marker with the history explainer; a marker-terminated thread offers no actions', async () => {
    getChatMock().mockResolvedValueOnce({ chat: [
      { id: 'h1', kind: 'user', text: 'old request' },
      { id: 'h2', kind: 'blockers', source: 'steps', blockers: [{ reason: 'r', fix: 'f' }] },
      { id: 'm1', kind: 'system', icon: 'fa-flag-checkered', boundary: true, text: 'Draft saved as v2.' },
    ] })
    render(<CreateFlow />)
    // the stored thread merges in with the marker as its last entry
    await screen.findByText('Draft saved as v2.')
    // §11: the marker is the one system chip with a description bullet — the
    // derived history explainer
    screen.getByText(/The messages above are from that draft — your AI starts fresh/)
    // §11: no divider while the marker is the thread's last entry — the rule
    // only sits between a settled conversation and the next one
    expect(screen.queryByTestId('chat-boundary-divider')).toBeNull()
    // §11 history-inert: the turn action row never renders under a settled
    // session — the in-sync draft would otherwise offer the Test-draft pill
    expect(screen.queryByTestId('chat-turn-actions')).toBeNull()
    // a history blockers entry collapses to its dismissed summary whatever its
    // stored flag says — its Dismiss/Apply buttons are gone with it
    screen.getByText('1 blocker — dismissed')
    expect(screen.queryByText('Your AI hit a blocker')).toBeNull()
    expect(screen.queryByText('Apply to the spec & sync')).toBeNull()
  })

  it('entries after the marker act normally — the turn action row returns with the new session', async () => {
    getChatMock().mockResolvedValueOnce({ chat: [
      { id: 'm1', kind: 'system', icon: 'fa-flag-checkered', boundary: true, text: 'Draft discarded.' },
      { id: 'n1', kind: 'system', icon: 'fa-vial', text: 'Draft execution succeeded.' },
    ] })
    render(<CreateFlow />)
    await screen.findByText('Draft discarded.')
    // an entry follows the marker → the divider renders, and only under the
    // marker (the plain system chip after it carries none)
    expect(screen.getAllByTestId('chat-boundary-divider')).toHaveLength(1)
    // post-boundary entry at the end → the in-sync draft's Test pill is back
    await waitFor(() => expect(screen.getByTestId('chat-turn-actions')).toBeTruthy())
    screen.getByTestId('chat-test-draft')
  })

  it('create mode: persisted error entries render with no Try again anywhere', async () => {
    // The removed create pipeline's spec-call errors carried a Try-again pill;
    // unified chat failures never do — legacy persisted entries render plain.
    // A pending draft resumes here, so the slot thread merges (§4.4).
    storeMod.useStore.setState({ createFrom: 'new', automationId: null })
    ;(mockedApi.getDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      draft: { spec: [{ kind: 'h1', text: 'Kept' }, { kind: 'p', text: 'Body.' }], steps: [] },
      agentId: null,
    })
    getChatMock().mockResolvedValueOnce({ chat: [
      { id: 'e1', kind: 'error', source: 'spec', text: 'old failure' },
      { id: 'm1', kind: 'system', icon: 'fa-flag-checkered', boundary: true, text: 'Draft discarded.' },
      { id: 'e2', kind: 'error', source: 'spec', text: 'fresh failure' },
    ] })
    render(<CreateFlow />)
    await screen.findByText('fresh failure')
    screen.getByText('old failure') // history stays visible…
    // …and neither session's failure offers a retry pill
    expect(screen.queryByText('Try again')).toBeNull()
  })

  it('fresh create entry discards a leftover slot thread — the suggestions stay (§4.4 fresh-entry clear)', async () => {
    // No pending draft to resume: the settled session's thread must never
    // replay over the create empty state — it is dropped and unlinked.
    storeMod.useStore.setState({ createFrom: 'new', automationId: null })
    getChatMock().mockResolvedValueOnce({ chat: [
      { id: 'a1', kind: 'activity', title: 'Working on the request…', text: 'Choosing what to do', outcome: 'done' },
      { id: 'm1', kind: 'system', icon: 'fa-flag-checkered', boundary: true, text: 'Draft discarded.' },
    ] })
    render(<CreateFlow />)
    await waitFor(() => expect(mockedApi.putChat).toHaveBeenCalledWith('pending', []))
    // the empty state stands; nothing from the old session renders
    screen.getByRole('heading', { name: 'What should Autowright do for you?' })
    expect(screen.queryByText('Working on the request…')).toBeNull()
    expect(screen.queryByText('Draft discarded.')).toBeNull()
  })

  it('a resumed pending draft keeps its slot thread (§4.4 — the clear is entry-without-draft only)', async () => {
    storeMod.useStore.setState({ createFrom: 'new', automationId: null })
    ;(mockedApi.getDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      draft: { spec: [{ kind: 'h1', text: 'Kept' }, { kind: 'p', text: 'Body.' }], steps: [] },
      agentId: null,
    })
    getChatMock().mockResolvedValueOnce({ chat: [
      { id: 'm1', kind: 'system', icon: 'fa-flag-checkered', boundary: true, text: 'Draft discarded.' },
    ] })
    render(<CreateFlow />)
    await screen.findByText('Draft discarded.')
    expect(mockedApi.putChat).not.toHaveBeenCalledWith('pending', [])
  })
})

describe('CreateFlow old-version view: thread survival + test gating (§11)', () => {
  beforeEach(armPendingPoll)
  const V1_ROW = {
    version: 1, when: 'Jul 1', note: null,
    spec: AUTO.spec, steps: AUTO.steps, instructions: '', notes: '', params: [], packages: [],
  }
  const testRow = (status: string) => ({
    id: 'e9', automationId: 'a1', automationName: 'My auto', automationDeleted: false, ver: 'Test',
    status, trigger: 'Test', triggerSender: null, test: true, steps: [],
    duration: '', started: '', startedMs: 1, endedMs: status === 'executing' ? 0 : 2,
    queuedMs: 0, note: null, error: null,
  })

  it('a test chip landed while viewing v1 survives Back to draft (shown blocks never removed)', async () => {
    storeMod.useStore.setState({
      automations: [{ ...AUTO, version: 2, versions: [V1_ROW] } as unknown as Automation],
      test: { executionId: 'e9' },
      executions: [testRow('executing')] as never,
      executionFull: { e9: testRow('executing') } as never,
    })
    render(<CreateFlow />)
    // touch the draft so leaving the Draft view stashes it (§4.4)
    fireEvent.click(rowText('Fast local'))
    fireEvent.click(screen.getByTestId('version-menu'))
    fireEvent.click(screen.getByText('v1'))
    expect(screen.getByText(/Loaded v1 from history/)).toBeTruthy()
    // the live test settles while v1 is viewed - the run chip lands in the thread
    storeMod.useStore.setState({
      executions: [testRow('succeeded')] as never,
      executionFull: { e9: testRow('succeeded') } as never,
    })
    await waitFor(() => expect(screen.getByText('Test succeeded.')).toBeTruthy())
    // returning to the draft keeps the live thread - the chip never vanishes
    fireEvent.click(screen.getByText('Back to draft'))
    expect(screen.queryByText(/Loaded v1 from history/)).toBeNull()
    expect(screen.getByText('Test succeeded.')).toBeTruthy()
  })

  it('viewing an old version disables the test controls - an old version is never tested', async () => {
    storeMod.useStore.setState({
      automations: [{ ...AUTO, version: 2, versions: [V1_ROW] } as unknown as Automation],
    })
    render(<CreateFlow />)
    expect((screen.getByTestId('test-draft-toggle') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('version-menu'))
    fireEvent.click(screen.getByText('v1'))
    const toggle = screen.getByTestId('test-draft-toggle') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle) // inert - the setup section never opens
    expect(screen.queryByText('Run test')).toBeNull()
    expect(mockedApi.postTest).not.toHaveBeenCalled()
    // back on the draft the toggle re-enables
    fireEvent.click(screen.getByText('Back to draft'))
    expect((screen.getByTestId('test-draft-toggle') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('CreateFlow send/sync edit guard + settle flush + poll retry (§11)', () => {
  beforeEach(armPendingPoll)
  const done = (draft: Record<string, unknown>) => ({
    id: 'j1', status: 'done', stage: null, detail: null, error: null, mode: 'chat', draft,
  })
  const send = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'), { target: { value: text } })
    fireEvent.click(screen.getByText('Send'))
  }
  const STAGED_CHIP = 'Parameter “greeting” staged — applies when you save.'

  it('leaving with Keep draft mid-chained-sync flushes the held workflow chips (hold-and-flush)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(done({
      spec: [{ kind: 'h1', text: 'My auto' }, { kind: 'p', text: 'With greeting.' }],
      actions: { paramValues: { greeting: 'hi' }, sync: true },
    }))
    render(<CreateFlow />)
    send('stage greeting and sync')
    // the chat settles, the chained sync starts and never answers (held chips)
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(screen.queryByText(STAGED_CHIP)).toBeNull() // held, not landed
    // back (the §4.4 keep path) - the settle flush lands the receipts
    fireEvent.click(screen.getAllByText('My auto').find((el) => el.closest('button'))!)
    await waitFor(() => {
      const calls = (mockedApi.putChat as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some((c) => (c[1] as Array<{ text?: string }>).some((e) => e.text === STAGED_CHIP))).toBe(true)
    })
    await waitFor(() => expect(screen.getByText(STAGED_CHIP)).toBeTruthy())
  })

  it('leaving mid-chat-job never cancels it — the job keeps building in the background (§19)', async () => {
    render(<CreateFlow />)
    send('rename everything')
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    // leave via the header back — §19 background continuation: the exit
    // flushes the thread with the pending user entry as-is (no "Edit stopped"
    // chip: the turn is still running) and never DELETEs the job.
    fireEvent.click(screen.getAllByText('My auto').find((el) => el.closest('button'))!)
    await waitFor(() => {
      const calls = (mockedApi.putChat as ReturnType<typeof vi.fn>).mock.calls
      const flushed = calls.map((c) => c[1] as Array<{ kind: string; text?: string }>)
      expect(flushed.some((list) =>
        list.some((e) => e.kind === 'user' && e.text === 'rename everything'))).toBe(true)
      expect(flushed.some((list) =>
        list.some((e) => e.text === 'Edit stopped — the spec is unchanged.'))).toBe(false)
    })
    expect(mockedApi.cancelDraftJob).not.toHaveBeenCalled()
  })

  it('sending under an unsaved spec edit asks first; cancel keeps both texts, confirm proceeds', async () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByTestId('spec-edit'))
    fireEvent.change(screen.getByTestId('spec-editor'), { target: { value: '# My auto\nTyped change.' } })
    const input = screen.getByPlaceholderText('Change something, or ask a question…') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'and also weekends' } })
    fireEvent.click(screen.getByText('Send'))
    // the discard confirm gates the send - no job yet
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Discard your spec edits?')).toBeTruthy()
    expect(mockedApi.postDraftJob).not.toHaveBeenCalled()
    // cancelling aborts: composer text and the open editor both survive
    fireEvent.click(within(dialog).getByText('Cancel'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(input.value).toBe('and also weekends')
    expect((screen.getByTestId('spec-editor') as HTMLTextAreaElement).value).toBe('# My auto\nTyped change.')
    expect(mockedApi.postDraftJob).not.toHaveBeenCalled()
    // confirming discards the edits and the send proceeds
    fireEvent.click(screen.getByText('Send'))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Discard edits'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    expect(draftBody(0).text).toBe('and also weekends')
    expect(screen.queryByTestId('spec-editor')).toBeNull()
  })

  it('starting a sync under an unsaved instructions edit asks the same way', async () => {
    render(<CreateFlow />)
    const card = cardOf(screen.getByText('BUILD INSTRUCTIONS'))
    fireEvent.click(screen.getByText('BUILD INSTRUCTIONS'))
    fireEvent.click(within(card).getByText('Edit'))
    fireEvent.change(card.querySelector('textarea')!, { target: { value: '- new rule' } })
    fireEvent.click(screen.getByText('Sync spec'))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Discard your instruction edits?')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('Cancel'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(mockedApi.postDraftJob).not.toHaveBeenCalled()
    expect((card.querySelector('textarea') as HTMLTextAreaElement).value).toBe('- new rule')
  })

  it('Fix with AI waits for the stored thread - the job carries the kept history and the seed', async () => {
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ chat: [
      { id: 'c1', at: '2026-08-01T00:00:00Z', kind: 'user', text: 'Earlier question' },
    ] })
    const failed = {
      id: 'e7', automationId: 'a1', automationName: 'My auto', automationDeleted: false, ver: 'v1',
      status: 'failed', trigger: 'Manual', triggerSender: null, test: false, steps: [],
      duration: '1s', started: '', startedMs: 1, endedMs: 2, queuedMs: 0, note: null,
      error: { step: 'Fetch pages', message: 'boom', reason: null },
    }
    storeMod.useStore.setState({ fixExec: 'e7', executions: [failed] as never, executionFull: { e7: failed } as never })
    render(<CreateFlow />)
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const body = draftBody(0)
    expect(body.executionId).toBe('e7')
    expect(String(body.text)).toMatch(/^This execution failed/)
    const chat = body.chat as Array<{ kind: string; text?: string }>
    expect(chat.some((e) => e.text === 'Earlier question')).toBe(true)
    expect(chat.some((e) => e.kind === 'system' && /Execution failed at step Fetch pages/.test(e.text ?? ''))).toBe(true)
  })

  it('one transient poll error never fails the job - the next tick recovers it', async () => {
    let calls = 0
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new Error('socket hiccup')
      return done({ answer: 'All good' })
    })
    render(<CreateFlow />)
    send('hello')
    await waitFor(() => expect(screen.getByText('All good')).toBeTruthy(), { timeout: 6000 })
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })

  it('three consecutive poll failures give up with the error entry', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('backend gone')
    })
    render(<CreateFlow />)
    send('hello')
    await waitFor(() => expect(screen.getByText('Something went wrong')).toBeTruthy(), { timeout: 8000 })
    expect(screen.getByText('backend gone')).toBeTruthy()
  })
})

describe('CreateFlow background continuation & re-attach (§11/§19)', () => {
  beforeEach(() => {
    armPendingPoll()
    storeMod.useStore.setState({ draftJobs: [] })
  })
  const USER_ENTRY = { id: 'u1', at: '2026-08-20T08:00:00', kind: 'user' as const, text: 'add weekends' }
  const jobRow = (status: string, mode: 'chat' | 'sync' = 'chat') =>
    [{ owner: 'a1', jobId: 'jx', status, mode }]

  it('re-attaches a building chat job on entry — poll resumes, no cancel, no chip', async () => {
    storeMod.useStore.setState({ draftJobs: jobRow('building') })
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({ chat: [USER_ENTRY] })
    render(<CreateFlow />)
    await waitFor(() => expect(mockedApi.getDraftJob).toHaveBeenCalledWith('jx'))
    // the composer swaps Send for the running job's Cancel (§11 in-flight rules)
    await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy())
    expect(screen.queryByText('Edit stopped — the spec is unchanged.')).toBeNull()
    expect(mockedApi.postDraftJob).not.toHaveBeenCalled()
    expect(mockedApi.cancelDraftJob).not.toHaveBeenCalled()
  })

  it('applies a held chat outcome on entry exactly like a live settle, then acks', async () => {
    storeMod.useStore.setState({ draftJobs: jobRow('done') })
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({ chat: [USER_ENTRY] })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'jx', status: 'done', stage: 'Working on the request', detail: null, error: null,
      mode: 'chat', events: [], draft: { spec: null, answer: 'All set.' },
    })
    render(<CreateFlow />)
    await waitFor(() => expect(screen.getByText('All set.')).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText('From your AI')).toBeTruthy()
    await waitFor(() => expect(mockedApi.ackDraftJob).toHaveBeenCalledWith('jx'))
    // the settled stage trail landed too — never a bare outcome
    expect(screen.getByText(/Working on the request/)).toBeTruthy()
  })

  it('a vanished job closes the orphaned turn with the Edit-stopped chip', async () => {
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({ chat: [USER_ENTRY] })
    render(<CreateFlow />)
    await waitFor(() => expect(screen.getByText('Edit stopped — the spec is unchanged.')).toBeTruthy())
    expect(mockedApi.getDraftJob).not.toHaveBeenCalled()
  })

  it('a background settle drops trigger ops when the base list is not the one the agent saw', async () => {
    storeMod.useStore.setState({ draftJobs: jobRow('done') })
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({ chat: [USER_ENTRY] })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'jx', status: 'done', stage: 'Working on the request', detail: null, error: null,
      mode: 'chat', events: [],
      // the agent saw a one-entry list; the editor's base list is empty now
      sentTriggers: [{ kind: 'cron', expression: '0 8 * * *', enabled: true }],
      draft: { spec: null, actions: { triggers: [{ op: 'add', trigger: { kind: 'cron', expression: '0 9 * * *', enabled: true } }] } },
    })
    render(<CreateFlow />)
    await waitFor(() => expect(screen.getByText('Trigger changes dropped — the triggers changed while your AI worked. Ask again.')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByText('Trigger added.')).toBeNull()
  })

  it('a background settle applies trigger ops when the base list still matches', async () => {
    storeMod.useStore.setState({ draftJobs: jobRow('done') })
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({ chat: [USER_ENTRY] })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'jx', status: 'done', stage: 'Working on the request', detail: null, error: null,
      mode: 'chat', events: [], sentTriggers: [],
      draft: { spec: null, actions: { triggers: [{ op: 'add', trigger: { kind: 'cron', expression: '0 9 * * *', enabled: true } }] } },
    })
    render(<CreateFlow />)
    await waitFor(() => expect(screen.getByText('Trigger added.')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByText(/Trigger changes dropped/)).toBeNull()
  })

  it('a slot that owns a building job keeps its thread and re-attaches (fresh-entry clear skipped)', async () => {
    storeMod.useStore.setState({
      createFrom: 'new' as never, automationId: null,
      draftJobs: [{ owner: 'pending', jobId: 'jp', status: 'building', mode: 'chat' }],
    })
    ;(mockedApi.getDraft as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      draft: null, agentId: null, job: { jobId: 'jp', status: 'building', mode: 'chat' },
    })
    ;(mockedApi.getChat as ReturnType<typeof vi.fn>).mockResolvedValue({
      chat: [{ id: 'u9', at: '2026-08-20T08:00:00', kind: 'user', text: 'watch a price' }],
    })
    render(<CreateFlow />)
    // §11: the job ref counts as something to resume — the thread stays
    // (never PUT [] over it) and the poll re-attaches to the slot's job.
    await waitFor(() => expect(mockedApi.getDraftJob).toHaveBeenCalledWith('jp'))
    expect(mockedApi.putChat).not.toHaveBeenCalledWith('pending', [])
    expect(screen.getByText('watch a price')).toBeTruthy()
  })
})
