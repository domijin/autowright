// Unit tests for src/triggers.ts. nextTriggerShort is pure math over the §19
// preview results (no trigger math lives in the renderer — §4.3). The
// useTriggerPreview debounce/sequence guard is timing-hard to stage in e2e, so
// it is exercised here through renderHook with the api mocked.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { TriggerPreview } from '../src/types'

vi.mock('../src/api', () => ({
  connectInfo: vi.fn(async () => false),
  openWs: vi.fn(() => () => {}),
  api: { triggersPreview: vi.fn(() => Promise.reject(new Error('offline'))) },
}))

import { api } from '../src/api'
import { nextTriggerShort, useTriggerPreview } from '../src/triggers'

const pv = (over: Partial<TriggerPreview> = {}): TriggerPreview =>
  ({ valid: true, label: 'L', short: 'S', nextAt: 1000, ...over })

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('nextTriggerShort', () => {
  it('picks the soonest nextAt among enabled valid entries; enabled defaults to true', () => {
    const triggers = [{}, { enabled: true }, { enabled: false }]
    const previews = [
      pv({ nextAt: 500, short: 'A' }),
      pv({ nextAt: 100, short: 'B' }),
      pv({ nextAt: 1, short: 'C' }),   // disabled — never wins
    ]
    expect(nextTriggerShort(triggers, previews)).toBe('B')
  })
  it('skips invalid entries, null nextAt, and entries with no preview yet', () => {
    expect(nextTriggerShort(
      [{}, {}, {}],
      [pv({ valid: false, nextAt: 1, short: 'bad' }), pv({ nextAt: null, short: 'none' }), pv({ nextAt: 9, short: 'ok' })],
    )).toBe('ok')
    // previews shorter than triggers: the uncovered entry is skipped, not crashed on
    expect(nextTriggerShort([{}, {}], [pv({ short: 'only' })])).toBe('only')
  })
  it('null when nothing has an upcoming occurrence', () => {
    expect(nextTriggerShort([], [])).toBeNull()
    expect(nextTriggerShort([{ enabled: false }], [pv()])).toBeNull()
    expect(nextTriggerShort([{}], [pv({ nextAt: null })])).toBeNull()
  })
})

describe('useTriggerPreview (§19 debounced preview)', () => {
  const cron = { kind: 'cron', expression: '0 8 * * *' }

  it('debounces 300 ms then fetches; an empty list clears immediately with no call', async () => {
    vi.useFakeTimers()
    const tp = vi.mocked(api.triggersPreview)
    tp.mockClear()
    tp.mockResolvedValue({ triggers: [pv({ short: 'daily 8:00' })] } as never)
    const { result, rerender } = renderHook(
      ({ t }: { t: object[] }) => useTriggerPreview(t), { initialProps: { t: [cron] as object[] } },
    )
    expect(result.current).toEqual([])          // empty until the first response
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(tp).not.toHaveBeenCalled()           // still inside the debounce window
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(tp).toHaveBeenCalledWith([cron])
    expect(result.current).toEqual([pv({ short: 'daily 8:00' })])
    rerender({ t: [] })
    expect(result.current).toEqual([])          // cleared synchronously
    expect(tp).toHaveBeenCalledTimes(1)         // no request for the empty list
  })

  it('a stale in-flight response never lands after the triggers change', async () => {
    vi.useFakeTimers()
    const tp = vi.mocked(api.triggersPreview)
    tp.mockClear()
    let resolveOld!: (v: unknown) => void
    tp.mockReturnValueOnce(new Promise((r) => { resolveOld = r }) as never)
    tp.mockResolvedValueOnce({ triggers: [pv({ short: 'new' })] } as never)
    const { result, rerender } = renderHook(
      ({ t }: { t: object[] }) => useTriggerPreview(t), { initialProps: { t: [cron] as object[] } },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })  // old request in flight
    rerender({ t: [{ kind: 'cron', expression: '30 9 * * 1' }] })     // bumps the sequence
    expect(result.current).toEqual([])          // previous results keep showing (none yet)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(result.current).toEqual([pv({ short: 'new' })])
    await act(async () => { resolveOld({ triggers: [pv({ short: 'old' })] }) })
    expect(result.current).toEqual([pv({ short: 'new' })])  // stale response discarded
  })
})
