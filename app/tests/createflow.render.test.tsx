// Component tests for the §11 create/edit page: grant checkboxes keeping
// unchecked agents/secrets out of every drafting-job payload (§8), the Build &
// test panel, blockers thread entries, applying chat responses, the footer
// action block, and the left-column cards. CreateFlow renders for real
// (happy-dom) in edit mode with the store seeded and the api module mocked;
// payload assertions read the exact POST /drafts bodies.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Agent, Auto, SecretMeta } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    instructions: vi.fn(async () => ({ framework: '# Framework', defaultBuild: '- rules' })),
    postDraftJob: vi.fn(async () => ({ jobId: 'j1' })),
    getDraftJob: vi.fn(() => new Promise(() => { /* poll never answers in tests */ })),
    cancelDraftJob: vi.fn(async () => ({})),
    putDraft: vi.fn(async () => ({})),
    deleteDraft: vi.fn(async () => ({})),
    putPendingDraft: vi.fn(async () => ({})),
    getPendingDraft: vi.fn(async () => ({ draft: null, agentId: null })),
    openPendingDraft: vi.fn(async () => ({})),
    deletePendingDraft: vi.fn(async () => ({})),
    checkPackages: vi.fn(async () => ({ packages: [] })),
    outdatedPackages: vi.fn(async () => ({ packages: [] })),
    postTest: vi.fn(async () => ({ execId: 'e1' })),
    analyzeExec: vi.fn(async () => ({})),
    getAuto: vi.fn(async () => ({})),
    state: vi.fn(async () => ({})),
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
const SECRETS: SecretMeta[] = [
  { name: 'MAIL_PASSWORD', desc: '', set: true, usedBy: '' },
  { name: 'CRM_API_KEY', desc: '', set: true, usedBy: '' },
]
const AUTO = {
  id: 'a1', name: 'My auto', desc: '', version: 1,
  triggers: [], triggerChip: 'No triggers', triggersOff: false, nextAt: null,
  instr: '- keep it simple',
  lastStatus: 'none', live: [], resultChip: null, resultStatus: null, lastExecLabel: '',
  agentId: 'g1', stepAgents: ['g1', 'g2'], allowedSecrets: ['MAIL_PASSWORD', 'CRM_API_KEY'],
  snapshotSettings: { preVersion: true, preClear: true, preRestore: true },
  specMeta: '', params: [],
  steps: [{ file: '01-a.py', name: 'Fetch pages', desc: '', code: 'log("a")' }],
  spec: [{ k: 'h1', text: 'My auto' }, { k: 'p', text: 'Does things.' }],
  packages: [], versions: [], draft: null,
} as unknown as Auto

beforeEach(() => {
  vi.clearAllMocks()
  storeMod.useStore.setState({
    surface: 'create', createFrom: 'edit', page: 'automations', autoId: 'a1',
    autos: [AUTO], agents: AGENTS, secrets: SECRETS,
    execs: [], execFull: {}, execLogs: {}, toast: null, test: null,
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
// getAuto echo the seeded automation: the mount-time loadAuto stores its
// response verbatim, and the default `{}` would erase the auto (no id match)
// the moment the test awaits anything.
const armPendingPoll = () => {
  ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => { /* poll never answers */ }))
  ;(mockedApi.getAuto as ReturnType<typeof vi.fn>).mockImplementation(async () => storeMod.useStore.getState().autos[0] ?? {})
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
    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    expect(body.mode).toBe('sync')
    expect(body.autoId).toBe('a1')
    expect(body.enabledAgents).toEqual(['g1'])                    // g2 gone
    expect(body.allowedSecrets).toEqual(['MAIL_PASSWORD'])        // CRM_API_KEY gone
    // the serialized in-editor draft carries the same trimmed grants
    const current = body.current as { stepAgents: string[]; allowedSecrets: string[] }
    expect(current.stepAgents).toEqual(['g1'])
    expect(current.allowedSecrets).toEqual(['MAIL_PASSWORD'])
  })

  it('unchecking everything sends explicit empty arrays, not missing keys', async () => {
    render(<CreateFlow />)
    fireEvent.click(rowText('Cloud writer'))
    fireEvent.click(rowText('Fast local'))
    fireEvent.click(rowText('MAIL_PASSWORD'))
    fireEvent.click(rowText('CRM_API_KEY'))
    expect(screen.getByText('0 of 2 enabled')).toBeTruthy()
    expect(screen.getByText('0 of 2 allowed')).toBeTruthy()

    fireEvent.click(screen.getByText('Sync with spec'))
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
    expect(body.allowedSecrets).toEqual(['MAIL_PASSWORD'])        // unchecked secret gone
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

    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    expect(draftBody(0).enabledAgents).toEqual(['g1', 'g2'])
  })
})

