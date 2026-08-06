// §15 e2e: backend restart under a live UI — the renderer's WS reconnect loop
// re-reads backend.json through the preload bridge (§3, api.ts openWs), so a
// NEW backend on a new port/token is picked up without reloading the window.
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, closeApp, launchApp, shot, type AppHandle } from './harness'

describe('resilience e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('reconnects to a restarted backend and keeps working', async () => {
    backend = await new Backend().start()
    const { id } = await backend.createAutomation('Resilience e2e')
    handle = await launchApp(backend.home, true)
    const { page } = handle
    await page.getByText('Resilience e2e').waitFor({ timeout: 20_000 })

    // SIGKILL the backend and boot a fresh process on the SAME home —
    // new port, new token, new backend.json.
    await backend.restart()

    // Execute on the new backend over HTTP; the UI can only learn about it
    // through a re-established WS (ws.open triggers a refresh), so the badge
    // flipping to Succeeded proves the reconnect worked end to end.
    const exec = await backend.executeAndWait(id)
    expect(exec.status).toBe('succeeded')
    await page.getByText('Succeeded', { exact: true }).first().waitFor({ timeout: 45_000 })
    await page.getByText('All good').first().waitFor({ timeout: 15_000 })
    await shot(page, 'resilience-reconnected.png')
  }, 120_000)
})
