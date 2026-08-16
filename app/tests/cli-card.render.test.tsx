// §4.9 COMMAND LINE card: state comes from the §3 cli-status preload IPC
// (the shim file on disk), Install/Reinstall fire cli-install and re-read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '../src/types'
import { useStore } from '../src/store'
import SettingsPage from '../src/pages/SettingsPage'

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false,
  dataPath: '/tmp', dataSize: '0 B',
}

type CliState = 'installed' | 'stale' | 'missing' | 'foreign'

const cliStatus = vi.fn<() => Promise<{ state: CliState }>>()
const cliInstall = vi.fn<() => Promise<{ ok: boolean }>>()

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).autowright = { cliStatus, cliInstall }
  useStore.setState({ settings: SETTINGS })
  cliStatus.mockReset()
  cliInstall.mockReset()
})

afterEach(cleanup)

describe('COMMAND LINE card (§4.9)', () => {
  it('installed: path shown, no action button', async () => {
    cliStatus.mockResolvedValue({ state: 'installed' })
    render(<SettingsPage />)
    await screen.findByText('COMMAND LINE')
    await screen.findByText('Installed at /usr/local/bin/autowright')
    expect(screen.queryByRole('button', { name: /Install…|Reinstall…/ })).toBeNull()
  })

  it('missing: Install… button fires cli-install and re-reads the state', async () => {
    cliStatus.mockResolvedValueOnce({ state: 'missing' })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed' })
    render(<SettingsPage />)
    const btn = await screen.findByRole('button', { name: 'Install…' })
    await screen.findByText(/Not installed — manage automations from the Terminal/)
    fireEvent.click(btn)
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByText('Installed at /usr/local/bin/autowright')
  })

  it('declined install returns to the previous state, no error banner', async () => {
    cliStatus.mockResolvedValue({ state: 'missing' })
    cliInstall.mockResolvedValue({ ok: false })
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install…' }))
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: 'Install…' })
  })

  it('stale: amber reinstall row', async () => {
    cliStatus.mockResolvedValue({ state: 'stale' })
    render(<SettingsPage />)
    await screen.findByText(/Points at an old location — reinstall to fix/)
    await screen.findByRole('button', { name: 'Reinstall…' })
  })

  it('foreign: never touched, no button', async () => {
    cliStatus.mockResolvedValue({ state: 'foreign' })
    render(<SettingsPage />)
    await screen.findByText(/a different autowright is already at \/usr\/local\/bin/i)
    expect(screen.queryByRole('button', { name: /Install…|Reinstall…/ })).toBeNull()
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('COMMAND LINE')).toBeNull()
  })
})
