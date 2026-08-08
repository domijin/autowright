// Automation detail (§4.3/§4.4/§7, prototype "Automation detail" screen).
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { SecretModal } from '../SecretModal'
import { useStore } from '../store'
import type { Automation, ParamDef, SecretMeta, SnapshotSettings, Step, Trigger, DraftTrigger, TriggerKindFields } from '../types'
import {
  BackLink, Badge, BtnGhost, BtnPrimary, Caret, Collapse, ConfirmModal, EmptyNotice, executingToast,
  Eyebrow, FailureNotice, HeaderActions, MenuRow, MiniBadge, Modal, PULSE, PopMenu, PyCode, ScrollArea, Tag, Toggle,
  nextIn, stepTimeoutLabel, stepTimeoutTitle, usePopover, validUrl,
} from '../ui'
import { cronLabels, cronNext, cronValid, fmtMoment, nextTriggerShort, timeAt, triggerShort, tzSuffix } from '../cron'
import { ResultSection, SpecMarkdown } from '../result'

const badgeAnim = (s: string) => (s === 'executing' ? PULSE : 'none')

// §6.3 automatic-snapshot toggles — label + plain-language explanation per reason
const SNAP_SETTINGS: Array<{ key: keyof SnapshotSettings; label: string; help: string }> = [
  {
    key: 'preVersion', label: 'Before a new version executes',
    help: 'Saves a copy of memory right before the first execution of a newly saved version, so you can restore how memory was if the new version mishandles it.',
  },
  {
    key: 'preClear', label: 'Before clearing memory',
    help: 'Saves a copy right before Clear memory empties the directory, so a clear can be undone.',
  },
  {
    key: 'preRestore', label: 'Before restoring a snapshot',
    help: 'Saves a copy of the current memory right before a restore replaces it, so a restore can be undone.',
  },
]

// ---------- §9.2 Add-trigger editor (kind picker → cron expression / one-shot time) ----------

const pickChipStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
  background: active ? 'var(--accent-chip-bg)' : 'rgba(255,255,255,.04)',
  border: `1px solid ${active ? 'oklch(0.74 0.155 52 / .4)' : 'var(--border-input)'}`,
  color: active ? 'var(--accent)' : 'var(--text-2)', borderRadius: 6, padding: '4px 10px', flex: 'none',
  transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter), border-color var(--t-hover) var(--ease-enter)',
})

const TZ_LIST: string[] = Intl.supportedValuesOf('timeZone')

type AddableKind = 'cron' | 'time' | 'app_start' | 'discord' | 'imessage'

// §9.2: one icon per kind — the picker chips and the trigger rows share it
const KIND_META: Array<{ kind: AddableKind; icon: string; label: string }> = [
  { kind: 'cron', icon: 'fa-solid fa-clock', label: 'Cron' },
  { kind: 'time', icon: 'fa-solid fa-calendar-day', label: 'One time' },
  { kind: 'app_start', icon: 'fa-solid fa-rocket', label: 'App start' },
  { kind: 'discord', icon: 'fa-brands fa-discord', label: 'Discord' },
  { kind: 'imessage', icon: 'fa-solid fa-comment', label: 'iMessage' },
]
const kindIcon = (k: AddableKind) => KIND_META.find((m) => m.kind === k)!.icon

// §9.2 iMessage permission checklist — FDA can only be detected and guided
// (macOS has no prompt API for it); Automation is promptable via the probe.
function ImsgPermissions() {
  const [perms, setPerms] = useState<{
    fullDisk: boolean; automation: 'granted' | 'denied' | 'unknown'
  } | null>(null)
  const [probing, setProbing] = useState(false)
  useEffect(() => {
    let live = true
    const poll = () => {
      api.imessagePermissions().then((p) => { if (live) setPerms(p) }).catch(() => {})
    }
    poll()
    const iv = setInterval(poll, 3000) // §9.2: flips to granted moments after the user toggles it
    return () => { live = false; clearInterval(iv) }
  }, [])
  const probe = () => {
    setProbing(true)
    api.imessageAutomationProbe()
      .then((r) => setPerms((p) => (p ? { ...p, automation: r.automation } : p)))
      .catch(() => {})
      .finally(() => setProbing(false))
  }
  const row = (icon: React.ReactNode, name: string, note: string, action?: React.ReactNode) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
      <span style={{ width: 14, flex: 'none', textAlign: 'center' }}>{icon}</span>
      <span style={{ font: '500 11.5px var(--sans)', color: 'var(--text-2)', flex: 'none' }}>{name}</span>
      <span style={{
        flex: 1, minWidth: 0, font: '400 11.5px/1.4 var(--sans)', color: 'var(--text-muted)',
      }}>
        {note}
      </span>
      {action}
    </div>
  )
  const check = <i className="fa-solid fa-check" style={{ color: 'var(--green)', fontSize: 11 }} />
  const dot = (c: string) => <i className="fa-solid fa-circle" style={{ color: c, fontSize: 7 }} />
  const btn = (label: string, onClick: () => void, spin = false) => (
    <button className="ad-btn-accent-ghost small" onClick={onClick} disabled={spin} style={{ flex: 'none' }}>
      {spin && <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 9, marginRight: 5 }} />}
      {label}
    </button>
  )
  return (
    <div style={{
      border: '1px solid var(--hairline-dim)', borderRadius: 8, padding: '8px 10px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {row(
        perms == null ? dot('var(--text-faint)') : perms.fullDisk ? check : dot('var(--amber)'),
        'Full Disk Access',
        perms == null ? 'Checking…'
          : perms.fullDisk ? 'Granted'
          : 'Needed — Autowright reads incoming messages from the Messages database',
        perms != null && !perms.fullDisk
          ? btn('Open System Settings', () =>
              window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'))
          : undefined,
      )}
      {row(
        perms == null ? dot('var(--text-faint)')
          : perms.automation === 'granted' ? check
          : dot(perms.automation === 'denied' ? 'var(--amber)' : 'var(--text-faint)'),
        'Messages automation',
        perms == null ? 'Checking…'
          : perms.automation === 'granted' ? 'Granted'
          : perms.automation === 'denied'
          ? 'Denied — turn it on in System Settings → Privacy & Security → Automation'
          : 'Not asked yet — Autowright sends replies through Messages',
        perms != null && perms.automation === 'unknown'
          ? btn('Grant', probe, probing)
          : undefined,
      )}
    </div>
  )
}

/** §9.2 setup-guide disclosure — the one pattern both message-trigger kinds use. */
function GuideToggle({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button className="ad-btn-text dim small" onClick={onToggle} style={{ alignSelf: 'flex-start' }}>
        <Caret open={open} style={{ marginRight: 5 }} />
        {label}
      </button>
      <Collapse open={open}>
        <ol style={{
          margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.6, cursor: 'text',
          color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {children}
        </ol>
      </Collapse>
    </div>
  )
}

/** §9.2 segmented 24-hour time entry — one `ad-input` box, three two-digit
 *  fields (HH:MM:SS). Automation-advance on a completed pair, ↑/↓ stepping with
 *  wrap, Backspace-when-empty jumps back, paste distributes digit pairs. */
const TIME_MAXES = [23, 59, 59]

function TimeParts({ parts, invalid, onChange }: {
  parts: [string, string, string]
  invalid: boolean
  onChange: (p: [string, string, string]) => void
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const set = (i: number, v: string) => {
    const next = [...parts] as [string, string, string]
    next[i] = v
    onChange(next)
  }
  const type = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (digits.length <= 2) {
      set(i, digits)
      if (digits.length === 2 && i < 2) refs.current[i + 1]?.select()
      return
    }
    // paste: digit pairs spill into the following segments
    const next = [...parts] as [string, string, string]
    let rest = digits.slice(0, 6)
    let j = i
    while (rest && j < 3) { next[j] = rest.slice(0, 2); rest = rest.slice(2); j++ }
    onChange(next)
    refs.current[Math.min(j, 2)]?.select()
  }
  const key = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (parts[i] === '') return set(i, '00')
      const span = TIME_MAXES[i] + 1
      const cur = Math.min(Number(parts[i]), TIME_MAXES[i])
      set(i, String((cur + (e.key === 'ArrowUp' ? 1 : span - 1)) % span).padStart(2, '0'))
    } else if (e.key === 'Backspace' && parts[i] === '' && i > 0) {
      refs.current[i - 1]?.select()
    }
  }
  return (
    <div
      className={`ad-input${invalid ? ' invalid' : ''}`}
      style={{
        display: 'flex', alignItems: 'baseline', padding: '7px 9px',
        fontFamily: 'var(--mono)', fontSize: 12, cursor: 'text',
      }}
    >
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: 'var(--text-faint)' }}>:</span>}
          <input
            ref={(el) => { refs.current[i] = el }}
            value={p}
            onChange={(e) => type(i, e.target.value)}
            onKeyDown={(e) => key(i, e)}
            onFocus={(e) => e.target.select()}
            // pad from the DOM value: auto-advance blurs this segment in the
            // same tick as its onChange, so the closure's `p` is one render old
            onBlur={(e) => { if (e.target.value.length === 1) set(i, `0${e.target.value}`) }}
            placeholder={['HH', 'MM', 'SS'][i]}
            inputMode="numeric"
            spellCheck={false}
            aria-label={['hours', 'minutes', 'seconds'][i]}
            style={{
              width: 20, textAlign: 'center', background: 'none', border: 'none',
              outline: 'none', font: 'inherit', color: 'inherit', padding: 0,
            }}
          />
        </React.Fragment>
      ))}
    </div>
  )
}

