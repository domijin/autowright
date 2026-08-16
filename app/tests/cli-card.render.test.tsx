// §4.9 COMMAND LINE card: state comes from the §3 cli-status preload IPC
// (the shim files on disk), Install fires cli-install and re-reads. The CLI
// is opt-in: install is a silent write into ~/.local/bin — no password copy
// anywhere; `onPath` false appends the PATH hint to the installed state.
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

type Cli = { state: 'installed' | 'stale' | 'missing' | 'foreign'; path: string; onPath: boolean }

const USER = '/Users/me/.local/bin/autowright'
const LEGACY = '/usr/local/bin/autowright'

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
  it('installed: the effective path shown, no action button, no PATH hint when on PATH', async () => {
    cliStatus.mockResolvedValue({ state: 'installed', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText('COMMAND LINE')
    await screen.findByText(`Installed at ${USER}`)
    expect(screen.queryByText(/Add ~\/\.local\/bin to your PATH/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
  })

  it('installed but ~/.local/bin off the login PATH: appends the export hint', async () => {
    cliStatus.mockResolvedValue({ state: 'installed', path: USER, onPath: false })
    render(<SettingsPage />)
    await screen.findByText(new RegExp(`Installed at .*Add ~/\\.local/bin to your PATH to use it: export PATH`))
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
  })

  it('missing: no-password copy, Install fires cli-install silently and re-reads', async () => {
    cliStatus.mockResolvedValueOnce({ state: 'missing', path: USER, onPath: true })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed', path: USER, onPath: true })
    render(<SettingsPage />)
    const btn = await screen.findByRole('button', { name: 'Install' })
    await screen.findByText(/Installs to ~\/\.local\/bin — no password needed/)
    expect(screen.queryByText(/password/i)?.textContent).not.toMatch(/ask for your password/)
    fireEvent.click(btn)
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByText(`Installed at ${USER}`)
  })

  it('failed install returns to the previous state, no error banner', async () => {
    cliStatus.mockResolvedValue({ state: 'missing', path: USER, onPath: true })
    cliInstall.mockResolvedValue({ ok: false })
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: 'Install' })
  })

  it('stale legacy shim: amber sudo-rm instruction with a fresh Install button', async () => {
    cliStatus.mockResolvedValue({ state: 'stale', path: LEGACY, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(/An old autowright command at \/usr\/local\/bin.*sudo rm \/usr\/local\/bin\/autowright, then install here/)
    await screen.findByRole('button', { name: 'Install' })
  })

  it('foreign: never touched, no button, effective path named', async () => {
    cliStatus.mockResolvedValue({ state: 'foreign', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(new RegExp(`a different autowright is already at ${USER.replace(/[/.]/g, '\\$&')}`, 'i'))
    expect(screen.queryByRole('button', { name: /Install/ })).toBeNull()
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('COMMAND LINE')).toBeNull()
  })
})
