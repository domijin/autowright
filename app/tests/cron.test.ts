// Unit tests for src/cron.ts — mirrors backend schedule.py. The parity block
// replays the Python implementation's recorded outputs (tests/fixtures/).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cronValid, cronNext, cronLabels, timeAt, tzSuffix, fmtMoment, timeLabels,
  nextTriggerShort, triggerLabel, triggerShort, type TriggerLike,
} from '../src/cron'
import fixture from '../../tests/fixtures/cron_parity.json'

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z')

describe('cronValid', () => {
  it('rejects wrong field counts', () => {
    expect(cronValid('* * * *')).toBe(false)
    expect(cronValid('* * * * * *')).toBe(false)
    expect(cronValid('')).toBe(false)
    expect(cronValid('   ')).toBe(false)
  })
  it('accepts tab-separated 5 fields', () => {
    expect(cronValid('0\t12\t*\t*\t*')).toBe(true)
  })
  it('accepts lists, ranges, and steps', () => {
    expect(cronValid('0,30 8,20 * * *')).toBe(true)
    expect(cronValid('0 9-17 * * 1-5')).toBe(true)
    expect(cronValid('*/15 * * * *')).toBe(true)
    expect(cronValid('*/1 * * * *')).toBe(true)
    expect(cronValid('0-59 * * * *')).toBe(true)
  })
  it('rejects malformed steps and ranges', () => {
    expect(cronValid('5/ * * * *')).toBe(false)
    expect(cronValid('*/0 * * * *')).toBe(false)
    expect(cronValid('1-2-3 * * * *')).toBe(false)
  })
  it('rejects out-of-range values per field', () => {
    expect(cronValid('60 * * * *')).toBe(false)
    expect(cronValid('* 24 * * *')).toBe(false)
    expect(cronValid('* * 0 * *')).toBe(false)
    expect(cronValid('* * 32 * *')).toBe(false)
    expect(cronValid('* * * 0 *')).toBe(false)
    expect(cronValid('* * * 13 *')).toBe(false)
    expect(cronValid('* * * * 7')).toBe(false)
  })
})

