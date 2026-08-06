// Unit tests for src/store.ts — the real zustand store, with the api module
// mocked so refresh/loadExec never hit the network. window.autowright is
// stubbed BEFORE the dynamic import so the module-level onOpenTarget hook
// registers against our capture.
//
// Note: autoIdFromHash and navSame are module-private (not exported), so they
// are exercised through their observable behavior — the onOpenTarget deep-link
// callback and history.pushState dedupe — instead of direct calls.
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Exec, LogLine } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: {
    state: vi.fn(() => Promise.reject(new Error('offline'))),
    getExec: vi.fn(() => Promise.reject(new Error('offline'))),
    getExecLogs: vi.fn(() => Promise.reject(new Error('offline'))),
    getAuto: vi.fn(() => Promise.reject(new Error('offline'))),
  },
}))

let store: typeof import('../src/store')
let apiMod: typeof import('../src/api')
let openTarget: ((hash: string) => void) | undefined
// Snapshot of the store's pristine state, captured once right after import —
// beforeEach restores ALL of it so no test leaks state into the next.
let initialState: Record<string, unknown>

beforeAll(async () => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    onOpenTarget: (cb: (hash: string) => void) => { openTarget = cb },
    trayAlert: () => Promise.resolve(),
  }
  store = await import('../src/store')
  apiMod = await import('../src/api')
  initialState = { ...store.useStore.getState() }
})

const ex = (id: string, startedMs: number, over: Partial<Exec> = {}): Exec => ({
  id, autoId: 'a1', autoName: 'Auto', autoDeleted: false, ver: 'v1',
  status: 'succeeded', trigger: 'Manual', test: false, dur: '1s',
  started: 'now', startedMs, note: null, error: null, ...over,
})
const line = (seq: number, text = 'line'): LogLine => ({ t: '00:00', k: 'out', seq, text })

beforeEach(() => {
  // Full reset: fresh deep copies of every data field, action functions shared.
  const fresh = Object.fromEntries(Object.entries(initialState).map(([k, v]) =>
    [k, typeof v === 'function' ? v : structuredClone(v)]))
  store.useStore.setState(fresh as unknown as ReturnType<typeof store.useStore.getState>, true)
})
afterEach(() => vi.useRealTimers())

describe('logKey', () => {
  it('null step → the execution log bucket', () => {
    expect(store.logKey(null, null)).toBe('x.0')
    expect(store.logKey(null, 3)).toBe('x.0')
  })
  it('step + attempt select the attempt file, attempt defaults to 1', () => {
    expect(store.logKey(2, 3)).toBe('2.3')
    expect(store.logKey(0, null)).toBe('0.1')
  })
})

describe('autoIdFromHash (via the onOpenTarget deep link)', () => {
  it('a valid 36-char uuid in the hash navigates to the automation', () => {
    expect(openTarget).toBeTypeOf('function')
    openTarget!('#/app?auto=123e4567-e89b-12d3-a456-426614174000')
    const m = store.useStore.getState()
    expect(m.page).toBe('automation')
    expect(m.autoId).toBe('123e4567-e89b-12d3-a456-426614174000')
  })
  it('missing or malformed auto id does not navigate', () => {
    openTarget!('#/app')
    expect(store.useStore.getState().page).toBe('automations')
    openTarget!('#/app?auto=SHORT')
    expect(store.useStore.getState().page).toBe('automations')
    openTarget!('#/app?auto=123E4567-E89B-12D3-A456-426614174000') // uppercase → no match
    expect(store.useStore.getState().page).toBe('automations')
  })
})

describe('navSame (via history.pushState dedupe)', () => {
  it('identical nav snapshots push exactly once; any changed field pushes again', () => {
    const spy = vi.spyOn(history, 'pushState')
    const m = store.useStore.getState()
    m.go('executions')
    const base = spy.mock.calls.length
    m.go('executions')                       // same page + same ids → deduped
    expect(spy.mock.calls.length).toBe(base)
    m.go('executions', { execId: 'e1' })     // execId differs → pushes
    expect(spy.mock.calls.length).toBe(base + 1)
    m.go('execution', { execId: 'e1' })      // page differs → pushes
    expect(spy.mock.calls.length).toBe(base + 2)
    m.go('execution', { execId: 'e1', autoId: 'a9' }) // autoId differs → pushes
    expect(spy.mock.calls.length).toBe(base + 3)
    spy.mockRestore()
  })
})

