// §15 e2e: agent management — switch the default agent, delete it, and the
// remaining agent becomes default (§19 delete reassigns). Config-only agents;
// the fake claude answers every readiness check.
import { afterEach, describe, expect, it } from 'vitest'
import { Backend, clickNav, closeApp, launchApp, shot, waitFor, type AppHandle } from './harness'

interface AgentJson { id: string; name: string | null; default: boolean }

describe('agent management e2e', () => {
  let backend: Backend | null = null
  let handle: AppHandle | null = null

  afterEach(async () => {
    await closeApp(handle)
    handle = null
    await backend?.stop()
    backend = null
  })

  it('switches the default agent and reassigns it on delete', async () => {
    backend = await new Backend().start()
    await backend.createAgent('First Agent') // becomes default (first agent)
    await backend.createAgent('Second Agent')
    handle = await launchApp(backend.home, true)
    const { page } = handle

    await clickNav(page, 'Agents')
    await page.getByText('First Agent', { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByText('Second Agent', { exact: true }).waitFor()
    // Both session checks land on Ready (fake claude resolves + signed in).
    await waitFor(async () => (await page.getByText('Ready', { exact: true }).count()) === 2,
      20_000, 'both agents to check Ready')

    const agents = async () => await backend!.api('GET', '/agents') as AgentJson[]
    expect((await agents()).find((a) => a.name === 'First Agent')?.default).toBe(true)

    // Make Second Agent the default via its card menu.
    const secondCard = page.locator('.ad-card-click').filter({ hasText: 'Second Agent' })
    await secondCard.getByTitle('More actions').click()
    await page.getByText('Make default').click()
    await page.getByText(/Second Agent is now the default/).waitFor({ timeout: 10_000 })
    await waitFor(async () => (await agents()).find((a) => a.name === 'Second Agent')?.default === true,
      10_000, 'default to switch')
    await shot(page, 'agents-default-switched.png')

    // Delete it — the other agent gets the default flag back.
    await secondCard.getByTitle('More actions').click()
    await page.getByText('Remove agent…').click()
    await page.getByRole('button', { name: 'Remove agent', exact: true }).click()
    // The confirm modal also names the agent — wait on the CARD disappearing.
    await secondCard.waitFor({ state: 'detached', timeout: 10_000 })
    await waitFor(async () => {
      const list = await agents()
      return list.length === 1 && list[0].name === 'First Agent' && list[0].default === true
    }, 10_000, 'default to reassign on delete')
    await shot(page, 'agents-deleted-reassigned.png')
  }, 120_000)
})