describe('cronNext', () => {
  it('is strictly after: a match at `after` itself is skipped', () => {
    const d = cronNext('0 12 * * *', new Date('2026-07-20T12:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-21T12:00:00Z')
  })
  it('a match one minute later is taken', () => {
    const d = cronNext('0 12 * * *', new Date('2026-07-20T11:59:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-20T12:00:00Z')
  })
  it('Vixie rule: dom and dow both restricted → either matches', () => {
    // Friday Jul 24 (dow 5) fires before the 13th (dom).
    const d = cronNext('0 12 13 * 5', new Date('2026-07-20T00:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2026-07-24T12:00:00Z')
  })
  it('unsatisfiable Feb 30 → null', () => {
    expect(cronNext('0 0 30 2 *', new Date('2026-07-20T00:00:00Z'), 'UTC')).toBeNull()
  })
  it('leap day found in the next leap year', () => {
    const d = cronNext('0 0 29 2 *', new Date('2026-07-20T00:00:00Z'), 'UTC')
    expect(d && iso(d)).toBe('2028-02-29T00:00:00Z')
  })
  it('invalid expression → null', () => {
    expect(cronNext('bogus', new Date(), 'UTC')).toBeNull()
    expect(cronNext('* * * *', new Date(), 'UTC')).toBeNull()
  })
})

describe('cronNext without timezone (local-zone path)', () => {
  // Mid-July and mid-January at mid-day sit far from any plausible host zone's
  // DST transition (those cluster around Mar/Apr and Sep–Nov, near midnight),
  // so these local-wall-clock assertions hold in any host zone.
  it('reads the expression on the local wall clock', () => {
    const jul = cronNext('30 12 * * *', new Date(2026, 6, 15, 12, 0, 0))
    expect(jul).toEqual(new Date(2026, 6, 15, 12, 30))
    const jan = cronNext('0 9 * * *', new Date(2026, 0, 15, 12, 0, 0))
    expect(jan).toEqual(new Date(2026, 0, 16, 9, 0))
  })
  it('is strictly after: a local match at `after` itself rolls to the next day', () => {
    const d = cronNext('30 12 * * *', new Date(2026, 6, 15, 12, 30, 0))
    expect(d).toEqual(new Date(2026, 6, 16, 12, 30))
  })
  it('a match one minute later is taken', () => {
    const d = cronNext('30 12 * * *', new Date(2026, 0, 15, 12, 29, 0))
    expect(d).toEqual(new Date(2026, 0, 15, 12, 30))
  })
})

describe('parity with the Python backend (tests/fixtures/cron_parity.json)', () => {
  describe('next', () => {
    for (const c of fixture.next) {
      it(`${c.expression} · ${c.timezone} · after ${c.after_utc}`, () => {
        const d = cronNext(c.expression, new Date(c.after_utc), c.timezone)
        if (c.next_utc === null) expect(d).toBeNull()
        else expect(d && iso(d)).toBe(c.next_utc)
      })
    }
  })
  describe('labels', () => {
    for (const c of fixture.labels) {
      it(`${JSON.stringify(c.expression)} · ${c.timezone ?? 'local'}`, () => {
        const got = cronLabels(c.expression, c.timezone ?? undefined)
        expect(got.label).toBe(c.label)
        expect(got.short).toBe(c.short)
      })
    }
  })
})

describe('timeAt', () => {
  it('no timezone reads the wall clock as local time', () => {
    const d = timeAt('2026-07-20T09:30')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(20)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
  })
  it('timezone reads the wall clock in that zone', () => {
    const d = timeAt('2026-07-20T09:30', 'Asia/Tokyo')
    expect(iso(d)).toBe('2026-07-20T00:30:00Z')
  })
  it('"T" and space separators are equivalent', () => {
    const a = timeAt('2026-07-20T09:30', 'UTC')
    const b = timeAt('2026-07-20 09:30', 'UTC')
    expect(iso(a)).toBe('2026-07-20T09:30:00Z')
    expect(iso(b)).toBe('2026-07-20T09:30:00Z')
  })
  it('invalid string → NaN Date, with and without timezone', () => {
    expect(Number.isNaN(timeAt('not a date').getTime())).toBe(true)
    expect(Number.isNaN(timeAt('not a date', 'UTC').getTime())).toBe(true)
  })
})

describe('tzSuffix', () => {
  it('undefined → empty', () => {
    expect(tzSuffix(undefined)).toBe('')
  })
  it('last IANA segment, underscores → spaces', () => {
    expect(tzSuffix('Asia/Tokyo')).toBe(' (Tokyo)')
    expect(tzSuffix('America/Argentina/Buenos_Aires')).toBe(' (Buenos Aires)')
  })
})

describe('fmtMoment / timeLabels', () => {
  it('midnight is 12 AM, noon is 12 PM', () => {
    expect(fmtMoment(new Date(2026, 6, 20, 0, 5))).toBe('Jul 20, 12:05 AM')
    expect(fmtMoment(new Date(2026, 6, 20, 12, 0))).toBe('Jul 20, 12:00 PM')
  })
  it('minutes are zero-padded', () => {
    expect(fmtMoment(new Date(2026, 6, 20, 15, 7))).toBe('Jul 20, 3:07 PM')
  })
  it('timeLabels renders the wall clock as written, with timezone suffix', () => {
    const { label, short } = timeLabels('2026-07-20T15:00', 'Asia/Tokyo')
    expect(label).toBe('Once at Jul 20, 3:00 PM (Tokyo)')
    expect(short).toBe('Once Jul 20 15:00 (Tokyo)')
  })
  it('seconds show only when non-zero (§4.3)', () => {
    expect(fmtMoment(new Date(2026, 6, 20, 15, 0, 15))).toBe('Jul 20, 3:00:15 PM')
    const withSecs = timeLabels('2026-07-20T15:00:15')
    expect(withSecs.label).toBe('Once at Jul 20, 3:00:15 PM')
    expect(withSecs.short).toBe('Once Jul 20 15:00:15')
    expect(timeLabels('2026-07-20T15:00:00').label).toBe('Once at Jul 20, 3:00 PM')
  })
})

describe('triggerLabel / triggerShort — message and app-start branches (§4.3)', () => {
  it('short labels are the bare kind names', () => {
    expect(triggerShort({ kind: 'app_start' })).toBe('App start')
    expect(triggerShort({ kind: 'discord', channel: '123456789' })).toBe('Discord')
    expect(triggerShort({ kind: 'imessage', from: '+15550123' })).toBe('iMessage')
  })
  it('app_start long label', () => {
    expect(triggerLabel({ kind: 'app_start' })).toBe('On app start')
  })
  it('message labels show their detail field, plus a curly-quoted pattern', () => {
    expect(triggerLabel({ kind: 'discord', channel: '123456789' })).toBe('Discord · 123456789')
    expect(triggerLabel({ kind: 'discord', channel: '123456789', pattern: 'deploy' }))
      .toBe('Discord · 123456789 · “deploy”')
    expect(triggerLabel({ kind: 'imessage', from: '+15550123' })).toBe('iMessage · +15550123')
    expect(triggerLabel({ kind: 'imessage', from: '+15550123', pattern: 'report' }))
      .toBe('iMessage · +15550123 · “report”')
  })
  it('a broken trigger missing its channel/sender reads "missing"', () => {
    expect(triggerLabel({ kind: 'discord' })).toBe('Discord · missing')
    expect(triggerLabel({ kind: 'imessage' })).toBe('iMessage · missing')
    expect(triggerLabel({ kind: 'discord', pattern: 'x' })).toBe('Discord · missing · “x”')
  })
  it('an empty pattern is falsy — no quoted segment', () => {
    expect(triggerLabel({ kind: 'discord', channel: 'c', pattern: '' })).toBe('Discord · c')
  })
})

describe('nextTriggerShort', () => {
  afterEach(() => vi.useRealTimers())
  const pin = (isoNow: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(isoNow))
  }

  it('disabled triggers, app_start, past, and invalid times are all skipped', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expression: '0 12 * * *', timezone: 'UTC', enabled: false },
      { kind: 'app_start' },
      { kind: 'time', at: '2020-01-01T00:00', timezone: 'UTC' },
      { kind: 'time', at: 'garbage' },
    ]
    expect(nextTriggerShort(triggers)).toBeNull()
    expect(nextTriggerShort([])).toBeNull()
  })

  it('earliest enabled occurrence wins (one-shot before cron)', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expression: '0 12 * * *', timezone: 'UTC' },          // 12:00Z today
      { kind: 'time', at: '2026-07-20T06:00', timezone: 'UTC' },      // 06:00Z today
      { kind: 'app_start' },
    ]
    expect(nextTriggerShort(triggers)).toBe('Once Jul 20 6:00 (UTC)')
  })

  it('cron wins when the one-shot is later', () => {
    pin('2026-07-20T00:00:00Z')
    const triggers: TriggerLike[] = [
      { kind: 'cron', expression: '0 12 * * *', timezone: 'UTC' },          // 12:00Z today
      { kind: 'time', at: '2026-07-21T06:00', timezone: 'UTC' },      // tomorrow
    ]
    expect(nextTriggerShort(triggers)).toBe('Daily 12:00 (UTC)')
  })
})