/** Timezone picker — the app's standard popover pattern, filterable (§9.2). */
function TzPick({ timezone, onPick }: { timezone: string; onPick: (z: string) => void }) {
  const [open, setOpen, ref] = usePopover()
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const zones = needle ? TZ_LIST.filter((z) => z.toLowerCase().includes(needle)) : TZ_LIST
  return (
    <div ref={ref} style={{ position: 'relative', marginTop: 8 }}>
      <button
        className="ad-btn-pill"
        onClick={() => { setQ(''); setOpen(!open) }}
        title="Timezone the trigger's times read in"
      >
        <i className="fa-solid fa-globe" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
        <span style={timezone ? {} : { fontWeight: 400, color: 'var(--text-muted)' }}>{timezone || 'Local time'}</span>
        <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
      </button>
      <PopMenu show={open} style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 280 }}>
        {open && (
          <input
            className="ad-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter timezones…"
            spellCheck={false}
            autoFocus
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 9px', marginBottom: 4 }}
          />
        )}
        <ScrollArea style={{ maxHeight: 240 }}>
          {!needle && (
            <MenuRow active={!timezone} onClick={() => { setOpen(false); onPick('') }}>Local time</MenuRow>
          )}
          {zones.map((z) => (
            <MenuRow key={z} active={z === timezone} onClick={() => { setOpen(false); onPick(z) }}>{z}</MenuRow>
          ))}
          {needle && zones.length === 0 && (
            <div style={{ padding: '9px 11px', font: '400 11px/1.5 var(--sans)', color: 'var(--text-muted)' }}>
              No timezone matches.
            </div>
          )}
        </ScrollArea>
      </PopMenu>
    </div>
  )
}

