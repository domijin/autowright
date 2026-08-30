// §15 e2e: add a cron trigger through the real Add-trigger editor, assert the
// humanized label + next-occurrence line, then toggle it off. Pure DOM + HTTP —
// no native dialogs are involved (confirmed against AutomationDetail.tsx).
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, waitFor, type AppHandle } from './harness'

describe('triggers e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('adds a daily cron trigger and toggles it off', async () => {
    backend = await new Backend().start()
    await backend.createAutomation('E2E automation')
    handle = await launchApp(backend.home, true)
    const { page } = handle

    // List → detail.
    await page.getByText('E2E automation').waitFor({ timeout: 20_000 })
    await page.getByText('E2E automation').click()
    await page.getByRole('button', { name: 'Execute now' }).waitFor({ timeout: 10_000 })

    // Add-trigger editor: cron is the default kind; the live preview
    // humanizes the expression before anything is stored.
    await page.getByRole('button', { name: 'Add trigger' }).click()
    await page.getByPlaceholder(/minute hour day month weekday/).fill('0 8 * * *')
    await page.getByText(/^Daily at 8:00 · next:/).waitFor({ timeout: 10_000 })
    await shot(page, 'trigger-preview.png')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // Stored: the backend's humanized row label plus the live status line.
    await page.getByText('Daily at 8:00', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText(/Next execution in/).waitFor()
    await shot(page, 'trigger-added.png')

    // Toggle off — chip flips to "· triggers off", status line explains.
    await page.getByTitle('Turn this trigger off').click()
    await page.getByText(/Daily 8:00 · triggers off/).waitFor({ timeout: 10_000 })
    await page.getByText(/All triggers are off/).waitFor()
    await shot(page, 'trigger-off.png')
  }, 120_000)

  it('stores the catch-up opt-out and shows the NO CATCH-UP badge', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Catch-up e2e')
    handle = await launchApp(backend.home, true)
    const { page } = handle

    // List -> detail.
    await page.getByText('Catch-up e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Catch-up e2e').click()
    await page.getByRole('button', { name: 'Execute now' }).waitFor({ timeout: 10_000 })

    // Add-trigger editor: the §4.3 opt-out rides the cron form.
    await page.getByRole('button', { name: 'Add trigger' }).click()
    await page.getByPlaceholder(/minute hour day month weekday/).fill('0 8 * * *')
    await page.getByText(/^Daily at 8:00 · next:/).waitFor({ timeout: 10_000 })

    // Catching up is the default; the sleep note reads off the same state.
    const box = page.getByRole('checkbox', { name: 'Catch up if missed' })
    expect(await box.isChecked()).toBe(true)
    await page.getByText(/executes once when it wakes/).waitFor()
    await box.uncheck()
    await page.getByText(/that time is skipped\./).waitFor()
    await shot(page, 'trigger-no-catchup-editor.png')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // Stored: the row carries the badge, and §19 serializes the field.
    await page.getByText('Daily at 8:00', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('NO CATCH-UP').waitFor()
    await shot(page, 'trigger-no-catchup-badge.png')
    const cronTrigger = async () => {
      const auto = await backend!.api('GET', `/automations/${id}`) as
        { triggers: Array<{ kind: string; runIfMissed?: boolean }> }
      return auto.triggers.find((t) => t.kind === 'cron')
    }
    await waitFor(async () => (await cronTrigger())?.runIfMissed === false,
      10_000, 'the stored cron to carry runIfMissed false')

    // Editing pre-fills the stored value; turning it back on clears the badge.
    await page.getByRole('button', { name: 'Edit trigger' }).click()
    expect(await box.isChecked()).toBe(false)
    await box.check()
    await page.getByText(/executes once when it wakes/).waitFor()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('NO CATCH-UP').waitFor({ state: 'detached', timeout: 10_000 })
    await waitFor(async () => (await cronTrigger())?.runIfMissed === true,
      10_000, 'the stored cron to carry runIfMissed true')
    await shot(page, 'trigger-catchup-restored.png')
  }, 120_000)
})