describe('CreateFlow Build & test panel (§11)', () => {
  it('out of sync (grant gap): Sync now shows, Test disables with the sync-first hint', async () => {
    // an agent step pinned to g2 — unchecking g2 opens a derived grant gap
    storeMod.useStore.setState({
      autos: [{
        ...AUTO,
        steps: [{ file: '01-a.py', name: 'Judge', desc: '', code: 'log("a")', agent: true, why: 'w', agents: ['Fast local'] }],
      } as unknown as Auto],
    })
    render(<CreateFlow />)
    // the step tag renders the same name — target the checkbox row through its
    // model line ('qwen3:8b' is unique to it); the click bubbles to the row
    const agentRow = () => screen.getByText('qwen3:8b')
    fireEvent.click(agentRow())     // uncheck the agent the step calls
    expect(screen.getByText('Sync now')).toBeTruthy()
    expect(screen.getByText(/steps call an agent that isn’t enabled/)).toBeTruthy()
    // the Test button stays visible but disabled, with the §11 hint
    const testBtn = screen.getByText('Test the draft').closest('button')!
    expect(testBtn.disabled).toBe(true)
    expect(screen.getByText('Sync first — a test executes the steps as generated from the spec.')).toBeTruthy()
    // re-checking the grant clears the gap instantly — Test re-enables
    fireEvent.click(agentRow())
    expect(screen.getByText('Sync with spec')).toBeTruthy()
    expect((screen.getByText('Test the draft').closest('button')!).disabled).toBe(false)
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
    const testBtn = within(panel).getByText('Test the draft').closest('button')!
    expect(testBtn.disabled).toBe(false)
    expect(testBtn.classList.contains('ad-btn-text')).toBe(true)
    const syncBtn = within(panel).getByText('Sync with spec').closest('button')!
    expect(syncBtn.classList.contains('ad-btn-text')).toBe(true)
    expect(syncBtn.classList.contains('dim')).toBe(true)
  })

  it('Test the draft is a disclosure: setup shows every option at once, only Run test starts it', async () => {
    armPendingPoll()
    storeMod.useStore.setState({
      autos: [{
        ...AUTO,
        params: [{ name: 'city', kind: 'text', label: 'City', help: '', value: 'Oslo' }],
        triggers: [{ kind: 'discord', channel: '#general', secret: 'DISCORD_TOKEN', off: false }],
      } as unknown as Auto],
    })
    render(<CreateFlow />)
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    // collapsed: no setup section, no Run test
    expect(within(panel).queryByText('Run test')).toBeNull()
    expect(within(panel).queryByText('PARAMETER VALUES · THIS TEST ONLY')).toBeNull()
    // the toggle expands the setup — it never starts a test
    fireEvent.click(within(panel).getByText('Test the draft'))
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

  it('a diagnosed blocked sync lands a thread blockers entry with the build-failure headline', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'sync', blockedAt: 'steps', diagnosed: true,
      blockers: [{ reason: 'The build failed validation.', fix: 'Simplify the spec.' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(
      () => expect(screen.getByText('The build failed — your AI suggests these fixes')).toBeTruthy(),
      { timeout: 3000 },
    )
    // same editable cards + apply action as an agent-refusal blocker
    expect(screen.getByDisplayValue('The build failed validation.')).toBeTruthy()
    expect(screen.getByText('Apply to the spec & sync')).toBeTruthy()
  })

  it('an undiagnosed blocked sync keeps the agent-refusal headline', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'sync', blockedAt: 'steps',
      blockers: [{ reason: 'Needs a channel id.', fix: 'Name it in the spec.' }],
    })
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(
      () => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(),
      { timeout: 3000 },
    )
  })
})