/** Bot-token secret picker — the app's standard popover pattern (§9.2). */
function SecretPick({ secrets, selected, onPick }: {
  secrets: SecretMeta[]; selected: string; onPick: (name: string) => void
}) {
  const [open, setOpen, ref] = usePopover()
  return (
    <div ref={ref} style={{ position: 'relative', flex: '0 1 auto', minWidth: 0 }}>
      <button
        className="ad-btn-pill"
        onClick={() => setOpen(!open)}
        title="The secret holding your Discord bot token"
        style={{ maxWidth: '100%' }}
      >
        <i className="fa-solid fa-key" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          ...(selected ? {} : { fontWeight: 400, color: 'var(--text-muted)' }),
        }}>
          {selected || 'Choose the bot-token secret…'}
        </span>
        <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
      </button>
      <PopMenu show={open} style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 240 }}>
        {secrets.length === 0 ? (
          <div style={{ padding: '9px 14px', font: '400 11px/1.5 var(--sans)', color: 'var(--text-muted)' }}>
            No secrets yet — press New secret.
          </div>
        ) : secrets.map((s) => {
          const sel = s.name === selected
          return (
            <button
              className="ad-btn-bare"
              key={s.name}
              onClick={() => { setOpen(false); onPick(s.name) }}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer',
                borderBottom: '1px solid var(--hairline-dim)',
                background: sel ? 'var(--accent-hint-bg)' : 'transparent',
              }}
            >
              <span style={{ width: 14, flex: 'none', textAlign: 'center', font: '600 12px var(--mono)', color: 'var(--accent)' }}>
                {sel ? <i className="fa-solid fa-check" style={{ fontSize: 10 }} /> : ''}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ font: `500 12px var(--mono)`, color: sel ? 'var(--text)' : 'var(--text-2)' }}>{s.name}</span>
                  {!s.set && <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>}
                </div>
                {s.description && (
                  <div style={{
                    font: '400 11.5px/1.45 var(--sans)', color: 'var(--text-muted)', marginTop: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {s.description}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </PopMenu>
    </div>
  )
}

// What the editor produces — the §4.3 kind-discriminated field sets; the
// caller adds id/off. A flat field bag exists only inside the editor's state.
type TriggerDraft = TriggerKindFields
type TriggerFieldBag = {
  kind?: AddableKind; expression?: string; at?: string; timezone?: string
  channel?: string; secret?: string; pattern?: string; mention?: boolean; author?: string[]
  from?: string
}

function TriggerEditor({ hasAppStart, initial, onSave, onCancel }: {
  hasAppStart: boolean
  initial?: Trigger // §9.2 edit mode: pre-filled, submit reads Save
  onSave: (t: TriggerDraft) => void
  onCancel: () => void
}) {
  const secrets = useStore((s) => s.secrets)
  const init: TriggerFieldBag = initial ?? {}
  const [kind, setKind] = useState<AddableKind>(init.kind ?? 'cron')
  const [expression, setExpr] = useState(init.expression ?? '')
  // §9.2 One time: date and segmented 24-hour time entered apart, combined
  // into `at`; seconds pre-fill 00 so only hour + minute need typing
  const [date, setDate] = useState(init.at ? init.at.slice(0, 10) : '')
  const [tparts, setTparts] = useState<[string, string, string]>(
    init.at
      ? [init.at.slice(11, 13), init.at.slice(14, 16), init.at.slice(17, 19) || '00']
      : ['', '', '00'],
  )
  const [timezone, setTz] = useState(init.timezone ?? '') // '' → local time, no timezone stored (§4.3)
  const [channel, setChannel] = useState(init.channel ?? '')
  const [secret, setSecret] = useState(init.secret ?? '')
  const [pattern, setPattern] = useState(init.pattern ?? '')
  // §9.2: mention-only by default for new triggers — a busy channel shouldn't fire on every message
  const [mention, setMention] = useState(initial ? !!init.mention : true)
  const [author, setAuthor] = useState((init.author ?? []).join(', '))
  const [from, setFrom] = useState(init.from ?? '')
  const [guide, setGuide] = useState(false)
  const [secretModal, setSecretModal] = useState(false)
  const exprOk = cronValid(expression)
  const [hh, mm, ss] = tparts
  const timeEntered = hh !== '' || mm !== ''
  const timeOk = hh !== '' && mm !== '' && ss !== '' && +hh <= 23 && +mm <= 59 && +ss <= 59
  const at = date && timeOk
    ? `${date}T${tparts.map((p) => p.padStart(2, '0')).join(':')}`
    : ''
  const atDate = at ? timeAt(at, timezone || undefined) : null
  const atOk = !!atDate && !Number.isNaN(atDate.getTime()) && atDate > new Date()
  const channelOk = /^[0-9]+$/.test(channel)
  // §4.3: optional sender filter — comma-separated numeric user ids
  const authorIds = author.split(',').map((s) => s.trim()).filter(Boolean)
  const authorOk = author.trim() === ''
    || (authorIds.length > 0 && authorIds.every((a) => /^[0-9]+$/.test(a)))
  // §4.3: email, or E.164 phone after stripping obvious formatting — a
  // number without the country code could never match a stored handle.
  const fromNorm = from.includes('@') ? from.trim() : from.trim().replace(/[\s().-]/g, '')
  const fromOk = from.includes('@')
    ? !!from.trim() && !/\s/.test(from.trim())
    : /^\+[0-9]{3,15}$/.test(fromNorm)
  const canAdd = kind === 'cron' ? exprOk : kind === 'time' ? atOk
    : kind === 'discord' ? channelOk && !!secret && authorOk
    : kind === 'imessage' ? fromOk : true
  const nxt = kind === 'cron' && exprOk ? cronNext(expression, undefined, timezone || undefined) : null
  const preview = kind === 'cron'
    ? (exprOk ? `${cronLabels(expression, timezone || undefined).label}${nxt ? ` · next: ${fmtMoment(nxt)}` : ''}` : (expression ? 'Not a valid cron expression' : ''))
    : kind === 'time'
    ? (atOk ? `Once at ${fmtMoment(new Date(at))}${tzSuffix(timezone || undefined)}`
      : timeEntered && !timeOk ? 'Hours go 0–23, minutes and seconds 0–59'
      : at ? 'Pick a time in the future' : '')
    : kind === 'discord'
    ? (channelOk ? `On Discord message in ${channel}` : (channel ? 'The channel id is numbers only' : ''))
    : kind === 'imessage'
    ? (fromOk ? `On iMessage from ${fromNorm}` : (from ? 'Needs a country code (+1…) or an email' : ''))
    : 'On app start — executes when you launch the app'
  return (
    <div style={{ border: '1px dashed var(--border-dashed)', borderRadius: 8, padding: '11px 12px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {KIND_META.map((m) => {
          const taken = m.kind === 'app_start' && hasAppStart
          return (
            <button
              key={m.kind}
              onClick={() => { if (!taken) setKind(m.kind) }}
              disabled={taken}
              title={taken ? 'Already added' : undefined}
              style={{ ...pickChipStyle(kind === m.kind), ...(taken ? { color: 'var(--text-deco)', cursor: 'default' } : {}) }}
            >
              <i className={m.icon} style={{ fontSize: 9, marginRight: 5 }} />
              {m.label}
            </button>
          )
        })}
      </div>
      {kind === 'imessage' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <GuideToggle label="How iMessage triggers work" open={guide} onToggle={() => setGuide(!guide)}>
            <li>This Mac’s Messages account is the identity — no bot, no token. When the sender below texts it, the automation executes.</li>
            <li>Messages this Mac sends never trigger (loop safety) — and iMessage can’t text yourself anyway, since your own messages come from the same Apple ID. The sender must be someone else. To trigger it yourself, either create a new Apple ID, sign Messages on this Mac into it, and text that account — or use a Discord trigger instead: a bot in your own server can receive your own messages.</li>
            <li>Grant the two permissions below.</li>
            <li>Enter the sender below exactly as Messages knows them — phone numbers in international form (<b>+1…</b>), or an email. To see the stored handle, open the conversation in Messages and press the ⓘ info button. Formatting like spaces and dashes is fine — it’s stripped automatically.</li>
          </GuideToggle>
          <ImsgPermissions />
        </div>
      )}
      {kind === 'discord' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <GuideToggle label="New to Discord bots? Step-by-step setup" open={guide} onToggle={() => setGuide(!guide)}>
            <li>
              Open{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                discord.com/developers/applications
              </a>
              {' '}and sign in — if Discord shows an onboarding page first, skip it. Press <b>New Application</b> and give it a name.
            </li>
            <li>On its <b>Bot</b> tab press <b>Reset Token</b> and copy the token — it shows only once.</li>
            <li>Still on the Bot tab, under <b>Privileged Gateway Intents</b> turn on <b>Message Content Intent</b> — without it the bot can’t read messages.</li>
            <li>Press the <b>New secret</b> button below, paste the token as the value and <b>Save to Keychain</b> — the secret is selected automatically.</li>
            <li>In the portal’s left sidebar click <b>OAuth2</b> and scroll to the <b>OAuth2 URL Generator</b> section.</li>
            <li>Tick the <b>bot</b> scope — a <b>Bot Permissions</b> grid appears below it. Tick <b>View Channels</b> there. If an Integration Type selector shows, leave it on <b>Guild Install</b>.</li>
            <li>Copy the <b>Generated URL</b> at the bottom and open it in your browser. Pick your server, press Continue, then <b>Authorize</b>. You need Manage Server on that server — and the bot showing offline afterwards is fine.</li>
            <li>In Discord open User Settings (gear icon), scroll the settings sidebar to the bottom and click <b>Developer</b>, then turn on <b>Developer Mode</b>. Close settings and right-click the channel → <b>Copy Channel ID</b>.</li>
            <li>Paste the channel id below, choose the bot-token secret, press <b>Add</b>.</li>
          </GuideToggle>
        </div>
      )}
      {kind === 'cron' ? (
        <input
          className={`ad-input${expression && !exprOk ? ' invalid' : ''}`}
          value={expression}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="0 8 * * *   (minute hour day month weekday, Sun = 0)"
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
        />
      ) : kind === 'time' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className={`ad-input${at && !atOk ? ' invalid' : ''}`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px', colorScheme: 'dark' }}
          />
          <TimeParts
            parts={tparts}
            invalid={(timeEntered && !timeOk) || !!(at && !atOk)}
            onChange={setTparts}
          />
        </div>
      ) : kind === 'discord' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className={`ad-input${channel && !channelOk ? ' invalid' : ''}`}
            value={channel}
            onChange={(e) => setChannel(e.target.value.trim())}
            placeholder="Channel id (numbers — right-click the channel → Copy Channel ID)"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <SecretPick secrets={secrets} selected={secret} onPick={setSecret} />
            <button className="ad-btn-accent-ghost small" onClick={() => setSecretModal(true)} style={{ flex: 'none' }}>
              <i className="fa-solid fa-plus" style={{ fontSize: 9, marginRight: 5 }} />
              New secret
            </button>
          </div>
          {secretModal && (
            <SecretModal
              modal={{ mode: 'add' }}
              onClose={() => setSecretModal(false)}
              onSaved={(name) => setSecret(name)}
            />
          )}
          <input
            className="ad-input"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Message filter — only messages containing… (optional)"
            title="Fires only when the message contains this text — case-insensitive, plain substring"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
          />
          <input
            className={`ad-input${author && !authorOk ? ' invalid' : ''}`}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Sender filter — only messages from these user ids (optional)"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: -2 }}>
            Fires only on messages from these Discord users — comma-separate several ids.
            A user id is a long number like 234567890123456789 — right-click their name →
            Copy User ID (needs Developer Mode, enabled in step 8).
          </div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, alignSelf: 'flex-start',
            color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none',
          }}>
            <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} />
            Only when the bot is mentioned
          </label>
        </div>
      ) : kind === 'imessage' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className={`ad-input${from && !fromOk ? ' invalid' : ''}`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="Sender — +15551234567 or an email"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
          />
          <input
            className="ad-input"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Message filter — only messages containing… (optional)"
            title="Fires only when the message contains this text — case-insensitive, plain substring"
            spellCheck={false}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px' }}
          />
        </div>
      ) : null}
      {(kind === 'cron' || kind === 'time') && <TzPick timezone={timezone} onPick={setTz} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9 }}>
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11,
          color: canAdd ? 'var(--accent)' : 'var(--red-text)',
        }}>
          {preview}
        </span>
        <button
          className="ad-btn-accent-ghost small"
          onClick={() => {
            onSave(kind === 'app_start' ? { kind }
              : kind === 'discord' ? {
                  kind, channel, secret,
                  ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
                  ...(mention ? { mention: true } : {}),
                  ...(authorIds.length ? { author: [...new Set(authorIds)].sort() } : {}),
                }
              : kind === 'imessage' ? {
                  kind, from: fromNorm,
                  ...(pattern.trim() ? { pattern: pattern.trim() } : {}),
                }
              : { ...(kind === 'cron' ? { kind, expression: expression.trim() } : { kind, at }), ...(timezone ? { timezone } : {}) })
          }}
          disabled={!canAdd}
          style={{ flex: 'none' }}
        >
          {initial ? 'Save' : 'Add'}
        </button>
        <button className="ad-btn-text dim" onClick={onCancel} style={{ flex: 'none' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function AddTrigger({ hasAppStart, onAdd }: { hasAppStart: boolean; onAdd: (t: TriggerDraft) => void }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button className="ad-btn-dashed" onClick={() => setOpen(true)} style={{ marginTop: 9 }}>
        <i className="fa-solid fa-plus" style={{ fontSize: 9 }} /> Add trigger
      </button>
    )
  }
  return (
    <div className="ad-anim-item" style={{ marginTop: 10 }}>
      <TriggerEditor
        hasAppStart={hasAppStart}
        onSave={(t) => { onAdd(t); setOpen(false) }}
        onCancel={() => setOpen(false)}
      />
    </div>
  )
}

/** §6 concurrency settings + the live queue. One `number` row per setting, using
 *  the same §9.2 compact-row layout as ParamRow, and PATCHing on the same
 *  no-version/no-AI path. */
