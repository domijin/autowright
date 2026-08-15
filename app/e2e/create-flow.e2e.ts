// §15 e2e: the create-flow journey — request → real §8 chat + chained-sync
// pipeline (fake `claude` answers both calls) → Test (real §11 draft
// execution) → Create → Execute now → execution page with steps, logs, result.
import { afterEach, describe, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

describe('create flow e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('drafts, tests, creates, and executes an automation end to end', async () => {
    backend = await new Backend().start()
    // The create flow needs an agent (agents.length === 0 redirects to the
    // Agents page) — seed one config-only record over HTTP.
    await backend.createAgent('Draft Agent')
    handle = await launchApp(backend.home, true)
    const { page } = handle

    // Empty list → the editor's create empty state: the chat pane carries the
    // headline and the input (§11 — one screen from birth to save).
    await page.getByRole('heading', { name: 'Automations' }).waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Create your first automation' }).click()
    await page.getByRole('heading', { name: 'What should Autowright do for you?' }).waitFor({ timeout: 10_000 })

    // The chat input — the first message is an ordinary §8 chat job (the
    // new-automation rule). The fake claude names the automation from this
    // exact text via the actions.yaml `name`.
    await page.getByPlaceholder('Describe the job — one sentence is enough.').fill('Track manga chapters e2e')
    await page.getByRole('button', { name: 'Send' }).click()
    await shot(page, 'create-drafting.png')

    // The chat call lands the spec (fixed fake envelope) and arms the chained
    // sync, which delivers the steps + param.
    await page.getByText('Every day at 8:00.').waitFor({ timeout: 60_000 })
    await page.getByText('Check for changes').waitFor({ timeout: 60_000 })
    await page.getByText('Build the result').waitFor()
    await page.getByText('Notify only on changes').first().waitFor()
    await shot(page, 'create-review.png')

    // Test: the toggle opens the setup section; Run test starts the real
    // draft execution through the engine (scratch memory).
    await page.getByTestId('test-draft-toggle').click()
    await page.getByRole('button', { name: 'Run test' }).click()
    await page.getByText('Test succeeded — the memory copy was discarded.').waitFor({ timeout: 60_000 })
    await shot(page, 'create-test-succeeded.png')

    // Create → lands on the automation's detail page.
    await page.getByRole('button', { name: 'Create automation' }).click()
    const execBtn = page.getByRole('button', { name: 'Execute now' })
    await execBtn.waitFor({ timeout: 20_000 })
    // Two headings carry the name (title row + the spec's own h1) — any is fine.
    await page.getByRole('heading', { name: 'Track manga chapters e2e' }).first().waitFor()

    // Execute for real, then open the execution record.
    await execBtn.click()
    await page.getByText('Succeeded').first().waitFor({ timeout: 60_000 })
    await page.getByText('Manual · v1').first().click()

    // Execution page: result section, both steps in the rail, logs.
    await page.getByText('Mock run — nothing new.').waitFor({ timeout: 20_000 })
    await page.getByText('All good').first().waitFor()
    // The STEPS rail rows are buttons ("<name> <duration>"); the names also
    // appear in the result's step list, so target the rail by role.
    await page.getByRole('button', { name: /Check for changes/ }).waitFor()
    await page.getByRole('button', { name: /Build the result/ }).waitFor()
    // Selecting step 1 shows its real log line (fake step's `log(...)`).
    await page.getByRole('button', { name: /Check for changes/ }).click()
    await page.getByText(/nothing to do in mock mode/).waitFor({ timeout: 20_000 })
    await shot(page, 'create-execution-page.png')
  }, 120_000)
})
