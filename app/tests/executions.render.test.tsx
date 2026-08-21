// Component tests for the §7 executions list: the three sections (Running /
// Waiting / Finished), the Waiting table's own columns, and the drain order —
// a §6 queued firing must read top-down in the order it will actually run.
// ExecutionsList renders for real (happy-dom) with the store seeded and the
// api module mocked.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Execution } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    getExecution: vi.fn(() => Promise.reject(new Error('offline'))),
    getExecutionLogs: vi.fn(() => Promise.reject(new Error('offline'))),
  },
}))

let storeMod: typeof import('../src/store')
let ExecutionsList: typeof import('../src/pages/ExecutionsList').default
let ExecutionPage: typeof import('../src/pages/ExecutionPage').default

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: () => {},
    trayAlert: () => Promise.resolve(),
  }
  storeMod = await import('../src/store')
  ExecutionsList = (await import('../src/pages/ExecutionsList')).default
  ExecutionPage = (await import('../src/pages/ExecutionPage')).default
})

const NOW = 1_700_000_000_000

const ex = (id: string, over: Partial<Execution> = {}): Execution => ({
  id, automationId: 'a1', automationName: 'Automation', automationDeleted: false, versionLabel: 'v1',
  status: 'succeeded', trigger: 'Manual', triggerSender: null, test: false, duration: '1.0s',
  started: 'Today, 8:00 AM', startedMs: NOW, endedMs: NOW, queuedMs: 0,
  note: null, error: null, ...over,
})

const seed = (executions: Execution[]) => storeMod.useStore.setState({ page: 'executions', executions })

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  storeMod.useStore.setState({ page: 'executions', executions: [], automations: [], toast: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('executions list sections (§7)', () => {
  it('splits queued firings out of Running into their own Waiting section', () => {
    seed([
      ex('e-run', { status: 'executing', duration: '', endedMs: 0 }),
      ex('e-wait', { status: 'queued', duration: '', endedMs: 0, queuedMs: NOW - 5_000, trigger: 'Discord' }),
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
    seed([ex('e-wait', { status: 'queued', duration: '', endedMs: 0, queuedMs: NOW - 65_000 })])
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
      ex('e-new', { status: 'queued', duration: '', endedMs: 0, queuedMs: NOW - 2_000 }),
      ex('e-old', { status: 'queued', duration: '', endedMs: 0, queuedMs: NOW - 30_000 }),
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

  it('lists §11 test executions like any run, printing "Test" once in the trigger column', () => {
    seed([ex('e-test', { test: true, trigger: 'Test', versionLabel: 'Test', automationName: 'New automation' })])
    const { container } = render(<ExecutionsList />)

    expect(screen.getByText('e-test')).toBeTruthy()
    // trigger and versionLabel labels are both "Test" — the row never prints the pair (§7)
    expect(container.textContent).not.toContain('Test · Test')
    expect(screen.getByText('Test')).toBeTruthy()
  })

  it('keeps waiting rows visible under a filter that only applies to finished rows', () => {
    seed([
      ex('e-wait', { status: 'queued', duration: '', endedMs: 0, queuedMs: NOW - 1_000 }),
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

// §7 Finished cap: retention can be off entirely (`keepForever`), so the finished
// list is unbounded; the page paints 200 rows and reveals the rest 200 at a time.
describe('executions list finished cap (§7)', () => {
  const finishedRows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      ex(`e-${String(i).padStart(4, '0')}`, { endedMs: NOW - i * 1000, startedMs: NOW - i * 1000 }))

  it('renders 200 finished rows and says how many are hidden', () => {
    seed(finishedRows(1250))
    render(<ExecutionsList />)

    expect(screen.getAllByTestId('execution-row').length).toBe(200)
    expect(screen.getByText('Show more (1,050 hidden)')).toBeTruthy()
    // the cap keeps the newest rows: the sort is by endedMs, newest first
    expect(screen.getByText('e-0000')).toBeTruthy()
    expect(screen.queryByText('e-0200')).toBeNull()
  })

  it('reveals the next 200 on each click, then drops the control', () => {
    seed(finishedRows(450))
    render(<ExecutionsList />)

    fireEvent.click(screen.getByText('Show more (250 hidden)'))
    expect(screen.getAllByTestId('execution-row').length).toBe(400)

    fireEvent.click(screen.getByText('Show more (50 hidden)'))
    expect(screen.getAllByTestId('execution-row').length).toBe(450)
    expect(screen.queryByText(/Show more/)).toBeNull()
  })

  it('shows no control when the finished list fits the cap', () => {
    seed(finishedRows(200))
    render(<ExecutionsList />)

    expect(screen.getAllByTestId('execution-row').length).toBe(200)
    expect(screen.queryByText(/Show more/)).toBeNull()
  })

  it('never caps Running or Waiting', () => {
    seed([
      ...Array.from({ length: 3 }, (_, i) =>
        ex(`r-${i}`, { status: 'executing', duration: '', endedMs: 0 })),
      ...finishedRows(250),
    ])
    render(<ExecutionsList />)

    // 3 running + the 200-row finished page
    expect(screen.getAllByTestId('execution-row').length).toBe(203)
    expect(screen.getByText('Show more (50 hidden)')).toBeTruthy()
  })
})

// §7 log cap: the LOGS pane shows the last 2000 lines and says so when earlier
// lines were dropped. Log sequences are gapless from 1 (§5), so a kept head past
// 1 is the truncation signal.
describe('execution page log cap (§7)', () => {
  const line = (sequence: number) => ({ time: '00:00', kind: 'out' as const, sequence, text: `line ${sequence}` })
  const withLogs = (lines: ReturnType<typeof line>[]) => {
    const full: Execution = {
      ...ex('e1'),
      steps: [{
        name: 'Step one', status: 'succeeded', duration: '1s',
        attempts: [{ number: 1, status: 'succeeded', duration: '1s', startedMs: NOW }],
      }],
      result: null,
    }
    storeMod.useStore.setState({
      page: 'execution', executionId: 'e1', executions: [ex('e1')],
      executionFull: { e1: full },
      execLogs: { e1: { '0.1': lines } },
    })
  }

  it('shows the truncation notice when the kept log starts past line 1', () => {
    withLogs([line(51), line(52), line(53)])
    render(<ExecutionPage />)

    expect(screen.getByText('Truncated — showing the last 2000 lines. The full log is on disk.')).toBeTruthy()
    expect(screen.getByText('line 51')).toBeTruthy()
  })

  it('shows no notice for a whole log', () => {
    withLogs([line(1), line(2)])
    render(<ExecutionPage />)

    expect(screen.getByText('line 1')).toBeTruthy()
    expect(screen.queryByText(/Truncated/)).toBeNull()
  })
})