function ConcurrencyCard({ auto, showToast }: { auto: Automation; showToast: (m: string, ms?: number) => void }) {
  const loadAuto = useStore((s) => s.loadAuto)
  const executions = useStore((s) => s.executions)
  const [confirmClear, setConfirmClear] = useState(false)

  // §9.2: the waiting count is the automation's own `queued` records — the same
  // source the §7 Waiting section lists. A count carried on the automation would
  // ride a /state snapshot, and two refreshes racing (the finish and the
  // promotion it drains into) can land out of order and leave a promoted entry
  // counted as waiting; a record's status flips with `exec.started` and can't.
  const waiting = executions.filter((e) => e.automationId === auto.id && e.status === 'queued' && !e.test).length

  const patch = (key: 'maxParallel' | 'maxQueued', v: number) => {
    void (async () => {
      try {
        await api.patchAutomation(auto.id, { [key]: v })
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  // §6/§9.2: the caution is specific or it isn't shown — an automation whose
  // steps never touch memory has nothing to warn about.
  const memSteps = auto.maxParallel > 1
    ? (auto.steps ?? []).filter(s => /\bmemory\b/.test(s.code ?? '')).map(s => s.name)
    : []

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <Eyebrow>CONCURRENCY</Eyebrow>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          Applies to incoming messages — no new version, no AI involved.
        </span>
      </div>
      <div className="ad-card" style={{ overflow: 'hidden' }}>
        <NumberSettingRow
          label="Run at once"
          help="How many executions of this automation may run at the same time."
          value={auto.maxParallel} min={1}
          onCommit={(v) => patch('maxParallel', v)}
        />
        {memSteps.length > 0 && (
          <div className="ad-anim-item" style={{
            margin: '12px 18px', background: 'var(--notice-amber-bg)',
            border: '1px solid var(--notice-amber-border)', borderRadius: 10, padding: '11px 14px',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-2)',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flex: 'none', marginTop: 5 }} />
            <span>
              {memSteps.map(n => <code key={n} style={{ fontFamily: 'var(--mono)' }}>{n}</code>)
                .reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], [])}
              {memSteps.length === 1 ? ' writes' : ' write'} to memory. Parallel executions share one
              memory directory, so two runs updating the same value can lose one of the updates.
            </span>
          </div>
        )}
        <NumberSettingRow
          label="Queue when busy"
          help="How many incoming messages wait for a free slot. Beyond this they're answered with a busy notice instead."
          value={auto.maxQueued} min={0} last={waiting === 0}
          onCommit={(v) => patch('maxQueued', v)}
        />
        {waiting > 0 && (
          <div className="ad-anim-item" style={{
            padding: '12px 18px', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 12,
          }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              <i className="fa-solid fa-hourglass-half" style={{ marginRight: 7, color: 'var(--cyan)' }} />
              {waiting} waiting
            </span>
            <button className="ad-btn-text" onClick={() => setConfirmClear(true)}>Clear queue</button>
          </div>
        )}
      </div>
      {confirmClear && (
        <ConfirmModal
          title="Clear queue"
          body={`Cancel ${waiting} waiting message${waiting === 1 ? '' : 's'}? Each sender is told. Executions already running are not affected.`}
          confirmLabel="Clear queue"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false)
            void (async () => {
              try {
                const { cancelled } = await api.clearQueue(auto.id)
                void loadAuto(auto.id)
                showToast(`${cancelled} waiting message${cancelled === 1 ? '' : 's'} cancelled.`)
              } catch (err) {
                showToast((err as Error).message)
              }
            })()
          }}
        />
      )}
    </div>
  )
}

function NumberSettingRow(
  { label, help, value, min, last, onCommit }:
  { label: string; help: string; value: number; min: number; last?: boolean; onCommit: (v: number) => void },
) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <div style={{
      padding: '14px 18px', borderBottom: last ? 'none' : '1px solid var(--hairline-dim)',
      display: 'flex', gap: 18, alignItems: 'center',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>{help}</div>
      </div>
      <input
        value={draft ?? String(value)}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => {
          // Commit on blur rather than per keystroke: an intermediate "" or "0"
          // would otherwise PATCH a value the user never meant to set.
          const v = draft === null || draft === '' ? value : Math.max(min, parseInt(draft, 10))
          setDraft(null)
          if (v !== value) onCommit(v)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="ad-input"
        style={{
          width: 70, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 13,
          textAlign: 'center', padding: '6px 10px', flex: 'none',
        }}
      />
    </div>
  )
}

function ParamRow({ automationId, p, last }: { automationId: string; p: ParamDef; last: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const loadAuto = useStore((s) => s.loadAuto)
  const [lines, setLines] = useState<string[]>(() => [...(p.lines ?? [])])
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() => (p.rows ?? []).map((r) => ({ ...r })))
  const [text, setText] = useState<string | null>(null)
  const [num, setNum] = useState<string | null>(null)
  const [tog, setTog] = useState<boolean | null>(null) // optimistic toggle — a double-click must not compute twice from stale props
  const [foc, setFoc] = useState(false)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<unknown>(undefined)

  // Resync from the server value when it changes underneath (a restore, a new
  // version's defaults, an edit from another window) — but never while an edit
  // is pending or an input is focused, so typing is never clobbered.
  const serverLines = JSON.stringify(p.lines ?? [])
  useEffect(() => {
    if (!timer.current && !foc) setLines([...(p.lines ?? [])])
  }, [serverLines])
  const serverRows = JSON.stringify(p.rows ?? [])
  useEffect(() => {
    if (!timer.current && !foc) setRows((p.rows ?? []).map((r) => ({ ...r })))
  }, [serverRows])
  useEffect(() => { setTog(null) }, [p.on])

  const commit = (value: unknown) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    pending.current = undefined
    void (async () => {
      try {
        await api.patchAutomation(automationId, { paramValues: { [p.name]: value } })
        void loadAuto(automationId)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  // Debounced commit: saves as the user types, without one PATCH per keystroke.
  const commitSoon = (value: unknown) => {
    pending.current = value
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; commit(pending.current) }, 600)
  }
  const flush = () => { if (timer.current) commit(pending.current) }
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); commit(pending.current) } }, [])

  const setLinesSaved = (next: string[], now = false) => { setLines(next); now ? commit(next) : commitSoon(next) }
  const setRowsSaved = (next: { key: string; value: string }[], now = false) => { setRows(next); now ? commit(next) : commitSoon(next) }

  let good = 0
  let bad = 0
  if (p.kind === 'list' && p.validate) {
    good = lines.filter((l) => l.trim() && validUrl(l)).length
    bad = lines.filter((l) => l.trim() && !validUrl(l)).length
  }

  // §9.2 hybrid layout: compact controls (toggle/number) sit on the label's line,
  // wide editors (text/list/kv) stack below the full-width label + help.
  const compact = p.kind === 'toggle' || p.kind === 'number'
  const labelBlock = (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
        {p.kind === 'text' && !p.value && (
          <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>
        )}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
    </div>
  )

  return (
    <div style={{
      padding: '14px 18px', borderBottom: last ? 'none' : '1px solid var(--hairline-dim)',
      display: 'flex', gap: compact ? 18 : 8, flexDirection: compact ? 'row' : 'column',
      alignItems: compact ? 'center' : 'stretch',
    }}>
      {labelBlock}
      <div style={{ minWidth: 0, display: 'flex', flex: 'none' }}>
        {p.kind === 'toggle' && (
          <Toggle
            on={tog ?? !!p.on}
            onChange={() => {
              const v = !(tog ?? !!p.on)
              setTog(v)
              void (async () => {
                try {
                  await api.patchAutomation(automationId, { paramValues: { [p.name]: v } })
                  void loadAuto(automationId)
                } catch (err) {
                  setTog(null) // roll the optimistic value back — the server still holds the old one
                  showToast((err as Error).message)
                }
              })()
            }}
          />
        )}
        {p.kind === 'number' && (
          <input
            value={num ?? String(p.value ?? '')}
            inputMode="numeric"
            onChange={(e) => {
              const s = e.target.value.replace(/[^0-9]/g, '')
              setNum(s)
              const min = p.min ?? 0
              const v = s === '' ? min : Math.max(min, parseInt(s, 10))
              commitSoon(v)
            }}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              flush()
              setNum(null)
            }}
            className="ad-input"
            style={{
              width: 70, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 13,
              textAlign: 'center', padding: '6px 10px',
            }}
          />
        )}
        {p.kind === 'text' && (
          <input
            value={text ?? String(p.value ?? '')}
            placeholder={p.placeholder ?? ''}
            onChange={(e) => { setText(e.target.value); commitSoon(e.target.value) }}
            onFocus={() => setFoc(true)}
            onBlur={() => {
              setFoc(false)
              flush()
              setText(null)
            }}
            className="ad-input"
            style={{ width: '100%', maxWidth: 520, fontSize: 12.5, padding: '8px 12px' }}
          />
        )}
        {p.kind === 'list' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lines.map((l, j) => {
              const inv = !!p.validate && !!l.trim() && !validUrl(l)
              return (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    className={`ad-input${inv ? ' invalid' : ''}`}
                    value={l}
                    onChange={(e) => setLinesSaved(lines.map((x, i) => (i === j ? e.target.value : x)))}
                    onBlur={flush}
                    style={{
                      flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px',
                      ...(inv ? { color: 'var(--red-text)' } : {}),
                    }}
                  />
                  {inv && (
                    <MiniBadge c="var(--red-text)" bg="var(--red-bg)" style={{ flex: 'none' }}>
                      NOT A VALID LINK
                    </MiniBadge>
                  )}
                  <button className="ad-btn-x" onClick={() => setLinesSaved(lines.filter((_, i) => i !== j), true)}>
                    <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                  </button>
                </div>
              )
            })}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button className="ad-btn-dashed" onClick={() => setLinesSaved([...lines, ''])}>
                + Add line
              </button>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)' }}>
                {lines.length}{p.validate ? ` lines · ${good} valid links${bad ? ` · ${bad} needs attention` : ''}` : ' entries'}
              </span>
            </div>
          </div>
        )}
        {p.kind === 'kv' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((r, j) => (
              <div key={j} style={{ display: 'flex', gap: 6 }}>
                <input
                  className="ad-input"
                  value={r.key}
                  onChange={(e) => setRowsSaved(rows.map((x, i) => (i === j ? { ...x, key: e.target.value } : x)))}
                  onBlur={flush}
                  style={{
                    flex: 1.3, minWidth: 0, color: 'var(--text-muted)',
                    fontFamily: 'var(--mono)', fontSize: 11.5, padding: '7px 10px',
                  }}
                />
                <input
                  className="ad-input"
                  value={r.value}
                  onChange={(e) => setRowsSaved(rows.map((x, i) => (i === j ? { ...x, value: e.target.value } : x)))}
                  onBlur={flush}
                  style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '7px 10px' }}
                />
                <button className="ad-btn-x" onClick={() => setRowsSaved(rows.filter((_, i) => i !== j), true)}>
                  <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                </button>
              </div>
            ))}
            <button className="ad-btn-dashed" onClick={() => setRowsSaved([...rows, { key: '', value: '' }])}>
              + Add row
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- steps ----------