describe('CreateFlow blockers thread entries (§11)', () => {
  beforeEach(armPendingPoll)

  it('fields lock while a job is busy and unlock when it settles (cb095d9)', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BLOCKED_SYNC)
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // sync-source explainer
    expect(screen.getByText('It couldn’t sync the steps with the spec. Edit the fix below, then apply it to the spec and sync again.')).toBeTruthy()
    const fix = screen.getByDisplayValue('Name it in the spec.') as HTMLTextAreaElement
    expect(fix.readOnly).toBe(false)
    fireEvent.change(fix, { target: { value: 'Use channel 42.' } })
    // a second sync (never answering) locks the fields and the primary
    fireEvent.click(screen.getByText('Sync with spec'))
    expect((screen.getByDisplayValue('Use channel 42.') as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(true)
    // the footer Cancel settles the job — the entry is editable again
    fireEvent.click(screen.getByText('Cancel'))
    expect((screen.getByDisplayValue('Use channel 42.') as HTMLTextAreaElement).readOnly).toBe(false)
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(false)
  })

  it('viewing an old version locks the fields; Dismiss still collapses the entry', async () => {
    storeMod.useStore.setState({
      autos: [{
        ...AUTO, version: 2,
        versions: [{ v: 1, when: 'Jul 1', note: null, spec: AUTO.spec, steps: AUTO.steps, instr: '', notes: '', params: [], packages: [] }],
      } as unknown as Auto],
    })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BLOCKED_SYNC)
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync with spec'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // browse v1 from the version menu — the thread survives, read-only
    fireEvent.click(screen.getByText('Draft'))
    fireEvent.click(screen.getByText('v1'))
    expect((screen.getByDisplayValue('Name it in the spec.') as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByText('Apply to the spec & sync').closest('button')!).disabled).toBe(true)
    expect((screen.getByPlaceholderText('Back to the draft to edit or ask.') as HTMLTextAreaElement).disabled).toBe(true)
    // Dismiss is never gated — the entry collapses to the one-line summary
    fireEvent.click(screen.getByText('Dismiss'))
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
  })

  it('create spec blockers: answers join the request and restart the create job', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'j1', status: 'blocked', stage: null, detail: null, error: null, draft: null,
      mode: 'create', blockedAt: 'spec',
      blockers: [{ reason: 'Which folder?', fix: '' }],
    })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    // spec-source explainer + the clarify primary
    expect(screen.getByText('It couldn’t write a spec for this request. Answer below — your answers are added to the request and the spec is rewritten.')).toBeTruthy()
    const primary = screen.getByText('Answer & rewrite the spec').closest('button')!
    expect(primary.disabled).toBe(true) // fix still empty
    fireEvent.change(screen.getByPlaceholderText('What should change so this can be built'),
      { target: { value: 'The Downloads folder' } })
    expect(primary.disabled).toBe(false)
    fireEvent.click(primary)
    // entry collapses, the answer lines land as a user entry, create re-runs
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
    expect(screen.getByText('Which folder? — The Downloads folder')).toBeTruthy()
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2))
    const body = draftBody(1)
    expect(body.mode).toBe('create')
    expect(body.text).toBe('Watch my Downloads folder\n\nWhich folder? — The Downloads folder')
  })

  it('chat blockers answer as a fresh chat message with the chat explainer', async () => {
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...BLOCKED_SYNC, mode: 'chat', blockedAt: 'chat' })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: 'Send it to Discord too' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('Answer below — your answers are sent back and the spec is rewritten.')).toBeTruthy()
    fireEvent.click(screen.getByText('Answer & rewrite the spec'))
    expect(screen.getByText('1 blocker — dismissed')).toBeTruthy()
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(2))
    const body = draftBody(1)
    expect(body.mode).toBe('chat')
    expect(body.text).toBe('Needs a channel id. — Name it in the spec.')
  })

  it('create steps blockers keep the landed spec out of sync with the steps explainer', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    const spec = [{ k: 'h1', text: 'Folder watcher' }, { k: 'p', text: 'Watches things.' }]
    // call 1 lands the spec mid-job (building tick), then the steps call blocks
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: 'j1', status: 'building', stage: 'Generating the steps', detail: null,
        error: null, mode: 'create', draft: { spec },
      })
      .mockResolvedValue({
        id: 'j1', status: 'blocked', stage: null, detail: null, error: null,
        mode: 'create', blockedAt: 'steps', draft: { spec },
        blockers: [{ reason: 'Needs a channel id.', fix: 'Name it in the spec.' }],
      })
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(screen.getByText('Your AI hit a blocker')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('It couldn’t build the steps as the spec asks. Edit the fix below, then apply it to the spec and rebuild.')).toBeTruthy()
    expect(screen.getByText('Apply to the spec & sync')).toBeTruthy()
    // the call-1 spec landed and the workflow is out of sync
    expect(screen.getByText('Watches things.')).toBeTruthy()
    expect(screen.getByText('The workflow is out of sync — these steps still match the old spec.')).toBeTruthy()
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
      spec: [{ k: 'h1', text: 'My auto' }, { k: 'p', text: 'Now with weekends.' }],
      answer: 'Sure — done.',
    }))
    render(<CreateFlow />)
    send('Also weekends')
    await waitFor(() => expect(screen.getByText('Spec updated')).toBeTruthy(), { timeout: 3000 })
    // §11 order: the answer entry lands before the rewrite entry
    const answer = screen.getByText('Sure — done.')
    const rewrite = screen.getByText('Spec updated')
    expect(answer.compareDocumentPosition(rewrite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the rewrite applied to the spec card and marked the workflow out of sync
    expect(screen.getByText('Now with weekends.')).toBeTruthy()
    expect(screen.getByText('The workflow is out of sync — these steps still match the old spec.')).toBeTruthy()
    expect(storeMod.useStore.getState().toast)
      .toBe('Spec updated — the workflow is out of sync. Sync the steps before saving.')
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
      spec: [{ k: 'h1', text: 'My auto' }, { k: 'p', text: 'Synced spec.' }],
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
        spec: [{ k: 'h1', text: 'My auto' }, { k: 'p', text: 'Test me.' }],
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
})