describe('applyEvent', () => {
  it('exec.started inserts and re-sorts by startedMs desc, replacing an existing id', () => {
    store.useStore.setState({ execs: [ex('e1', 100), ex('e2', 50)] })
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'exec.started', exec_json: ex('e3', 200, { status: 'executing' }) })
    expect(store.useStore.getState().execs.map((e) => e.id)).toEqual(['e3', 'e1', 'e2'])
    store.useStore.getState().applyEvent({ ev: 'exec.started', exec_json: ex('e2', 300) })
    expect(store.useStore.getState().execs.map((e) => e.id)).toEqual(['e2', 'e3', 'e1'])
  })

  it('exec.finished header merge preserves an already-loaded full body', () => {
    const full: Exec = {
      ...ex('e1', 100, { status: 'executing' }),
      steps: [{ name: 's1', status: 'succeeded', dur: '1s', attempts: [] }],
      result: { chip: 'done' },
    }
    store.useStore.setState({ execs: [ex('e1', 100, { status: 'executing' })], execFull: { e1: full } })
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e1', 100, { status: 'failed', test: true }), // header: no steps/result
    })
    const got = store.useStore.getState().execFull.e1
    expect(got.status).toBe('failed')
    expect(got.steps).toEqual(full.steps)     // body kept through the merge
    expect(got.result).toEqual(full.result)
  })

  it('exec.log dedupes by seq against the bucket tail, gaps accepted', () => {
    store.useStore.setState({ execLogs: { e9: { 'x.0': [line(5)] } } })
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(5) })
    expect(store.useStore.getState().execLogs.e9['x.0']).toHaveLength(1)
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(4) })
    expect(store.useStore.getState().execLogs.e9['x.0']).toHaveLength(1)
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'e9', stepIndex: null, attempt: null, line: line(7) })
    expect(store.useStore.getState().execLogs.e9['x.0'].map((l) => l.seq)).toEqual([5, 7])
    // no bucket open → the line is dropped, not crashed on
    store.useStore.getState().applyEvent({ ev: 'exec.log', execId: 'nope', stepIndex: null, attempt: null, line: line(1) })
    expect(store.useStore.getState().execLogs.nope).toBeUndefined()
  })

  it('exec.finished toasts a summary for real executions', () => {
    vi.useFakeTimers()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e5', 1, { status: 'succeeded' }),
      auto_json: { name: 'My Auto', resultChip: '3 changes' },
    })
    expect(store.useStore.getState().toast).toBe('My Auto finished — 3 changes.')
    vi.runAllTimers()
    expect(store.useStore.getState().toast).toBeNull()

    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e6', 2, { status: 'failed' }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBe('My Auto failed — needs attention.')
    vi.runAllTimers()
  })

  it('exec.step replaces exactly the indexed step on a loaded full record (§19)', () => {
    const steps = [
      { name: 's1', status: 'succeeded', dur: '1s', attempts: [] },
      { name: 's2', status: 'executing', dur: '', attempts: [] },
    ] as NonNullable<Exec['steps']>
    store.useStore.setState({ execFull: { e1: { ...ex('e1', 100), steps } } })
    const updated = { name: 's2', status: 'succeeded', dur: '2s', attempts: [] }
    store.useStore.getState().applyEvent({ ev: 'exec.step', execId: 'e1', index: 1, step: updated })
    const got = store.useStore.getState().execFull.e1.steps!
    expect(got[0]).toEqual(steps[0])   // untouched
    expect(got[1]).toEqual(updated)    // replaced wholesale
    expect(got).toHaveLength(2)
  })

  it('exec.step is a no-op when no full record is loaded', () => {
    store.useStore.setState({ execFull: { other: { ...ex('other', 1) } } }) // no steps either
    const before = store.useStore.getState().execFull
    store.useStore.getState().applyEvent({
      ev: 'exec.step', execId: 'nope', index: 0,
      step: { name: 's', status: 'succeeded', dur: '1s', attempts: [] },
    })
    // header-only record (no steps) is also left alone
    store.useStore.getState().applyEvent({
      ev: 'exec.step', execId: 'other', index: 0,
      step: { name: 's', status: 'succeeded', dur: '1s', attempts: [] },
    })
    expect(store.useStore.getState().execFull).toEqual(before)
  })

  it('beginTest tracks only the execId and fetches the full record; clearTest drops it', () => {
    const getExec = vi.mocked(apiMod.api.getExec)
    getExec.mockClear()
    store.useStore.getState().beginTest('eT')
    // §11: steps/status render off the ordinary exec record — beginTest holds
    // no analysis state of its own, just the tracked id, and loads the record.
    expect(store.useStore.getState().test).toEqual({ execId: 'eT' })
    expect(getExec).toHaveBeenCalledWith('eT')
    store.useStore.getState().clearTest()
    expect(store.useStore.getState().test).toBeNull()
  })

  it('fixExec is plain handed-off state, untouched by events', () => {
    // §7/§9.2 Fix with AI: the store only carries the failed execId to the
    // editor; no event mutates it — CreateFlow consumes and clears it on mount.
    store.useStore.setState({ fixExec: 'eF' })
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('eF', 1, { status: 'failed' }),
      auto_json: { name: 'A', resultChip: null },
    })
    expect(store.useStore.getState().fixExec).toBe('eF')
  })

  it('toast suppressed for test executions and for cancelled status', () => {
    vi.useFakeTimers()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e7', 3, { status: 'succeeded', test: true }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBeNull()
    store.useStore.getState().applyEvent({
      ev: 'exec.finished',
      exec_json: ex('e8', 4, { status: 'cancelled' }),
      auto_json: { name: 'My Auto', resultChip: null },
    })
    expect(store.useStore.getState().toast).toBeNull()
  })
})

