// §4.9 COMMAND LINE card: state comes from the §3 cli-status preload IPC
// (the shim files on disk), Install/Reinstall fire cli-install and re-read.
// Copy and button are target-aware: user target (~/.local/bin) is silent —
// no ellipsis, no password sentence; system target explains the admin prompt.
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

type Cli = { state: 'installed' | 'stale' | 'missing' | 'foreign'; target: 'user' | 'system'; path: string }

const USER = '/Users/me/.local/bin/autowright'
const SYSTEM = '/usr/local/bin/autowright'

const cliStatus = vi.fn<() => Promise<Cli>>()
const cliInstall = vi.fn<() => Promise<{ ok: boolean }>>()

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).autowright = { cliStatus, cliInstall }
  useStore.setState({ settings: SETTINGS })
  cliStatus.mockReset()
  cliInstall.mockReset()
})

afterEach(cleanup)

describe('COMMAND LINE card (§4.9)', () => {
  it('installed: the effective path shown, no action button', async () => {
    cliStatus.mockResolvedValue({ state: 'installed', target: 'user', path: USER })
    render(<SettingsPage />)
    await screen.findByText('COMMAND LINE')
    await screen.findByText(`Installed at ${USER}`)
    expect(screen.queryByRole('button', { name: /Install|Reinstall/ })).toBeNull()
  })

  it('missing, user target: no-password copy, Install without ellipsis, silent flow re-reads', async () => {
    cliStatus.mockResolvedValueOnce({ state: 'missing', target: 'user', path: USER })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed', target: 'user', path: USER })
    render(<SettingsPage />)
    const btn = await screen.findByRole('button', { name: 'Install' })
    await screen.findByText(/Installs to ~\/\.local\/bin — no password needed/)
    expect(screen.queryByText(/ask for your password/)).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByText(`Installed at ${USER}`)
  })

  it('missing, system target: password explainer, Install… fires cli-install and re-reads', async () => {
    cliStatus.mockResolvedValueOnce({ state: 'missing', target: 'system', path: SYSTEM })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed', target: 'system', path: SYSTEM })
    render(<SettingsPage />)
    const btn = await screen.findByRole('button', { name: 'Install…' })
    await screen.findByText(/macOS will ask for your password — \/usr\/local\/bin is a system folder/)
    fireEvent.click(btn)
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByText(`Installed at ${SYSTEM}`)
  })

  it('declined install returns to the previous state, no error banner', async () => {
    cliStatus.mockResolvedValue({ state: 'missing', target: 'system', path: SYSTEM })
    cliInstall.mockResolvedValue({ ok: false })
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install…' }))
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: 'Install…' })
  })

  it('stale: amber reinstall row with the not-yours-to-edit explainer', async () => {
    cliStatus.mockResolvedValue({ state: 'stale', target: 'system', path: SYSTEM })
    render(<SettingsPage />)
    await screen.findByText(/Points at an old location — reinstall to fix.*isn’t yours to edit/)
    await screen.findByRole('button', { name: 'Reinstall…' })
  })

  it('foreign: never touched, no button, effective path named', async () => {
    cliStatus.mockResolvedValue({ state: 'foreign', target: 'user', path: USER })
    render(<SettingsPage />)
    await screen.findByText(new RegExp(`a different autowright is already at ${USER.replace(/[/.]/g, '\\$&')}`, 'i'))
    expect(screen.queryByRole('button', { name: /Install|Reinstall/ })).toBeNull()
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('COMMAND LINE')).toBeNull()
  })
})