function StepRow({ s, n, open, onToggle, last, agentTags }: {
  s: Step; n: number; open: boolean; onToggle: () => void; last: boolean
  agentTags: { name: string; why?: string }[]
}) {
  // §9.2: declared entries carry the per-use `why`; code-referenced names don't.
  const stepSecrets = (s.secrets ?? []).map((e) => ({ ...e }))
  for (const m of (s.code || '').matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)) {
    if (!stepSecrets.some((t) => t.name === m[1])) stepSecrets.push({ name: m[1] })
  }
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--hairline-dim)' }}>
      <button className="ad-btn-bare ad-hover-row ad-focus-inset" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', cursor: 'pointer' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }}>{n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
            {s.agent && agentTags.map((t) => (
              <Tag
                key={t.name}
                icon="fa-microchip"
                c="var(--accent)"
                title={t.why || s.why || `This step calls the ${t.name} AI agent.`}
                style={{ background: 'var(--accent-chip-bg)', border: '1px solid var(--border-card-hover)' }}
              >
                {t.name}
              </Tag>
            ))}
            {stepSecrets.map((t) => (
              <Tag
                key={t.name}
                icon="fa-key"
                title={t.why || `This step uses the ${t.name} secret from your Keychain`}
                style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
              >
                {t.name}
              </Tag>
            ))}
            <Tag
              icon="fa-clock"
              title={stepTimeoutTitle(s)}
              style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
            >
              {stepTimeoutLabel(s)}
            </Tag>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>{s.description}</div>
        </div>
        <span title={open ? 'Hide script' : 'View script'} style={{ color: 'var(--text-deco)', flex: 'none' }}>
          <Caret open={open} openDeg={180} closedDeg={0} style={{ fontSize: 12 }} />
        </span>
      </button>
      <Collapse open={open}>
        {s.agent && s.why && (
          <div style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid var(--hairline-dim)',
            background: 'var(--accent-hint-bg)', padding: '10px 18px 10px 45px',
          }}>
            <i className="fa-solid fa-microchip" style={{ color: 'var(--accent-hover)', fontSize: 10, marginTop: 3 }} />
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
              <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>Why an agent: </span>{s.why}
            </span>
          </div>
        )}
        <PyCode code={s.code} style={{
          margin: 0, background: 'var(--bg-code)', borderTop: '1px solid var(--hairline-dim)',
          padding: '14px 18px 14px 45px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.75,
          color: 'var(--code-text)', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0,
        }} />
      </Collapse>
    </div>
  )
}

// Holds the open-step set locally so a toggle re-renders only this list —
// a page-level re-render blocks paint past the front-loaded half of the
// §14 collapse transition and the expand reads as a pop. Steps open
// independently: auto-closing the previous step would run its collapse
// simultaneously and the two motions cancel into a layout shuffle.
function StepList({ steps, fallbackAgent }: { steps: Step[]; fallbackAgent: string }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  return (
    <>
      {steps.map((s, i) => (
        <StepRow
          key={i}
          s={s}
          n={i + 1}
          open={open.has(i)}
          onToggle={() => toggle(i)}
          last={i === steps.length - 1}
          agentTags={s.agents?.length ? s.agents : [{ name: fallbackAgent }]}
        />
      ))}
    </>
  )
}

// ---------- page ----------

