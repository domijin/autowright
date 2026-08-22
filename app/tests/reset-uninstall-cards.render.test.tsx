// §4.9 RESET and UNINSTALL cards — the two destructive cards below QUIT, most
// severe last. Both render only with the preload bridge; UNINSTALL additionally
// needs the §3 `uninstall-supported` answer. Busy and error leave everything in
// place and toast; success is the shell's business (relaunch / self-removal).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Settings } from '../src/types'
import { useStore } from '../src/store'
import SettingsPage from '../src/pages/SettingsPage'

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: false, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false, cliEnabled: false,
  dataPath: '/tmp', dataSize: '0 B',
}

type Result = { ok: true } | { busy: true } | { error: string }

const cliStatus = vi.fn<() => Promise<{ state: 'missing' }>>()
const resetAll = vi.fn<() => Promise<Result>>()
const uninstallApp = vi.fn<(o: { deleteData: boolean }) => Promise<Result>>()
const uninstallSupported = vi.fn<() => Promise<boolean>>()
const updateBrewManaged = vi.fn<() => Promise<boolean>>()
const showToast = vi.fn<(msg: string) => void>()

const bridge = () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    cliStatus, resetAll, uninstallApp, uninstallSupported, updateBrewManaged,
  }
}

beforeEach(() => {
  bridge()
  cliStatus.mockResolvedValue({ state: 'missing' })
  uninstallSupported.mockResolvedValue(true)
  updateBrewManaged.mockResolvedValue(false)
  useStore.setState({ platformOs: '', settings: SETTINGS, showToast })
  resetAll.mockReset()
  uninstallApp.mockReset()
  showToast.mockReset()
})

afterEach(cleanup)

// ConfirmModal acts on onClose, which fires only after the overlay's exit
// animation — jsdom runs no animations, so end it by hand.
function finishModalAnim(name: string) {
  const dlg = screen.getByRole('alertdialog', { name })
  fireEvent.animationEnd(dlg.parentElement!)
}

describe('RESET card (§4.9)', () => {
  const openConfirm = async () => {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset…' }))
    return screen.findByRole('alertdialog', { name: 'Delete all data and start over?' })
  }

  it('renders the row with its consequence copy', async () => {
    render(<SettingsPage />)
    await screen.findByText('RESET')
    await screen.findByText('Delete all data and start over')
    await screen.findByText(
      'Erases every automation, execution, agent, secret, and setting from this Mac, '
      + 'then Autowright restarts as new.',
    )
    await screen.findByRole('button', { name: 'Reset…' })
  })

  it('the confirm carries the spec body and the Delete everything label', async () => {
    await openConfirm()
    expect(screen.getByText(
      'Every automation, execution, agent, and setting on this Mac is deleted, and every '
      + 'secret is removed from your Keychain. Autowright then restarts as if newly '
      + 'installed. This can’t be undone.',
    )).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete everything' })).toBeTruthy()
  })

  it('cancel fires nothing', async () => {
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    finishModalAnim('Delete all data and start over?')
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Delete all data and start over?' })).toBeNull())
    expect(resetAll).not.toHaveBeenCalled()
  })

  it('confirm invokes reset-all once and shows Resetting…', async () => {
    resetAll.mockReturnValue(new Promise(() => {})) // in flight — the app relaunches
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    finishModalAnim('Delete all data and start over?')
    await waitFor(() => expect(resetAll).toHaveBeenCalledTimes(1))
    await screen.findByText('Resetting…')
    expect(screen.getByRole('button', { name: /Resetting…/ })).toHaveProperty('disabled', true)
  })

  it('busy (live execution): toast, row resets, nothing deleted', async () => {
    resetAll.mockResolvedValue({ busy: true })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    finishModalAnim('Delete all data and start over?')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'An automation is executing — reset when it finishes.'))
    const btn = await screen.findByRole('button', { name: 'Reset…' })
    expect(btn).toHaveProperty('disabled', false)
  })

  it('error: toast with the error text, row resets', async () => {
    resetAll.mockResolvedValue({ error: 'stop failed: launchd still reports the job' })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }))
    finishModalAnim('Delete all data and start over?')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'stop failed: launchd still reports the job'))
    await screen.findByRole('button', { name: 'Reset…' })
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('RESET')).toBeNull()
  })

  it('windows: the copy names the PC and the Credential Manager', async () => {
    useStore.setState({ platformOs: 'windows' })
    await openConfirm()
    expect(screen.getByText(
      'Erases every automation, execution, agent, secret, and setting from this PC, '
      + 'then Autowright restarts as new.',
    )).toBeTruthy()
    expect(screen.getByText(
      'Every automation, execution, agent, and setting on this PC is deleted, and every '
      + 'secret is removed from your Credential Manager. Autowright then restarts as if '
      + 'newly installed. This can’t be undone.',
    )).toBeTruthy()
    expect(screen.queryByText(/Keychain/)).toBeNull()
  })
})

