// §15 e2e: memory snapshots on the detail page (§6.3) — a step writes memory
// via the real SDK (memory.save), then the UI takes a manual snapshot, lists
// it, and restores it (which mints a pre-restore snapshot of current memory).
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

const MEMORY_STEP = {
  file: '01-remember.py', name: 'Remember', desc: 'writes memory',
  code: 'from autowright import memory, result\nmemory.save("seen", {"count": 1})\nresult.status("ok")\nresult.chip("Remembered")\n',
}

describe('memory snapshots e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('takes a manual snapshot and restores it from the detail page', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Snapshot e2e', [MEMORY_STEP])
    const exec = await backend.executeAndWait(id) // memory now exists
    expect(exec.status).toBe('succeeded')

    handle = await launchApp(backend.home, true)
    const { page } = handle

    await page.getByText('Snapshot e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Snapshot e2e').click()
    await page.getByRole('button', { name: 'Execute now' }).waitFor({ timeout: 10_000 })

    // MEMORY card: non-empty memory enables the Snapshot button.
    const snapBtn = page.getByRole('button', { name: 'Snapshot', exact: true })
    await snapBtn.waitFor({ timeout: 10_000 })
    await snapBtn.click()
    await page.getByPlaceholder('Name — optional').fill('E2E snap')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // Listed newest-first with its reason/version meta ("manual · v1 · …").
    await page.getByText('E2E snap').waitFor({ timeout: 10_000 })
    await page.getByText(/manual · v1/).waitFor()
    await shot(page, 'snapshot-taken.png')

    // Restore: inline confirm (preRestore default on → current state is
    // snapshotted first), then the pre-restore snapshot appears in the list.
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await page.getByText(/the current state is snapshotted first/).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await page.getByText(/pre-restore · v1/).waitFor({ timeout: 10_000 })
    await page.getByText('E2E snap').waitFor() // the manual snapshot survives
    await shot(page, 'snapshot-restored.png')
  }, 120_000)
})
