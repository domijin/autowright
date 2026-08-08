// §4.3 trigger math for the renderer — mirrors backend schedule.py for the
// Add-trigger live preview, draft-trigger chips, and "next trigger" labels.
// The API remains the authority: every stored trigger is validated server-side.

export interface TriggerLike {
  kind: 'cron' | 'time' | 'app_start' | 'discord' | 'imessage'
  expression?: string
  at?: string
  timezone?: string
  enabled?: boolean
  channel?: string  // discord: numeric channel id
  from?: string     // imessage: sender handle
  pattern?: string  // discord/imessage: message filter
}

// ---------- §4.3 `timezone`: wall clock in the trigger's zone ----------

/** §4.3 label suffix — the zone's city: last IANA segment, _ → space. */
export function tzSuffix(timezone?: string): string {
  return timezone ? ` (${timezone.split('/').pop()!.replace(/_/g, ' ')})` : ''
}

// Wall clocks are carried as "wall ms": the wall-clock fields UTC-encoded via
// Date.UTC. UTC has no DST, so adding days or setting hours on wall ms never
// shifts the components — mirroring the backend's naive-datetime math
// (schedule.py). Building candidates as real local Dates instead (setHours on
// a local Date) silently normalizes DST-nonexistent times and corrupts the
// wall clock, even for other zones' triggers on a *local* transition day.

/** Wall clock of instant `d` in `timezone`, as wall ms. */
function wallMsInZone(d: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
}

/** Wall clock of instant `d` in the local zone, as wall ms. */
function wallMsLocal(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
}

/** Wall ms → the real instant (two-pass offset fixpoint for `timezone`), matching the
 * backend's fold=0 `_to_local`: ambiguous fall-back wall times resolve to the
 * earlier instant; wall times erased by spring-forward resolve with the
 * pre-transition offset, landing just past the gap (§4.3 "next valid minute"). */
function wallMsToDate(wallMs: number, timezone?: string): Date {
  const w = new Date(wallMs)
  if (!timezone) return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes())
  const g1 = 2 * wallMs - wallMsInZone(new Date(wallMs), timezone)
  const g2 = g1 + wallMs - wallMsInZone(new Date(g1), timezone)
  if (wallMsInZone(new Date(g2), timezone) !== wallMs) {
    // Nonexistent wall time: in a gap the pre-transition offset is the smaller
    // one, so it yields the later UTC candidate.
    return new Date(Math.max(g1, g2))
  }
  return new Date(wallMsInZone(new Date(g2 - 3600000), timezone) === wallMs ? g2 - 3600000 : g2)
}

/** Wall ms → the earliest reading strictly after `afterMs`, or null when every
 * reading is at or before it. Mirrors the backend's `_wall_to_local`: the
 * wall→instant map is non-monotonic around DST transitions (an ambiguous
 * fall-back wall time reads as the earlier instant, which can land before the
 * baseline), so a baseline inside the repeated hour must advance to the later
 * reading instead of going backwards. */
function wallMsToDateAfter(wallMs: number, timezone: string | undefined, afterMs: number): Date | null {
  const d = wallMsToDate(wallMs, timezone)
  if (d.getTime() > afterMs) return d
  if (timezone) {
    const later = new Date(d.getTime() + 3600000)
    if (wallMsInZone(later, timezone) === wallMs && later.getTime() > afterMs) return later
  }
  return null
}

/** A one-shot's real moment: `at`'s wall clock read in `timezone` (local when absent). */
export function timeAt(at: string, timezone?: string): Date {
  const wall = new Date(at)
  if (!timezone || Number.isNaN(wall.getTime())) return wall
  // Read the wall fields from the string itself — parsing through a local
  // Date would normalize an `at` that is DST-nonexistent locally.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(at)
  return wallMsToDate(m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) : wallMsLocal(wall), timezone)
}

const DOW_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
const SEARCH_DAYS = 366 * 5

interface Field { vals: Set<number>; star: boolean }

function parseField(text: string, lo: number, hi: number): Field | null {
  if (!text) return null
  const vals = new Set<number>()
  for (const item of text.split(',')) {
    const [body, stepS, extra] = item.split('/')
    if (extra !== undefined) return null
    let step = 1
    if (stepS !== undefined) {
      if (!/^\d+$/.test(stepS) || Number(stepS) < 1) return null
      step = Number(stepS)
    }
    let a: number
    let b: number
    if (body === '*') {
      a = lo; b = hi
    } else if (/^\d+-\d+$/.test(body)) {
      const [aS, bS] = body.split('-')
      a = Number(aS); b = Number(bS)
    } else if (/^\d+$/.test(body)) {
      a = Number(body); b = a
    } else {
      return null
    }
    if (a < lo || b > hi || a > b) return null
    for (let v = a; v <= b; v += step) vals.add(v)
  }
  return { vals, star: text === '*' }
}

function parseCron(expression: string): Field[] | null {
  const parts = (expression ?? '').trim().split(/\s+/)
  if (parts.length !== 5 || parts[0] === '') return null
  const out: Field[] = []
  for (let i = 0; i < 5; i++) {
    const f = parseField(parts[i], RANGES[i][0], RANGES[i][1])
    if (!f) return null
    out.push(f)
  }
  return out
}

export function cronValid(expression: string): boolean {
  return parseCron(expression) !== null
}

/** Next match strictly after `after` (default now), as a real local-time Date;
 * with `timezone` the expression reads as the zone's wall clock. Null if invalid/unsatisfiable. */