describe('applyEvent — harness.install / ollama.pull live progress (§10/§12)', () => {
  it('harness.install keys progress by provider id and merges across ids', () => {
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'harness.install', id: 'claude', line: 'Downloading…', pct: 42, done: false })
    m.applyEvent({ ev: 'harness.install', id: 'ollama', line: 'Unpacking…', done: false })
    const hi = store.useStore.getState().harnessInstall
    expect(hi.claude).toEqual({ line: 'Downloading…', pct: 42, done: false, ok: undefined, error: undefined })
    expect(hi.ollama).toEqual({ line: 'Unpacking…', pct: undefined, done: false, ok: undefined, error: undefined })
  })

  it('harness.install terminal events carry done/ok and the failure line', () => {
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'harness.install', id: 'codex', done: true, ok: true })
    expect(store.useStore.getState().harnessInstall.codex.done).toBe(true)
    expect(store.useStore.getState().harnessInstall.codex.ok).toBe(true)
    m.applyEvent({ ev: 'harness.install', id: 'gemini', done: true, ok: false, error: 'Gemini CLI needs Node.js' })
    const g = store.useStore.getState().harnessInstall.gemini
    expect(g.ok).toBe(false)
    expect(g.error).toBe('Gemini CLI needs Node.js')
  })

  it('ollama.pull holds the latest line only — the UI parses pct out of it', () => {
    const m = store.useStore.getState()
    m.applyEvent({ ev: 'ollama.pull', model: 'qwen3:8b', line: 'pulling 3f2a… 12%', done: false })
    expect(store.useStore.getState().ollamaPull).toEqual({ model: 'qwen3:8b', line: 'pulling 3f2a… 12%', done: false, ok: undefined })
    m.applyEvent({ ev: 'ollama.pull', model: 'qwen3:8b', line: '', done: true, ok: true })
    expect(store.useStore.getState().ollamaPull).toEqual({ model: 'qwen3:8b', line: '', done: true, ok: true })
  })

  it('loadExecLogs merges the snapshot with WS lines streamed past it', async () => {
    let resolveFetch!: (v: { lines: LogLine[] }) => void
    ;(apiMod.api.getExecLogs as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => { resolveFetch = r }),
    )
    const p = store.useStore.getState().loadExecLogs('e1')
    // the bucket opens synchronously, before the snapshot resolves…
    expect(store.useStore.getState().execLogs.e1['x.0']).toEqual([])
    // …so a line streamed while the fetch is in flight buffers there
    store.useStore.getState().applyEvent({
      ev: 'exec.log', execId: 'e1', stepIndex: null, attempt: null, line: line(10),
    })
    // snapshot only covers up to seq 8 — the WS line past it must survive
    resolveFetch({ lines: [line(7), line(8)] })
    await p
    expect(store.useStore.getState().execLogs.e1['x.0'].map((l) => l.seq)).toEqual([7, 8, 10])
  })

  it('agents.changed nudges a full refresh (§19: clients re-GET /state)', () => {
    const orig = store.useStore.getState().refresh
    const spy = vi.fn(async () => {})
    store.useStore.setState({ refresh: spy })
    try {
      store.useStore.getState().applyEvent({ ev: 'agents.changed' })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      store.useStore.setState({ refresh: orig })
    }
  })
})
