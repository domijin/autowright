// §15 e2e: the §11 editor chat pane — the one agent surface. Three journeys
// through the real two-call pipeline against the fake claude: a prose answer,
// a chat-driven spec rewrite synced from the thread entry and saved as v2,
// the actions.yaml chain (rewrite → auto-sync → auto-test → settled chip),
// and §7 Fix with AI seeding the thread from a failed execution.
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

const BOOM_STEP = {
  file: '01-boom.py', name: 'Boom', description: 'always fails',
  code: 'assert False, "distinct boom message e2e"\n',
}

const CHAT_INPUT = 'Change something, or ask a question…'

describe('editor chat e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  /** Seed an automation with a drafting agent and open its editor. */
  async function openEditor(name: string, steps?: Array<{ file: string; name: string; description: string; code: string }>) {
    backend = await new Backend().start()
    const agent = await backend.createAgent('Chat Agent')
    const { id } = await backend.createAutomation(name, steps, { agentId: agent.id })
    handle = await launchApp(backend.home, true)
    const { page } = handle
    await page.getByText(name).waitFor({ timeout: 20_000 })
    await page.getByText(name).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Test the draft' }).waitFor({ timeout: 10_000 })
    return { id, page }
  }

  it('answers a question, rewrites the spec from chat, and syncs from the thread entry', async () => {
    const { id, page } = await openEditor('Chat loop e2e')

    // A question-shaped message gets a prose `answer` entry (markdown), no rewrite.
    await page.getByPlaceholder(CHAT_INPUT).fill('What does this workflow do?')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText(/The workflow has two steps/).waitFor({ timeout: 60_000 })
    await page.getByText('In sync with the spec.').waitFor() // still in sync

    // A change request: while the §8 chat job runs, the footer swaps the input
    // for the page's only live-job surface — stage label + Cancel (§11).
    await page.getByPlaceholder(CHAT_INPUT).fill('Track new manga chapters instead')
    await page.getByRole('button', { name: 'Send' }).click()
    // .first(): the header save hint shows the same stage string as the footer
    await page.getByText('Working on the request…').first().waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()

    // The rewrite lands as a "Spec updated" entry carrying the request text
    // and the out-of-sync note with its inline Sync now. (exact — the toast
    // "Spec updated — …" would otherwise match too)
    await page.getByText('Spec updated', { exact: true }).waitFor({ timeout: 60_000 })
    await page.getByText('Track new manga chapters instead').first().waitFor()
    await page.getByTestId('chat-sync-now').click()
    await page.getByText('Steps synced with the spec.', { exact: true }).waitFor({ timeout: 60_000 })
    await page.getByText('In sync with the spec.').waitFor()
    await shot(page, 'editor-chat-synced.png')

    // The chat-driven edit saves like any other draft.
    await page.getByRole('button', { name: 'Save as v2' }).click()
    await page.getByText('v2', { exact: true }).first().waitFor({ timeout: 20_000 })
    const auto = await backend!.api('GET', `/automations/${id}`) as { version: number }
    expect(auto.version).toBe(2)
  }, 120_000)

  it('runs the fix-and-test action chain: rewrite → auto-sync → auto-test → settled chip', async () => {
    const { page } = await openEditor('Chat chain e2e')

    // The fake claude's fix-and-test response carries an answer, a spec
    // rewrite, a notes.md rewrite, and actions.yaml `sync: true` +
    // `test: true` — the §11 chaining watcher fires the sync, then the test.
    await page.getByPlaceholder(CHAT_INPUT).fill('Please fix-and-test this workflow')
    await page.getByRole('button', { name: 'Send' }).click()

    await page.getByText('Fixed — rebuilding the steps and running a test.').waitFor({ timeout: 60_000 })
    await page.getByText('Notes updated.', { exact: true }).waitFor({ timeout: 20_000 })
    await page.getByText('Steps synced with the spec.', { exact: true }).waitFor({ timeout: 60_000 })
    // The chained test executes the synced draft's real steps; the settled
    // run lands as a quiet system chip in the thread (§11).
    await page.getByText('Test succeeded.', { exact: true }).waitFor({ timeout: 60_000 })
    await page.getByText('Test succeeded — the memory copy was discarded.').waitFor()
    await shot(page, 'editor-chat-chain.png')
  }, 120_000)

  it('Fix with AI seeds the thread from the failed execution and starts the analysis', async () => {
    // Fail a real execution before the app ever opens.
    backend = await new Backend().start()
    const agent = await backend.createAgent('Chat Agent')
    const { id } = await backend.createAutomation('Fix with AI e2e', [BOOM_STEP], { agentId: agent.id })
    const exec = await backend.executeAndWait(id)
    expect(exec.status).toBe('failed')

    handle = await launchApp(backend.home, true)
    const { page } = handle
    await page.getByText('Fix with AI e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Fix with AI e2e').click()

    // §9.2 failure notice → Fix with AI → the editor opens with the failure
    // seeded as a system entry and the canned analyze chat message in flight.
    await page.getByText(/Failed at step/).waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: /Fix with AI/ }).click()
    await page.getByText(/Execution failed at step Boom/).waitFor({ timeout: 20_000 })
    // The fake claude answers the analyze message with a spec rewrite.
    await page.getByText('Spec updated', { exact: true }).waitFor({ timeout: 60_000 })
    await page.getByText(/This execution failed — figure out why/).first().waitFor()
    await shot(page, 'editor-chat-fix-with-ai.png')
  }, 120_000)
})