export default function AutomationDetail() {
  const { automationId, automations, agents, executions, go, setSurface, showToast, loadAuto } = useStore()
  const auto: Automation | undefined = automations.find((a) => a.id === automationId)

  const [verOpen, setVerOpen, verRef] = usePopover()
  const [actOpen, setActOpen, actRef] = usePopover()
  const [delAsk, setDelAsk] = useState(false)
  const [exportAsk, setExportAsk] = useState(false)
  const [exportValues, setExportValues] = useState(true)
  const [specOpen, setSpecOpen] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [snapAsk, setSnapAsk] = useState(false)
  const [snapName, setSnapName] = useState('')
  const [snapRow, setSnapRow] = useState<{ sid: string; kind: 'restore' | 'rename' | 'delete' } | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [, setTick] = useState(0)

  // Full record (params/steps/latest) only comes from the full fetch.
  useEffect(() => {
    if (automationId) { void loadAuto(automationId); setConfirmClear(false); setSnapAsk(false); setSnapRow(null) }
  }, [automationId])
  // §4.3: refresh the countdown every 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])
  // automationId may point at a deleted automation.
  useEffect(() => { if (!auto) go('automations') }, [auto, go])

  if (!auto) return null

  // §6: `live` is a list — with maxParallel > 1 several run at once, and only a
  // full set of slots blocks a manual start.
  const liveCount = auto.live.length
  const executing = liveCount > 0
  const atCapacity = liveCount >= auto.maxParallel
  const busyToast = executingToast(auto.maxParallel, auto.maxQueued)
  const trigs = auto.triggers
  const noTrigs = trigs.length === 0
  const allOff = auto.triggersOff
  const countdown = auto.nextAt == null ? '' : nextIn(auto)
  const nextShort = nextTriggerShort(trigs)
  // §4.3: enabled app_start/message triggers have no computable next — nextAt stays null.
  const discordOn = trigs.some((t) => t.kind === 'discord' && t.enabled)
  const imsgOn = trigs.some((t) => t.kind === 'imessage' && t.enabled)
  const msgListening = auto.nextAt == null && (discordOn || imsgOn)
  const listenWhat = discordOn && imsgOn ? 'messages' : discordOn ? 'Discord messages' : 'iMessages'
  const appStartOnly = auto.nextAt == null && !msgListening && trigs.some((t) => t.kind === 'app_start' && t.enabled)
  // nextAt can be null with an enabled non-app_start trigger too (e.g. an
  // elapsed one-shot not yet consumed) — never render a dangling "next in ".
  const noNext = auto.nextAt == null
  const trigChip = executing ? `${auto.triggerChip} · executing now`
    : noTrigs ? 'No triggers'
    : allOff ? `${auto.triggerChip} · triggers off`
    : appStartOnly ? `${auto.triggerChip} · on app start`
    : noNext ? auto.triggerChip
    : `${auto.triggerChip} · next in ${countdown}`
  const trigStatusText = executing ? 'Executing now… the triggers are unchanged.'
    : noTrigs ? 'No triggers set — executes only when you press Execute now or use the menu bar.'
    : allOff ? 'All triggers are off — won’t execute on its own. Execute now and the menu bar still work.'
    : msgListening ? `Listening for ${listenWhat} — executes when a matching message arrives. Execute now and the menu bar still work.`
    : appStartOnly ? 'Executes when this app next starts — Execute now and the menu bar still work.'
    : noNext ? 'No upcoming occurrence — Execute now and the menu bar still work.'
    : `Next execution in ${countdown}${nextShort ? ` (${nextShort})` : ''} · executes even when the app is closed.`
  const trigChipOn = executing || (!allOff && !noTrigs)
  const execLabel = executing ? 'Executing…' : 'Execute now'
  const execIconCls = executing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'

  const doExecute = (ver?: string, toastMsg?: string) => {
    if (atCapacity) { showToast(busyToast); return }
    void (async () => {
      try {
        await api.executeNow(auto.id, ver)
        if (toastMsg) showToast(toastMsg)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? busyToast : er.message)
      }
    })()
  }

  // §4.3 trigger edits are user-owned operational state: whole-list PATCH, no version, no AI.
  const putTriggers = (next: Array<Trigger | DraftTrigger>, toastMsg: string) => {
    void (async () => {
      try {
        await api.patchAutomation(auto.id, { triggers: next })
        showToast(toastMsg)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const [editTrig, setEditTrig] = useState<string | null>(null) // §9.2: id of the row swapped for the inline editor
  const [removeTrig, setRemoveTrig] = useState<Trigger | null>(null) // §9.2: trigger awaiting remove confirmation
  const toggleTrigger = (t: Trigger) => {
    putTriggers(
      trigs.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)),
      t.enabled ? `Trigger turned off — ${t.short}. Execute now still works.` : `Trigger turned on — ${t.short}.`,
    )
  }
  const removeTrigger = (t: Trigger) => {
    putTriggers(trigs.filter((x) => x.id !== t.id), `Trigger removed — ${t.short}.`)
  }

  const confirmDelete = () => {
    setDelAsk(false)
    const nm = auto.name
    void (async () => {
      try {
        await api.deleteAutomation(auto.id)
        go('automations')
        showToast(`“${nm}” deleted — its past results stay in Executions.`)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const revealMemory = () => {
    const p = auto.memory?.path
    if (!p) return
    void window.autowright?.revealPath(p)
    showToast(`Shown in Finder — Autowright › Memory › ${auto.name}`)
  }

  const doClearMemory = () => {
    setConfirmClear(false)
    void (async () => {
      try {
        await api.clearMemory(auto.id)
        showToast('Memory cleared — the next execution starts fresh.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  // §6.3 memory snapshots
  const doSnapshot = () => {
    const name = snapName.trim()
    setSnapAsk(false)
    setSnapName('')
    void (async () => {
      try {
        await api.createSnapshot(auto.id, name || undefined)
        showToast('Snapshot saved.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const doRestoreSnap = (sid: string) => {
    setSnapRow(null)
    void (async () => {
      try {
        await api.restoreSnapshot(auto.id, sid)
        showToast('Memory restored — the next execution continues from the snapshot.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const doRenameSnap = (sid: string) => {
    const name = renameVal.trim()
    setSnapRow(null)
    void (async () => {
      try {
        await api.renameSnapshot(auto.id, sid, name || null)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  // §6.3 automatic-snapshot toggles — user-owned operational state, applies immediately (§19 PATCH)
  const setSnapSetting = (key: keyof SnapshotSettings, on: boolean) => {
    void (async () => {
      try {
        await api.patchAutomation(auto.id, { snapshotSettings: { [key]: on } })
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const doDeleteSnap = (sid: string) => {
    setSnapRow(null)
    void (async () => {
      try {
        await api.deleteSnapshot(auto.id, sid)
        showToast('Snapshot deleted.')
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const discardDraft = () => {
    void (async () => {
      try {
        await api.deleteDraft(auto.id)
        showToast(`Draft discarded — v${auto.version} is unchanged.`)
        void loadAuto(auto.id)
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }

  const lr = auto.latest
  // §9.2 failure notice: latest execution (§4.1: skipped AND queued records
  // never count as latest — a waiting firing must not hide a failure notice)
  // failed → its §4.5 error leads the LATEST RESULT card.
  const latestExec = executions.find((e) =>
    e.automationId === auto.id && e.status !== 'skipped' && e.status !== 'queued' && !e.test)
  const failedExec = latestExec?.status === 'failed' && latestExec.error ? latestExec : null
  const params = auto.params ?? []
  const steps = auto.steps ?? []
  const spec = auto.spec ?? []
  const olderVersions = (auto.versions ?? []).filter((v) => v.version !== auto.version)
  // §11 test executions are draft-scoped — never listed among real executions
  const recentExecs = executions.filter((e) => e.automationId === auto.id && !e.test).slice(0, 6)

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 30px 70px' }}>
      <BackLink label="Automations" onClick={() => go('automations')} />

      {/* title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '14px 0 6px' }}>
        <h1
          title={auto.name}
          style={{
            fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0,
            minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {auto.name}
        </h1>
        <div ref={verRef} style={{ position: 'relative' }}>
          <button className="ad-btn-pill" onClick={() => setVerOpen(!verOpen)}>
            <span>v{auto.version}</span>
            <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
          </button>
          <PopMenu
            show={verOpen}
            style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 360, padding: 0, overflow: 'hidden' }}
          >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                borderBottom: '1px solid var(--hairline-dim)', background: 'rgba(255,255,255,.03)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text)' }}>
                    v{auto.version} · current
                  </div>
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                    What triggers and Execute now always use.
                  </div>
                </div>
              </div>
              <ScrollArea style={{ maxHeight: '60vh' }}>
              {olderVersions.map((v) => (
                <div key={v.version} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  borderBottom: '1px solid var(--hairline-dim)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12.5, color: 'var(--text-2)' }}>v{v.version}</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>
                      {(v.note ? `${v.note} — ` : '') + v.when}
                    </div>
                  </div>
                  <button
                    className="ad-btn-accent-ghost small"
                    onClick={() => {
                      setVerOpen(false)
                      doExecute(`v${v.version}`, `Executing v${v.version} once — triggers and Execute now stay on v${auto.version}.`)
                    }}
                    style={{ flex: 'none' }}
                  >
                    <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Execute once
                  </button>
                </div>
              ))}
              </ScrollArea>
              <div style={{
                padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)',
                background: 'var(--bg-card)',
              }}>
                Executing an older version once doesn’t change anything — triggers and{' '}
                <i className="fa-solid fa-play" style={{ fontSize: 9 }} /> Execute now always use the current version.
                To make an older version current, open Edit and restore it from the Version menu.
              </div>
          </PopMenu>
        </div>
        <Badge status={auto.lastStatus} style={{ animation: badgeAnim(auto.lastStatus) }} />
        <div style={{ flex: 1 }} />
        <HeaderActions>
          <button className="ad-btn-ghost" onClick={() => setSurface('create', 'edit')}>
            Edit
          </button>
          <BtnPrimary onClick={() => doExecute()}>
            <i className={execIconCls} style={{ fontSize: 9 }} /> {execLabel}
          </BtnPrimary>
          <div ref={actRef} style={{ position: 'relative' }}>
            <button
              className="ad-btn-ghost"
              onClick={() => setActOpen(!actOpen)}
              title="More actions"
              style={{ padding: '8px 11px' }}
            >
              <i className="fa-solid fa-ellipsis" style={{ fontSize: 12 }} />
            </button>
            <PopMenu show={actOpen} style={{ top: 'calc(100% + 6px)', right: 0, minWidth: 210 }}>
              <MenuRow onClick={() => { setActOpen(false); setExportValues(true); setExportAsk(true) }}>
                <i className="fa-solid fa-file-export" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                Export…
              </MenuRow>
              <MenuRow danger onClick={() => { setActOpen(false); setDelAsk(true) }}>
                <i className="fa-solid fa-trash-can" style={{ fontSize: 11, width: 14, textAlign: 'center', marginRight: 9 }} />
                Delete automation…
              </MenuRow>
            </PopMenu>
          </div>
        </HeaderActions>
      </div>

      {/* §9.2 lede row: the automation's description (read-only — editing lives on the edit page)
          with the §4.3 trigger status chip beside it; chip stands alone when description is empty */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 24px' }}>
        {auto.description && (
          <p
            title={auto.description}
            style={{
              font: "400 13.5px/1.6 var(--sans)", color: 'var(--text-muted)', margin: 0,
              flex: '0 1 auto', minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {auto.description}
          </p>
        )}
        <span style={{
          flex: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontWeight: 500,
          fontSize: 11.5, color: trigChipOn ? 'var(--accent)' : 'var(--gray)',
          background: trigChipOn ? 'var(--accent-chip-bg)' : 'var(--gray-bg)',
          borderRadius: 6, padding: '3px 9px',
          transition: 'color var(--t-hover) var(--ease-enter), background var(--t-hover) var(--ease-enter)',
        }}>
          <i
            className={executing ? 'fa-solid fa-spinner fa-spin' : (allOff || noTrigs) ? 'fa-solid fa-pause' : 'fa-solid fa-clock'}
            style={{ fontSize: 9 }}
          />
          {trigChip}
        </span>
      </div>

      {/* §4.4 draft banner */}
      {auto.draft && (
        <div className="ad-anim-item" style={{
          margin: '0 0 24px', background: 'var(--bg-card)', border: '1px dashed oklch(0.74 0.155 52 / .45)',
          borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <MiniBadge c="var(--accent)" bg="var(--accent-chip-bg)" style={{ flex: 'none' }}>Draft</MiniBadge>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>
            Unsaved edit based on v{auto.version} — kept from your last edit session. Resume editing to keep working on it.
          </span>
          <button
            className="ad-btn-soft"
            onClick={() => setSurface('create', 'edit')}
            style={{ flex: 'none' }}
          >
            Resume editing
          </button>
          <button className="ad-btn-text dim" onClick={discardDraft} style={{ flex: 'none' }}>
            Discard
          </button>
        </div>
      )}

      {/* latest result */}
      {(lr || failedExec) ? (
        <div style={{ marginBottom: 26 }}>
          {failedExec && (
            <FailureNotice
              error={failedExec.error!}
              onView={() => go('execution', { executionId: failedExec.id })}
              // §7/§9.2 Fix with AI: open the editor seeded with this failure
              onFix={() => {
                useStore.setState({ fixExec: failedExec.id })
                setSurface('create', 'edit')
              }}
              style={{ marginBottom: lr ? 10 : 0 }}
            />
          )}
          {lr && (
            <ResultSection
              label="LATEST RESULT" result={lr} executionId={lr.executionId} compact
              stamp={latestExec ? `${latestExec.status}:${latestExec.duration}` : undefined}
            />
          )}
        </div>
      ) : (
        <EmptyNotice
          title="No executions yet"
          body="Press Execute now — the first result will appear right here."
          style={{ marginBottom: 26 }}
        />
      )}

      {/* triggers — no overflow clip (§9.2): the editor's timezone/secret
          popovers must overhang the card edge; there are no full-bleed hover
          rows here that would need corner masking */}
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ marginBottom: 10 }}>TRIGGERS</Eyebrow>
        <div className="ad-card">
          <div style={{ padding: '13px 18px' }}>
            {trigs.map((t) => t.id === editTrig ? (
              <div key={t.id} className="ad-anim-item" style={{ padding: '5px 0' }}>
                <TriggerEditor
                  hasAppStart={trigs.some((x) => x.kind === 'app_start' && x.id !== t.id)}
                  initial={t}
                  onSave={(nt) => {
                    setEditTrig(null)
                    putTriggers(
                      trigs.map((x) => (x.id === t.id ? { ...nt, id: t.id, enabled: t.enabled } : x)),
                      `Trigger updated — ${triggerShort(nt)}.`,
                    )
                  }}
                  onCancel={() => setEditTrig(null)}
                />
              </div>
            ) : (
              <div key={t.id} style={{ padding: '5px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: t.enabled ? 'var(--accent-chip-bg)' : 'var(--hairline-dim)',
                    color: t.enabled ? 'var(--accent)' : 'var(--text-faint)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
                    transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter)',
                  }}>
                    <i className={kindIcon(t.kind)} style={{ fontSize: 12 }} />
                  </span>
                  <span
                    style={{
                      flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 12,
                      color: t.enabled ? 'var(--text-2)' : 'var(--text-faint)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {t.label}
                  </span>
                  {t.kind !== 'app_start' && (
                    <button
                      className="ad-btn-icon"
                      onClick={() => setEditTrig(t.id)}
                      title="Edit trigger"
                      aria-label="Edit trigger"
                    >
                      <i className="fa-solid fa-pen" style={{ fontSize: 11 }} />
                    </button>
                  )}
                  <Toggle on={t.enabled} onChange={() => toggleTrigger(t)} title={t.enabled ? 'Turn this trigger off' : 'Turn this trigger on'} />
                  <button className="ad-btn-x" onClick={() => setRemoveTrig(t)} title="Remove trigger" aria-label="Remove trigger">
                    <i className="fa-solid fa-xmark" />
                  </button>
                </div>
                {/* §9.2: a message trigger's listener state — errors in red, connecting muted, connected silent */}
                {(t.kind === 'discord' || t.kind === 'imessage') && t.enabled && t.connection && t.connection.state !== 'connected' && (
                  <div className="ad-anim-item" style={{
                    marginLeft: 40, marginTop: 2, fontFamily: 'var(--mono)', fontSize: 11,
                    color: t.connection.state === 'error' ? 'var(--red-text)' : 'var(--text-faint)',
                  }}>
                    {t.connection.state === 'error' ? t.connection.error ?? 'connection error' : 'connecting…'}
                  </div>
                )}
              </div>
            ))}
            {noTrigs && (
              <div style={{
                border: '1px dashed var(--border-dashed)', borderRadius: 8, padding: '9px 12px',
                fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11.5, color: 'var(--text-faint)',
              }}>
                No triggers
              </div>
            )}
            <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 8 }}>{trigStatusText}</div>
            <AddTrigger
              hasAppStart={trigs.some((t) => t.kind === 'app_start')}
              onAdd={(t) => putTriggers([...trigs, { ...t, enabled: true }], `Trigger added — ${triggerShort(t)}.`)}
            />
          </div>
        </div>
      </div>

      {/* parameters */}
      {params.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow>PARAMETERS</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Changes apply on the next execution — no new version, no AI involved.
            </span>
          </div>
          <div className="ad-card" style={{ overflow: 'hidden' }}>
            {params.map((p, i) => (
              <ParamRow key={p.name} automationId={auto.id} p={p} last={i === params.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* §6 concurrency — only for automations that can actually queue */}
      {trigs.some(t => t.kind === 'discord' || t.kind === 'imessage') && (
        <ConcurrencyCard auto={auto} showToast={showToast} />
      )}

      {/* recent executions */}
      {recentExecs.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <Eyebrow>RECENT EXECUTIONS</Eyebrow>
            <button className="ad-btn-text" onClick={() => go('executions')}>
              All executions <i className="fa-solid fa-chevron-right" style={{ fontSize: 9 }} />
            </button>
          </div>
          <div className="ad-card" style={{ overflow: 'hidden' }}>
            {recentExecs.map((e, i) => (
              <button
                className="ad-btn-bare ad-hover-row ad-focus-inset"
                key={e.id}
                onClick={() => go('execution', { executionId: e.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '11px 18px',
                  borderBottom: i === recentExecs.length - 1 ? 'none' : '1px solid var(--hairline-dim)',
                  cursor: 'pointer',
                }}
              >
                <Badge
                  status={e.status}
                  style={{
                    width: 88, display: 'inline-flex', justifyContent: 'center', flex: 'none',
                    animation: badgeAnim(e.status),
                  }}
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', flex: 'none' }}>{e.id.slice(0, 8)}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)', flex: 'none' }}>
                  {/* §9.2: message-triggered rows read "Discord · Dave · v3" */}
                  {e.trigger}{e.triggerSender ? ` · ${e.triggerSender}` : ''}{e.ver ? ` · ${e.ver}` : ''}
                </span>
                {e.note && <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)' }}>{e.note}</span>}
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{e.duration}</span>
                <span style={{ fontSize: 12, color: 'var(--text-faint)', width: 130, textAlign: 'right', flex: 'none' }}>{e.started}</span>
                <span style={{ color: 'var(--text-deco)' }}><i className="fa-solid fa-chevron-right" style={{ fontSize: 10 }} /></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* memory (§9.2 MEMORY card, snapshots per §6.3) */}
      {auto.memory && (
        <div style={{ marginBottom: 26 }}>
          <Eyebrow style={{ marginBottom: 10 }}>MEMORY</Eyebrow>
          <div className="ad-card" style={{ padding: '13px 18px' }}>
            <div
            // §14: keyed remount + opacity-only fade — the inline swap never jumps the row
            key={confirmClear ? 'clear' : snapAsk ? 'snap' : 'actions'}
            className="ad-anim-fade"
            style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
          >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>
                {auto.memory.size} · {auto.memory.updated}
              </span>
              <div style={{ flex: 1 }} />
              {confirmClear ? (
                <>
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                    {auto.snapshotSettings.preClear
                      ? 'Next execution starts fresh, like the first time. Current memory is snapshotted first.'
                      : "Next execution starts fresh, like the first time. Automatic snapshots are off — this can't be undone."}
                  </span>
                  <button className="ad-btn-danger-ghost" onClick={doClearMemory}>
                    Clear
                  </button>
                  <button className="ad-btn-soft" onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                </>
              ) : snapAsk ? (
                <>
                  <input
                    className="ad-input"
                    value={snapName}
                    onChange={(e) => setSnapName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') doSnapshot() }}
                    placeholder="Name — optional"
                    autoFocus
                    style={{ width: 220, fontSize: 12, padding: '5px 10px' }}
                  />
                  <button
                    className="ad-btn-soft"
                    onClick={doSnapshot}
                    style={{ border: '1px solid oklch(0.74 0.155 52 / .4)', color: 'var(--accent)', fontWeight: 600 }}
                  >
                    Save
                  </button>
                  <button className="ad-btn-soft" onClick={() => { setSnapAsk(false); setSnapName('') }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="ad-btn-soft" onClick={revealMemory}>
                    Show in Finder
                  </button>
                  {auto.memory.size === 'empty' ? (
                    <button className="ad-btn-soft" disabled title="Memory is empty">
                      Snapshot
                    </button>
                  ) : (
                    <button className="ad-btn-soft" onClick={() => setSnapAsk(true)}>
                      Snapshot
                    </button>
                  )}
                  <button className="ad-btn-text danger" onClick={() => setConfirmClear(true)}>
                    Clear memory
                  </button>
                </>
              )}
            </div>
            {(auto.snapshots ?? []).length > 0 && (
              <div className="ad-anim-item" style={{ marginTop: 12, borderTop: '1px solid var(--hairline)' }}>
                {(auto.snapshots ?? []).map((s) => (
                  <div
                    // §14: keyed remount + fade on the row's inline action/confirm swaps
                    key={`${s.id}:${snapRow?.sid === s.id ? snapRow.kind : 'row'}`}
                    className="ad-anim-fade"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      padding: '9px 0', borderBottom: '1px solid var(--hairline-dim)',
                    }}
                  >
                    {snapRow?.sid === s.id && snapRow.kind === 'restore' ? (
                      <>
                        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                          {auto.snapshotSettings.preRestore
                            ? 'Replaces current memory — the current state is snapshotted first.'
                            : 'Replaces current memory — automatic snapshots are off, so the current state is lost.'}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button
                          className="ad-btn-soft"
                          onClick={() => doRestoreSnap(s.id)}
                          disabled={executing}
                          title={executing ? 'Blocked while an execution is live' : undefined}
                          style={{
                            border: '1px solid oklch(0.74 0.155 52 / .4)',
                            color: 'var(--accent)', fontWeight: 600,
                          }}
                        >
                          Restore
                        </button>
                        <button className="ad-btn-soft" onClick={() => setSnapRow(null)}>
                          Keep
                        </button>
                      </>
                    ) : snapRow?.sid === s.id && snapRow.kind === 'rename' ? (
                      <>
                        <input
                          className="ad-input"
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') doRenameSnap(s.id) }}
                          placeholder="Name — optional"
                          autoFocus
                          style={{ width: 220, fontSize: 12, padding: '5px 10px' }}
                        />
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text" onClick={() => doRenameSnap(s.id)}>
                          Save
                        </button>
                        <button className="ad-btn-text" onClick={() => setSnapRow(null)}>
                          Cancel
                        </button>
                      </>
                    ) : snapRow?.sid === s.id && snapRow.kind === 'delete' ? (
                      <>
                        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Delete this snapshot?</span>
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text danger" onClick={() => doDeleteSnap(s.id)}>
                          Delete
                        </button>
                        <button className="ad-btn-text" onClick={() => setSnapRow(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)' }}>
                          {s.name ?? 'Snapshot'}
                        </span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
                          {s.reason} · {s.version} · {s.size} · {s.files} {s.files === 1 ? 'file' : 'files'} · {s.when}
                        </span>
                        <div style={{ flex: 1 }} />
                        <button className="ad-btn-text" onClick={() => setSnapRow({ sid: s.id, kind: 'restore' })}>
                          Restore
                        </button>
                        <button
                          className="ad-btn-text"
                          onClick={() => { setRenameVal(s.name ?? ''); setSnapRow({ sid: s.id, kind: 'rename' }) }}
                        >
                          Rename
                        </button>
                        <button className="ad-btn-text danger" onClick={() => setSnapRow({ sid: s.id, kind: 'delete' })}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* §6.3 automatic-snapshot toggles */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
              <Eyebrow style={{ marginBottom: 4 }}>AUTOMATIC SNAPSHOTS</Eyebrow>
              {SNAP_SETTINGS.map(({ key, label, help }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '7px 0' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)' }}>{label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{help}</div>
                  </div>
                  <Toggle
                    on={auto.snapshotSettings[key]}
                    onChange={() => setSnapSetting(key, !auto.snapshotSettings[key])}
                    title={auto.snapshotSettings[key] ? 'Turn this automatic snapshot off' : 'Turn this automatic snapshot on'}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* steps */}
      {steps.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
            <Eyebrow>STEPS</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Written by your AI — read them anytime.</span>
          </div>
          <div className="ad-card" style={{ overflow: 'hidden' }}>
            {/* §9.2: one agent tag per name in a step's agents list; empty →
                the automation's first enabled agent, fallback "agent". */}
            <StepList
              steps={steps}
              fallbackAgent={(() => {
                const first = auto.stepAgents.map((id) => agents.find((z) => z.id === id)).find((g) => !!g)
                return first ? (first.name || first.harness) : 'agent'
              })()}
            />
          </div>
        </div>
      )}

      {/* spec */}
      {spec.length > 0 && (
        <div>
          <div className="ad-card" style={{ overflow: 'hidden' }}>
            <button
              className="ad-btn-bare ad-hover-row ad-focus-inset"
              onClick={() => setSpecOpen(!specOpen)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', cursor: 'pointer' }}
            >
              <Eyebrow>SPEC</Eyebrow>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{auto.specMeta}</span>
              <div style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                <Caret open={specOpen} openDeg={180} closedDeg={0} /> {specOpen ? 'collapse' : 'expand'}
              </span>
            </button>
            <Collapse open={specOpen}>
              <div style={{ borderTop: '1px solid var(--hairline)', padding: '8px 18px 18px' }}>
                <SpecMarkdown blocks={spec} />
                <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-muted)' }}>
                  The AI regenerates the steps from this document when you edit it. Every change mints a new version — older ones live in the Version menu on the edit page.
                </div>
              </div>
            </Collapse>
          </div>
        </div>
      )}

      {exportAsk && (
        <Modal onClose={() => setExportAsk(false)} width={440} cardStyle={{ padding: '22px 24px' }}>
          {(close) => {
            // §5.1/§9.2: fetch the archive, then hand it to the native save dialog.
            const doExport = async () => {
              try {
                const data = await api.exportAutomation(auto.id, exportValues)
                close()
                const safe = auto.name.replace(/[/\\:*?"<>|]+/g, ' ').trim() || 'automation'
                const path = await window.autowright?.saveFile(`${safe}.autowright`, data)
                if (path) showToast(`Exported to ${path}.`)
              } catch (e) { showToast((e as Error).message) }
            }
            return (
              <>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: 'var(--text)' }}>
                  Export “{auto.name}”
                </h2>
                <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 18px' }}>
                  One shareable file with the spec, steps and settings — import it on any Mac running Autowright.
                </p>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Include parameter values</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      Your saved parameter values travel with the file — turn this off when sharing with someone else.
                    </div>
                  </div>
                  <Toggle on={exportValues} onChange={setExportValues} />
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 22 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)', marginRight: 'auto' }}>
                    <i className="fa-solid fa-lock" style={{ fontSize: 10 }} />
                    Secret values and memory never leave this Mac
                  </span>
                  <BtnGhost onClick={close}>Cancel</BtnGhost>
                  <BtnPrimary onClick={() => { void doExport() }}>Export</BtnPrimary>
                </div>
              </>
            )
          }}
        </Modal>
      )}
      {removeTrig && (
        <ConfirmModal
          title="Remove this trigger?"
          body={(
            <>
              <span style={{ fontWeight: 500, color: 'var(--text)' }}>{removeTrig.label}</span>
              {' '}is removed from this automation. Its settings are gone — add it again to get it back.
            </>
          )}
          confirmLabel="Remove trigger"
          danger
          onConfirm={() => { const t = removeTrig; setRemoveTrig(null); removeTrigger(t) }}
          onCancel={() => setRemoveTrig(null)}
        />
      )}
      {delAsk && (
        <ConfirmModal
          title="Delete this automation?"
          body={(
            <>
              <span style={{ fontWeight: 500, color: 'var(--text)' }}>{auto.name}</span>
              {' '}will be deleted — its triggers stop, and its versions and memory go with it. Past results stay in Executions.
              {executing && (
                <p style={{ color: 'var(--amber)', margin: '8px 0 0' }}>An execution is in progress — deleting cancels it.</p>
              )}
            </>
          )}
          confirmLabel="Delete automation"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDelAsk(false)}
        />
      )}
    </div>
  )
}
