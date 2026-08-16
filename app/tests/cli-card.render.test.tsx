// §4.9 COMMAND LINE card: a Toggle bound to the stored cliEnabled setting;
// disk state from the §3 cli-status preload IPC. Turning on patches the
// setting and installs (silent, ~/.local/bin); a failed install patches it
// back. Turning off touches no files — Delete is the explicit removal, and
// an undeletable legacy shim comes back as a toasted manual command.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '../src/types'
import { useStore } from '../src/store'
import SettingsPage from '../src/pages/SettingsPage'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: { patchSettings: vi.fn(() => Promise.resolve({})), setDataPath: vi.fn(() => Promise.resolve({})) },
}))
const patchSettings = vi.mocked(api.patchSettings)

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false,
  cliEnabled: false, dataPath: '/tmp', dataSize: '0 B',
}

type Cli = { state: 'installed' | 'stale' | 'missing' | 'foreign'; path: string; onPath: boolean }

const USER = '/Users/me/.local/bin/autowright'
const LEGACY = '/usr/local/bin/autowright'

const cliStatus = vi.fn<() => Promise<Cli>>()
const cliInstall = vi.fn<() => Promise<{ ok: boolean }>>()
const cliUninstall = vi.fn<() => Promise<{ ok: true } | { ok: false; hint: string }>>()

function setup(cliEnabled: boolean) {
  ;(window as unknown as Record<string, unknown>).autowright = { cliStatus, cliInstall, cliUninstall }
  useStore.setState({ settings: { ...SETTINGS, cliEnabled } })
}

beforeEach(() => {
  cliStatus.mockReset()
  cliInstall.mockReset()
  cliUninstall.mockReset()
  patchSettings.mockClear()
})

afterEach(cleanup)

describe('COMMAND LINE card (§4.9)', () => {
  it('on + installed: path shown, toggle on, no Install/Delete buttons', async () => {
    setup(true)
    cliStatus.mockResolvedValue({ state: 'installed', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText('COMMAND LINE')
    await screen.findByText(`Installed at ${USER}`)
    expect(screen.queryByRole('button', { name: /Install|Delete/ })).toBeNull()
  })

  it('on + installed: PATH row with the copyable command block, regardless of onPath', async () => {
    setup(true)
    cliStatus.mockResolvedValue({ state: 'installed', path: USER, onPath: true })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SettingsPage />)
    // §4.9 PATH row: own title + description below the toggle row.
    await screen.findByText('Add it to your PATH')
    await screen.findByText(/If your Terminal can’t find autowright, add ~\/\.local\/bin to your PATH:/)
    await screen.findByText('echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zprofile && source ~/.zprofile')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zprofile && source ~/.zprofile'))
    await waitFor(() => expect(useStore.getState().toast).toContain('Copied'))
  })

  it('off + missing: turning the toggle on patches cliEnabled and installs silently', async () => {
    setup(false)
    cliStatus.mockResolvedValueOnce({ state: 'missing', path: USER, onPath: true })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(/Turning this on installs to ~\/\.local\/bin — no password needed\./)
    // No PATH row while off — it belongs to on+installed only.
    expect(screen.queryByText('Add it to your PATH')).toBeNull()
    const card = (await screen.findByText('COMMAND LINE')).parentElement as HTMLElement
    fireEvent.click(card.querySelector('[role="switch"]') as Element)
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ cliEnabled: true }))
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    // The real app flips the store via the settings.changed WS refresh —
    // simulate it, then the card shows the enabled+installed copy.
    useStore.setState({ settings: { ...SETTINGS, cliEnabled: true } })
    await screen.findByText(`Installed at ${USER}`)
  })

  it('failed install patches the setting back to false — no error banner', async () => {
    setup(false)
    cliStatus.mockResolvedValue({ state: 'missing', path: USER, onPath: true })
    cliInstall.mockResolvedValue({ ok: false })
    render(<SettingsPage />)
    const card = (await screen.findByText('COMMAND LINE')).parentElement as HTMLElement
    fireEvent.click(card.querySelector('[role="switch"]') as Element)
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ cliEnabled: false }))
  })

  it('off + still installed: Delete row (own title + description) removes the shim; turning off never deleted it', async () => {
    setup(false)
    cliStatus.mockResolvedValueOnce({ state: 'installed', path: USER, onPath: true })
    cliUninstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'missing', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(new RegExp(`Still installed at ${USER.replace(/[/.]/g, '\\$&')} — turn on to keep it up to date`))
    // §4.9: Delete lives in its own row below the toggle row.
    await screen.findByText('Delete the command')
    await screen.findByText(/Removes the command file from this Mac\. Your automations, settings, and executions aren’t affected\./)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(cliUninstall).toHaveBeenCalledTimes(1))
    await screen.findByText(/Not installed — manage automations from the Terminal/)
    expect(screen.queryByText('Delete the command')).toBeNull()
  })

  it('undeletable legacy shim: Delete toasts the manual command, row stays', async () => {
    setup(false)
    cliStatus.mockResolvedValue({ state: 'stale', path: LEGACY, onPath: true })
    cliUninstall.mockResolvedValue({ ok: false, hint: `Remove it with: sudo rm ${LEGACY}` })
    render(<SettingsPage />)
    await screen.findByText(/An old autowright command at \/usr\/local\/bin points at an old location\./)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(cliUninstall).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useStore.getState().toast).toContain('sudo rm'))
    await screen.findByRole('button', { name: 'Delete' })
  })

  it('on + missing: amber warning row below the toggle with a Reinstall button', async () => {
    setup(true)
    cliStatus.mockResolvedValueOnce({ state: 'missing', path: USER, onPath: true })
    cliInstall.mockResolvedValue({ ok: true })
    cliStatus.mockResolvedValueOnce({ state: 'installed', path: USER, onPath: true })
    render(<SettingsPage />)
    // §4.9 missing-warning row: own title + description, Reinstall action.
    await screen.findByText(/CLI is missing/)
    await screen.findByText(/autowright wasn’t found in ~\/\.local\/bin — it may have been deleted or moved\. Reinstall it to keep using it from the Terminal\./)
    fireEvent.click(await screen.findByRole('button', { name: 'Reinstall' }))
    await waitFor(() => expect(cliInstall).toHaveBeenCalledTimes(1))
    await screen.findByText(`Installed at ${USER}`)
    expect(screen.queryByText(/CLI is missing/)).toBeNull()
  })

  it('on + stale legacy: amber row-1 copy plus the warning row with Reinstall', async () => {
    setup(true)
    cliStatus.mockResolvedValue({ state: 'stale', path: LEGACY, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(/An old autowright command at \/usr\/local\/bin points at an old location\./)
    await screen.findByText(/CLI is missing/)
    await screen.findByRole('button', { name: 'Reinstall' })
  })

  it('foreign: never touched — no toggle, no buttons', async () => {
    setup(false)
    cliStatus.mockResolvedValue({ state: 'foreign', path: USER, onPath: true })
    render(<SettingsPage />)
    await screen.findByText(new RegExp(`a different autowright is already at ${USER.replace(/[/.]/g, '\\$&')}`, 'i'))
    const card = (await screen.findByText('COMMAND LINE')).parentElement as HTMLElement
    expect(card.querySelector('[role="switch"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Install|Delete/ })).toBeNull()
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    setup(false)
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('COMMAND LINE')).toBeNull()
  })
})
