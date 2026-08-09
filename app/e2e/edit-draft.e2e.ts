// §15 e2e: edit-mode draft Test on an existing automation. Step code is
// view-only in the editor (StepRow renders read-only PyCode), so the editable
// surface exercised here is the SPEC text (its Edit → textarea → Save path).
// The §11 test executes the draft's real steps on a scratch memory copy —
// live memory bytes and the automation's derived display must not change.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

const MEMORY_STEP = {
  file: '01-remember.py', name: 'Remember', description: 'writes memory and logs',
  code: 'from autowright import log, memory, result\nmemory.save("seen", {"count": 7})\nlog("edit-draft distinctive log line")\nresult.status("ok")\nresult.chip("Remembered")\n',
}

describe('edit draft e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('tests an edit draft without touching live memory, then discards it', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Edit draft e2e', [MEMORY_STEP])
    const realExec = await backend.executeAndWait(id)
    expect(realExec.status).toBe('succeeded')

    // Live memory as written by the real execution, straight from the tmp home.
    const memFile = path.join(backend.home, 'automations', id, 'memory', 'seen.yaml')
    const memBefore = await readFile(memFile, 'utf-8')
    expect(memBefore).toContain('count')

    handle = await launchApp(backend.home, true)
    const { page } = handle

    // Detail → the edit flow (the header's Edit button, §9.2).
    await page.getByText('Edit draft e2e').waitFor({ timeout: 20_000 })
    await page.getByText('Edit draft e2e').click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Test the draft' }).waitFor({ timeout: 10_000 })

    // §11 draft test — the pristine draft is in sync, so the Build & test
    // panel's Test executes v1's real steps on scratch memory. (The spec-edit
    // path is exercised after the run — an out-of-sync draft can't be tested.)
    await page.getByRole('button', { name: 'Test the draft' }).click()
    await page.getByRole('button', { name: 'Run test' }).click()
    await page.getByText('Test succeeded — the memory copy was discarded.').waitFor({ timeout: 60_000 })
    // §11: the settled test also lands as a quiet system chip in the chat thread.
    await page.getByText('Test succeeded.', { exact: true }).waitFor()
    await shot(page, 'edit-draft-test.png')

    // The test is a real execution record: View run (inside the reopened setup
    // section's run row) shows the step's log line.
    await page.getByRole('button', { name: 'Test the draft' }).click()
    await page.getByRole('button', { name: 'View run' }).click()
    await page.getByText('Draft test').waitFor({ timeout: 10_000 })
    await page.getByText('edit-draft distinctive log line').waitFor({ timeout: 20_000 })
    await shot(page, 'edit-draft-test-run.png')

    // §4.4/§11 isolation, asserted outside the UI: live memory bytes are
    // byte-identical, and the derived display still points at the REAL
    // execution — the test never becomes lastStatus/latest.
    const memAfter = await readFile(memFile, 'utf-8')
    expect(memAfter).toBe(memBefore)
    const auto = await backend.api('GET', `/automations/${id}`) as {
      version: number; lastStatus: string; latest: { executionId: string } | null
    }
    expect(auto.lastStatus).toBe('succeeded')
    expect(auto.latest?.executionId).toBe(realExec.id)

    // Back to the automation → editor again: exercise the spec's editable
    // surface (Edit → textarea → Save).
    await page.getByRole('heading', { name: 'Edit draft e2e' }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Test the draft' }).waitFor({ timeout: 10_000 })
    await page.getByTestId('spec-edit').click()
    const specBox = page.getByTestId('spec-editor')
    await specBox.waitFor({ timeout: 10_000 })
    const cur = await specBox.inputValue()
    await specBox.fill(`${cur}\nDistinctive spec addendum e2e.`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Distinctive spec addendum e2e.').waitFor({ timeout: 10_000 })
    // §11 Build & test panel: out of sync locks the Test button behind a sync
    await page.getByText(/these steps still match the old spec/).waitFor({ timeout: 10_000 })
    await page.getByText('Sync first — a test executes the steps as generated from the spec.').waitFor()
    expect(await page.getByRole('button', { name: 'Test the draft' }).isDisabled()).toBe(true)

    // Back to the detail page: leaving the editor kept the draft — discard it
    // from the §4.4 banner and confirm v1 is unchanged.
    await page.getByRole('button', { name: 'Edit draft e2e' }).click()
    await page.getByText('Unsaved edit based on v1').waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await page.getByText('Unsaved edit based on v1').waitFor({ state: 'detached', timeout: 10_000 })
    await page.getByText('v1', { exact: true }).first().waitFor()
    expect((await backend.api('GET', `/automations/${id}`) as { version: number }).version).toBe(1)
    await shot(page, 'edit-draft-discarded.png')
  }, 120_000)
})