describe('CreateFlow footer action block + input lock (§11)', () => {
  beforeEach(armPendingPoll)

  it('chat job: footer shows the stage with the only spinner and Cancel (a1354db)', () => {
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Change something, or ask a question…'),
      { target: { value: 'Do a thing' } })
    fireEvent.click(screen.getByText('Send'))
    expect(screen.getByText('Working on the request…')).toBeTruthy()
    expect(spinnersIn(document.body).length).toBe(1)
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    expect(spinnersIn(panel).length).toBe(0)
    expect(within(panel).queryByText('Cancel')).toBeNull()
    expect(screen.getAllByText('Cancel').length).toBe(1) // the footer's
  })

  it('sync job: footer and panel status name the agent; spinner and Cancel stay in the footer', () => {
    render(<CreateFlow />)
    fireEvent.click(screen.getByText('Sync with spec'))
    // the same live line renders in the footer and as the panel's status text
    expect(screen.getAllByText('Cloud writer · Default model is rewriting the steps from your spec…').length).toBe(2)
    const panel = cardOf(screen.getByText('BUILD & TEST'))
    expect(spinnersIn(document.body).length).toBe(1)
    expect(spinnersIn(panel).length).toBe(0)
    expect(within(panel).queryByText('Cancel')).toBeNull()
    expect(screen.getAllByText('Cancel').length).toBe(1)
    // the panel's sync button disables instead of turning into a cancel
    expect((within(panel).getByText('Sync with spec').closest('button')!).disabled).toBe(true)
  })

  it('create job: stage labels walk spec → steps → packages', async () => {
    storeMod.useStore.setState({ createFrom: 'app' })
    const building = (stage: string, detail: string | null) => ({
      id: 'j1', status: 'building', stage, detail, error: null, mode: 'create',
      draft: { spec: [{ k: 'h1', text: 'Folder watcher' }] },
    })
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(
      building('Generating the steps', 'Writing step 1 of 2'))
    render(<CreateFlow />)
    fireEvent.change(screen.getByPlaceholderText('Describe the job — one sentence is enough.'),
      { target: { value: 'Watch my Downloads folder' } })
    fireEvent.click(screen.getByText('Send'))
    // call 1 in flight — the footer (and spec card) show the spec stage
    expect(screen.getAllByText('Writing the spec…').length).toBeGreaterThan(0)
    // the spec lands mid-job → steps stage plus the finer detail line
    await waitFor(() => expect(screen.getAllByText('Generating the steps…').length).toBeGreaterThan(0), { timeout: 3000 })
    expect(screen.getByText('Writing step 1 of 2')).toBeTruthy()
    // the job's install stage flips the label
    ;(mockedApi.getDraftJob as ReturnType<typeof vi.fn>).mockResolvedValue(
      building('Installing the packages', null))
    await waitFor(() => expect(screen.getAllByText('Installing the packages…').length).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('a live test disables the input with the wait placeholder', () => {
    storeMod.useStore.setState({
      test: { execId: 'e9' },
      execs: [{
        id: 'e9', autoId: 'a1', autoName: 'My auto', autoDeleted: false, ver: 'v1',
        status: 'executing', trigger: 'Test', triggerSender: null, test: true,
        dur: '', started: '', startedMs: 1, endedMs: 0, queuedMs: 0, note: null, error: null,
      }] as never,
    })
    render(<CreateFlow />)
    const input = screen.getByPlaceholderText('Wait for the test to finish.') as HTMLTextAreaElement
    expect(input.disabled).toBe(true)
    expect((screen.getByText('Send').closest('button')!).disabled).toBe(true)
  })
})

describe('CreateFlow left-column cards + test-failure repair (§11)', () => {
  beforeEach(armPendingPoll)

  it('agents and secrets cards default collapsed with counts; warnings force them open', () => {
    storeMod.useStore.setState({
      autos: [{
        ...AUTO,
        steps: [{ file: '01-a.py', name: 'Judge', desc: '', code: 'x = secrets.CRM_API_KEY', agent: true, why: 'w', agents: ['Fast local'] }],
      } as unknown as Auto],
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
      autos: [{ ...AUTO, notes: '- Site rate-limits at 10 rpm' } as unknown as Auto],
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

  it('Analyze the failure posts the canned chat message with the run id', async () => {
    const failed = {
      id: 'e9', autoId: 'a1', autoName: 'My auto', autoDeleted: false, ver: 'v1',
      status: 'failed', trigger: 'Test', triggerSender: null, test: true,
      dur: '1s', started: '', startedMs: 1, endedMs: 2, queuedMs: 0, note: null,
      error: { step: 'Fetch pages', message: 'boom', reason: null }, steps: [],
    }
    storeMod.useStore.setState({
      test: { execId: 'e9' }, execs: [failed] as never, execFull: { e9: failed } as never,
    })
    render(<CreateFlow />)
    expect(screen.getByText('Test failed.')).toBeTruthy()
    fireEvent.click(screen.getByText('Analyze the failure'))
    await waitFor(() => expect(mockedApi.postDraftJob).toHaveBeenCalledTimes(1))
    const body = draftBody(0)
    expect(body.mode).toBe('chat')
    expect(body.runId).toBe('e9')
    expect(body.text).toBe('The test failed at step Fetch pages — figure out why and change the automation so it won’t happen again.')
    // the canned message lands as a user entry in the thread
    expect(screen.getByText(body.text as string)).toBeTruthy()
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
    fireEvent.click(screen.getByText('Sync with spec'))
    expect(pick.disabled).toBe(true)
  })
})
