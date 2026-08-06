// §15 e2e: failure diagnostics + in-place Retry, Cancel on a live execution,
// and skip-step. The flaky step uses real memory as its attempt counter
// (test_engine.py retry pattern); a failed execution fires one real macOS
// notification — accepted.
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, waitFor, type AppHandle } from './harness'

const FLAKY_STEP = {
  file: '01-flaky.py', name: 'Flaky', desc: 'fails once, then succeeds',
  code: 'from autowright import log, memory, result\nn = memory.load("attempt", 0) + 1\nmemory.save("attempt", n)\nassert n > 1, "first attempt fails"\nresult.status("ok")\nresult.chip("Recovered")\n',
}
const SLEEP_STEP = {
  file: '01-sleep.py', name: 'Sleep', desc: 'sleeps',
  code: 'from autowright import log, result\nimport time\nlog("sleeping")\ntime.sleep(60)\nresult.status("ok")\n',
}
const QUICK_STEP = {
  file: '02-quick.py', name: 'Quick', desc: 'finishes',
  code: 'from autowright import result\nresult.status("ok")\nresult.chip("Made it")\n',
}

describe('failure and retry e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('shows §7 diagnostics on a failed execution and retries it in place', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Retry e2e', [FLAKY_STEP])
    const exec = await backend.executeAndWait(id)
    expect(exec.status).toBe('failed')

    handle = await launchApp(backend.home, true)
    const { page } = handle

    // Detail page leads with the §9.2 failure notice.
    await page.getByText('Retry e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Retry e2e').click()
    await page.getByText(/Failed at step/).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /View execution/ }).click()

    // Execution page: failed badge + the exact error message.
    await page.getByText('Failed', { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.getByText(/AssertionError: first attempt fails/).first().waitFor()
    await shot(page, 'retry-failed.png')

    // In-place retry: same record, the failed step gains attempt 2.
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByText(/Attempt 2 · Succeeded/).waitFor({ timeout: 30_000 })
    await page.getByText(/Attempt 1 · Failed/).waitFor()
    await page.getByText('Succeeded', { exact: true }).first().waitFor()
    await shot(page, 'retry-succeeded.png')

    // The list/derived display recovers too.
    await waitFor(async () => {
      const a = await backend!.api('GET', `/automations/${id}`) as { lastStatus: string }
      return a.lastStatus === 'succeeded'
    }, 10_000, 'lastStatus to recover')
  }, 120_000)

  it('cancels a live execution from the execution page', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Cancel e2e', [SLEEP_STEP])
    handle = await launchApp(backend.home, true)
    const { page } = handle
    await page.getByText('Cancel e2e').waitFor({ timeout: 20_000 })

    await backend.execute(id)
    await page.getByText('Cancel e2e').click()
    await page.getByText('Manual · v1').first().waitFor({ timeout: 10_000 })
    await page.getByText('Manual · v1').first().click()

    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Cancelled', { exact: true }).first().waitFor({ timeout: 20_000 })
    await shot(page, 'cancelled.png')
  }, 120_000)

  it('skips the live step and the execution continues to the next one', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Skip e2e', [SLEEP_STEP, QUICK_STEP])
    handle = await launchApp(backend.home, true)
    const { page } = handle
    await page.getByText('Skip e2e').waitFor({ timeout: 20_000 })

    const execId = await backend.execute(id)
    await page.getByText('Skip e2e').click()
    await page.getByText('Manual · v1').first().waitFor({ timeout: 10_000 })
    await page.getByText('Manual · v1').first().click()

    // §7 skip affordance — header button, only while a step is live.
    await page.getByRole('button', { name: /Skip step/ }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: /Skip step/ }).click()
    await page.getByText('Succeeded', { exact: true }).first().waitFor({ timeout: 30_000 })
    await page.getByText('Made it').first().waitFor()
    await shot(page, 'skip-step.png')

    const e = await backend.api('GET', `/executions/${execId}`) as { steps: Array<{ status: string }> }
    expect(e.steps[0].status).toBe('skipped')
    expect(e.steps[1].status).toBe('succeeded')
  }, 120_000)
})
