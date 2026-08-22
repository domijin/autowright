// §4.9/§2 platform gating on the Settings GENERAL card: the "Keep this Mac
// awake" row renders only while the store's `capabilities.keepAwake` is true,
// and the notifications row only while `capabilities.notifications` is (both
// read from §19 /health). Hidden, never disabled — the stored settings are
// untouched either way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PlatformCapabilities, Settings } from '../src/types'
import { useStore } from '../src/store'
import SettingsPage from '../src/pages/SettingsPage'

vi.mock('../src/api', () => ({
  api: { patchSettings: vi.fn(() => Promise.resolve({})), setDataPath: vi.fn(() => Promise.resolve({})) },
}))

const SETTINGS: Settings = {
  login: false, menuBarIcon: false, keepAwake: true, automaticUpdateCheck: false,
  notifications: 'attention', days: 30, keepForever: false, developerMode: false,
  cliEnabled: false, dataPath: '/tmp', dataSize: '0 B',
}

const MAC: PlatformCapabilities = {
  imessage: true, notifications: true, keepAwake: true, service: true, agentInstall: true,
}

const setup = (caps: Partial<PlatformCapabilities>) => {
  // No preload bridge: the §4.9 COMMAND LINE and QUIT cards stay out of the way.
  delete (window as unknown as Record<string, unknown>).autowright
  useStore.setState({ settings: { ...SETTINGS }, platformCapabilities: { ...MAC, ...caps } })
}

const KEEP_AWAKE = 'Keep this Mac awake'
const NOTIFY = 'Notify me'

beforeEach(() => { useStore.setState({ platformCapabilities: MAC }) })
afterEach(cleanup)

describe('Settings GENERAL card — platform gating (§4.9/§9)', () => {
  it('all capabilities on: both rows render', async () => {
    setup({})
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.getByText(KEEP_AWAKE)).toBeTruthy()
    expect(screen.getByText(NOTIFY)).toBeTruthy()
    expect(screen.getByText('Only when something needs attention')).toBeTruthy()
  })

  it('keepAwake false: that row is gone, the notifications row stays', async () => {
    setup({ keepAwake: false })
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText(KEEP_AWAKE)).toBeNull()
    expect(screen.queryByText(/Prevents this Mac from sleeping/)).toBeNull()
    expect(screen.getByText(NOTIFY)).toBeTruthy()
    // Hidden, not disabled — no leftover toggle for the gated row.
    expect(screen.getByText('Show in the menu bar')).toBeTruthy()
  })

  it('notifications false: that row is gone, the keepAwake row stays', async () => {
    setup({ notifications: false })
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText(NOTIFY)).toBeNull()
    expect(screen.queryByText('Only when something needs attention')).toBeNull()
    expect(screen.queryByText('After every execution')).toBeNull()
    expect(screen.getByText(KEEP_AWAKE)).toBeTruthy()
  })

  it('both false: neither row renders and the stored settings are untouched', async () => {
    setup({ keepAwake: false, notifications: false })
    render(<SettingsPage />)
    await screen.findByText('GENERAL')
    expect(screen.queryByText(KEEP_AWAKE)).toBeNull()
    expect(screen.queryByText(NOTIFY)).toBeNull()
    // §4.9: the values keep living in the store (CLI parity) — only the rows go.
    expect(useStore.getState().settings?.keepAwake).toBe(true)
    expect(useStore.getState().settings?.notifications).toBe('attention')
  })
})
