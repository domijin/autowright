// §15 e2e: add a cron trigger through the real Add-trigger editor, assert the
// humanized label + next-occurrence line, then toggle it off. Pure DOM + HTTP —
// no native dialogs are involved (confirmed against AutomationDetail.tsx).
import { afterEach, describe, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

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
})
