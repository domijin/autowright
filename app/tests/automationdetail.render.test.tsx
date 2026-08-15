// Component tests for the §9.2 capacity popup: pressing Execute now while
// anything is live routes through the modal — Run now (free slot), Queue
// (slots full, queue has room, sends §19 queue: true), or the capacity-full
// notice (no run option). AutomationDetail renders for real (happy-dom) with
// the store seeded and the api module mocked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Automation, Execution } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    getAutomation: vi.fn(() => Promise.reject(new Error('offline'))),
    triggersPreview: vi.fn(async () => ({ triggers: [] })),
    executeNow: vi.fn(async () => ({ executionId: 'e-new', queued: false })),
  },
}))

let storeMod: typeof import('../src/store')
let mockedApi: Record<string, ReturnType<typeof vi.fn>>
let AutomationDetail: typeof import('../src/pages/AutomationDetail').default

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  mockedApi = (await import('../src/api')).api as unknown as Record<string, ReturnType<typeof vi.fn>>
  AutomationDetail = (await import('../src/pages/AutomationDetail')).default
})

const auto = (over: Partial<Automation> = {}): Automation => ({
  id: 'a1', name: 'Job', description: '', version: 1, triggers: [], triggerChip: 'No triggers',
  triggersOff: false, nextAt: null, instructions: '', notes: '', lastStatus: 'succeeded',
  live: [], maxParallel: 1, maxQueued: 10, resultChip: null, resultStatus: null,
  lastExecutionLabel: 'Today', agentId: null, stepAgents: [], allowedSecrets: [],
  snapshotSettings: { preVersion: true, preClear: true, preRestore: true }, specMeta: '',
  ...over,
})

const NOW = 1_700_000_000_000

const queuedRow = (id: string): Execution => ({
  id, automationId: 'a1', automationName: 'Job', automationDeleted: false, ver: 'v1',
  status: 'queued', trigger: 'Manual', test: false, duration: '',
  started: 'Today, 8:00 AM', startedMs: NOW, endedMs: 0, queuedMs: NOW - 5_000,
  note: null, error: null,
})

const seed = (a: Automation, executions: Execution[] = []) =>
  storeMod.useStore.setState({ page: 'automation', automationId: 'a1', automations: [a], executions, toast: null })

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  mockedApi.executeNow.mockClear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const clickExecuteNow = () => {
  // The header's accent primary — reads "Executing…" while anything is live.
  const btn = screen.getAllByRole('button').find((b) => /Execute now|Executing…/.test(b.textContent ?? ''))
  expect(btn).toBeTruthy()
  fireEvent.click(btn!)
}

describe('§9.2 capacity popup', () => {
  it('nothing live → no popup, executes immediately', async () => {
    seed(auto())
    render(<AutomationDetail />)
    clickExecuteNow()
    expect(screen.queryByText('Already executing')).toBeNull()
    await waitFor(() => expect(mockedApi.executeNow).toHaveBeenCalledTimes(1))
    expect(mockedApi.executeNow).toHaveBeenCalledWith('a1', undefined, 'manual', false)
  })

  it('free slot beside a live execution → Run now confirm, plain start', async () => {
    seed(auto({ live: ['e1'], maxParallel: 3 }))
    render(<AutomationDetail />)
    clickExecuteNow()
    expect(mockedApi.executeNow).not.toHaveBeenCalled()
    expect(screen.getByText('Already executing')).toBeTruthy()
    expect(screen.getByText(/1 of 3 slots are busy/)).toBeTruthy()
    expect(screen.queryByText('Queue')).toBeNull()
    fireEvent.click(screen.getByText('Run now'))
    await waitFor(() => expect(mockedApi.executeNow).toHaveBeenCalledTimes(1))
    expect(mockedApi.executeNow).toHaveBeenCalledWith('a1', undefined, 'manual', false)
  })

  it('slots full with queue room → Queue sends queue: true and toasts', async () => {
    mockedApi.executeNow.mockResolvedValueOnce({ executionId: 'e-q', queued: true })
    seed(auto({ live: ['e1'], maxParallel: 1, maxQueued: 10 }))
    render(<AutomationDetail />)
    clickExecuteNow()
    expect(screen.getByText('Already executing')).toBeTruthy()
    expect(screen.getByText(/The slot is busy/)).toBeTruthy()
    expect(screen.queryByText('Run now')).toBeNull()
    fireEvent.click(screen.getByText('Queue'))
    await waitFor(() => expect(mockedApi.executeNow).toHaveBeenCalledTimes(1))
    expect(mockedApi.executeNow).toHaveBeenCalledWith('a1', undefined, 'manual', true)
    await waitFor(() =>
      expect(storeMod.useStore.getState().toast).toBe('Queued — runs as soon as a slot frees up.'))
  })

  it('slots and queue both full → capacity-full notice, no run or queue option', async () => {
    seed(auto({ live: ['e1'], maxParallel: 1, maxQueued: 1 }), [queuedRow('e-wait')])
    render(<AutomationDetail />)
    clickExecuteNow()
    expect(screen.getByText('Execution and queue capacity is full')).toBeTruthy()
    expect(screen.getByText(/1 executing, 1 waiting\./)).toBeTruthy()
    expect(screen.queryByText('Run now')).toBeNull()
    expect(screen.queryByText('Queue')).toBeNull()
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => expect(screen.queryByText('Execution and queue capacity is full')).toBeNull())
    expect(mockedApi.executeNow).not.toHaveBeenCalled()
  })

  it('maxQueued 0 → capacity-full notice without a waiting count', () => {
    seed(auto({ live: ['e1'], maxParallel: 1, maxQueued: 0 }))
    render(<AutomationDetail />)
    clickExecuteNow()
    expect(screen.getByText('Execution and queue capacity is full')).toBeTruthy()
    expect(screen.getByText(/1 executing\./)).toBeTruthy()
    expect(mockedApi.executeNow).not.toHaveBeenCalled()
  })
})
