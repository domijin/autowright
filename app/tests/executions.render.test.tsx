// Component tests for the §7 executions list: the three sections (Running /
// Waiting / Finished), the Waiting table's own columns, and the drain order —
// a §6 queued firing must read top-down in the order it will actually run.
// ExecutionsList renders for real (happy-dom) with the store seeded and the
// api module mocked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Exec } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    getExec: vi.fn(() => Promise.reject(new Error('offline'))),
  },
}))

let storeMod: typeof import('../src/store')
let ExecutionsList: typeof import('../src/pages/ExecutionsList').default

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  ExecutionsList = (await import('../src/pages/ExecutionsList')).default
})

const NOW = 1_700_000_000_000

const ex = (id: string, over: Partial<Exec> = {}): Exec => ({
  id, autoId: 'a1', autoName: 'Auto', autoDeleted: false, ver: 'v1',
  status: 'succeeded', trigger: 'Manual', test: false, dur: '1.0s',
  started: 'Today, 8:00 AM', startedMs: NOW, endedMs: NOW, queuedMs: 0,
  note: null, error: null, ...over,
})

const seed = (execs: Exec[]) => storeMod.useStore.setState({ page: 'executions', execs })

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  storeMod.useStore.setState({ page: 'executions', execs: [], autos: [], toast: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('executions list sections (§7)', () => {
  it('splits queued firings out of Running into their own Waiting section', () => {
    seed([
      ex('e-run', { status: 'executing', dur: '', endedMs: 0 }),
      ex('e-wait', { status: 'queued', dur: '', endedMs: 0, queuedMs: NOW - 5_000, trigger: 'Discord' }),
      ex('e-done'),
    ])
    const { container } = render(<ExecutionsList />)

    expect(screen.getByText('RUNNING')).toBeTruthy()
    expect(screen.getByText('WAITING')).toBeTruthy()
    expect(screen.getByText('FINISHED')).toBeTruthy()
    // section membership read from document order (labels precede their tables):
    // the running row sits between RUNNING and WAITING, the queued row after WAITING
    const text = container.textContent!
    expect(text.indexOf('e-run')).toBeGreaterThan(text.indexOf('RUNNING'))
    expect(text.indexOf('e-run')).toBeLessThan(text.indexOf('WAITING'))
    expect(text.indexOf('e-wait')).toBeGreaterThan(text.indexOf('WAITING'))
  })

  it('gives the Waiting table its own columns — a queued row has no duration and never started', () => {
    seed([ex('e-wait', { status: 'queued', dur: '', endedMs: 0, queuedMs: NOW - 65_000 })])
    render(<ExecutionsList />)

    expect(screen.getByText('WAITING FOR')).toBeTruthy()
    expect(screen.getByText('QUEUED AT')).toBeTruthy()
    expect(screen.getByText('1m 5s')).toBeTruthy()
    // DURATION / STARTED belong to the other tables, and neither is rendered here
    expect(screen.queryByText('DURATION')).toBeNull()
    expect(screen.queryByText('STARTED')).toBeNull()
  })

  it('orders Waiting oldest-first — the §6 drain order, so the next to run reads top', () => {
    seed([
      ex('e-new', { status: 'queued', dur: '', endedMs: 0, queuedMs: NOW - 2_000 }),
      ex('e-old', { status: 'queued', dur: '', endedMs: 0, queuedMs: NOW - 30_000 }),
    ])
    const { container } = render(<ExecutionsList />)

    const text = container.textContent!
    expect(text.indexOf('e-old')).toBeGreaterThan(text.indexOf('WAITING'))
    expect(text.indexOf('e-old')).toBeLessThan(text.indexOf('e-new'))
  })

  it('stays a single unlabelled table when nothing is live or waiting', () => {
    seed([ex('e-done')])
    render(<ExecutionsList />)

    expect(screen.queryByText('RUNNING')).toBeNull()
    expect(screen.queryByText('WAITING')).toBeNull()
    expect(screen.queryByText('FINISHED')).toBeNull()
  })

  it('keeps waiting rows visible under a filter that only applies to finished rows', () => {
    seed([
      ex('e-wait', { status: 'queued', dur: '', endedMs: 0, queuedMs: NOW - 1_000 }),
      ex('e-done', { status: 'failed' }),
    ])
    render(<ExecutionsList />)

    // apply the Succeeded filter: the failed finished row is filtered out…
    fireEvent.click(screen.getByText('Succeeded'))
    expect(screen.queryByText('e-done')).toBeNull()
    expect(screen.getByText('No succeeded executions')).toBeTruthy()
    // …but the waiting row is outside the filter and stays visible
    expect(screen.getByText('WAITING')).toBeTruthy()
    expect(screen.getByText('e-wait')).toBeTruthy()
  })
})