export function cronNext(expression: string, after?: Date, timezone?: string): Date | null {
  const f = parseCron(expression)
  if (!f) return null
  const [mins, hours, doms, months, dows] = f
  const now = after ?? new Date()
  let t = timezone ? wallMsInZone(now, timezone) : wallMsLocal(now)
  t -= t % 60000
  t += 60000 // strictly after
  const hhmm: [number, number][] = []
  for (const hh of [...hours.vals].sort((x, y) => x - y)) {
    for (const mm of [...mins.vals].sort((x, y) => x - y)) hhmm.push([hh, mm])
  }
  const tDay = new Date(t)
  let day = Date.UTC(tDay.getUTCFullYear(), tDay.getUTCMonth(), tDay.getUTCDate())
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const d = new Date(day)
    if (months.vals.has(d.getUTCMonth() + 1)) {
      const specDow = d.getUTCDay() // Sun=0 — already the spec convention
      // Vixie rule: both dom and dow restricted → a date matching either fires.
      const dayOk = dows.star ? doms.vals.has(d.getUTCDate())
        : doms.star ? dows.vals.has(specDow)
        : doms.vals.has(d.getUTCDate()) || dows.vals.has(specDow)
      if (dayOk) {
        // A candidate on a later day is always > t, so one compare covers
        // both the same-day floor and later days (as in the backend).
        for (const [hh, mm] of hhmm) {
          const cand = day + (hh * 60 + mm) * 60000
          if (cand >= t) {
            const inst = wallMsToDateAfter(cand, timezone, now.getTime())
            if (inst) return inst
          }
        }
      }
    }
    day += 86400000
  }
  return null
}

const hm = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`

/** §4.3 humanized labels — exactly two simple shapes get words. */
export function cronLabels(expression: string, timezone?: string): { label: string; short: string } {
  const sfx = tzSuffix(timezone)
  const p = expression.trim().split(/\s+/)
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') {
    const t = hm(Number(p[1]), Number(p[0]))
    if (p[4] === '*') return { label: `Daily at ${t}${sfx}`, short: `Daily ${t}${sfx}` }
    if (/^\d$/.test(p[4]) && Number(p[4]) <= 6) {
      const d = Number(p[4])
      return { label: `${DOW_LONG[d]} at ${t}${sfx}`, short: `${DOW_SHORT[d]} ${t}${sfx}` }
    }
  }
  return { label: expression.trim() + sfx, short: expression.trim() + sfx }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// §4.3: seconds show only when non-zero — cron occurrences stay ":00"-free.
const secs = (s: number) => (s ? `:${String(s).padStart(2, '0')}` : '')

/** "Jul 20, 3:00 PM" — the Add-trigger "next:" preview and one-shot labels. */
export function fmtMoment(d: Date): string {
  const ampm = `${(d.getHours() % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')}${secs(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${ampm}`
}

export function timeLabels(at: string, timezone?: string): { label: string; short: string } {
  const sfx = tzSuffix(timezone)
  // Wall fields straight from the string (like timeAt): `new Date(at)` would
  // normalize an `at` that is DST-nonexistent in the LOCAL zone, shifting the
  // label an hour off the backend's (§4.3: the two label implementations
  // must agree — the backend reads the wall fields verbatim).
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(at)
  if (m) {
    const [mo, da, hh, mi, ss] = [+m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0]
    const ampm = `${(hh % 12) || 12}:${String(mi).padStart(2, '0')}${secs(ss)} ${hh < 12 ? 'AM' : 'PM'}`
    return {
      label: `Once at ${MONTHS[mo - 1]} ${da}, ${ampm}${sfx}`,
      short: `Once ${MONTHS[mo - 1]} ${da} ${hm(hh, mi)}${secs(ss)}${sfx}`,
    }
  }
  const d = new Date(at)
  return {
    label: `Once at ${fmtMoment(d)}${sfx}`,
    short: `Once ${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d.getHours(), d.getMinutes())}${secs(d.getSeconds())}${sfx}`,
  }
}

export function triggerShort(t: TriggerLike): string {
  if (t.kind === 'app_start') return 'App start'
  if (t.kind === 'discord') return 'Discord'
  if (t.kind === 'imessage') return 'iMessage'
  return t.kind === 'cron' ? cronLabels(t.expression ?? '', t.timezone).short : timeLabels(t.at ?? '', t.timezone).short
}

/** §4.3 long label — mirrors the backend's trigger_display label: message
 * triggers show their detail fields ("missing" flags a broken one). */
export function triggerLabel(t: TriggerLike): string {
  if (t.kind === 'app_start') return 'On app start'
  if (t.kind === 'discord' || t.kind === 'imessage') {
    const name = t.kind === 'discord' ? 'Discord' : 'iMessage'
    const detail = (t.kind === 'discord' ? t.channel : t.from) || 'missing'
    return `${name} · ${detail}${t.pattern ? ` · “${t.pattern}”` : ''}`
  }
  return t.kind === 'cron' ? cronLabels(t.expression ?? '', t.timezone).label : timeLabels(t.at ?? '', t.timezone).label
}

/** Short label of the soonest enabled trigger (§4.3 nextAt's trigger), null when none. */
export function nextTriggerShort(triggers: TriggerLike[]): string | null {
  let best: { at: Date; t: TriggerLike } | null = null
  for (const t of triggers) {
    if (t.enabled === false || t.kind === 'app_start' || t.kind === 'discord' || t.kind === 'imessage') continue // §4.3: no computable next occurrence
    const at = t.kind === 'cron' ? cronNext(t.expression ?? '', undefined, t.timezone) : timeAt(t.at ?? '', t.timezone)
    if (!at || Number.isNaN(at.getTime()) || at <= new Date()) continue
    if (!best || at < best.at) best = { at, t }
  }
  return best ? triggerShort(best.t) : null
}