describe('UNINSTALL card (§4.9)', () => {
  const openConfirm = async () => {
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall…' }))
    return screen.findByRole('alertdialog', { name: 'Uninstall Autowright?' })
  }

  it('renders the row with its consequence copy', async () => {
    render(<SettingsPage />)
    await screen.findByText('UNINSTALL')
    await screen.findByText('Uninstall Autowright')
    await screen.findByText(
      'Stops and removes the background service, then removes Autowright from this Mac.',
    )
    await screen.findByRole('button', { name: 'Uninstall…' })
  })

  it('unsupported platform: the card is hidden entirely', async () => {
    uninstallSupported.mockResolvedValue(false)
    render(<SettingsPage />)
    // RESET still renders — only UNINSTALL is gated on the §3 answer.
    await screen.findByText('RESET')
    await waitFor(() => expect(uninstallSupported).toHaveBeenCalled())
    expect(screen.queryByText('UNINSTALL')).toBeNull()
  })

  it('a shell too old to answer uninstall-supported: card hidden', async () => {
    ;(window as unknown as Record<string, unknown>).autowright = { cliStatus }
    render(<SettingsPage />)
    await screen.findByText('RESET')
    expect(screen.queryByText('UNINSTALL')).toBeNull()
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('UNINSTALL')).toBeNull()
  })

  it('brew-managed: no button, the cask command instead', async () => {
    updateBrewManaged.mockResolvedValue(true)
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<SettingsPage />)
    await screen.findByText('UNINSTALL')
    await waitFor(() => expect(
      screen.getByText('brew uninstall --cask --zap hansololz/tap/autowright')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Uninstall…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      'brew uninstall --cask --zap hansololz/tap/autowright'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Copied to clipboard.'))
  })

  it('the confirm carries the spec body, the checkbox (unchecked), and the label', async () => {
    await openConfirm()
    expect(screen.getByText(
      'The background service stops and is removed, then Autowright quits and removes '
      + 'itself from this Mac.',
    )).toBeTruthy()
    const box = screen.getByRole('checkbox', { name: 'Also delete my data and secrets' })
    expect(box).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: 'Uninstall Autowright' })).toBeTruthy()
  })

  it('cancel fires nothing', async () => {
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Uninstall Autowright?' })).toBeNull())
    expect(uninstallApp).not.toHaveBeenCalled()
  })

  it('confirm with the box unchecked keeps every file in place', async () => {
    uninstallApp.mockReturnValue(new Promise(() => {})) // in flight — the app exits
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Autowright' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() => expect(uninstallApp).toHaveBeenCalledWith({ deleteData: false }))
    expect(uninstallApp).toHaveBeenCalledTimes(1)
    await screen.findByText('Uninstalling…')
    expect(screen.getByRole('button', { name: /Uninstalling…/ })).toHaveProperty('disabled', true)
  })

  it('checking the box sends deleteData true', async () => {
    uninstallApp.mockReturnValue(new Promise(() => {}))
    await openConfirm()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete my data and secrets' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Autowright' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() => expect(uninstallApp).toHaveBeenCalledWith({ deleteData: true }))
  })

  it('the checkbox resets to unchecked on the next open', async () => {
    uninstallApp.mockResolvedValue({ busy: true })
    await openConfirm()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete my data and secrets' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Autowright' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() => expect(uninstallApp).toHaveBeenCalledWith({ deleteData: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall…' }))
    await screen.findByRole('alertdialog', { name: 'Uninstall Autowright?' })
    expect(screen.getByRole('checkbox', { name: 'Also delete my data and secrets' }))
      .toHaveProperty('checked', false)
  })

  it('busy (live execution): toast, row resets, nothing removed', async () => {
    uninstallApp.mockResolvedValue({ busy: true })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Autowright' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'An automation is executing — uninstall when it finishes.'))
    const btn = await screen.findByRole('button', { name: 'Uninstall…' })
    expect(btn).toHaveProperty('disabled', false)
  })

  it('error (the macOS trash failure included): toast, the app stays open', async () => {
    uninstallApp.mockResolvedValue({
      error: 'Autowright couldn’t move itself to the Trash — drag it there from Applications.',
    })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall Autowright' }))
    finishModalAnim('Uninstall Autowright?')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Autowright couldn’t move itself to the Trash — drag it there from Applications.'))
    await screen.findByRole('button', { name: 'Uninstall…' })
  })

  it('windows: the copy names the PC', async () => {
    useStore.setState({ platformOs: 'windows' })
    await openConfirm()
    expect(screen.getByText(
      'Stops and removes the background service, then removes Autowright from this PC.',
    )).toBeTruthy()
    expect(screen.getByText(
      'The background service stops and is removed, then Autowright quits and removes '
      + 'itself from this PC.',
    )).toBeTruthy()
  })
})
