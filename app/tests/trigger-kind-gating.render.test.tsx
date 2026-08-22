// §9.2/§2 platform gating: the add-trigger kind picker offers iMessage only
// while the store's `capabilities.imessage` (read from §19 /health) is true —
// absent, never disabled, on every other platform. The editor renders for real
// (happy-dom) against the real store with the api module mocked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    triggersPreview: vi.fn(async () => ({ triggers: [] })),
    imessagePermissions: vi.fn(async () => ({ fullDisk: true, automation: 'granted' })),
  },
}))

let storeMod: typeof import('../src/store')
let TriggerEditor: typeof import('../src/pages/detail/TriggerEditor').TriggerEditor

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  TriggerEditor = (await import('../src/pages/detail/TriggerEditor')).TriggerEditor
})

const caps = (imessage: boolean) =>
  storeMod.useStore.setState({
    secrets: [],
    platformCapabilities: {
      imessage, notifications: true, keepAwake: true, service: true, agentInstall: true,
    },
  })

const editor = () => (
  <TriggerEditor hasAppStart={false} onSave={() => {}} onCancel={() => {}} />
)

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

describe('§9.2 kind picker — iMessage gating', () => {
  it('capabilities.imessage true: every kind chip is offered', () => {
    caps(true)
    render(editor())
    for (const label of ['Cron', 'One time', 'App start', 'Discord', 'iMessage']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('capabilities.imessage false: the chip is absent, not disabled', () => {
    caps(false)
    render(editor())
    expect(screen.queryByText('iMessage')).toBeNull()
    // The other four still stand — only the one kind is gated.
    for (const label of ['Cron', 'One time', 'App start', 'Discord']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('the gated kind can never be picked — its setup body stays away too', () => {
    caps(false)
    render(editor())
    expect(screen.queryByText('How iMessage triggers work')).toBeNull()
    // Picking a kind that IS offered still works.
    fireEvent.click(screen.getByText('Discord'))
    expect(screen.getByText('New to Discord bots? Step-by-step setup')).toBeTruthy()
    expect(screen.queryByText('How iMessage triggers work')).toBeNull()
  })
})
