// §4.9 QUIT card: confirm-gated quit-all IPC (§3 explicit-quit exception) —
// busy and error leave everything running and toast; success exits the app.
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

const cliStatus = vi.fn<() => Promise<{ state: 'missing' }>>()
const quitAll = vi.fn<() => Promise<{ ok: true } | { busy: true } | { error: string }>>()
const showToast = vi.fn<(msg: string) => void>()

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).autowright = { cliStatus, quitAll }
  cliStatus.mockResolvedValue({ state: 'missing' })
  useStore.setState({ settings: SETTINGS, showToast })
  quitAll.mockReset()
  showToast.mockReset()
})

afterEach(cleanup)

async function openConfirm() {
  render(<SettingsPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Quit…' }))
  return screen.findByRole('alertdialog', { name: 'Quit Autowright entirely?' })
}

// ConfirmModal acts on onClose, which fires only after the overlay's exit
// animation — jsdom runs no animations, so end it by hand.
function finishModalAnim() {
  const dlg = screen.getByRole('alertdialog', { name: 'Quit Autowright entirely?' })
  fireEvent.animationEnd(dlg.parentElement!)
}

describe('QUIT card (§4.9)', () => {
  it('renders the row with its consequence copy', async () => {
    render(<SettingsPage />)
    await screen.findByText('QUIT')
    await screen.findByText('Quit Autowright entirely')
    await screen.findByText(/schedules and message triggers pause until you next log in/)
    await screen.findByRole('button', { name: 'Quit…' })
  })

  it('Quit… opens the confirm; cancel fires nothing', async () => {
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    finishModalAnim()
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Quit Autowright entirely?' })).toBeNull())
    expect(quitAll).not.toHaveBeenCalled()
  })

  it('confirm invokes quit-all once and shows Stopping…', async () => {
    quitAll.mockReturnValue(new Promise(() => {})) // in flight — app is exiting
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Quit Autowright' }))
    finishModalAnim()
    await waitFor(() => expect(quitAll).toHaveBeenCalledTimes(1))
    await screen.findByText('Stopping…')
    expect(screen.getByRole('button', { name: /Stopping…/ })).toHaveProperty('disabled', true)
  })

  it('busy (live execution): toast, button re-enabled, nothing quits', async () => {
    quitAll.mockResolvedValue({ busy: true })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Quit Autowright' }))
    finishModalAnim()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'An automation is executing — quit when it finishes.'))
    const btn = await screen.findByRole('button', { name: 'Quit…' })
    expect(btn).toHaveProperty('disabled', false)
  })

  it('stop failure: toast with the error, app stays up', async () => {
    quitAll.mockResolvedValue({ error: 'stop failed: launchd still reports the job' })
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Quit Autowright' }))
    finishModalAnim()
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'stop failed: launchd still reports the job'))
    await screen.findByRole('button', { name: 'Quit…' })
  })

  it('no preload bridge (plain browser): card hidden', async () => {
    delete (window as unknown as Record<string, unknown>).autowright
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText('QUIT')).toBeNull()
  })
})
