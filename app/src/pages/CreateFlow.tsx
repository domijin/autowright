// Create / edit flow (§11): one editor screen from birth to save — a floating
// chat panel (the editor's only conversational surface: requests, answers,
// blockers, failure analyses, drafting progress) beside the Review grid. Drafting/chatting/
// syncing are §8 backend jobs (POST /drafts + polling); on create, the review
// pane renders in a drafting state and fills in as the pipeline delivers (spec
// card first, steps skeletons after). This page also renders the Review
// dirty-gating, version menu, per-step agent/secret tags, and the
// secrets/agents warning cards.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent, Automation, Blocker, ChatEntry, DraftPayload, DraftTest, DraftTrigger, PackageDep, ParamDef, SpecBlock, Step, Trigger, VersionInfo } from '../types'
import { BtnGhost, BtnPrimary, Caret, Collapse, ConfirmModal, Eyebrow, GreenCheck, HeaderActions, MiniBadge, PULSE, PopMenu, ProgressBar, PyCode, ScrollArea, Spinner, Tag, Toggle, agName, dispModel, paramSummary, stepTimeoutLabel, stepTimeoutTitle, useOverlayThumb, usePopover, validUrl } from '../ui'
import { nextTriggerShort, triggerLabel } from '../cron'
import { SecretModal } from '../SecretModal'
import { Markdown, SpecMarkdown } from '../result'

// markdown-ish text ↔ SpecBlock[] ('# ', '## ', '- ', plain lines)
export function specToText(blocks: SpecBlock[]): string {
  return blocks.map((b) => (b.kind === 'h1' ? '# ' + b.text : b.kind === 'h2' ? '## ' + b.text : b.kind === 'li' ? '- ' + b.text : b.text)).join('\n')
}
export function textToSpec(text: string): SpecBlock[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean).map((s): SpecBlock =>
    s.startsWith('## ') ? { kind: 'h2', text: s.slice(3) }
      : s.startsWith('# ') ? { kind: 'h1', text: s.slice(2) }
        : s.startsWith('- ') ? { kind: 'li', text: s.slice(2) }
          : { kind: 'p', text: s })
}

// §11 Blocker panel: each blocker's reason + edited fix lands in the spec under
// a "Constraints & resolutions" section — the resolution lives in the document
// itself, so it survives later edits and syncs and versions like any spec text.
const CONSTRAINTS_TITLE = 'Constraints & resolutions'
export function amendSpec(spec: SpecBlock[], blockers: Blocker[]): SpecBlock[] {
  const items: SpecBlock[] = blockers.map((b) => ({ kind: 'li', text: `${b.reason.trim()} — ${b.fix.trim()}` }))
  const at = spec.findIndex((b) => b.kind === 'h2' && b.text.trim().toLowerCase() === CONSTRAINTS_TITLE.toLowerCase())
  if (at < 0) return [...spec, { kind: 'h2', text: CONSTRAINTS_TITLE }, ...items]
  let end = at + 1
  while (end < spec.length && spec[end].kind !== 'h2' && spec[end].kind !== 'h1') end++
  return [...spec.slice(0, end), ...items, ...spec.slice(end)]
}

const blockerLine = (b: Blocker) => `${b.reason.trim()} — ${b.fix.trim()}`

// §11 thread entries — persisted with the draft (§4.4 `chat` → §5 chat.jsonl).
// The transient progress entry is rendered from job state, never stored.
export function newEntry(e: Omit<ChatEntry, 'id' | 'at'>): ChatEntry {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), ...e }
}
// §4.4: error entries persist too, so a later chat's CONVERSATION context
// still names a harness failure the user saw in the thread.
const PERSIST_KINDS = new Set(['user', 'answer', 'rewrite', 'blockers', 'system', 'error'])
export function persistChat(chat: ChatEntry[]): ChatEntry[] {
  return chat.filter((e) => PERSIST_KINDS.has(e.kind))
}

interface SecretRef { name: string; steps: number[] }
// A step's secrets are its declared `secrets` entries unioned with the
// `secrets.NAME` references in its code (§4.1). Tags carry the declared
// entry's per-use `why`; a code-referenced name with no entry has none.
export function stepSecretTags(s: Step): { name: string; why?: string }[] {
  const tags = (s.secrets ?? []).map((e) => ({ ...e }))
  for (const m of (s.code || '').matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)) {
    if (!tags.some((t) => t.name === m[1])) tags.push({ name: m[1] })
  }
  return tags
}
export function stepSecretNames(s: Step): string[] {
  return stepSecretTags(s).map((t) => t.name)
}
export function secretRefsOf(steps: Step[]): SecretRef[] {
  const refs: SecretRef[] = []
  steps.forEach((s, i) => {
    for (const nm of stepSecretNames(s)) {
      let e = refs.find((z) => z.name === nm)
      if (!e) { e = { name: nm, steps: [] }; refs.push(e) }
      if (!e.steps.includes(i)) e.steps.push(i)
    }
  })
  return refs
}

const stepList = (idx: number[]) => idx.map((i) => i + 1).join(', ')

// §11 Build-instructions card: bare lines (no markdown block syntax, outside code fences)
// become bullets so plain one-rule-per-line text renders as a list, not one paragraph.
export function instrToMd(text: string): string {
  let fence = false
  return text.split('\n').map((raw) => {
    const l = raw.trim()
    if (l.startsWith('```')) { fence = !fence; return raw }
    if (fence || !l || /^(#{1,3}\s|[-*]\s|\d+\.\s|\|)/.test(l)) return raw
    return `- ${l}`
  }).join('\n')
}

// The two §8 instruction files (framework-instructions.md, shown verbatim in the read-only
// Framework-instructions card, and default-build-instructions.md, the Build-instructions
// pre-fill). Loaded from the backend (GET /instructions) so both cards always show exactly
// what the agent is told.
let fwCache: string | null = null
let defaultBuildCache = ''

// ---------- small shared bits ----------

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden',
}

// §11: one text style for a card's collapsed hint AND its in-card empty
// states — the description never changes size between collapsed and open
const cardHintFont = "400 11.5px/1.5 var(--sans)"

// §11 status-aware collapsed line: the first meaningful text line of a
// markdown-ish document, markdown markers stripped — null when nothing remains
function docPreview(text: string): string | null {
  for (const raw of text.split('\n')) {
    const t = raw.replace(/^[\s#>*\-]+/, '').replace(/^\d+[.)]\s+/, '').replace(/[*_`]/g, '').trim()
    if (t) return t
  }
  return null
}

// §11: the one template every collapsible editor card renders through —
// whole-row header toggle with hover tint, caret + eyebrow, optional
// right-edge content (actions or counts; clicks there must stopPropagation),
// the collapsed line, and the body's top hairline. `inert` freezes the
// header while the card is held open by an edit in progress. The collapsed
// line is status-aware (§11): `preview` (one-line content summary, ellipsized)
// when the card holds content, else the `hint` explainer.
function SectionCard({ eyebrow, open, onToggle, inert, right, hint, preview, children }: {
  eyebrow: string
  open: boolean
  onToggle: (open: boolean) => void
  inert?: boolean
  right?: React.ReactNode
  hint: React.ReactNode
  preview?: string | null
  children: React.ReactNode
}) {
  return (
    <div style={cardStyle}>
      <div
        // The header nests action buttons in `right`, so it stays a div with
        // button semantics (§9: never nest buttons) — Enter/Space toggle it.
        className={inert ? 'ad-focus-inset' : 'ad-hover-row ad-focus-inset'}
        role="button"
        tabIndex={inert ? -1 : 0}
        onClick={() => { if (!inert) onToggle(!open) }}
        onKeyDown={(e) => {
          if (inert || e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(!open) }
        }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', cursor: inert ? 'default' : 'pointer', userSelect: 'none' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <Caret open={open} style={{ width: 14, flex: 'none', textAlign: 'center', color: 'var(--text-deco)' }} />
          <Eyebrow>{eyebrow}</Eyebrow>
        </span>
        {right}
      </div>
      <Collapse open={!open}>
        <button
          className="ad-btn-bare ad-focus-inset"
          onClick={() => onToggle(true)}
          style={{
            padding: '0 20px 13px 43px', font: cardHintFont, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none',
            ...(preview != null ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
          }}
        >
          {preview ?? hint}
        </button>
      </Collapse>
      <Collapse open={open}>
        <div style={{ borderTop: '1px solid var(--hairline)' }}>{children}</div>
      </Collapse>
    </div>
  )
}

// in-card empty state, hint-styled and hint-indented (§11: same left edge as
// the collapsed line, so an empty card's text stays put when the card opens)
function CardEmpty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '10px 20px 16px 43px', font: cardHintFont, color: 'var(--text-muted)' }}>{children}</div>
}

// §11: the one markdown body every card renders through — same padding, same
// 440px max height with inner scroll, same full-bleed table allowance
function CardMarkdown({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea style={{ padding: '12px 20px 16px', maxHeight: 440 }}>
      {/* 18px side padding + matching negative margin so Markdown's full-bleed tables (-18px) fit */}
      <div style={{ padding: '0 18px', margin: '0 -18px' }}>{children}</div>
    </ScrollArea>
  )
}

function CheckBox({ on }: { on: boolean }) {
  return (
    <span style={{
      width: 15, height: 15, borderRadius: 4, flex: 'none', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      background: on ? 'var(--accent)' : 'transparent',
      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-hover)'}`,
    }}>
      {on && <i className="fa-solid fa-check" style={{ fontSize: 9, color: 'var(--on-accent)' }} />}
    </span>
  )
}

function WarnBanner({ text }: { text: string }) {
  return (
    <div className="ad-anim-item" style={{
      background: 'var(--notice-red-bg)', border: '1px solid var(--notice-red-border)',
      borderRadius: 10, padding: '11px 14px', margin: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 9,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-2)' }}>{text}</div>
    </div>
  )
}

/** §11 blocker cards — one per blocker, three labeled, editable fields pre-filled
 * from the agent's answer; the user edits any of them (usually the fix). Fields
 * auto-grow with their content (ask-box pattern) above per-field minimum heights. */
function BlockerCards({ blockers, onChange, bare, readOnly }: {
  // §11: `bare` drops the bordered card wrapper — the panel's inline repair and
  // test-analysis blocks provide the frame; the spec-card clarification keeps
  // the bordered cards. `readOnly` locks the fields while the entry's primary
  // action is unavailable (job in flight / viewing an old version).
  blockers: Blocker[]; onChange?: (i: number, patch: Partial<Blocker>) => void; bare?: boolean; readOnly?: boolean
}) {
  const field = (label: string, value: string, minLines: number, set: (v: string) => void, opts?: { placeholder?: string }) => (
    <div style={{ padding: bare ? '10px 0 0' : '10px 16px 0' }}>
      <Eyebrow>{label}</Eyebrow>
      <textarea
        className="ad-input amber"
        value={value} rows={1} placeholder={opts?.placeholder} readOnly={readOnly}
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
        onChange={(e) => set(e.target.value)}
        style={{
          width: '100%', margin: '6px 0 2px', color: 'var(--text)',
          font: "400 12.5px/1.55 var(--sans)", padding: '8px 10px',
          minHeight: `${minLines * 19.5 + 18}px`,
          resize: 'none', overflow: 'hidden', display: 'block',
        }}
      />
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {blockers.map((b, i) => (
        <div key={i} style={bare ? { textAlign: 'left', paddingBottom: 4 } : {
          ...cardStyle, borderColor: 'oklch(0.8 0.13 85 / .35)', paddingBottom: 14, textAlign: 'left',
          borderLeft: '3px solid oklch(0.8 0.13 85 / .6)',
        }}>
          {blockers.length > 1 && (
            <Eyebrow style={{ color: 'var(--amber)', padding: bare ? '12px 0 0' : '12px 16px 0' }}>BLOCKER {i + 1}</Eyebrow>
          )}
          {field('REASON', b.reason, 2, (v) => onChange?.(i, { reason: v }))}
          {field('HOW TO FIX', b.fix, 3, (v) => onChange?.(i, { fix: v }), { placeholder: 'What should change so this can be built' })}
          {field('DETAILS', b.details ?? '', 2, (v) => onChange?.(i, { details: v }))}
        </div>
      ))}
    </div>
  )
}

/** Drafting-agent picker — lives in the chat pane composer (§11); menu opens
    upward over the thread, left-aligned so it stays inside the pane. */
function AgentPick({ agents, selected, onPick, disabled }: {
  agents: Agent[]; selected: Agent | null; onPick: (g: Agent) => void; disabled?: boolean
}) {
  const [open, setOpen, ref] = usePopover()
  return (
    <div ref={ref} style={{ position: 'relative', flex: '0 1 auto', minWidth: 0 }}>
      <button
        className="ad-btn-pill" disabled={disabled}
        onClick={() => setOpen(!open)}
        title="The agent that writes the spec and generates the steps"
        style={{ maxWidth: '100%' }}
      >
        <i className="fa-solid fa-microchip" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected ? `${agName(selected)} · ${dispModel(selected)}` : 'No agent'}</span>
        <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
      </button>
      <PopMenu show={open} style={{ bottom: 'calc(100% + 6px)', left: 0, minWidth: 290 }}>
          {agents.map((g) => {
            const sel = !!selected && g.id === selected.id
            return (
              <button
                key={g.id}
                className="ad-btn-bare ad-hover-row"
                onClick={() => { setOpen(false); onPick(g) }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--hairline-dim)',
                  // no inline background when unselected — .ad-hover-row's hover tint must win
                  ...(sel ? { background: 'var(--accent-hint-bg)' } : {}),
                  transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter)',
                }}
              >
                <span style={{ width: 14, flex: 'none', textAlign: 'center', font: "600 12px var(--mono)", color: 'var(--accent)' }}>{sel ? <i className="fa-solid fa-check" style={{ fontSize: 10 }} /> : ''}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: "600 12.5px var(--sans)", color: sel ? 'var(--text)' : 'var(--text-2)' }}>{agName(g)}</div>
                  <div style={{ font: "400 11.5px/1.45 var(--mono)", color: 'var(--text-muted)', marginTop: 1 }}>{dispModel(g)}</div>
                </div>
              </button>
            )
          })}
          <div style={{ padding: '9px 14px', font: "400 11px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
            Writes the spec and generates the steps for this automation. Autowright still executes everything.
          </div>
      </PopMenu>
    </div>
  )
}

// ---------- review working-copy state ----------

interface Rev {
  name: string
  description: string
  note: string
  spec: SpecBlock[]
  steps: Step[]
  params: NonNullable<DraftPayload['params']>
  packages: PackageDep[]    // §6.2 declared packages — display-only, the pipeline owns the list
  triggers: DraftTrigger[]  // §11 TRIGGERS card preview — what saving stores (§4.3 cron-subset replace)
  instructions: string
  notes: string             // §4.1 agent-owned working knowledge — never marks out of sync
  enabledAgents: string[]
  allowedSecrets: string[]
  // §11 dirty gating: true only for spec/instruction/agent-ask changes — grant
  // (agent/secret) sync state is derived from steps vs grants, never stored.
  dirty: boolean
  touched: boolean
  specEdit: boolean
  specText: string
  specTextOrig: string
  // §11 draft undo: one-level full-draft snapshot stashed when a chat
  // response changes the draft — Undo restores the draft exactly as it was
  // before that request. entryId is the thread entry the ghost Undo rides;
  // editor-state only, never serialized into the draft.
  undo: {
    spec: SpecBlock[]; steps: Step[]; params: Rev['params']; packages: PackageDep[]
    triggers: DraftTrigger[]; instructions: string; notes: string; dirty: boolean; entryId: string
  } | null
  instrEdit: boolean
  instrDraft: string | null
  notesEdit: boolean
  notesDraft: string | null
  // §11 chat-action chaining (§8 actions.yaml): `pendingSync` starts a sync as
  // soon as no job is in flight; `pendingTest` starts a draft test the moment
  // the workflow is in sync (after the chained sync), carrying the test-only
  // values. Both are editor state only — never serialized.
  pendingSync: boolean
  pendingTest: { values: Record<string, unknown> | null } | null
  // §11 chat thread — the editor's one conversational surface. Persisted with
  // the draft (persistChat strips transient error entries).
  chat: ChatEntry[]
  syncBusy: boolean
  // §8 chat job in flight (the thread's progress entry carries the Cancel)
  chatBusy: boolean
  // §11 Packages card: an install/retry call in flight; the §8 job's live stage
  // (drives the "Installing the packages…" skeleton + save-hint labels)
  pkgBusy: boolean
  genStage: string | null
  // §8 live progress: the job's finer in-flight line under the stage
  genDetail: string | null
  // §8 activity feed: the newest event texts (footer feed's dim history)
  genEvents: string[]
  // §11 drafting-on-Review (create): call-1/call-2 in-flight flags drive the
  // spec-card spinner and the right-column skeletons; blockers and spec-call
  // failures land as thread entries (§11 Blockers).
  specBusy: boolean
  stepsBusy: boolean
  stepsErr: { msg: string; detail?: string[] } | null
  // §11 "Previously resolved": the session's applied resolutions, stamped onto
  // new blockers entries so a fix that didn't take stays visible.
  resolved: string[]
  // §11: the draft's persisted last-test summary (test.yaml) — shown in the
  // Test card when no live test is in the store; replaced by the next test.
  lastTest: DraftTest | null
  viewing: 'draft' | number
  specSecOpen: boolean | null
  agSecOpen: boolean | null
  secSecOpen: boolean | null
  pkgSecOpen: boolean | null
  instrSecOpen: boolean | null
  notesSecOpen: boolean | null
  fwOpen: boolean
}

const revDefaults = {
  dirty: false, touched: false,
  specEdit: false, specText: '', specTextOrig: '',
  undo: null as Rev['undo'],
  instrEdit: false, instrDraft: null as string | null,
  notesEdit: false, notesDraft: null as string | null,
  pendingSync: false, pendingTest: null as Rev['pendingTest'],
  chat: [] as ChatEntry[],
  syncBusy: false, chatBusy: false,
  pkgBusy: false, genStage: null as string | null, genDetail: null as string | null,
  genEvents: [] as string[],
  specBusy: false, stepsBusy: false,
  stepsErr: null as Rev['stepsErr'],
  resolved: [] as string[],
  lastTest: null as DraftTest | null,
  viewing: 'draft' as Rev['viewing'],
  specSecOpen: null as boolean | null, agSecOpen: null as boolean | null, secSecOpen: null as boolean | null, pkgSecOpen: null as boolean | null, instrSecOpen: null as boolean | null, notesSecOpen: null as boolean | null, fwOpen: false,
}

// §11: the editor mounts on the create empty state — empty thread, placeholder
// cards; the first chat message starts the §8 create job (seedDrafting below).
export function seedEmpty(agents: Agent[], secretNames: string[]): Rev {
  return {
    ...revDefaults,
    name: 'New automation', description: '', note: '',
    spec: [], steps: [], params: [], packages: [],
    triggers: [],
    instructions: defaultBuildCache,
    notes: '',
    enabledAgents: agents.map((g) => g.id),
    allowedSecrets: secretNames,
  }
}

// §11 drafting-on-Review: the review pane empties the moment the create job
// starts — the spec card spins on call 1 and the right column shows skeletons
// until call 2 delivers. The thread survives (the caller carries it over).
export function seedDrafting(agents: Agent[], secretNames: string[]): Rev {
  return { ...seedEmpty(agents, secretNames), specBusy: true }
}

export function seedFromPayload(d: DraftPayload, agents: Agent[], secretNames: string[]): Rev {
  return {
    ...revDefaults,
    name: d.name || 'New automation', description: d.description || '', note: d.note || '',
    spec: d.spec ?? [], steps: d.steps ?? [], params: d.params ?? [],
    packages: d.packages ?? [],
    triggers: d.triggers ?? [],
    instructions: d.instructions ?? defaultBuildCache, // backend seeds instructions from default-build-instructions.md
    notes: d.notes ?? '',
    // §4.4: a resumed pending draft carries its grant selections; a fresh
    // drafting-job payload has none — default to everything enabled/allowed.
    enabledAgents: d.stepAgents
      ? d.stepAgents.filter((id) => agents.some((g) => g.id === id))
      : agents.map((g) => g.id),
    allowedSecrets: d.allowedSecrets ?? secretNames,
    lastTest: d.test ?? null,
    chat: d.chat ?? [],
  }
}

export function seedFromAuto(a: Automation, agents: Agent[], secretNames: string[]): Rev {
  const src: Pick<VersionInfo, 'spec' | 'steps' | 'instructions' | 'notes'> & { params?: VersionInfo['params']; packages?: VersionInfo['packages'] } =
    a.draft ?? {
      spec: a.spec ?? [], steps: a.steps ?? [], instructions: a.instructions || '', notes: a.notes || '',
      params: a.params,
      packages: a.packages,
    }
  return {
    ...revDefaults,
    name: a.name, description: a.description, note: '',
    spec: (src.spec ?? []).map((b) => ({ ...b })),
    steps: (src.steps ?? []).map((s) => ({ ...s })),
    params: (src.params ?? a.params ?? []).map((p) => ({ ...p })),
    packages: (src.packages ?? []).map((p) => ({ ...p })),
    triggers: (a.draft?.triggers ?? a.triggers).map(stripTrigger),
    instructions: src.instructions || '',
    notes: src.notes || '',
    // §4.4: a draft carries its own grant selections — resume restores them
    enabledAgents: (a.draft?.stepAgents ?? a.stepAgents).filter((id) => agents.some((x) => x.id === id)),
    allowedSecrets: (a.draft?.allowedSecrets ?? a.allowedSecrets).filter((n) => secretNames.includes(n)),
    lastTest: a.draft?.test ?? null,
    chat: a.draft?.chat ?? [],
    touched: !!a.draft,
  }
}

function loadVersionInto(r: Rev, snap: { spec: SpecBlock[]; steps: Step[]; instructions: string; notes?: string; params?: VersionInfo['params']; packages?: VersionInfo['packages'] }, viewing: Rev['viewing']): Rev {
  return {
    ...r,
    spec: (snap.spec ?? []).map((b) => ({ ...b })),
    steps: (snap.steps ?? []).map((s) => ({ ...s })),
    params: snap.params ? snap.params.map((p) => ({ ...p })) : r.params,
    packages: (snap.packages ?? []).map((p) => ({ ...p })),
    instructions: snap.instructions || '',
    notes: snap.notes || '',
    specEdit: false, specText: '', specTextOrig: '', undo: null, instrEdit: false, instrDraft: null,
    notesEdit: false, notesDraft: null, pendingSync: false, pendingTest: null,
    dirty: false, syncBusy: false, chatBusy: false,
    // A freshly loaded view is pristine — a stale carried-over `touched` would
    // make the §4.4 draft-keep paths persist this view's verbatim content over
    // a real draft.
    touched: false,
    resolved: [],
    viewing,
  }
}

// §4.4: which views' edits persist as the draft — the Draft view (an existing
// draft re-persists even untouched) or the current version's view when
// actually touched (§11: only old versions are read-only; untouched browsing
// must not clobber a real draft with the version's own content).
function holdsDraftEdits(r: Rev, a: Automation): boolean {
  if (r.viewing === 'draft') return r.touched || !!a.draft
  return r.viewing === a.version && r.touched
}

// §4.3 trigger merge: a sync's drafted crons take over the cron subset — an
// entry matching an existing cron on (expression, timezone) keeps its id and enabled state.
// Drafted message/app-start entries add only when no existing trigger matches
// their identity fields; existing non-cron triggers always survive.
// The §4.3 stored fields only — a stored Trigger's derived label/short/connection
// must not leak into a draft snapshot (§4.4 draft-only `triggers` key).
export function stripTrigger(t: Trigger | DraftTrigger): DraftTrigger {
  const base = { ...(t.id ? { id: t.id } : {}), enabled: t.enabled }
  switch (t.kind) {
    case 'cron': return { ...base, kind: 'cron', expression: t.expression, ...(t.timezone ? { timezone: t.timezone } : {}) }
    case 'time': return { ...base, kind: 'time', at: t.at, ...(t.timezone ? { timezone: t.timezone } : {}) }
    case 'app_start': return { ...base, kind: 'app_start' }
    case 'discord': return {
      ...base, kind: 'discord', channel: t.channel, secret: t.secret,
      ...(t.pattern ? { pattern: t.pattern } : {}), ...(t.mention ? { mention: true } : {}),
      ...(t.author?.length ? { author: t.author } : {}),
    }
    case 'imessage': return {
      ...base, kind: 'imessage', from: t.from,
      ...(t.pattern ? { pattern: t.pattern } : {}),
    }
  }
}
const isCron = (t: DraftTrigger): t is Extract<DraftTrigger, { kind: 'cron' }> => t.kind === 'cron'
function sameNonCron(a: DraftTrigger, b: DraftTrigger): boolean {
  if (a.kind === 'app_start' && b.kind === 'app_start') return true
  if (a.kind === 'imessage' && b.kind === 'imessage') {
    return a.from === b.from && (a.pattern ?? '') === (b.pattern ?? '')
  }
  if (a.kind === 'discord' && b.kind === 'discord') {
    return a.channel === b.channel && a.secret === b.secret
      && (a.pattern ?? '') === (b.pattern ?? '') && !!a.mention === !!b.mention
      && (a.author ?? []).join(',') === (b.author ?? []).join(',')
  }
  return false
}
export function mergeDraftTriggers(cur: DraftTrigger[], drafted: DraftTrigger[]): DraftTrigger[] {
  const crons = cur.filter(isCron)
  const used = new Set<number>()
  const next = drafted.filter(isCron).map((d) => {
    const i = crons.findIndex((c, j) => !used.has(j) && c.expression === d.expression && (c.timezone ?? '') === (d.timezone ?? ''))
    if (i < 0) return { ...d, enabled: true }
    used.add(i)
    return crons[i]
  })
  const added = drafted.filter((d) =>
    d.kind !== 'cron' && d.kind !== 'time' && !cur.some((c) => sameNonCron(c, d)))
  return [...next, ...cur.filter((t) => t.kind !== 'cron'), ...added.map((d) => ({ ...d, enabled: true }))]
}

export function serializeDraft(r: Rev): DraftPayload {
  return {
    name: r.name, description: r.description, note: r.note,
    params: r.params,
    packages: r.packages.map(({ pip, import: imp, why }) => ({ pip, import: imp, why })),
    steps: r.steps,
    spec: r.spec,
    instructions: r.instructions,
    notes: r.notes,
    triggers: r.triggers,
    stepAgents: r.enabledAgents,
    allowedSecrets: r.allowedSecrets,
    chat: persistChat(r.chat),
  }
}

// §11 chat-armed test values (§8 actions.yaml `test_values`) — merged into
// the panel's editors by name, tolerant of the yaml value shapes.
export function applyTestValues(ps: ParamDef[], vals: Record<string, unknown>): ParamDef[] {
  return ps.map((p) => {
    if (!(p.name in vals)) return p
    const v = vals[p.name]
    if (p.kind === 'toggle') return { ...p, on: !!v }
    if (p.kind === 'list') return { ...p, lines: Array.isArray(v) ? v.map(String) : [String(v)] }
    if (p.kind === 'kv') {
      if (Array.isArray(v)) return { ...p, rows: v as { key: string; value: string }[] }
      if (v && typeof v === 'object') return { ...p, rows: Object.entries(v as Record<string, unknown>).map(([key, val]) => ({ key, value: String(val) })) }
      return p
    }
    if (p.kind === 'number') return { ...p, value: typeof v === 'number' ? v : Number(v) || (p.min ?? 0) }
    return { ...p, value: String(v) }
  })
}

// ---------- step row (read-only agent + secret tags) ----------

function StepRow({ step, i, open, onToggle, availAgents, packages }: {
  step: Step; i: number; open: boolean; onToggle: () => void
  availAgents: Agent[]
  packages: PackageDep[]  // §6.2 declared packages — tagged when the step imports one
}) {
  // §4.1: one tag per entry in the step's `agents` list; an empty list falls
  // back to the automation's first enabled agent ("no agent" when none is).
  const agentTags: { nm: string | null; why?: string; ag: Agent | null }[] = step.agent
    ? ((step.agents ?? []).length
      ? (step.agents ?? []).map((e) => ({ nm: e.name, why: e.why, ag: availAgents.find((g) => agName(g) === e.name) ?? null }))
      : [{ nm: availAgents[0] ? agName(availAgents[0]) : null, ag: availAgents[0] ?? null }])
    : []
  const stepSecrets = stepSecretTags(step)
  const stepPkgs = packages.filter((p) => new RegExp(`\\b(?:import|from)\\s+${p.import}\\b`).test(step.code || ''))
  return (
    <div style={{ borderBottom: '1px solid var(--hairline-dim)' }}>
      <button
        className="ad-btn-bare ad-focus-inset ad-hover-row"
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ font: "600 13px var(--sans)" }}>
              <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>{i + 1}.</span> {step.name}
            </div>
            {agentTags.map(({ nm, why, ag }, j) => (
              <Tag
                key={j}
                title={ag
                  ? `This step calls ${agName(ag)} · ${dispModel(ag)} mid-execution${why ? ` — ${why}` : ''}`
                  : nm
                    ? `${nm} isn’t enabled for steps — this step would fail`
                    : 'No agent is enabled for steps — this step would fail'}
                icon="fa-microchip"
                c={ag ? 'var(--accent-hover)' : 'var(--red-text)'}
                style={{
                  background: ag ? 'var(--accent-chip-bg)' : 'var(--red-bg)',
                  border: `1px solid ${ag ? 'var(--border-card-hover)' : 'oklch(0.7 0.19 25 / .4)'}`,
                }}
              >
                {nm ?? 'no agent'}
              </Tag>
            ))}
            {stepSecrets.map((t) => (
              <Tag
                key={t.name}
                title={t.why || `This step uses the ${t.name} secret from your Keychain`}
                icon="fa-key" c="var(--text-muted)"
                style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
              >
                {t.name}
              </Tag>
            ))}
            {stepPkgs.map((p) => (
              <Tag
                key={p.import}
                title={`This step uses the ${p.import} Python package${p.version ? `, version ${p.version}` : ''} — installed automatically`}
                icon="fa-cube" c="var(--text-muted)"
                style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
              >
                {p.import}
              </Tag>
            ))}
            <Tag
              title={stepTimeoutTitle(step)}
              icon="fa-clock" c="var(--text-muted)"
              style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
            >
              {stepTimeoutLabel(step)}
            </Tag>
          </div>
          <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)' }}>{step.description}</div>
        </div>
        <span title={open ? 'Hide script' : 'View script'} style={{ color: 'var(--text-deco)', flex: 'none' }}>
          <Caret open={open} openDeg={0} closedDeg={90} style={{ fontSize: 12 }} />
        </span>
      </button>
      <Collapse open={open}>
        {step.agent && (
          <div style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid var(--hairline-dim)',
            background: 'var(--accent-hint-bg)', padding: '10px 20px',
          }}>
            <i className="fa-solid fa-microchip" style={{ color: 'var(--accent-hover)', fontSize: 10, marginTop: 3 }} />
            <span style={{ font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
              <span style={{ font: "500 11.5px var(--sans)", color: 'var(--text-2)' }}>Why an agent: </span>{step.why || ''}
            </span>
          </div>
        )}
        <PyCode code={step.code || '# script not written yet'} style={{
          margin: 0, background: 'var(--bg-code)', borderTop: '1px solid var(--hairline-dim)',
          padding: '12px 20px', font: "400 11.5px/1.75 var(--mono)", color: 'var(--code-text)',
          whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0,
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
function StepsList({ steps, availAgents, packages }: {
  steps: Step[]; availAgents: Agent[]; packages: PackageDep[]
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setOpen(new Set()), [steps])
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  return (
    <>
      {steps.map((s, i) => (
        <StepRow
          key={i} step={s} i={i}
          open={open.has(i)}
          onToggle={() => toggle(i)}
          availAgents={availAgents}
          packages={packages}
        />
      ))}
    </>
  )
}

// ---------- missing secret inline add ----------

function MissingSecretRow({ name, sub, onAdded }: { name: string; sub: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const showToast = useStore((s) => s.showToast)
  const add = async () => {
    if (!val.trim() || busy) return
    setBusy(true)
    try {
      await api.putSecret(name, val)
      showToast('Saved to your Keychain.')
      onAdded()
    } catch (e) {
      showToast((e as Error).message)
    }
    setBusy(false)
  }
  return (
    <div style={{ borderBottom: '1px solid var(--hairline-dim)' }}>
      <div
        className="ad-hover-row"
        onClick={() => setOpen(!open)}
        title={`Add ${name} to your Keychain`}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ width: 15, height: 15, borderRadius: 4, flex: 'none', border: '1px dashed oklch(0.7 0.19 25 / .5)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: "500 12px var(--mono)", color: 'var(--text)' }}>{name}</div>
          <div style={{ font: "400 11.5px var(--sans)", color: 'var(--text-muted)' }}>{sub}</div>
        </div>
        <span style={{
          display: 'inline-flex', padding: '3px 8px', borderRadius: 6, font: "600 10px var(--mono)",
          background: 'var(--red-bg)', border: '1px solid oklch(0.7 0.19 25 / .4)',
          color: 'var(--red-text)', flex: 'none', whiteSpace: 'nowrap',
        }}>
          add to Keychain
        </span>
      </div>
      {open && (
        <div className="ad-anim-item" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '0 20px 12px 47px' }}>
          <input
            className="ad-input"
            type="password" value={val} autoFocus placeholder="Value — goes straight to your Keychain"
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
            style={{ flex: 1, minWidth: 0, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px' }}
          />
          <BtnPrimary onClick={() => void add()} disabled={!val.trim() || busy}>
            Add secret
          </BtnPrimary>
        </div>
      )}
    </div>
  )
}

// ---------- param value editor (§4.2 kinds — create-mode card + §11 test values) ----------

function ParamEditor({ p, upd }: { p: ParamDef; upd: (patch: Record<string, unknown>) => void }) {
  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px',
  }
  if (p.kind === 'toggle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <Toggle on={!!p.on} onChange={(v) => upd({ on: v, default: v })} />
      </div>
    )
  }
  if (p.kind === 'list') {
    const lines = p.lines ?? []
    const setLines = (next: string[]) => upd({ lines: next, default: next })
    const good = lines.filter((l) => l.trim() && validUrl(l)).length
    const bad = lines.filter((l) => l.trim() && !validUrl(l)).length
    return (
      <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
        <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {lines.map((ln, li) => {
            const invalid = !!p.validate && ln.trim() !== '' && !validUrl(ln)
            return (
              <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className={`ad-input${invalid ? ' invalid' : ''}`}
                  value={ln}
                  onChange={(e) => setLines(lines.map((z, j) => (j === li ? e.target.value : z)))}
                  style={{ ...inputStyle, ...(invalid ? { color: 'var(--red-text)' } : {}) }}
                />
                {invalid && (
                  <MiniBadge c="var(--red-text)" bg="var(--red-bg)">NOT A VALID LINK</MiniBadge>
                )}
                <button className="ad-btn-x" onClick={() => setLines(lines.filter((_, j) => j !== li))}>
                  <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
                </button>
              </div>
            )
          })}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button className="ad-btn-dashed" onClick={() => setLines([...lines, ''])}>
              + Add line
            </button>
            {p.validate && (
              <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>
                {lines.length} lines · {good} valid links{bad > 0 ? ` · ${bad} needs attention` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }
  if (p.kind === 'kv') {
    const rows = p.rows ?? []
    const setRows = (next: { key: string; value: string }[]) => upd({ rows: next, default: next })
    return (
      <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
        <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, ri) => (
            <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className="ad-input"
                value={r.key} placeholder="Key"
                onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, key: e.target.value } : z)))}
                style={{ ...inputStyle, flex: '0 1 38%' }}
              />
              <input
                className="ad-input"
                value={r.value} placeholder="Value"
                onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, value: e.target.value } : z)))}
                style={inputStyle}
              />
              <button className="ad-btn-x" onClick={() => setRows(rows.filter((_, j) => j !== ri))}>
                <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
              </button>
            </div>
          ))}
          <button className="ad-btn-dashed" onClick={() => setRows([...rows, { key: '', value: '' }])}>
            + Add pair
          </button>
        </div>
      </div>
    )
  }
  if (p.kind === 'number') {
    const mn = p.min ?? 0
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <input
          className="ad-input"
          value={String(p.value ?? '')}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '')
            upd({ value: digits === '' ? '' : Number(digits), default: digits === '' ? mn : Number(digits) })
          }}
          onBlur={() => {
            const n = typeof p.value === 'number' ? p.value : NaN
            if (Number.isNaN(n) || n < mn) upd({ value: mn, default: mn })
          }}
          style={{ ...inputStyle, flex: 'none', width: 84, textAlign: 'right' }}
        />
      </div>
    )
  }
  // text
  return (
    <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid var(--hairline-dim)' }}>
      <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
      <input
        className="ad-input"
        value={String(p.value ?? '')} placeholder={p.placeholder}
        onChange={(e) => upd({ value: e.target.value, default: e.target.value })}
        style={{ ...inputStyle, width: '100%' }}
      />
    </div>
  )
}

// ---------- the page ----------

export default function CreateFlow() {
  const store = useStore()
  const { agents, secrets, automations, executions, executionFull, createFrom, automationId, go, setSurface, showToast, loadAuto, test, beginTest, clearTest } = store
  const isEdit = createFrom === 'edit'
  const auto = isEdit ? automations.find((a) => a.id === automationId) ?? null : null

  const [agentId, setAgentId] = useState<string | null>(() =>
    isEdit ? (auto?.agentId ?? null) : ((agents.find((g) => g.default) ?? agents[0])?.id ?? null))

  const jobIdRef = useRef<string | null>(null)
  // Cancel generation: bumped by every cancel path (and unmount). A POST-then-
  // poll flow captures it before the await; if it moved while the POST was in
  // flight, the flow cancels the freshly created job instead of arming the
  // poll — otherwise a cancel that lands mid-POST is silently ignored.
  const cancelGenRef = useRef(0)

  const [rev, setRev] = useState<Rev | null>(null)
  const [nameEdit, setNameEdit] = useState<string | null>(null)
  const [descEdit, setDescEdit] = useState<string | null>(null)
  // §11 chat pane input + the description that started the create job (Try
  // again / blocker answers re-run against it).
  const [chatText, setChatText] = useState('')
  const lastCreateRef = useRef('')
  // §11 test-setup section: the Test the draft disclosure toggle —
  // expanding shows every test option at once (param editors, trigger message,
  // the Run test row). Values survive a collapse; only Run test starts a test.
  const [testOpen, setTestOpen] = useState(false)
  // §11 test parameter values: seeded when the setup section first opens; the
  // values ride §19 `paramValues` and apply to this test only.
  const [testParams, setTestParams] = useState<ParamDef[] | null>(null)
  // §11 test trigger message: the mock rides §19 `triggerMock` only when the
  // message text is nonempty — an empty message runs the test without a payload.
  const [testMock, setTestMock] = useState<{ idx: number; text: string; sender: string } | null>(null)
  const [confirmSpecCancel, setConfirmSpecCancel] = useState(false)
  // §11 Secrets card New secret modal — a secret saved here is auto-allowed.
  const [secretModal, setSecretModal] = useState(false)
  const draftSnap = useRef<Rev | null>(null)
  const seededRef = useRef(false)

  // §4.4: any exit path keeps the draft — system back/forward unmounts the editor
  // without going through close(), so the persist lives in unmount cleanup.
  // Discard and save settle the draft so leaving afterwards writes nothing.
  // Create mode keeps to the pending slot (<root>/draft/) once a draft landed.
  const revRef = useRef(rev)
  revRef.current = rev
  const autoRef = useRef(auto)
  autoRef.current = auto
  const agentIdRef = useRef(agentId)
  agentIdRef.current = agentId
  const draftSettled = useRef(false)
  useEffect(() => () => {
    const r = revRef.current
    const a = autoRef.current
    if (draftSettled.current) return
    if (isEdit) {
      if (!a) return
      if (r && holdsDraftEdits(r, a)) {
        void api.putDraft(a.id, serializeDraft(r)).catch(() => { /* backend restarting */ })
      }
      return
    }
    if (r && !r.specBusy && (r.spec.length || r.steps.length)) {
      void api.putPendingDraft(serializeDraft(r), agentIdRef.current).catch(() => { /* backend restarting */ })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // §4.4 continuous persistence: once the draft holds anything worth keeping,
  // write it with a debounced PUT ~1 s after the last change — quitting the app
  // mid-edit loses nothing. The unmount save above stays the final flush;
  // settling (discard / save / create / start over) stops this writer.
  useEffect(() => {
    if (!rev || draftSettled.current) return
    const worthKeeping = isEdit
      ? !!auto && holdsDraftEdits(rev, auto)
      : !rev.specBusy && (rev.spec.length > 0 || rev.steps.length > 0)
    if (!worthKeeping) return
    const t = setTimeout(() => {
      if (draftSettled.current) return // settled after the timer armed — never write
      const r = revRef.current
      const a = autoRef.current
      if (!r) return
      if (isEdit) {
        if (a && holdsDraftEdits(r, a)) {
          void api.putDraft(a.id, serializeDraft(r)).catch(() => { /* backend restarting */ })
        }
        return
      }
      if (!r.specBusy && (r.spec.length || r.steps.length)) {
        void api.putPendingDraft(serializeDraft(r), agentIdRef.current).catch(() => { /* backend restarting */ })
      }
    }, 1000)
    return () => clearTimeout(t) // each change resets the timer (debounce) and unmount cancels it
  }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11: create mode mounts straight on the empty editor (empty thread,
  // placeholder cards). §4.4: while the pending slot holds a draft it resumes
  // over the untouched empty seed; a fast first message wins the race.
  // Opening also makes the slot's container exist (empty memory/) before any
  // drafting — §11 tests execute as execution records.
  useEffect(() => {
    if (isEdit) return
    setRev((r) => r ?? seedEmpty(agents, secrets.map((s) => s.name)))
    void api.openPendingDraft().catch(() => { /* backend restarting */ })
    let dead = false
    void api.getPendingDraft().then(({ draft, agentId: gid }) => {
      if (dead || !draft || seededRef.current) return
      const cur = revRef.current
      // Only the untouched empty seed may be replaced — never in-flight work.
      if (cur && (cur.touched || cur.specBusy || cur.stepsBusy || cur.chat.length > 0 || cur.spec.length > 0)) return
      seededRef.current = true
      const seeded = seedFromPayload(draft, agents, secrets.map((s) => s.name))
      // A draft kept mid-steps-generation resumes spec-only — mark it out of
      // sync so the §11 sync panel offers the rebuild.
      setRev({ ...seeded, touched: true, ...(seeded.steps.length || !seeded.spec.length ? {} : { dirty: true }) })
      if (gid && agents.some((g) => g.id === gid)) setAgentId(gid)
      showToast('Resumed your unsaved draft — Start over discards it.', 3400)
    }).catch(() => { /* backend restarting; the editor still works */ })
    return () => { dead = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const up = (patch: Partial<Rev>) => setRev((r) => (r ? { ...r, ...patch } : r))

  // ---- polling ----
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  const startPoll = (
    jobId: string,
    onDone: (d: DraftPayload) => void,
    onFail: (msg: string, detail?: string[]) => void,
    onCancelled?: () => void,
    onBlocked?: (blockers: Blocker[], at: 'spec' | 'steps' | 'chat', spec: SpecBlock[] | null, diagnosed: boolean) => void,
    onSpec?: (spec: SpecBlock[]) => void, // §11: create job's call-1 spec, mid-job
  ) => {
    stopPoll()
    jobIdRef.current = jobId
    let specDelivered = false
    let lastStage: string | null = null
    let lastDetail: string | null = null
    let lastEvKey = ''
    // Staleness guard: a slow in-flight tick may resolve after this job was
    // cancelled/replaced (jobIdRef changed) or after another tick already
    // handled the terminal status (jobIdRef cleared below). Checking the ref
    // covers both — callbacks fire once, and never against a different job.
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const j = await api.getDraftJob(jobId)
          if (jobIdRef.current !== jobId) return
          if (j.status !== 'building') jobIdRef.current = null
          // §8/§11: the job's live stage drives the skeleton + save-hint labels
          // ("Installing the packages…" after the steps land); `detail` is the
          // finer live-progress line under it, `events` the feed's history.
          const evs = j.events ?? []
          const evKey = evs.length ? `${evs.length}:${evs[evs.length - 1].text}` : ''
          if (j.status === 'building' && (j.stage !== lastStage || (j.detail ?? null) !== lastDetail || evKey !== lastEvKey)) {
            lastStage = j.stage
            lastDetail = j.detail ?? null
            lastEvKey = evKey
            const texts = evs.slice(-4).map((e) => e.text)
            setRev((r) => (r ? { ...r, genStage: j.stage, genDetail: lastDetail, genEvents: texts } : r))
          }
          if (onSpec && !specDelivered && j.status === 'building' && j.draft?.spec) {
            specDelivered = true
            onSpec(j.draft.spec)
          }
          if (j.status === 'done') {
            stopPoll()
            if (j.draft) onDone(j.draft)
            else onFail('The agent returned an empty draft.')
          } else if (j.status === 'blocked') {
            stopPoll()
            if (onBlocked) onBlocked(j.blockers ?? [], j.blockedAt ?? 'steps', j.draft?.spec ?? null, j.diagnosed ?? false)
            else onFail(j.error || 'Your AI hit a blocker.')
          } else if (j.status === 'failed') {
            stopPoll()
            onFail(j.error || '', j.errorDetail)
          } else if (j.status === 'cancelled') {
            stopPoll()
            onCancelled?.()
          }
        } catch (e) {
          if (jobIdRef.current !== jobId) return
          jobIdRef.current = null
          stopPoll()
          onFail((e as Error).message)
        }
      })()
    }, 700)
  }
  useEffect(() => () => {
    stopPoll()
    cancelGenRef.current++
    // Leaving the editor any way (sidebar nav, system back) must not orphan an
    // in-flight §8 drafting job — nobody would poll it and the harness would
    // keep working for a discarded result. Cancelling a finished job is a no-op.
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    // §11: a live test keeps executing — it's a real record, visible and
    // cancellable from its execution page; re-entering the editor re-attaches.
    useStore.getState().clearTest()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- guards + edit-mode seeding ----
  useEffect(() => {
    if (!isEdit && agents.length === 0) {
      setSurface('app')
      go('agents')
      showToast('No agent yet — add one here first. Creating and editing automations needs an AI.', 3600)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isEdit && automationId) void loadAuto(automationId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- instruction files (§8) — fetched once per app session ----
  const [fw, setFw] = useState<string>(fwCache ?? '')
  useEffect(() => {
    if (fwCache) return
    api.instructions()
      .then(({ framework, defaultBuild }) => {
        fwCache = framework
        defaultBuildCache = defaultBuild
        setFw(framework)
      })
      .catch(() => { /* panel renders empty; next mount retries */ })
  }, [])

  useEffect(() => {
    if (!isEdit || seededRef.current || !auto || !auto.spec) return
    seededRef.current = true
    setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
    if (auto.agentId) setAgentId(auto.agentId)
  }, [auto, isEdit, agents, secrets])

  const selAgent = agents.find((g) => g.id === agentId) ?? agents.find((g) => g.default) ?? agents[0] ?? null

  // ---- thread helpers ----
  const appendEntry = (e: Omit<ChatEntry, 'id' | 'at'>) =>
    setRev((r) => (r ? { ...r, chat: [...r.chat, newEntry(e)] } : r))
  const patchEntry = (id: string, patch: Partial<ChatEntry>) =>
    setRev((r) => (r ? { ...r, chat: r.chat.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : r))

  // ---- create job (§11: the first chat message drafts the automation) ----
  // The review pane empties right away; the spec card spins on call 1, renders
  // the spec the moment it validates (onSpec, mid-job), and the right column
  // stays skeleton until call 2 delivers the steps. The thread survives.
  const createEntryRef = useRef<string | null>(null)
  const submitCreate = async (request: string) => {
    lastCreateRef.current = request
    setNameEdit(null)
    setDescEdit(null)
    setRev((r) => ({
      ...seedDrafting(agents, secrets.map((s) => s.name)),
      chat: r?.chat ?? [], resolved: r?.resolved ?? [],
    }))
    const gen = cancelGenRef.current
    try {
      const { jobId } = await api.postDraftJob({ mode: 'create', text: request, agentId })
      if (cancelGenRef.current !== gen) { void api.cancelDraftJob(jobId).catch(() => { /* already gone */ }); return }
      startPoll(
        jobId,
        (d) => setRev((r) => ({
          ...seedFromPayload(d, agents, secrets.map((s) => s.name)),
          chat: [...(r?.chat ?? []), newEntry({ kind: 'system', text: 'Draft generated — review the spec and steps, then create it.' })],
          resolved: r?.resolved ?? [],
          // §11 title: the manifest name replaces the spec-title provisional
          name: d.name || (d.spec ?? []).find((b) => b.kind === 'h1')?.text || 'New automation',
        })),
        (msg, detail) => setRev((r) => r && (r.specBusy
          ? {
            // §11: a spec-call failure lands in the thread — red-tinted error
            // entry with Try again (the description also returns to the input).
            ...r, specBusy: false,
            chat: [...r.chat, newEntry({ kind: 'error', source: 'spec', text: msg || 'The spec didn’t validate — try again or rephrase.' })],
          }
          : { ...r, stepsBusy: false, stepsErr: { msg, detail } })),
        () => setRev((r) => r && ({ ...seedEmpty(agents, secrets.map((s) => s.name)), chat: r.chat })),
        // §11 Blockers: a spec-call block is the clarification case, a
        // steps-call block leaves the workflow out of sync — both land as
        // thread blockers entries.
        (blockers, at, spec, diagnosed) => setRev((r) => r && (at === 'spec'
          ? {
            ...r, specBusy: false, stepsBusy: false,
            chat: [...r.chat, newEntry({ kind: 'blockers', source: 'spec', blockers, diagnosed, resolved: r.resolved })],
          }
          : {
            ...r, stepsBusy: false, spec: spec ?? r.spec, dirty: true,
            chat: [...r.chat, newEntry({ kind: 'blockers', source: 'steps', blockers, diagnosed, resolved: r.resolved })],
          })),
        (spec) => setRev((r) => r && ({
          ...r, specBusy: false, stepsBusy: true, spec,
          name: spec.find((b) => b.kind === 'h1')?.text || r.name,
        })),
      )
    } catch (e) {
      setRev((r) => r && ({
        ...r, specBusy: false,
        chat: [...r.chat, newEntry({ kind: 'error', source: 'spec', text: (e as Error).message })],
      }))
    }
  }

  // §11 clarification case: the user answers spec-call blockers by editing the
  // entry's cards; the answers join the description and a new create job
  // starts in place. Chat-source blockers answer as a fresh chat message.
  const answerBlockersEntry = (entry: ChatEntry) => {
    const blockers = entry.blockers ?? []
    if (blockers.some((b) => !b.reason.trim() || !b.fix.trim())) return
    patchEntry(entry.id, { dismissed: true })
    const answers = blockers.map(blockerLine).join('\n')
    if (entry.source === 'chat') {
      void sendChat(answers)
      return
    }
    appendEntry({ kind: 'user', text: answers })
    void submitCreate(`${lastCreateRef.current.trim()}\n\n${answers}`)
  }

  // §11 Start over (create): cancel any job, discard the pending slot (thread
  // included), return to the empty state with the description in the input.
  const resetCreate = () => {
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    // §4.4: Start over discards the pending slot.
    void api.deletePendingDraft().catch(() => { /* none kept */ })
    setNameEdit(null)
    setDescEdit(null)
    setRev(seedEmpty(agents, secrets.map((s) => s.name)))
    setChatText((cur) => cur || lastCreateRef.current)
  }

  // §11: any spec / instruction / agent-ask / grant change while the steps are
  // still generating cancels the in-flight steps call — the landed spec is
  // kept and the standard sync panel rebuilds the steps. Returns true when a
  // steps call was cancelled (callers add stepsBusy:false + dirty to their patch).
  const cancelStepsGen = (): boolean => {
    if (!rev?.stepsBusy) return false
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    return true
  }

  // ---- review: derived ----
  const availAgents = rev ? rev.enabledAgents.map((id) => agents.find((g) => g.id === id)).filter((g): g is Agent => !!g) : []
  // §4.1: a step's callable agents — its named grants resolved against the
  // enabled agents, falling back to the first enabled agent when none named.
  const resolveAgs = (s: Step): Agent[] => {
    const named = (s.agents ?? []).map((e) => availAgents.find((g) => agName(g) === e.name)).filter((g): g is Agent => !!g)
    return named.length ? named : availAgents.slice(0, 1)
  }
  const agentStepIdx = rev ? rev.steps.map((s, i) => (s.agent ? i : -1)).filter((i) => i >= 0) : []
  // §11: per-name agent references — which steps name which agent, mirroring secRefs.
  const agRefs = (() => {
    const refs: { name: string; steps: number[] }[] = []
    if (rev) rev.steps.forEach((s, i) => {
      if (!s.agent) return
      for (const { name: nm } of s.agents ?? []) {
        const r = refs.find((x) => x.name === nm)
        r ? r.steps.push(i) : refs.push({ name: nm, steps: [i] })
      }
    })
    return refs
  })()
  const agNotEnabled = agRefs.filter((r) => agents.some((g) => agName(g) === r.name) && !availAgents.some((g) => agName(g) === r.name))
  const agMissing = agRefs.filter((r) => !agents.some((g) => agName(g) === r.name))
  // steps with no named agent fall back to the first enabled agent — they only
  // warn when nothing is enabled at all
  const agFallbackIdx = rev ? agentStepIdx.filter((i) => !(rev.steps[i].agents ?? []).length) : []
  const agNone = !!rev && agFallbackIdx.length > 0 && availAgents.length === 0
  // Memoized: this regex-scans every step's code and would otherwise re-run on
  // every keystroke anywhere in the editor.
  const secRefs = React.useMemo(() => (rev ? secretRefsOf(rev.steps) : []), [rev?.steps])
  const secNotAllowed = secRefs.filter((r) => secrets.some((z) => z.name === r.name) && !(rev?.allowedSecrets ?? []).includes(r.name))
  const secMissing = secRefs.filter((r) => !secrets.some((z) => z.name === r.name))
  const agWarn = !!rev && (agNone || agNotEnabled.length > 0 || agMissing.length > 0)
  const secWarn = !!rev && (secNotAllowed.length > 0 || secMissing.length > 0)
  // §11 dirty gating: grant sync state is derived, never stored — the workflow
  // is out of sync from grants exactly while a step needs a grant it doesn't
  // have. Re-checking the grant clears it instantly; toggles alone never dirty.
  const agentGap = !!rev && agentStepIdx.some((i) => {
    const s = rev.steps[i]
    const names = (s.agents ?? []).map((e) => e.name)
    return names.length
      ? names.some((nm) => !availAgents.some((g) => agName(g) === nm))
      : rev.enabledAgents.length === 0
  })
  const secretGap = secNotAllowed.length > 0
  // §11: the spec card defaults open and is force-open while the spec is
  // writing or being edited; the agents and secrets cards default collapsed
  // and are forced open while their warnings show (Packages pattern).
  const specOpenEff = !!rev?.specEdit || !!rev?.specBusy
    || ((rev?.specSecOpen ?? null) == null ? true : !!rev?.specSecOpen)
  const agSecOpenEff = !!rev?.agSecOpen || agWarn
  const secSecOpenEff = !!rev?.secSecOpen || secWarn
  // §11 Packages card: default collapsed when everything is installed; forced
  // open while any row is installing, not installed, or failed.
  const pkgProblem = !!rev && rev.packages.some((p) => p.status && p.status !== 'installed')
  const pkgSecOpenEff = (((rev?.pkgSecOpen ?? null) == null ? pkgProblem : !!rev?.pkgSecOpen) || pkgProblem || !!rev?.pkgBusy)
  // §11 BUILD INSTRUCTIONS card: defaults collapsed in create and edit alike
  const instrOpenEff = !!rev?.instrSecOpen
  // §11 NOTES card: defaults collapsed; forced open while being edited
  const notesOpenEff = !!rev?.notesEdit || (((rev?.notesSecOpen ?? null) == null) ? false : !!rev?.notesSecOpen)
  const viewingOld = isEdit && !!rev && !!auto && rev.viewing !== 'draft' && rev.viewing !== auto.version
  // §5: permissions are never versioned — a grant gap never blocks restoring an
  // old version; it fails at execution time instead (the cards still warn).
  const outOfSync = !!rev && (rev.dirty || (!viewingOld && (agentGap || secretGap)))
  const drafting = !!rev && (rev.specBusy || rev.stepsBusy)
  const saveBlocked = !!rev && (outOfSync || rev.syncBusy || rev.chatBusy || rev.specEdit
    || drafting || (!isEdit && rev.steps.length === 0))
  const busyRewrite = !!rev && (rev.syncBusy || rev.chatBusy)
  // §11: one agent job at a time — the chat input and every job starter gate on this.
  const anyJobBusy = !!rev && (rev.specBusy || rev.stepsBusy || rev.syncBusy || rev.chatBusy)
  // §11: the tracked test is an ordinary execution record — steps/status render
  // off it (executionFull carries the body; the header list covers the gap before
  // loadExecution lands).
  const testExec = test ? executionFull[test.executionId] ?? executions.find((e) => e.id === test.executionId) : undefined
  const testLive = testExec?.status === 'executing'
  // Sync panel: the button disables (never hides) while any §8 job runs, while
  // drafting, while viewing an old version, while a draft test is executing
  // (§11 rewrites-lock: nothing rewrites the workflow under a running test),
  // and while steps AND spec are both
  // empty — a spec-only draft (cancelled steps generation, resumed spec-only
  // pending draft) must always be able to rebuild its steps here (§11).
  const syncDisabled = !rev || busyRewrite || drafting || viewingOld || testLive
    || (rev.steps.length === 0 && rev.spec.length === 0)
  // §11 inputs-lock: while a sync or spec rewrite runs, every input disables —
  // buttons get `disabled`, non-button rows get this style. One shared look.
  const lockStyle: React.CSSProperties | undefined = busyRewrite ? { opacity: 0.45, pointerEvents: 'none' } : undefined
  // §11 title rename — hidden while any job runs and, in edit mode, while
  // viewing anything but the draft (Restore never renames).
  const canRename = !!rev && !drafting && !busyRewrite && (!isEdit || rev.viewing === 'draft')
  // Create mode: the spec `#` title stands in until the manifest name lands (§11)
  const draftName = !rev ? ''
    : !isEdit && rev.name === 'New automation' && rev.spec.find((b) => b.kind === 'h1')?.text
      ? rev.spec.find((b) => b.kind === 'h1')!.text
      : rev.name
  const titleText = !rev ? ''
    : !isEdit && rev.specBusy ? 'New automation…' : draftName
  const commitTitleRename = () => {
    const name = (nameEdit ?? '').trim()
    setNameEdit(null)
    if (!rev || !name || name === rev.name) return
    up({ name })
    // Edit mode: name is user-owned identity (§4.1) — it applies immediately
    // via PATCH, never rides the draft or waits for Save.
    if (isEdit && auto) void api.patchAutomation(auto.id, { name }).catch((e) => showToast((e as Error).message))
  }
  // §11 lede: the automation's description — same identity rules as the name, but a
  // blank commit clears it (description is optional, §4.1).
  const commitDescEdit = () => {
    const description = (descEdit ?? '').trim()
    setDescEdit(null)
    if (!rev || description === rev.description) return
    up({ description })
    if (isEdit && auto) void api.patchAutomation(auto.id, { description }).catch((e) => showToast((e as Error).message))
  }
  // Build & test panel stage label — §11 drafting stages
  const installingPkgs = rev?.genStage === 'Installing the packages'
  const stageLabel = rev?.specBusy ? 'Waiting for the spec…'
    : installingPkgs ? 'Installing the packages…' : 'Generating the steps…'

  // ---- review: chat + sync jobs ----
  const currentSerialized = () => (rev ? serializeDraft(rev) : null)

  // §11: a chat message starts one §8 `chat` job — the drafting agent gets the
  // in-editor draft (spec + steps + build instructions + notes), the grants
  // context, and the recent thread; the backend adds the RECENT RUNS and
  // PACKAGES context itself. One response may combine an answer with rewrites
  // (spec / build instructions / notes) and follow-up actions (sync, test,
  // rename) — applied in that order (§11), with the sync/test chain armed as
  // pending flags a watcher effect fires.
  const chatReqRef = useRef<{ text: string; entryId: string } | null>(null)
  const sendChat = async (textArg?: string, runId?: string) => {
    if (!rev || anyJobBusy || testLive || viewingOld) return
    const request = (textArg ?? chatText).trim()
    if (!request) return
    if (textArg === undefined) setChatText('')
    const entry = newEntry({ kind: 'user', text: request })
    chatReqRef.current = { text: request, entryId: entry.id }
    // §8 undo action: inputs lock while the job runs, so the snapshot at send
    // time is the snapshot at apply time — decides the restore toast below
    const hadSnap = !!rev.undo
    const history = persistChat(rev.chat) // the thread BEFORE this message
    const current = currentSerialized()
    const genCancelled = cancelStepsGen()
    setRev((r) => r && ({
      ...r,
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // one edit at a time
      notesDraft: null, notesEdit: false,
      chat: [...r.chat, entry],
      chatBusy: true, genStage: null, genDetail: null, genEvents: [], touched: true,
      ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
    }))
    const gen = cancelGenRef.current
    try {
      const { jobId } = await api.postDraftJob({
        mode: 'chat', text: request, ...(isEdit && auto ? { automationId: auto.id } : {}),
        ...(runId ? { runId } : {}),
        agentId, current, chat: history,
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      if (cancelGenRef.current !== gen) { void api.cancelDraftJob(jobId).catch(() => { /* already gone */ }); return }
      startPoll(
        jobId,
        (d) => {
          const actions = d.actions ?? {}
          const rewrote = !!d.spec || d.instructions != null || d.notes != null
          const empty = !d.answer && !rewrote && !d.actions
          setRev((r) => {
            if (!r) return r
            let next: Rev = { ...r, chatBusy: false }
            const chat = [...r.chat]
            if (d.answer) chat.push(newEntry({ kind: 'answer', text: d.answer }))
            // §8 undo action: arrives alone (validation) — run the §11
            // restore exactly like the undo row's button, or say there is
            // nothing left to undo
            if (actions.undo) {
              const snap = r.undo
              if (snap) {
                next = {
                  ...next,
                  spec: snap.spec, steps: snap.steps, params: snap.params, packages: snap.packages,
                  triggers: snap.triggers, instructions: snap.instructions, notes: snap.notes,
                  dirty: snap.dirty, undo: null,
                }
                chat.push(newEntry({ kind: 'system', text: 'Last change undone — the rewrites above no longer apply.' }))
              } else {
                chat.push(newEntry({ kind: 'system', text: 'Nothing to undo.' }))
              }
            }
            // §11 draft undo: a draft-changing response stashes the full
            // pre-request draft as one snapshot, anchored to the LAST
            // document entry it appends — the standalone undo row renders
            // directly beneath it
            let anchorId: string | null = null
            if (d.spec) {
              const entry = newEntry({ kind: 'rewrite', text: request })
              anchorId = entry.id
              next = { ...next, spec: d.spec, dirty: true }
              chat.push(entry)
            }
            if (d.instructions != null && d.instructions !== r.instructions) {
              const entry = newEntry({ kind: 'system', text: 'Build instructions updated.' })
              anchorId = entry.id
              // like a manual Build-instructions save — same dirty gating (§11)
              next = { ...next, instructions: d.instructions, dirty: true }
              chat.push(entry)
            }
            if (d.notes != null && d.notes !== r.notes) {
              const entry = newEntry({ kind: 'system', text: 'Notes updated.' })
              anchorId = entry.id
              // notes never mark the workflow out of sync (§4.1)
              next = { ...next, notes: d.notes }
              chat.push(entry)
            }
            if (actions.name && actions.name !== r.name) {
              const entry = newEntry({ kind: 'system', text: `Renamed to “${actions.name}”.` })
              if (anchorId) anchorId = entry.id // the row sits below every chip the request produced
              next = { ...next, name: actions.name }
              chat.push(entry)
            }
            if (actions.description && actions.description !== r.description) {
              const entry = newEntry({ kind: 'system', text: 'Description updated.' })
              if (anchorId) anchorId = entry.id
              next = { ...next, description: actions.description }
              chat.push(entry)
            }
            // an answer-only response leaves the existing snapshot untouched
            if (anchorId) {
              next = {
                ...next,
                undo: {
                  spec: r.spec, steps: r.steps, params: r.params, packages: r.packages,
                  triggers: r.triggers, instructions: r.instructions, notes: r.notes,
                  dirty: r.dirty, entryId: anchorId,
                },
              }
            }
            if (empty) chat.push(newEntry({ kind: 'error', text: 'The agent returned an empty response.' }))
            // §11 action chaining: arm the sync/test pendings; the watcher
            // effect below fires them against fresh state.
            if (actions.sync || (actions.test && next.dirty)) next = { ...next, pendingSync: true }
            if (actions.test) next = { ...next, pendingTest: { values: actions.testValues ?? null } }
            return { ...next, chat, touched: true }
          })
          // §4.1: name/description are user-owned identity — edit mode applies them
          // immediately via PATCH, exactly like the pencil edits.
          if (isEdit && auto && (actions.name || actions.description)) {
            void api.patchAutomation(auto.id, {
              ...(actions.name ? { name: actions.name } : {}),
              ...(actions.description ? { description: actions.description } : {}),
            }).catch((e) => showToast((e as Error).message))
          }
          if (d.spec && !actions.sync && !actions.test) {
            showToast('Spec updated — the workflow is out of sync. Sync the steps before saving.', 5800)
          }
          if (actions.undo && hadSnap) showToast('Last change undone.', 3200)
        },
        (msg) => setRev((r) => r && ({
          ...r, chatBusy: false,
          chat: [...r.chat, newEntry({ kind: 'error', text: msg || 'The request failed — try again or rephrase.' })],
        })),
        () => setRev((r) => r && ({ ...r, chatBusy: false })),
        // §11: a blocked chat call lands as a blockers entry — draft untouched.
        (blockers, _at, _spec, diagnosed) => setRev((r) => r && ({
          ...r, chatBusy: false,
          chat: [...r.chat, newEntry({ kind: 'blockers', source: 'chat', blockers, diagnosed, resolved: r.resolved })],
        })),
      )
    } catch (e) {
      setRev((r) => r && ({
        ...r, chatBusy: false,
        chat: [...r.chat, newEntry({ kind: 'error', text: (e as Error).message })],
      }))
    }
  }

  // §11 chat input send: with no spec or steps yet (fresh create), the message
  // is the description and starts the create job; otherwise it's a chat job.
  const sendMessage = () => {
    if (!rev || anyJobBusy || testLive || viewingOld) return
    const request = chatText.trim()
    if (!request) return
    const isCreate = !isEdit && rev.spec.length === 0 && rev.steps.length === 0
    if (!isCreate) { void sendChat(); return }
    setChatText('')
    const entry = newEntry({ kind: 'user', text: request })
    createEntryRef.current = entry.id
    setRev((r) => r && ({ ...r, chat: [...r.chat, entry] }))
    void submitCreate(request)
  }

  // §11 draft undo: restore the full pre-request snapshot — the draft looks
  // exactly as it did before the last agent request, chained-sync step
  // rewrites included. Grant sync state is derived, so an intervening
  // agent/secret change keeps its own out-of-sync state regardless.
  const undoDraft = () => {
    setRev((r) => {
      if (!r || !r.undo) return r
      const snap = r.undo
      return {
        ...r,
        spec: snap.spec, steps: snap.steps, params: snap.params, packages: snap.packages,
        triggers: snap.triggers, instructions: snap.instructions, notes: snap.notes,
        dirty: snap.dirty, undo: null, touched: true,
        // §11: the thread records the rollback — persisted, so the agent's §8
        // CONVERSATION context never assumes the undone rewrites still stand
        chat: [...r.chat, newEntry({ kind: 'system', text: 'Last change undone — the rewrites above no longer apply.' })],
      }
    })
    showToast('Last change undone.', 3200)
  }

  // §11: a blocked sync lands as a thread blockers entry (source: sync);
  // applying amends the in-editor spec (specOverride) and repeats the sync with it.
  const runSync = async (specOverride?: SpecBlock[]) => {
    // §11 rewrites-lock: nothing rewrites the workflow under a running test
    if (!rev || anyJobBusy || testLive) return
    // A cancel must return the panel to the state it was in (§11) — a sync
    // started from a clean draft must not leave it marked out-of-sync.
    dirtyBeforeSync.current = rev.dirty
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // discard unsaved edits
      notesDraft: null, notesEdit: false,
      syncBusy: true, genStage: null, genDetail: null, genEvents: [], touched: true, stepsErr: null,
      // §11 draft undo: a repair amend replaces the spec outside the undo flow
      ...(specOverride ? { spec: specOverride, undo: null } : {}),
    })
    const gen = cancelGenRef.current
    try {
      const { jobId } = await api.postDraftJob({
        mode: 'sync', ...(isEdit && auto ? { automationId: auto.id } : {}),
        agentId, current: { ...serializeDraft(rev), spec: specOverride ?? rev.spec },
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      if (cancelGenRef.current !== gen) { void api.cancelDraftJob(jobId).catch(() => { /* already gone */ }); return }
      startPoll(
        jobId,
        (d) => {
          setRev((r) => {
            if (!r) return r
            const steps = d.steps ?? r.steps
            const syncedEntry = newEntry({ kind: 'system', text: 'Steps synced with the spec.' })
            const notesEntry = d.notes != null && d.notes !== r.notes
              ? newEntry({ kind: 'system' as const, text: 'Notes updated.' }) : null
            // §8: the manifest's name/description are create-only — a sync never
            // touches them (both are user-owned identity, §4.1).
            return {
              // §11 draft undo: a completed sync keeps the snapshot — Undo
              // reverts the whole request, chained-sync steps included — and
              // re-anchors the undo row below the sync's own chips
              ...r, syncBusy: false, genStage: null, dirty: false,
              undo: r.undo ? { ...r.undo, entryId: (notesEntry ?? syncedEntry).id } : r.undo,
              steps, params: d.params ?? r.params, packages: d.packages ?? [],
              triggers: d.triggers ? mergeDraftTriggers(r.triggers, d.triggers) : r.triggers,
              // §8: call 2 may return an updated notes.md beside the manifest
              ...(d.notes != null && d.notes !== r.notes ? { notes: d.notes } : {}),
              // §11: a completed sync collapses any pending blockers entry —
              // its blockers describe steps that no longer exist — and lands
              // a quiet system chip in the thread.
              chat: [
                ...r.chat.map((e) => (e.kind === 'blockers' && !e.dismissed ? { ...e, dismissed: true } : e)),
                syncedEntry,
                ...(notesEntry ? [notesEntry] : []),
              ],
            }
          })
          showToast('Steps synced with the spec — review them, then save.', 3600)
        },
        (msg) => {
          setRev((r) => r && ({ ...r, syncBusy: false }))
          showToast(`The draft didn’t validate — try again or rephrase.${msg ? ' ' + msg : ''}`, 4500)
        },
        () => setRev((r) => r && ({ ...r, syncBusy: false })),
        (blockers, _at, _spec, diagnosed) => setRev((r) => r && ({
          ...r, syncBusy: false,
          chat: [...r.chat, newEntry({ kind: 'blockers', source: 'sync', blockers, diagnosed, resolved: r.resolved })],
        })),
      )
    } catch (e) {
      up({ syncBusy: false })
      showToast((e as Error).message)
    }
  }

  // §11 Packages card: check statuses once per package list (§19 /packages/check,
  // fast, no pip) — a saved automation whose packages went missing shows
  // "not installed" without waiting for an execution to self-heal.
  // The keys carry the transient-field presence too: switching versions resets
  // statuses/badges without changing the pip list, and must re-trigger the
  // fetch — a pip-only key would leave every row on "checking…" forever.
  const pkgKey = rev ? rev.packages.map((p) => `${p.pip}\t${p.status ? 1 : 0}`).join('\n') : ''
  const pkgOutdatedKey = rev ? rev.packages.map((p) => `${p.pip}\t${p.latest ? 1 : 0}`).join('\n') : ''
  useEffect(() => {
    if (!rev || rev.packages.length === 0 || !rev.packages.some((p) => !p.status)) return
    let stale = false
    void api.checkPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return p.status || !c ? p : { ...p, status: c.status, version: c.version }
          }),
        }))
      })
      .catch(() => { /* statuses stay unknown; the engine still ensures at execution (§7) */ })
    return () => { stale = true }
  }, [pkgKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 update badges: one read-only PyPI check per package list (§19
  // /packages/outdated) — advisory, a failure just leaves the badges off.
  useEffect(() => {
    if (!rev || rev.packages.length === 0) return
    let stale = false
    void api.outdatedPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return c ? { ...p, latest: c.latest } : p
          }),
        }))
      })
      .catch(() => { /* badges stay off */ })
    return () => { stale = true }
  }, [pkgOutdatedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 Update / Update all — pip install --upgrade in the shared
  // directory; no manifest writes, the installed version is the truth. The
  // new version applies to every automation using the package.
  const updatePkgs = async (pips: string[]) => {
    if (!rev || rev.pkgBusy) return
    const targets = rev.packages.filter((p) => p.latest && pips.includes(p.pip))
    if (targets.length === 0) return
    const before = rev.packages
    const list = targets.map(({ pip, import: imp }) => ({ pip, import: imp }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (targets.includes(p) ? { ...p, status: 'installing' as const, error: undefined } : p)),
    })
    try {
      const { packages } = await api.updatePackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => {
          const c = p.status === 'installing' && packages.find((z) => z.pip === p.pip)
          // merge onto the row — the §19 response carries no `why`
          return c ? { ...p, ...c, latest: undefined } : p
        }),
      }))
      showToast('Updated — the new version applies to every automation using the package.', 3600)
    } catch (e) {
      setRev((r) => r && ({ ...r, pkgBusy: false, packages: before }))
      showToast((e as Error).message)
    }
  }

  // §11: Install / Retry on the Packages card — the blocking §19 ensure; rows
  // show spinners while it runs. An install failure never blocks saving (§6.2).
  const installPkgs = async () => {
    if (!rev || rev.pkgBusy) return
    const list = rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (p.status === 'installed' ? p : { ...p, status: 'installing' as const, error: undefined })),
    })
    try {
      const { packages } = await api.installPackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => {
          const c = packages.find((z) => z.pip === p.pip)
          // merge onto the row — the §19 response carries no `why`
          return c ? { ...p, ...c } : p
        }),
      }))
    } catch (e) {
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => (p.status === 'installing' ? { ...p, status: 'missing' as const } : p)),
      }))
      showToast((e as Error).message)
    }
  }

  // §11: Cancel on the footer action block — kill the running job. A chat
  // cancel drops the pending user entry and returns the text to the input; a
  // create cancel returns to the empty state (spec call) or keeps the landed
  // spec out of sync (steps call).
  const cancelChat = () => {
    if (!rev?.chatBusy) return
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    const req = chatReqRef.current
    chatReqRef.current = null
    setRev((r) => r && ({
      ...r, chatBusy: false,
      chat: req ? r.chat.filter((e) => e.id !== req.entryId) : r.chat,
    }))
    if (req) setChatText((cur) => cur || req.text)
    showToast('Edit stopped — the spec is unchanged.', 4200)
  }
  const cancelCreate = () => {
    if (!rev) return
    if (rev.stepsBusy) {
      // steps call only — the landed spec is kept and sync rebuilds later
      if (cancelStepsGen()) up({ stepsBusy: false, dirty: true })
      return
    }
    if (!rev.specBusy) return
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    const entryId = createEntryRef.current
    createEntryRef.current = null
    setRev((r) => r && ({
      ...seedEmpty(agents, secrets.map((s) => s.name)),
      chat: entryId ? r.chat.filter((e) => e.id !== entryId) : r.chat,
    }))
    setChatText((cur) => cur || lastCreateRef.current)
  }

  // §11: sync Cancel (footer action block) — kill the job, keep the steps
  // and spec untouched, return the panel to the state it was in before.
  const dirtyBeforeSync = useRef(false)
  const cancelSync = () => {
    if (!rev?.syncBusy) return
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
    const wasDirty = dirtyBeforeSync.current
    setRev((r) => r && ({ ...r, syncBusy: false, dirty: wasDirty }))
    showToast(wasDirty
      ? 'Sync stopped — the workflow is still out of sync.'
      : 'Sync stopped — nothing changed.', 4200)
  }

  // §14 overlay-scrollbar thumb for the spec editor textarea (a textarea can't
  // host the thumb node itself, so the pane wires it up via this hook).
  const specThumb = useOverlayThumb()
  const instrThumb = useOverlayThumb()

  // §11 thread auto-scroll: newest at the bottom, scrolled on new content.
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatLen = rev?.chat.length ?? 0
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLen])

  // Chat-input auto-grow (ask-box pattern). Runs when the text changes and once
  // when the textarea attaches (it mounts after `rev` loads and again whenever a
  // job's busy footer swaps back to the input, so the mount-time effect pass
  // misses it — an unsized box would then jump on the first keystroke). Pins the
  // thread's scrollTop across the transient height:auto collapse, which
  // otherwise clamps the thread upward while typing.
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null)
  const sizeChatInput = () => {
    const el = chatInputRef.current
    if (!el) return
    const sc = chatScrollRef.current
    const keep = sc?.scrollTop ?? 0
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (sc) sc.scrollTop = keep
  }
  const attachChatInput = useCallback((el: HTMLTextAreaElement | null) => {
    chatInputRef.current = el
    if (el) sizeChatInput()
  }, [])
  useLayoutEffect(() => { sizeChatInput() }, [chatText])

  // §11 blockers-entry apply — same door for every non-clarification source:
  // write the edited cards into the spec's "Constraints & resolutions"
  // section, collapse the entry, then sync the steps.
  const applyBlockersEntry = (entry: ChatEntry) => {
    if (!rev) return
    const blockers = entry.blockers ?? []
    if (blockers.some((b) => !b.reason.trim() || !b.fix.trim())) return
    setRev((r) => r && ({
      ...r,
      resolved: [...r.resolved, ...blockers.map(blockerLine)],
      chat: r.chat.map((e) => (e.id === entry.id ? { ...e, dismissed: true } : e)),
    }))
    void runSync(amendSpec(rev.spec, blockers))
  }

  // §7/§9.2 Fix with AI: the editor opened from a failed execution seeds the
  // thread with the failure and sends the §11 canned analyze chat message —
  // an ordinary §8 chat job whose RECENT RUNS context carries this execution
  // in full detail (§19 runId). While another job is already in flight only
  // the seed lands; the user asks when it settles.
  const fixConsumed = useRef(false)
  useEffect(() => {
    if (!rev || fixConsumed.current) return
    const fx = useStore.getState().fixExec
    if (!fx) return
    fixConsumed.current = true
    useStore.setState({ fixExec: null })
    const ex = executionFull[fx] ?? executions.find((e) => e.id === fx)
    const failure = ex?.error
      ? `Execution failed at step ${ex.error.step ?? '?'} — ${ex.error.message}`
      : 'The execution failed.'
    appendEntry({ kind: 'system', text: failure })
    if (anyJobBusy || testLive || !ex || ex.status !== 'failed') return
    // The seed entry above already names the failing step — don't repeat it here.
    void sendChat('This execution failed — figure out why and change the automation so it won’t happen again.', fx)
  }, [rev != null]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11: settled runs seed the thread — entering the editor after the newest
  // Draft execution finished (later than the thread's last entry) appends a
  // run-settled system entry, so the conversation picks up where the run left off.
  const draftRunSeeded = useRef(false)
  useEffect(() => {
    if (!isEdit || !rev || draftRunSeeded.current) return
    draftRunSeeded.current = true
    const lastAt = rev.chat.length ? Date.parse(rev.chat[rev.chat.length - 1].at ?? '') || 0 : 0
    const dr = executions
      .filter((e) => e.automationId === automationId && e.ver === 'Draft'
        && (e.status === 'failed' || e.status === 'succeeded'))
      .sort((a, b) => b.startedMs - a.startedMs)[0]
    if (!dr || Math.max(dr.endedMs, dr.startedMs) <= lastAt) return
    appendEntry({
      kind: 'system',
      text: dr.status === 'failed'
        ? `Draft execution failed${dr.error?.step ? ` at step ${dr.error.step}` : ''} — ${dr.error?.message ?? 'see the run'}`
        : 'Draft execution succeeded.',
    })
  }, [rev != null]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- version menu (edit mode) ----
  const [verOpen, setVerOpen, verRef] = usePopover()
  const pickVersion = (key: 'draft' | number) => {
    if (!auto || !rev) return
    setVerOpen(false)
    if (rev.viewing === key) return
    if (holdsDraftEdits(rev, auto)) {
      draftSnap.current = rev
      void api.putDraft(auto.id, serializeDraft(rev)).catch(() => { /* keep local snapshot */ })
    }
    if (key === 'draft') {
      if (draftSnap.current) setRev({ ...draftSnap.current, viewing: 'draft' })
      else if (auto.draft) setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
      else setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instructions: auto.instructions, notes: auto.notes, params: auto.params, packages: auto.packages }, 'draft'))
    } else if (key === auto.version) {
      setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instructions: auto.instructions, notes: auto.notes, params: auto.params, packages: auto.packages }, key))
    } else {
      const s = (auto.versions ?? []).find((v) => v.version === key)
      if (s) setRev((r) => r && loadVersionInto(r, s, key))
    }
  }

  // ---- leave / start over / save ----
  const close = async () => {
    stopPoll()
    // Leaving create mid-generation abandons the job — kill the harness.
    if (!isEdit && jobIdRef.current && drafting) {
      void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
      jobIdRef.current = null
    }
    if (isEdit && auto) {
      if (rev && holdsDraftEdits(rev, auto)) {
        try { await api.putDraft(auto.id, serializeDraft(rev)) } catch { /* backend restarting */ }
        draftSettled.current = true
        showToast('Draft kept — resume it from this automation anytime.', 3400)
      }
      setSurface('app')
      go('automation')
      return
    }
    // §4.4: leaving create mode after a draft landed keeps the pending slot.
    if (!isEdit && rev && !rev.specBusy && (rev.spec.length || rev.steps.length)) {
      try { await api.putPendingDraft(serializeDraft(rev), agentId) } catch { /* backend restarting */ }
      draftSettled.current = true
      showToast('Draft kept — Resume draft picks it up anytime.', 3400)
    }
    setSurface('app')
    go('automations')
  }

  const startOver = async () => {
    if (isEdit && auto) {
      // Discard draft → back to detail
      try { await api.deleteDraft(auto.id) } catch { /* none saved yet */ }
      draftSnap.current = null
      draftSettled.current = true
      setSurface('app')
      go('automation')
      showToast(`Changes discarded — back to v${auto.version} as saved.`, 3200)
      return
    }
    resetCreate()
  }

  const doSave = async () => {
    if (!rev || saveBlocked) return
    try {
      draftSettled.current = true
      if (isEdit && auto) {
        if (typeof rev.viewing === 'number' && rev.viewing !== auto.version) {
          const { version } = await api.restore(auto.id, rev.viewing)
          setSurface('app')
          go('automation')
          showToast(`v${rev.viewing} restored as version ${version} — earlier versions stay in the Version menu.`, 3200)
        } else {
          const { version } = await api.saveVersion(auto.id, {
            draft: serializeDraft(rev), agentId,
            stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
          })
          setSurface('app')
          go('automation')
          showToast(auto.live.length
            ? `Version ${version} saved. ${auto.live.length === 1 ? 'The execution in progress finishes' : `The ${auto.live.length} executions in progress finish`} on v${version - 1} — v${version} applies from the next execution.`
            : `Version ${version} saved — earlier versions are in the Version menu when you edit.`, 3200)
        }
      } else {
        const created = await api.createAutomation({
          draft: serializeDraft(rev), name: rev.name, agentId,
          stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
        })
        // The detail page guards against unknown ids — make sure the store
        // knows the new automation before navigating (WS refresh may lag).
        await useStore.getState().loadAuto(created.id)
        setSurface('app')
        go('automation', { automationId: created.id })
        showToast('Created — nothing has executed yet. Press Execute now when you’re ready.', 3600)
      }
    } catch (e) {
      draftSettled.current = false
      showToast((e as Error).message)
    }
  }

  // ---- test (§11: create and edit mode) — executes the draft's REAL steps ----
  // §11 test values: seed from the automation's current values (draft default when a param
  // is new to the draft; create mode has no automation, so pure draft defaults) — edited
  // copies live only in this card.
  const seedTestParams = (): ParamDef[] => (rev?.params ?? []).map((d) => {
    const cur = (auto?.params ?? []).find((p) => p.name === d.name && p.kind === d.kind)
    if (d.kind === 'toggle') return { ...d, on: cur ? !!cur.on : !!d.default }
    if (d.kind === 'list') return { ...d, lines: cur?.lines ?? (Array.isArray(d.default) ? d.default as string[] : []) }
    if (d.kind === 'kv') return { ...d, rows: cur?.rows ?? (Array.isArray(d.default) ? d.default as { key: string; value: string }[] : []) }
    return { ...d, value: cur?.value ?? (d.default as string | number | undefined) }
  })
  // A synced/reloaded draft may rename or retype params — collapse the setup
  // section and drop its values.
  useEffect(() => { setTestOpen(false); setTestParams(null) }, [rev?.params])
  // §11 test trigger message: mock only against a message trigger in the editor's
  // list (off state irrelevant); a changed trigger list collapses the section.
  const msgTriggers = (rev?.triggers ?? []).filter(
    (t): t is Extract<DraftTrigger, { kind: 'discord' | 'imessage' }> =>
      t.kind === 'discord' || t.kind === 'imessage')
  const mockSenderSeed = (t: DraftTrigger) => (t.kind === 'imessage' ? t.from : 'Test')
  useEffect(() => { setTestOpen(false); setTestMock(null) }, [rev?.triggers])
  const testTriggerMock = (m: { idx: number; text: string; sender: string }) => {
    const t = msgTriggers[m.idx]
    if (!t || !m.text || !m.sender.trim()) return undefined
    return t.kind === 'discord'
      ? { kind: 'discord', text: m.text, sender: m.sender.trim(), channel: t.channel, secret: t.secret }
      : { kind: 'imessage', text: m.text, sender: m.sender.trim() }
  }
  const testParamValues = (ps: ParamDef[]) => Object.fromEntries(ps.map((p) => [p.name,
    p.kind === 'toggle' ? !!p.on
    : p.kind === 'list' ? (p.lines ?? [])
    : p.kind === 'kv' ? (p.rows ?? [])
    : p.kind === 'number' ? (typeof p.value === 'number' ? p.value : (p.min ?? 0))
    : String(p.value ?? ''),
  ]))
  const testSteps = (test && executionFull[test.executionId]?.steps) ?? []
  const testDone = testSteps.filter((s) => s.status !== 'queued' && s.status !== 'executing').length
  const testLiveIdx = testSteps.findIndex((s) => s.status === 'executing')
  // §11 panel buttons: compact borderless text buttons (the card-header
  // treatment — never bordered or filled boxes); the class owns the padding,
  // and the rows wrap so a button is never clipped.
  const panelBtnStyle: React.CSSProperties = { flex: 'none', whiteSpace: 'nowrap' }
  const panelRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 18px' }
  // §11 test-setup disclosure: Test the draft never starts a test —
  // it expands the setup section below the action row with every option at once
  // (param editors, trigger message, the Run test row). Entered values survive a
  // collapse; seeding happens only when the section opens without prior values.
  const toggleTestSetup = () => {
    if (testOpen) { setTestOpen(false); return }
    if (rev && rev.params.length > 0 && testParams === null) setTestParams(seedTestParams())
    if (msgTriggers.length > 0 && testMock === null) {
      setTestMock({ idx: 0, text: '', sender: mockSenderSeed(msgTriggers[0]) })
    }
    setTestOpen(true)
  }
  // §9.2 step-row caret language: left collapsed, down expanded.
  const testToggleBtn = (label: string) => (
    <button className="ad-btn-text" disabled={busyRewrite} onClick={toggleTestSetup} style={panelBtnStyle}>
      {label}{' '}
      <i className={`fa-solid ${testOpen ? 'fa-caret-down' : 'fa-caret-left'}`} style={{ fontSize: 10 }} />
    </button>
  )
  // §11: in the in-sync states the build zone is gone — sync access stays as
  // this faint text button riding the test action rows (disabled, never hidden).
  const syncGhostBtn = (
    <button
      className="ad-btn-text dim" disabled={syncDisabled}
      onClick={() => void runSync()}
      style={panelBtnStyle}
    >
      Sync with spec
    </button>
  )
  // A live test survives leaving the editor — re-attach the card on entry.
  useEffect(() => {
    if (test) return
    const live = executions.find((e) => e.test && e.status === 'executing'
      && (isEdit ? e.automationId === (auto?.id ?? '') : e.automationId === ''))
    if (live) beginTest(live.id)
  }, [executions]) // eslint-disable-line react-hooks/exhaustive-deps
  const runTest = async (valuesOverride?: Record<string, unknown>) => {
    // §11 Build & test panel: a test always runs steps that match the spec —
    // never stale ones (out of sync) and never mid-build.
    if (!rev || rev.steps.length === 0 || testLive || busyRewrite || outOfSync || drafting) return
    clearTest()
    try {
      const values = valuesOverride ?? (testParams ? testParamValues(testParams) : undefined)
      const mock = testMock ? testTriggerMock(testMock) : undefined
      const { executionId } = await api.postTest({
        draft: serializeDraft(rev),
        ...(isEdit && auto ? { automationId: auto.id } : {}), // edit: scratch memory copies the automation's
        ...(values ? { paramValues: values } : {}), // §11 test-only values
        ...(mock ? { triggerMock: mock } : {}), // §11 test trigger message — only when text is nonempty
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      })
      beginTest(executionId)
      setTestOpen(false) // §11: starting a test collapses the setup section — its inputs were snapshotted
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const cancelTest = () => {
    if (test && testLive) void api.cancelExecution(test.executionId).catch(() => { /* already done */ })
  }
  // §11: analysis runs only when asked, as the canned analyze chat message —
  // an ordinary §8 chat job reading the failing run's RECENT RUNS context.
  const runAnalyze = () => {
    if (!rev || !test || anyJobBusy || testLive || viewingOld) return
    const stepName = testExec?.error?.step
    void sendChat(
      `The test failed${stepName ? ` at step ${stepName}` : ''} — figure out why and change the automation so it won’t happen again.`,
      test.executionId)
  }

  // §11 chat-action chaining (§8 actions.yaml): pendingSync fires as soon as
  // nothing runs; pendingTest fires once the workflow is in sync (right away,
  // or after the chained sync lands) and is dropped with a system chip when
  // the sync didn't — a chat-armed test never runs stale steps.
  useEffect(() => {
    if (!rev || anyJobBusy || testLive || drafting) return
    if (!rev.pendingSync && !rev.pendingTest) return
    if (viewingOld) { up({ pendingSync: false, pendingTest: null }); return }
    if (rev.pendingSync) {
      up({ pendingSync: false })
      void runSync()
      return
    }
    if (outOfSync) {
      // chained sync failed / blocked / cancelled, or something rewrote first
      up({ pendingTest: null })
      appendEntry({ kind: 'system', text: 'Test skipped — the steps aren’t in sync with the spec.' })
      return
    }
    if (rev.steps.length === 0) { up({ pendingTest: null }); return }
    const values = rev.pendingTest?.values ?? null
    up({ pendingTest: null })
    if (values) setTestParams(applyTestValues(seedTestParams(), values)) // §11: pre-fill the panel's editors
    void runTest(values ?? undefined)
  }, [rev, anyJobBusy, testLive, drafting, viewingOld, outOfSync]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11 test-settled thread anchor: when the tracked test finishes, a
  // run-settled system entry lands so follow-up chat has the run in context.
  const prevTestStatus = useRef<string | null>(null)
  useEffect(() => {
    const st = testExec?.status ?? null
    const prev = prevTestStatus.current
    prevTestStatus.current = st
    if (!rev || !st || st === prev || prev !== 'executing') return
    if (st === 'succeeded') appendEntry({ kind: 'system', text: 'Test succeeded.' })
    else if (st === 'failed') {
      appendEntry({
        kind: 'system',
        text: `Test failed${testExec?.error?.step ? ` at step ${testExec.error.step}` : ''} — ${testExec?.error?.message ?? 'see the run'}.`,
      })
    }
  }, [testExec?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- render ----------
  const backLabel = isEdit ? (auto?.name ?? 'Automation') : 'Automations'
  // §11 create empty state: no spec, no steps, nothing drafting — the chat
  // pane shows the headline + example chips and the first message creates.
  const isCreateEmpty = !isEdit && !!rev && rev.spec.length === 0 && rev.steps.length === 0 && !drafting
  const inputDisabled = anyJobBusy || testLive || viewingOld
  const lastRewriteId = rev ? [...rev.chat].reverse().find((e) => e.kind === 'rewrite')?.id : undefined
  const patchEntryBlocker = (id: string, i: number, patch: Partial<Blocker>) =>
    setRev((r) => r && ({
      ...r,
      chat: r.chat.map((e) => (e.id === id
        ? { ...e, blockers: (e.blockers ?? []).map((b, k) => (k === i ? { ...b, ...patch } : b)) }
        : e)),
    }))
  // §11 blockers-entry copy, by source
  const blockersHeadline = (e: ChatEntry) => {
    const n = (e.blockers ?? []).length
    if (e.diagnosed) return 'The build failed — your AI suggests these fixes'
    return n > 1 ? `Your AI hit ${n} blockers` : 'Your AI hit a blocker'
  }
  const blockersExplainer = (e: ChatEntry) =>
    e.source === 'spec' ? 'It couldn’t write a spec for this request. Answer below — your answers are added to the request and the spec is rewritten.'
      : e.source === 'chat' ? 'Answer below — your answers are sent back and the spec is rewritten.'
        : e.source === 'steps' ? 'It couldn’t build the steps as the spec asks. Edit the fix below, then apply it to the spec and rebuild.'
          : 'It couldn’t sync the steps with the spec. Edit the fix below, then apply it to the spec and sync again.'

  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'flex-start' }}>
        {/* ===== chat panel (§11) — floating card matching the §9 rail rhythm:
            top 46 / bottom 12, 12px radius, 12px left gap; starts below the drag
            strips and the traffic lights, so no header padding or no-drag needed ===== */}
        {rev && (
          <div style={{
            width: 'clamp(340px, 26vw, 420px)', flex: 'none', alignSelf: 'flex-start',
            position: 'sticky', top: 46, marginTop: 6, marginLeft: 12,
            height: 'calc(100vh - 58px)',
            background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* thread — no header row (§11); the composer below carries the pane's identity */}
            <ScrollArea scrollRef={chatScrollRef} wrapStyle={{ flex: 1, minHeight: 0 }} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {rev.chat.length === 0 && !anyJobBusy && (isCreateEmpty ? (
                <div style={{ padding: '10px 4px' }}>
                  <h2 style={{ font: "600 19px/1.3 var(--sans)", letterSpacing: '-.02em', margin: '0 0 8px' }}>
                    What should Autowright do for you?
                  </h2>
                  <p style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-muted)', margin: '0 0 20px' }}>
                    Describe the job in plain words. Your AI writes it as scripts — you review everything before it executes.
                  </p>
                  <Eyebrow>OR START FROM AN EXAMPLE</Eyebrow>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0 20px' }}>
                    {[
                      { label: 'Track manga chapters', icon: 'fa-book-open', s: 'Check the manga I follow for new chapters every morning at 8.' },
                      { label: 'Back up a folder every night', icon: 'fa-box-archive', s: 'Back up my Projects folder to the Vault drive every night at 2.' },
                      { label: 'Email me a weekly report', icon: 'fa-envelope', s: 'Gather the week’s numbers and email the team a summary every Monday at 9.' },
                      { label: 'Watch a product’s price', icon: 'fa-tag', s: 'Watch the price of the keyboard I want and tell me when it drops below €120.' },
                      { label: 'Tidy my screenshots folder', icon: 'fa-broom', s: 'File my desktop screenshots into monthly folders every Sunday night.' },
                    ].map((c) => (
                      <button key={c.label} className="ad-chip-btn" onClick={() => setChatText(c.s)}>
                        <i className={`fa-solid ${c.icon}`} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ font: "400 11.5px/1.6 var(--sans)", color: 'var(--text-muted)', marginTop: 14 }}>
                    Your AI writes the steps — Autowright still executes everything on this Mac.
                  </div>
                </div>
              ) : (
                <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-muted)', textAlign: 'center', padding: '26px 12px' }}>
                  Ask anything, or describe a change — your AI answers here and rewrites the spec when you ask for changes.
                </div>
              ))}
              {rev.chat.map((e) => {
                // §11 draft undo: the standalone undo row — the page's only
                // undo affordance — beneath the snapshot's anchor entry
                const undoRow = e.id === rev.undo?.entryId && !anyJobBusy && !viewingOld && !testLive ? (
                  <div style={{ textAlign: 'center' }}>
                    <button className="ad-btn-text dim small" onClick={undoDraft}>Undo this change</button>
                  </div>
                ) : null
                if (e.kind === 'user') {
                  return (
                    <div key={e.id} style={{
                      font: "500 12.5px/1.5 var(--sans)", color: 'var(--text-2)',
                      background: 'var(--bg-inset)', border: '1px solid var(--hairline)',
                      borderRadius: 9, padding: '8px 12px', alignSelf: 'flex-end', maxWidth: '92%',
                      whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
                    }}>
                      {e.text}
                    </div>
                  )
                }
                if (e.kind === 'answer') {
                  return (
                    <div key={e.id} style={{ font: "400 12.5px/1.65 var(--sans)", color: 'var(--text-2)' }}>
                      <Markdown text={e.text ?? ''} />
                    </div>
                  )
                }
                if (e.kind === 'rewrite') {
                  return (
                    <React.Fragment key={e.id}>
                    <div className="ad-anim-item" style={{
                      border: '1px solid var(--border-card)', background: 'var(--bg-inset)',
                      borderRadius: 9, padding: '9px 12px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <i className="fa-solid fa-file-pen" style={{ fontSize: 10, color: 'var(--accent)' }} />
                        <span style={{ font: "600 12px var(--sans)", flex: 1, minWidth: 0 }}>Spec updated</span>
                      </div>
                      {e.text && (
                        <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3, overflowWrap: 'break-word' }}>{e.text}</div>
                      )}
                      {e.id === lastRewriteId && outOfSync && rev.dirty && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span style={{ flex: 1, minWidth: 0, font: "400 11.5px/1.5 var(--sans)", color: 'var(--amber)' }}>
                            The workflow is out of sync — sync the steps before saving.
                          </span>
                          {/* §11: the most common next step sits on the event itself */}
                          {!syncDisabled && !rev.pendingSync && (
                            <button className="ad-btn-text" onClick={() => void runSync()} style={{ flex: 'none' }}>
                              Sync now
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {undoRow}
                    </React.Fragment>
                  )
                }
                if (e.kind === 'blockers') {
                  if (e.dismissed) {
                    return (
                      <div key={e.id} style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', textAlign: 'center' }}>
                        {(e.blockers ?? []).length} blocker{(e.blockers ?? []).length === 1 ? '' : 's'} — dismissed
                      </div>
                    )
                  }
                  const invalid = (e.blockers ?? []).some((b) => !b.reason.trim() || !b.fix.trim())
                  const clarify = e.source === 'spec' || e.source === 'chat'
                  return (
                    <div key={e.id} className="ad-anim-item" style={{ textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                        <span style={{ font: "600 13.5px var(--sans)", color: 'var(--text)' }}>{blockersHeadline(e)}</span>
                      </div>
                      <div style={{ font: "400 12px/1.6 var(--sans)", color: 'var(--text-muted)', margin: '0 0 10px 15px' }}>
                        {blockersExplainer(e)}
                      </div>
                      <BlockerCards
                        bare
                        readOnly={anyJobBusy || viewingOld}
                        blockers={e.blockers ?? []}
                        onChange={(i, patch) => patchEntryBlocker(e.id, i, patch)}
                      />
                      {(e.resolved ?? []).length > 0 && (
                        <div style={{ margin: '12px 0 0', font: "400 11.5px/1.7 var(--sans)", color: 'var(--text-faint)' }}>
                          <Eyebrow>PREVIOUSLY RESOLVED</Eyebrow>
                          {(e.resolved ?? []).map((s, i) => <div key={i}>– {s}</div>)}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                        <BtnGhost onClick={() => patchEntry(e.id, { dismissed: true })}>Dismiss</BtnGhost>
                        <BtnPrimary
                          disabled={invalid || anyJobBusy || viewingOld}
                          onClick={() => (clarify ? answerBlockersEntry(e) : applyBlockersEntry(e))}
                        >
                          {clarify ? 'Answer & rewrite the spec' : 'Apply to the spec & sync'}
                        </BtnPrimary>
                      </div>
                    </div>
                  )
                }
                if (e.kind === 'error') {
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
                      <span style={{ flex: 1, minWidth: 0, font: "400 12px/1.6 var(--sans)", color: 'var(--text-2)', overflowWrap: 'break-word' }}>{e.text}</span>
                      {e.source === 'spec' && !anyJobBusy && !isEdit && (
                        <button className="ad-btn-soft" onClick={() => void submitCreate(lastCreateRef.current)} style={{ flex: 'none' }}>
                          Try again
                        </button>
                      )}
                    </div>
                  )
                }
                // system chip — the standalone undo row renders beneath it
                // when it anchors the snapshot (a response that rewrote
                // instructions or notes without touching the spec, §11)
                return (
                  <React.Fragment key={e.id}>
                  <div style={{ font: "400 11.5px/1.6 var(--sans)", color: 'var(--text-faint)', textAlign: 'center', overflowWrap: 'break-word' }}>
                    {e.text}
                  </div>
                  {undoRow}
                  </React.Fragment>
                )
              })}
            </ScrollArea>
            {/* footer composer — while a §8 job runs it keeps its shape and gains
                the progress block above the textarea (the page's only live job
                surface: spinner + stage + activity feed, §11); Send becomes Cancel */}
            <div style={{ flex: 'none', borderTop: '1px solid var(--hairline)', padding: '12px 14px' }}>
                {anyJobBusy && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                    <Spinner size={13} style={{ marginTop: 2, flex: 'none' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ font: "500 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                        {rev.chatBusy ? 'Working on the request…'
                          : rev.specBusy ? 'Writing the spec…'
                            : rev.syncBusy
                              ? `${selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'Your agent'} is rewriting the steps from your spec…`
                              : installingPkgs ? 'Installing the packages…' : 'Generating the steps…'}
                      </div>
                      {(() => {
                        // §11 activity feed: dim event history over the live detail
                        // line; the newest event hides when detail extends it (same
                        // message, growing line count) so it never shows twice.
                        const evs = rev.genEvents
                        const last = evs.length ? evs[evs.length - 1] : null
                        const hist = (rev.genDetail && last && rev.genDetail.startsWith(last) ? evs.slice(0, -1) : evs).slice(-3)
                        return (
                          <>
                            {hist.map((t, i) => (
                              <div key={`${i}-${t}`} style={{ font: "400 11px/1.5 var(--sans)", color: 'var(--text-faint)', marginTop: i === 0 ? 2 : 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
                            ))}
                            {rev.genDetail && (
                              <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: hist.length ? 0 : 2 }}>{rev.genDetail}</div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}
                <textarea
                  className="ad-input oneline-ph"
                  value={chatText} rows={1} disabled={inputDisabled}
                  ref={attachChatInput}
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  placeholder={testLive ? 'Wait for the test to finish.'
                    : viewingOld ? 'Back to the draft to edit or ask.'
                      : isCreateEmpty ? 'Describe the job — one sentence is enough.'
                        : 'Change something, or ask a question…'}
                  style={{
                    width: '100%', color: 'var(--text)', font: "400 12.5px/1.5 var(--sans)", padding: '8px 12px',
                    resize: 'none', overflow: 'hidden', display: 'block',
                  }}
                />
                {/* composer toolbar (§11) — the drafting-agent picker is a property of the
                    message being sent, so it is chosen here; Send is a quiet pill-height
                    secondary affordance (Enter is the primary send path) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
                  <AgentPick
                    agents={agents} selected={selAgent} disabled={busyRewrite}
                    onPick={(g) => {
                      if (busyRewrite || drafting) { showToast('Wait for the current rewrite to finish first.'); return }
                      if (selAgent && selAgent.id === g.id) return
                      setAgentId(g.id)
                      if (isEdit) up({ touched: true })
                      showToast(`${agName(g)} · ${dispModel(g)} now writes the spec and steps here.`, 3000)
                    }}
                  />
                  {anyJobBusy ? (
                    <button className="ad-btn-pill" onClick={rev.chatBusy ? cancelChat : rev.syncBusy ? cancelSync : cancelCreate} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                      Cancel
                    </button>
                  ) : (
                    <button className="ad-btn-pill" disabled={inputDisabled || !chatText.trim()} onClick={sendMessage} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                      Send
                    </button>
                  )}
                </div>
              </div>
          </div>
        )}

        {/* ===== review pane ===== */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* header */}
          <div className="ad-anim-page" style={{ padding: '20px 0 0' }}>
            <div style={{
              maxWidth: 1800, margin: '0 auto', padding: '0 30px 0 18px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <button className="ad-btn-text" onClick={() => void close()}>
                <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> {backLabel}
              </button>
            </div>
          </div>
          {!rev && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
              <Spinner size={24} />
            </div>
          )}
          {rev && (
          <div className="ad-anim-page" style={{ maxWidth: 1800, margin: '0 auto', padding: '14px 30px 60px 18px' }}>
            {/* title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '0 0 6px' }}>
              {nameEdit !== null ? (
                <input
                  className="ad-input"
                  value={nameEdit}
                  onChange={(e) => setNameEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTitleRename()
                    if (e.key === 'Escape') setNameEdit(null)
                  }}
                  onBlur={commitTitleRename}
                  autoFocus
                  style={{
                    font: "600 20px var(--sans)", letterSpacing: '-.01em', padding: '2px 10px',
                    minWidth: 0, flex: '0 1 auto', width: 420,
                  }}
                />
              ) : canRename ? (
                <div className="ad-title-rename always" title={draftName}>
                  <h1 style={{
                    font: "600 20px var(--sans)", letterSpacing: '-.01em', margin: 0,
                    minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {titleText}
                  </h1>
                  <button className="pencil" title="Rename" onClick={() => setNameEdit(draftName)}>
                    <i className="fa-solid fa-pencil" />
                  </button>
                </div>
              ) : (
                <h1 style={{
                  font: "600 20px var(--sans)", letterSpacing: '-.01em', margin: 0,
                  minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {titleText}
                </h1>
              )}
              {isEdit && auto && (
                <div ref={verRef} style={{ position: 'relative' }}>
                  <button className="ad-btn-pill" disabled={busyRewrite} onClick={() => setVerOpen(!verOpen)}>
                    <span>{rev.viewing === 'draft' ? 'Draft' : `v${rev.viewing}${rev.viewing === auto.version ? ' · current' : ''}`}</span>
                    <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
                  </button>
                  <PopMenu show={verOpen} style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 360 }}>
                    {/* a long version history scrolls inside the menu instead of past the window */}
                    <ScrollArea style={{ maxHeight: '60vh' }}>
                      {([
                        {
                          key: 'draft' as const, label: 'Draft',
                          sub: 'your working copy — unsaved',
                        },
                        {
                          key: auto.version, label: `v${auto.version}`,
                          sub: 'current · ' + (((auto.specMeta || '').split('·')[1] || '').trim()),
                        },
                        ...(auto.versions ?? []).map((v) => ({
                          key: v.version, label: `v${v.version}`, sub: v.when + (v.note ? ' · ' + v.note : ''),
                        })),
                      ]).map((it) => {
                        const sel = rev.viewing === it.key
                        return (
                          <button
                            key={String(it.key)}
                            className="ad-btn-bare ad-hover-row"
                            onClick={() => pickVersion(it.key)}
                            style={{
                              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer',
                              borderBottom: '1px solid var(--hairline-dim)',
                              // no inline background when unselected — .ad-hover-row's hover tint must win
                              ...(sel ? { background: 'var(--accent-hint-bg)' } : {}),
                              transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter)',
                            }}
                          >
                            <span style={{ width: 14, flex: 'none', textAlign: 'center', font: "600 12px var(--mono)", color: 'var(--accent)' }}>{sel ? <i className="fa-solid fa-check" style={{ fontSize: 10 }} /> : ''}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "600 12.5px var(--mono)", color: sel ? 'var(--text)' : 'var(--text-2)' }}>{it.label}</div>
                              <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)', marginTop: 1 }}>{it.sub}</div>
                            </div>
                          </button>
                        )
                      })}
                    </ScrollArea>
                  </PopMenu>
                </div>
              )}
              <div style={{ flex: 1 }} />
              <HeaderActions>
                {saveBlocked && !isCreateEmpty && (
                  <span style={{ font: "400 12px var(--sans)", color: 'var(--amber)' }}>
                    {rev.specBusy ? 'Writing the spec…'
                      : rev.stepsBusy ? (installingPkgs ? 'Installing the packages…' : 'Generating the steps…')
                        : rev.syncBusy ? (installingPkgs ? 'Installing the packages…' : 'Syncing steps…')
                          : rev.chatBusy ? 'Working on your request…'
                            : rev.specEdit ? 'Finish editing the spec first — save or cancel your edits'
                              : 'Sync and review the steps before saving'}
                  </span>
                )}
                <button className="ad-btn-text dim" disabled={busyRewrite} onClick={() => void startOver()}>
                  {isEdit ? 'Discard draft' : 'Start over'}
                </button>
                {isEdit && (rev.touched || !!auto?.draft) && (
                  <button className="ad-btn-ghost" onClick={() => void close()}>
                    Keep draft
                  </button>
                )}
                <BtnPrimary onClick={() => void doSave()} disabled={saveBlocked}>
                  {isEdit && auto
                    ? (viewingOld ? `Restore v${rev.viewing} as v${auto.version + 1}` : `Save as v${auto.version + 1}`)
                    : 'Create automation'}
                </BtnPrimary>
              </HeaderActions>
            </div>
            {/* lede: the automation's description (§4.1) — editable like the name; create mode
                shows the static drafting lede until drafting settles. The row is
                height-stable: every state shares one fixed-height box. The drafting-agent
                picker lives in the chat pane composer, not here. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, height: 26, minWidth: 0, margin: '0 0 20px' }}>
              {!isEdit && drafting ? (
                <p style={{
                  font: "400 13.5px/1.6 var(--sans)", color: 'var(--text-muted)', margin: 0, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  Read what your AI wrote. Change anything — nothing executes until you create it.
                </p>
              ) : descEdit !== null ? (
                <input
                  className="ad-input"
                  value={descEdit}
                  onChange={(e) => setDescEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitDescEdit()
                    if (e.key === 'Escape') setDescEdit(null)
                  }}
                  onBlur={commitDescEdit}
                  autoFocus
                  placeholder="What this automation does — one line"
                  style={{ font: "400 13.5px/1.6 var(--sans)", height: 26, padding: '0 10px', width: 640, maxWidth: '100%' }}
                />
              ) : (
                <div
                  className={canRename ? 'ad-title-rename always' : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                >
                  <p style={{
                    font: "400 13.5px/1.6 var(--sans)", margin: 0, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    color: rev.description ? 'var(--text-muted)' : 'var(--text-faint)',
                  }}>
                    {rev.description || (canRename ? 'No description yet — press the pencil to add one.' : 'No description yet.')}
                  </p>
                  {canRename && (
                    <button className="pencil" title="Edit the description" onClick={() => setDescEdit(rev.description)}>
                      <i className="fa-solid fa-pencil" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* old-version banner */}
            {viewingOld && auto && (
              <div className="ad-anim-item" style={{
                background: 'var(--notice-accent-bg)', border: '1px solid var(--notice-accent-border)',
                borderRadius: 10, padding: '11px 14px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`Loaded v${rev.viewing} from history. Saving restores it as v${auto.version + 1} — your draft stays in the Version menu.`}
                </span>
                <button className="ad-btn-soft" disabled={busyRewrite} onClick={() => pickVersion('draft')} style={{ flex: 'none' }}>
                  Back to draft
                </button>
              </div>
            )}

            {/* live-execution note */}
            {isEdit && !!auto?.live.length && (
              <div className="ad-anim-item" style={{
                background: 'var(--notice-cyan-bg)', border: '1px solid var(--notice-cyan-border)',
                borderRadius: 10, padding: '11px 14px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', animation: PULSE, flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`An execution is happening right now on v${auto.version}. Saving won’t interrupt it — that execution finishes on v${auto.version}. v${auto.version + 1} takes over from the next execution (${nextTriggerShort(auto.triggers) ?? auto.triggerChip}).`}
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,.95fr)', gap: 18, alignItems: 'start' }}>
              {/* ===== left column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* SPEC */}
                <SectionCard
                  eyebrow="SPEC"
                  open={specOpenEff}
                  // §11: inert while the card is force-open writing or editing
                  inert={rev.specEdit || rev.specBusy}
                  onToggle={(o) => up({ specSecOpen: o })}
                  hint="What the automation should do, in plain words. The AI regenerates the steps from this document when it changes."
                  right={specOpenEff && !rev.specBusy && (!rev.specEdit ? (
                      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                      <button
                        // §11: an old version is browsed read-only — editing
                        // here would mark the draft dirty and lock Restore
                        // behind a disabled sync button.
                        className="ad-btn-text small ad-focus-inset" disabled={busyRewrite || viewingOld || testLive}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (busyRewrite || viewingOld || testLive) return
                          // §11: starting a spec edit while the steps are still
                          // generating cancels the steps call — sync rebuilds later.
                          const genCancelled = cancelStepsGen()
                          const t = specToText(rev.spec)
                          up({
                            instrDraft: null, instrEdit: false, notesDraft: null, notesEdit: false,
                            specText: t, specTextOrig: t, specEdit: true,
                            ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
                          })
                          if (genCancelled) showToast('Step generation stopped — sync the steps when you finish editing.', 4200)
                        }}
                      >
                        Edit
                      </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                        <button
                          className="ad-btn-text dim small ad-focus-inset"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (rev.specText !== rev.specTextOrig) { setConfirmSpecCancel(true); return }
                            up({ specEdit: false, specText: '', specTextOrig: '' })
                          }}                        >
                          Cancel
                        </button>
                        <button
                          className="ad-btn-link small ad-focus-inset"
                          disabled={rev.specText === rev.specTextOrig}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (rev.specText === rev.specTextOrig) return
                            // §11 draft undo: a manual Save under the snapshot clears it
                            up({
                              undo: null,
                              spec: textToSpec(rev.specText), specEdit: false, specText: '', specTextOrig: '',
                              dirty: true, touched: true,
                            })
                            showToast('Spec saved — the workflow is out of sync. Sync the steps before saving.', 5800)
                          }}                        >
                          Save
                        </button>
                      </div>
                    ))}
                >
                  {/* §11 drafting-on-Review: call 1 in flight — static text only;
                      the live surface is the chat footer's action block */}
                  {rev.specBusy ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '46px 20px 50px' }}>
                      <span style={{ font: "500 13px var(--sans)", color: 'var(--text-muted)' }}>Writing the spec…</span>
                      <span style={{ font: "500 11px var(--mono)", color: 'var(--text-muted)' }}>
                        {selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'No agent'}
                      </span>
                    </div>
                  ) : rev.specEdit ? (
                    <>
                      <div className="ad-scrollwrap" style={{ position: 'relative' }}>
                        <textarea
                          value={rev.specText} rows={1}
                          ref={(el) => { specThumb.attach(el); if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
                          onChange={(e) => up({ specText: e.target.value, touched: true })}
                          onScroll={specThumb.onScroll}
                          style={{
                            width: '100%', background: 'var(--bg-inset)', border: 'none', color: 'var(--text-2)',
                            font: "400 12.5px/1.7 var(--mono)", padding: '12px 20px 18px', resize: 'none', outline: 'none', display: 'block',
                            minHeight: 92, maxHeight: 440, overflowY: 'auto',
                          }}
                          className="ad-scrollhide"
                        />
                        {specThumb.node}
                      </div>
                      <div style={{ padding: '9px 20px', borderTop: '1px solid var(--hairline-dim)', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                        Saving rewrites the steps to match the new spec.
                      </div>
                    </>
                  ) : (
                    isCreateEmpty ? (
                      <CardEmpty>The spec appears here as your AI writes it — describe the job in the chat to start.</CardEmpty>
                    ) : (
                      <CardMarkdown>
                        <SpecMarkdown blocks={rev.spec} />
                      </CardMarkdown>
                    )
                  )}
                </SectionCard>

                {/* NOTES — §4.1 agent-owned working knowledge (§11): agent-written
                    via §8 chat/sync notes.md rewrites, user-prunable here. Never
                    marks the workflow out of sync and never gates Save. */}
                <SectionCard
                  eyebrow="NOTES"
                  open={notesOpenEff}
                  inert={rev.notesEdit}
                  onToggle={(o) => up({ notesSecOpen: o })}
                  hint="No notes yet — your AI records what it learns (page quirks, dead ends, fixes) as you build and test."
                  preview={rev.notes.trim() ? docPreview(rev.notes) : null}
                  right={<>
                    {notesOpenEff && !rev.notesEdit && rev.notes.trim() !== '' && (
                      <button
                        className="ad-btn-text small ad-focus-inset" disabled={busyRewrite}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (busyRewrite) return
                          up({
                            specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false,
                            notesDraft: rev.notes, notesEdit: true, notesSecOpen: true,
                          })
                        }}
                        style={{ flex: 'none' }}
                      >
                        Edit
                      </button>
                    )}
                    {notesOpenEff && rev.notesEdit && (
                      <span style={{ display: 'flex', gap: 9, alignItems: 'center', flex: 'none' }}>
                        <button
                          className="ad-btn-text dim small ad-focus-inset"
                          onClick={(e) => { e.stopPropagation(); up({ notesDraft: null, notesEdit: false }) }}
                        >
                          Cancel
                        </button>
                        <button
                          className="ad-btn-link small ad-focus-inset"
                          disabled={rev.notesDraft == null || rev.notesDraft === rev.notes}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (rev.notesDraft == null || rev.notesDraft === rev.notes) return
                            // §4.1: a notes change never marks the workflow out of sync;
                            // §11 draft undo: a manual Save under the snapshot clears it
                            up({ notes: rev.notesDraft, notesDraft: null, notesEdit: false, touched: true, undo: null })
                          }}
                        >
                          Save
                        </button>
                      </span>
                    )}
                  </>}
                >
                  {!rev.notesEdit && (
                    rev.notes.trim() ? (
                      <CardMarkdown>
                        <Markdown text={rev.notes} />
                      </CardMarkdown>
                    ) : (
                      <CardEmpty>No notes yet — your AI records what it learns (page quirks, dead ends, fixes) as you build and test.</CardEmpty>
                    )
                  )}
                  {rev.notesEdit && (
                    <textarea
                      value={rev.notesDraft ?? rev.notes} rows={1}
                      ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
                      onChange={(e) => up({ notesDraft: e.target.value })}
                      placeholder="Markdown — your AI’s working knowledge for this automation. Prune anything stale or wrong."
                      style={{
                        width: '100%', background: 'var(--bg-inset)', border: 'none',
                        color: 'var(--text-2)', font: "400 12.5px/1.7 var(--mono)", padding: '14px 20px',
                        resize: 'none', outline: 'none', display: 'block', minHeight: 92, overflow: 'hidden',
                      }}
                    />
                  )}
                </SectionCard>

                {/* AGENTS · AVAILABLE TO STEPS */}
                <SectionCard
                  eyebrow="AGENTS · AVAILABLE TO STEPS"
                  open={agSecOpenEff}
                  onToggle={(o) => up({ agSecOpen: o })}
                  hint="Which agents steps may call mid-execution. Fewer enabled means more predictable executions."
                  preview={availAgents.length ? availAgents.map(agName).join(' · ') : null}
                  right={
                    <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
                      {availAgents.length} of {agents.length} enabled
                    </span>
                  }
                >
                    <div>
                      {agWarn && (
                        <WarnBanner text={[
                          ...(agNone ? [`Step${agFallbackIdx.length > 1 ? 's' : ''} ${stepList(agFallbackIdx)} need${agFallbackIdx.length > 1 ? '' : 's'} an agent, but none is enabled — the execution would fail there. Enable one below.`] : []),
                          ...agNotEnabled.map((r) => `Step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} call${r.steps.length > 1 ? '' : 's'} ${r.name}, but it isn’t enabled here — the execution would fail there. Enable it below.`),
                          ...agMissing.map((r) => `${r.name} isn’t one of your agents — the execution would fail at step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)}.`),
                        ].join(' ')} />
                      )}
                      {agents.map((g) => {
                        const on = rev.enabledAgents.includes(g.id)
                        // §11: named references count even while the agent is disabled, so the
                        // warned row still shows where it's called; unnamed steps fall back to
                        // the first enabled agent.
                        const used = agentStepIdx.filter((i) => {
                          const names = (rev.steps[i].agents ?? []).map((e) => e.name)
                          return names.length ? names.includes(agName(g)) : availAgents[0]?.id === g.id
                        })
                        return (
                          <button
                            key={g.id}
                            onClick={() => {
                              if (busyRewrite) return
                              if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                              const genCancelled = cancelStepsGen() // §11: grant changes cancel an in-flight steps call
                              const genPatch = genCancelled ? { stepsBusy: false as const, dirty: true } : {}
                              if (on) {
                                up({ ...genPatch, enabledAgents: rev.enabledAgents.filter((z) => z !== g.id), ...(isEdit ? { touched: true } : {}) })
                                if (used.length) showToast(`Step${used.length > 1 ? 's' : ''} ${stepList(used)} ${used.length > 1 ? 'are' : 'is'} out of sync — ${agName(g)} is no longer available here. Re-enable it or sync the steps before saving.`, 5000)
                              } else {
                                up({ ...genPatch, enabledAgents: [...rev.enabledAgents, g.id], ...(isEdit ? { touched: true } : {}) })
                                showToast(`${agName(g)} is now available to steps — Sync with spec if the steps should be rewritten to use it.`, 3600)
                              }
                            }}
                            className="ad-btn-bare ad-focus-inset ad-hover-row"
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)', cursor: 'pointer', userSelect: 'none', ...lockStyle }}
                          >
                            <CheckBox on={on} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "600 12.5px var(--sans)" }}>{agName(g)}</div>
                              <div style={{ font: "400 11.5px var(--sans)", color: 'var(--text-muted)' }}>{dispModel(g)}</div>
                            </div>
                            {used.length > 0 && (
                              <span style={{ font: "500 10px var(--mono)", color: 'var(--text-faint)', flex: 'none', whiteSpace: 'nowrap' }}>
                                called by step{used.length > 1 ? 's' : ''} {stepList(used)}
                              </span>
                            )}
                          </button>
                        )
                      })}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                        Steps marked <i className="fa-solid fa-microchip" style={{ fontSize: 9, color: 'var(--accent-hover)' }} /> call one of these mid-execution — for the parts plain code can’t do, like reading a messy page or writing prose. Fewer enabled means more predictable executions.
                      </div>
                    </div>
                </SectionCard>

                {/* SECRETS · ALLOWED FOR STEPS */}
                <SectionCard
                  eyebrow="SECRETS · ALLOWED FOR STEPS"
                  open={secSecOpenEff}
                  onToggle={(o) => up({ secSecOpen: o })}
                  hint="Only checked secrets are handed to this automation at execution time. Values come from your Keychain."
                  preview={rev.allowedSecrets.length ? rev.allowedSecrets.join(' · ') : null}
                  right={
                    <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
                      {rev.allowedSecrets.length} of {secrets.length} allowed
                    </span>
                  }
                >
                    <div>
                      {secWarn && (
                        <WarnBanner text={[
                          ...secNotAllowed.map((r) => `Step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} use${r.steps.length > 1 ? '' : 's'} ${r.name}, but it isn’t allowed here — the execution would fail there. Allow it below.`),
                          ...secMissing.map((r) => `${r.name} isn’t in your Keychain — the execution would fail at step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)}. Click it below to add the value.`),
                        ].join(' ')} />
                      )}
                      {secrets.map((s) => {
                        const ref = secRefs.find((r) => r.name === s.name)
                        const on = rev.allowedSecrets.includes(s.name)
                        return (
                          <button
                            key={s.name}
                            onClick={() => {
                              if (busyRewrite) return
                              if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                              const genCancelled = cancelStepsGen() // §11: grant changes cancel an in-flight steps call
                              const genPatch = genCancelled ? { stepsBusy: false as const, dirty: true } : {}
                              if (on) {
                                up({ ...genPatch, allowedSecrets: rev.allowedSecrets.filter((z) => z !== s.name), ...(isEdit ? { touched: true } : {}) })
                                if (ref) showToast(`Step${ref.steps.length > 1 ? 's' : ''} ${stepList(ref.steps)} use${ref.steps.length > 1 ? '' : 's'} ${s.name} — re-allow it or sync the steps before saving.`, 4500)
                              } else {
                                up({ ...genPatch, allowedSecrets: [...rev.allowedSecrets, s.name], ...(isEdit ? { touched: true } : {}) })
                              }
                            }}
                            className="ad-btn-bare ad-focus-inset ad-hover-row"
                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)', cursor: 'pointer', userSelect: 'none', ...lockStyle }}
                          >
                            <CheckBox on={on} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ font: "500 12px var(--mono)", color: 'var(--text)' }}>{s.name}</div>
                            </div>
                            {ref && (
                              <span style={{ font: "500 10px var(--mono)", color: 'var(--text-faint)', flex: 'none', whiteSpace: 'nowrap' }}>
                                used by step{ref.steps.length > 1 ? 's' : ''} {stepList(ref.steps)}
                              </span>
                            )}
                          </button>
                        )
                      })}
                      {secMissing.map((r) => (
                        <div key={r.name} style={lockStyle}>
                          <MissingSecretRow
                            name={r.name}
                            sub={`used by step${r.steps.length > 1 ? 's' : ''} ${stepList(r.steps)} — not in your Keychain`}
                            onAdded={() => up({ allowedSecrets: [...rev.allowedSecrets, r.name], ...(isEdit ? { touched: true } : {}) })}
                          />
                        </div>
                      ))}
                      {secrets.length === 0 && secRefs.length === 0 && (
                        <div style={{ padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)', font: "400 12px var(--sans)", color: 'var(--text-muted)' }}>
                          No secrets in your Keychain yet — press New secret.
                        </div>
                      )}
                      {/* §11: a secret added from this card is an explicit grant — auto-allowed on save */}
                      <div style={{ padding: '11px 20px 0', ...lockStyle }}>
                        <button className="ad-btn-accent-ghost small" onClick={() => setSecretModal(true)}>
                          <i className="fa-solid fa-plus" style={{ fontSize: 9, marginRight: 5 }} />
                          New secret
                        </button>
                      </div>
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                        Only checked secrets are handed to this automation at execution time — a step that asks for anything else fails. Values come from your Keychain and never appear in scripts or logs.
                      </div>
                    </div>
                </SectionCard>
                {secretModal && (
                  <SecretModal
                    modal={{ mode: 'add' }}
                    onClose={() => setSecretModal(false)}
                    onSaved={(name) => {
                      const genCancelled = cancelStepsGen() // §11: grant changes cancel an in-flight steps call
                      const genPatch = genCancelled ? { stepsBusy: false as const, dirty: true } : {}
                      up({ ...genPatch, allowedSecrets: [...rev.allowedSecrets, name], ...(isEdit ? { touched: true } : {}) })
                    }}
                  />
                )}

                {/* BUILD INSTRUCTIONS */}
                <SectionCard
                  eyebrow="BUILD INSTRUCTIONS"
                  open={instrOpenEff}
                  inert={rev.instrEdit}
                  onToggle={(o) => up({ instrSecOpen: o })}
                  hint="Standing rules your AI follows every time it writes or edits this automation."
                  preview={rev.instructions.trim() ? docPreview(rev.instructions) : null}
                  right={<>
                    {instrOpenEff && !rev.instrEdit && (
                      <button
                        className="ad-btn-text small ad-focus-inset" disabled={busyRewrite || testLive}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (busyRewrite || testLive) return
                          if (rev.specBusy) { showToast('Wait for the spec first.'); return }
                          const genCancelled = cancelStepsGen() // §11: instruction edits cancel an in-flight steps call
                          up({
                            specEdit: false, specText: '', specTextOrig: '', notesDraft: null, notesEdit: false,
                            instrDraft: rev.instructions, instrEdit: true, instrSecOpen: true,
                            ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
                          })
                          if (genCancelled) showToast('Step generation stopped — sync the steps when you finish editing.', 4200)
                        }}
                        style={{ flex: 'none' }}
                      >
                        Edit
                      </button>
                    )}
                    {instrOpenEff && rev.instrEdit && (
                      <span style={{ display: 'flex', gap: 9, alignItems: 'center', flex: 'none' }}>
                        <button
                          className="ad-btn-text dim small ad-focus-inset"
                          disabled={!defaultBuildCache || (rev.instrDraft ?? rev.instructions) === defaultBuildCache}
                          onClick={(e) => { e.stopPropagation(); up({ instrDraft: defaultBuildCache }) }}
                        >
                          Reset to default
                        </button>
                        <button
                          className="ad-btn-text dim small ad-focus-inset"
                          onClick={(e) => { e.stopPropagation(); up({ instrDraft: null, instrEdit: false }) }}                        >
                          Cancel
                        </button>
                        <button
                          className="ad-btn-link small ad-focus-inset"
                          disabled={rev.instrDraft == null || rev.instrDraft === rev.instructions}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (rev.instrDraft == null || rev.instrDraft === rev.instructions) return
                            // §11 draft undo: a manual Save under the snapshot clears it
                            up({ instructions: rev.instrDraft, instrDraft: null, instrEdit: false, touched: true, dirty: true, undo: null })
                            showToast('Instructions saved — the workflow is out of sync. Sync the steps before saving.', 5800)
                          }}                        >
                          Save
                        </button>
                      </span>
                    )}
                  </>}
                >
                  {!rev.instrEdit && (
                    rev.instructions.trim() ? (
                      <CardMarkdown>
                        <Markdown text={instrToMd(rev.instructions)} />
                      </CardMarkdown>
                    ) : (
                      <CardEmpty>No instructions yet — press Edit to add standing rules.</CardEmpty>
                    )
                  )}
                  {rev.instrEdit && (
                    <div className="ad-scrollwrap" style={{ position: 'relative' }}>
                      <textarea
                        value={rev.instrDraft ?? rev.instructions} rows={1}
                        ref={(el) => { instrThumb.attach(el); if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
                        onChange={(e) => up({ instrDraft: e.target.value })}
                        onScroll={instrThumb.onScroll}
                        placeholder="Markdown — one rule per line: “Prefer Python.” “Never delete files — move them to the Trash.”"
                        style={{
                          width: '100%', background: 'var(--bg-inset)', border: 'none',
                          color: 'var(--text-2)', font: "400 12.5px/1.7 var(--mono)", padding: '14px 20px',
                          resize: 'none', outline: 'none', display: 'block', minHeight: 92, maxHeight: 440, overflowY: 'auto',
                        }}
                        className="ad-scrollhide"
                      />
                      {instrThumb.node}
                    </div>
                  )}
                </SectionCard>

                {/* FRAMEWORK INSTRUCTIONS */}
                <SectionCard
                  eyebrow="FRAMEWORK INSTRUCTIONS"
                  open={rev.fwOpen}
                  onToggle={(o) => up({ fwOpen: o })}
                  hint="The built-in instructions your AI reads before writing anything, word for word. They update with the app, nothing for you to maintain."
                >
                    <CardMarkdown>
                      {fw
                        ? <Markdown text={fw} />
                        : <div style={{ font: "400 12px/1.65 var(--mono)", color: 'var(--text-2)' }}>Couldn’t load framework-instructions.md — reopen this page to retry.</div>}
                    </CardMarkdown>
                    <div style={{ padding: '0 20px 16px', font: cardHintFont, color: 'var(--text-muted)' }}>
                      framework-instructions.md — sent to your AI, word for word, with every drafting request. Updates with the app, nothing for you to maintain.
                    </div>
                </SectionCard>
              </div>

              {/* ===== right column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* BUILD & TEST — §11: one persistent panel merging the workflow's
                    sync state (above Steps: a sync rewrites the steps AND the param
                    definitions) and the draft test — sync, then test, in one place.
                    Quiet when fine, loud only when blocking: chat is the primary way
                    to build and test (§8 actions), so the build zone renders only
                    while drafting / syncing / out of sync, the in-sync states are a
                    single test zone with a ghost sync button on the action row, no
                    dot is ever green, and the one accent-primary button is Sync now
                    while out of sync. */}
                <div style={cardStyle}>
                  <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <Eyebrow>BUILD &amp; TEST</Eyebrow>
                  </div>
                  {/* build zone — states 1–3 only (drafting, sync in flight, out of
                      sync); an in-sync workflow shows no indicator at all */}
                  {(drafting || rev.syncBusy || outOfSync) && (
                  <div style={{ padding: '12px 20px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* the indicator sits in an 18px box matching the title's line-height,
                          so it stays centered on the first line even when the text wraps */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                        <span style={{ height: 18, display: 'flex', alignItems: 'center', flex: 'none' }}>
                          {/* §11: never a spinner here (the live surface is the chat
                              footer's action block) and never green — a faint dot
                              marks a job, amber marks out of sync */}
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: rev.syncBusy || drafting ? 'var(--text-faint)' : 'var(--amber)' }} />
                        </span>
                        <span style={{
                          minWidth: 0,
                          font: "500 12.5px/18px var(--sans)",
                          color: rev.syncBusy || drafting ? 'var(--text-muted)' : 'var(--text)',
                        }}>
                          {drafting ? stageLabel
                            : rev.syncBusy
                              ? `${selAgent ? `${agName(selAgent)} · ${dispModel(selAgent)}` : 'Your agent'} is rewriting the steps from your spec…`
                              : (rev.dirty ? 'The workflow is out of sync — these steps still match the old spec.'
                                : agentGap ? 'The workflow is out of sync — steps call an agent that isn’t enabled.'
                                  : 'The workflow is out of sync — steps use a secret that isn’t allowed.')}
                        </span>
                      </div>
                      {!rev.syncBusy && !drafting && outOfSync && (
                        <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '2px 0 0 16px' }}>
                          {rev.dirty ? 'Sync the steps to the new spec, then review them. Saving is locked until you do — nothing ships unreviewed.'
                            : agentGap ? 'Re-enable the agent, or sync the steps so they only call agents available here. Saving is locked until you do.'
                              : 'Re-allow the secret, or sync the steps so they only use secrets allowed here. Saving is locked until you do.'}
                        </div>
                      )}
                    </div>
                    {/* §11: no Cancel here — a running sync is cancelled from the
                        chat footer's action block; the button just disables */}
                    <button
                      className={outOfSync ? 'ad-btn-primary' : 'ad-btn-text dim'} disabled={syncDisabled}
                      onClick={() => void runSync()}
                      style={outOfSync ? { flex: 'none', whiteSpace: 'nowrap' } : panelBtnStyle}
                    >
                      {outOfSync ? 'Sync now' : 'Sync with spec'}
                    </button>
                  </div>
                  )}
                  {/* §11 test zone, out of sync: the test button disabled beside the
                      sync-first hint — but a still-executing test keeps its Cancel */}
                  {!rev.syncBusy && !drafting && outOfSync && (
                    <div style={{ padding: '12px 20px 14px', borderTop: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 12 }}>
                      {testLive ? (
                        <button className="ad-btn-text" onClick={cancelTest} style={panelBtnStyle}>
                          Cancel
                        </button>
                      ) : (
                        <button className="ad-btn-text" disabled style={panelBtnStyle}>
                          Test the draft
                        </button>
                      )}
                      <span style={{ minWidth: 0, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                        Sync first — a test executes the steps as generated from the spec.
                      </span>
                    </div>
                  )}
                  {/* test zone — in-sync states only. One hairline opens the zone;
                      the Test the draft disclosure on the action row
                      expands the test-setup section (param editors, trigger message,
                      Run test) as sub-blocks over dim dividers. */}
                  {!drafting && !rev.syncBusy && !outOfSync && (
                    <>
                      {/* §11: no build zone in sync — the header hairline opens the
                          single test zone directly */}
                      <div>
                        {test ? (
                          /* §11: status + progress only — the live step timeline,
                             logs, and result live on the test's execution page */
                          <div style={{ padding: '12px 20px 14px' }}>
                            {!testExec ? (
                              <Spinner size={13} />
                            ) : (
                              <>
                                {testLive ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: "400 12px var(--sans)", color: 'var(--text-2)' }}>
                                    <Spinner size={13} />
                                    <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                      Executing
                                      {testSteps.length > 0 ? ` — step ${Math.max(testLiveIdx, 0) + 1} of ${testSteps.length}` : ''}
                                      {testLiveIdx >= 0 ? ` · ${testSteps[testLiveIdx].name}` : ''}
                                    </span>
                                  </div>
                                ) : testExec.status === 'succeeded' ? (
                                  <GreenCheck label="Test succeeded — the memory copy was discarded." />
                                ) : testExec.status === 'failed' ? (
                                  <div className="ad-anim-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--amber)', fontSize: 13 }} />
                                    <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--amber)' }}>Test failed.</span>
                                  </div>
                                ) : (
                                  <div style={{ font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>
                                    Test {testExec.status}.
                                  </div>
                                )}
                                {testLive && testSteps.length > 0 && (
                                  <div style={{ margin: '11px 0 3px' }}>
                                    <ProgressBar percent={(testDone / testSteps.length) * 100} />
                                  </div>
                                )}
                                <div style={{ ...panelRowStyle, marginTop: 8 }}>
                                  {/* §11 state 5: Sync with spec, then the Test the draft
                                      setup toggle — Run test and View run live in the
                                      expanded setup section; only a live test keeps
                                      View run on the action row (the setup is hidden) */}
                                  {testLive ? (
                                    <>
                                      <button className="ad-btn-text" onClick={cancelTest} style={panelBtnStyle}>
                                        Cancel
                                      </button>
                                      {syncGhostBtn}
                                      <button
                                        className="ad-btn-text dim"
                                        onClick={() => go('execution', { executionId: test.executionId })}
                                        style={panelBtnStyle}
                                      >
                                        <i className="fa-solid fa-arrow-up-right-from-square" style={{ fontSize: 10 }} /> View run
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      {syncGhostBtn}
                                      {testToggleBtn('Test the draft')}
                                      {/* §11: sends the canned analyze chat message — the
                                          whole repair loop lives in the thread */}
                                      {testExec.status === 'failed' && !anyJobBusy && (
                                        <button className="ad-btn-text dim" onClick={runAnalyze} style={panelBtnStyle}>
                                          <i className="fa-solid fa-magnifying-glass" style={{ fontSize: 10 }} /> Analyze the failure
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        ) : rev.lastTest ? (
                          /* §11: persisted last-test summary (test.yaml) — a resumed
                             draft shows the outcome instead of throwing it away */
                          <div style={{ padding: '12px 20px 14px', font: "400 12px var(--sans)" }}>
                            {rev.lastTest.status === 'succeeded' ? (
                              <GreenCheck label={`Last test succeeded — ${rev.lastTest.when}.`} />
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--amber)', fontSize: 13 }} />
                                <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--amber)' }}>Last test failed — {rev.lastTest.when}.</span>
                              </div>
                            )}
                            <div style={{ ...panelRowStyle, marginTop: 8 }}>
                              {syncGhostBtn}
                              {testToggleBtn('Test the draft')}
                            </div>
                          </div>
                        ) : (
                          /* §11 in sync, never tested: the quiet setup toggle (testing
                             never shouts — a failed test never blocks saving) side by
                             side with the ghost sync, and the plain-words
                             status-and-side-effects line — which wraps below the
                             buttons when space runs out */
                          <div style={{ ...panelRowStyle, padding: '10px 20px 12px' }}>
                            {syncGhostBtn}
                            {testToggleBtn('Test the draft')}
                            <span style={{ flex: '1 1 320px', minWidth: 0, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                              In sync with the spec. A test executes the real steps on this Mac — emails send, files move; memory is a scratch copy.
                            </span>
                          </div>
                        )}
                      </div>
                      {/* §11 test-setup section — expanded by the Test the draft
                          disclosure toggle, hidden while a test executes;
                          shows every option at once, then the Run test row */}
                      {testOpen && !testLive && rev.params.length > 0 && testParams !== null && (
                        <div className="ad-anim-item" style={{ borderTop: '1px solid var(--hairline-dim)', ...lockStyle }}>
                          <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--hairline-dim)', font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--text-muted)' }}>
                            PARAMETER VALUES · THIS TEST ONLY
                          </div>
                          {testParams.map((p) => (
                            <ParamEditor
                              key={p.name} p={p}
                              upd={(patch) => setTestParams((ps) => ps && ps.map((x) => (x.name === p.name ? { ...x, ...patch } : x)))}
                            />
                          ))}
                        </div>
                      )}
                      {/* §11 trigger-message fields — below the param editors, same
                          setup section */}
                      {testOpen && !testLive && msgTriggers.length > 0 && testMock !== null && (
                        <div className="ad-anim-item" style={{ borderTop: '1px solid var(--hairline-dim)', ...lockStyle }}>
                          <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--hairline-dim)', font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--text-muted)' }}>
                            TRIGGER MESSAGE · THIS TEST ONLY
                          </div>
                          <div style={{ padding: '13px 20px 3px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {msgTriggers.length > 1 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                {msgTriggers.map((t, i) => (
                                  <button
                                    key={i}
                                    // .ad-btn-text supplies the resting/hover text colors for the
                                    // inactive tabs; the active tab pins accent inline
                                    className="ad-btn-text"
                                    onClick={() => setTestMock({ ...testMock, idx: i, sender: mockSenderSeed(t) })}
                                    style={{
                                      font: "500 12px var(--mono)", borderRadius: 6, padding: '3px 9px', whiteSpace: 'nowrap',
                                      ...(i === testMock.idx ? { color: 'var(--accent)' } : {}),
                                      background: i === testMock.idx ? 'var(--accent-chip-bg)' : 'rgba(255, 255, 255, 0.06)',
                                      transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter)',
                                    }}
                                  >
                                    {triggerLabel(t)}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ flex: 'none', width: 64, font: "600 10px var(--mono)", letterSpacing: '.07em', color: 'var(--text-faint)' }}>FROM</span>
                              <input
                                className="ad-input" value={testMock.sender}
                                onChange={(e) => setTestMock({ ...testMock, sender: e.target.value })}
                                style={{ flex: 1, minWidth: 0, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px' }}
                              />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ flex: 'none', width: 64, font: "600 10px var(--mono)", letterSpacing: '.07em', color: 'var(--text-faint)' }}>MESSAGE</span>
                              <input
                                className="ad-input" value={testMock.text}
                                placeholder="The message that starts this test"
                                onChange={(e) => setTestMock({ ...testMock, text: e.target.value })}
                                style={{ flex: 1, minWidth: 0, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px' }}
                              />
                            </div>
                          </div>
                          <div style={{ padding: '10px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                            Applies to this test only — nothing is saved; leave the message empty to test without one.{' '}
                            {msgTriggers[testMock.idx]?.kind === 'discord'
                              ? 'A step’s reply() posts to the real Discord channel.'
                              : 'A step’s reply() can’t send from a mocked iMessage — it logs the failed send instead.'}
                          </div>
                        </div>
                      )}
                      {/* §11 run row — closes the setup section: Run test is the only
                          control that starts a test; View run rides beside it when a
                          test record exists */}
                      {testOpen && !testLive && (
                        <div className="ad-anim-item" style={{ borderTop: '1px solid var(--hairline-dim)', padding: '4px 20px 10px', ...lockStyle }}>
                          <div style={panelRowStyle}>
                            <button
                              className="ad-btn-text"
                              disabled={rev.steps.length === 0 || busyRewrite}
                              onClick={() => void runTest()}
                              style={panelBtnStyle}
                            >
                              <i className="fa-solid fa-play" style={{ fontSize: 10 }} /> Run test
                            </button>
                            {(test || (!!rev.lastTest?.executionId && executions.some((e) => e.id === rev.lastTest!.executionId))) && (
                              <button
                                className="ad-btn-text dim"
                                onClick={() => go('execution', { executionId: test ? test.executionId : rev.lastTest!.executionId! })}
                                style={panelBtnStyle}
                              >
                                <i className="fa-solid fa-arrow-up-right-from-square" style={{ fontSize: 10 }} /> View run
                              </button>
                            )}
                          </div>
                          {(rev.params.length > 0 || msgTriggers.length > 0) && (
                            <div style={{ font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)', paddingBottom: 2 }}>
                              {rev.params.length > 0 && msgTriggers.length > 0
                                ? 'Values and the message apply to this test only — nothing is saved.'
                                : rev.params.length > 0
                                  ? 'These values apply to this test only — nothing is saved.'
                                  : 'The message applies to this test only — nothing is saved.'}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {/* STEPS */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <Eyebrow>STEPS · GENERATED</Eyebrow>
                  </div>
                  {/* §11 drafting-on-Review: static placeholder — drafting progress
                      lives in the thread; also shown on the create empty state */}
                  {(drafting || isCreateEmpty) && (
                    <div style={{ padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>
                      Steps appear here once the build finishes.
                    </div>
                  )}
                  {/* §11: a steps-call failure renders here; Rebuild runs a §8 sync against the landed spec */}
                  {rev.stepsErr && !rev.syncBusy && (
                    <div className="ad-anim-item" style={{
                      background: 'var(--notice-red-bg)', border: '1px solid var(--notice-red-border)',
                      borderRadius: 10, padding: '11px 14px', margin: '12px 14px',
                      display: 'flex', alignItems: 'flex-start', gap: 9,
                    }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ font: "500 12.5px var(--sans)", color: 'var(--text)' }}>
                          {rev.stepsErr.msg || 'The steps didn’t validate — try again or rephrase.'}
                        </div>
                        {(rev.stepsErr.detail ?? []).length > 0 && (
                          <div style={{ font: "400 11px/1.6 var(--mono)", color: 'var(--text-muted)', marginTop: 4 }}>
                            {(rev.stepsErr.detail ?? []).map((d, i) => <div key={i}>{d}</div>)}
                          </div>
                        )}
                      </div>
                      <button className="ad-btn-soft" onClick={() => void runSync()} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                        Rebuild the steps
                      </button>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', opacity: outOfSync || busyRewrite ? 0.45 : 1, transition: 'opacity var(--t-hover) var(--ease-enter)', marginBottom: -1 }}>
                    <StepsList steps={rev.steps} availAgents={availAgents} packages={rev.packages} />
                  </div>
                </div>

                {/* TRIGGERS — display-only (§11): what saving stores — drafted crons
                    merged over the saved list (§4.3); one-shots/on-off edited on the
                    automation page */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <Eyebrow>TRIGGERS</Eyebrow>
                  </div>
                  {drafting || isCreateEmpty ? (
                    <div style={{ padding: '13px 20px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>Triggers appear here once the build finishes.</div>
                  ) : (
                    <div style={{ padding: '13px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      {rev.triggers.map((t, i) => (
                        <span key={i} style={{
                          font: "500 12px var(--mono)", color: 'var(--accent)', background: 'var(--accent-chip-bg)',
                          borderRadius: 6, padding: '3px 9px', whiteSpace: 'nowrap',
                        }}>
                          {triggerLabel(t)}
                        </span>
                      ))}
                      <span style={{ font: "400 11.5px var(--sans)", color: 'var(--text-faint)' }}>
                        {rev.triggers.length > 0
                          ? 'Executes even when the app is closed. The schedule follows the spec — one-shots and on/off live on the automation page.'
                          : 'No triggers — executes only via Execute now and the menu bar.'}
                      </span>
                    </div>
                  )}
                </div>

                {/* PARAMETERS — display-only (§16): value input lives on the automation page,
                    test-only values in the Test card */}
                <div style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
                    <Eyebrow>PARAMETERS · YOUR AI ASKED FOR THESE</Eyebrow>
                    {!drafting && rev.params.length > 0 && (
                      <span style={{ font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--text-muted)' }}>READ-ONLY HERE</span>
                    )}
                  </div>
                  {drafting || isCreateEmpty ? (
                    <div style={{ padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>Parameters appear here once the build finishes.</div>
                  ) : rev.params.length === 0 ? (
                    <div style={{ padding: '14px 20px 16px', font: "400 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                      No settings needed — your AI didn’t ask for any.
                    </div>
                  ) : (
                    <>
                      {rev.params.map((p) => {
                        // §16: value summary — edit mode shows the live value (§5 name+kind
                        // match), create mode the drafted default
                        const live = auto?.params?.find((q) => q.name === p.name && q.kind === p.kind)
                        return (
                          <div key={p.name} style={{ padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                              <div style={{ font: "600 12.5px var(--sans)" }}>{p.label}</div>
                              <div style={{ font: "500 12px var(--mono)", color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>
                                {paramSummary(live ?? p)}
                              </div>
                            </div>
                            <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 2 }}>{p.help}</div>
                          </div>
                        )
                      })}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                        Values aren’t part of a version — set them on the automation page after saving. For a test, set test-only values in the Build & test panel — or ask your AI, which can change the parameter definitions and set test values when it runs a test.
                      </div>
                    </>
                  )}
                </div>

                {/* PACKAGES · PYTHON LIBRARIES (§6.2) — display-only, right column like
                    Triggers/Parameters: the drafting pipeline owns the list */}
                <div style={cardStyle}>
                  <button
                    className={`ad-btn-bare ad-focus-inset${rev.packages.length > 0 ? ' ad-hover-row' : ''}`}
                    disabled={rev.packages.length === 0}
                    onClick={() => rev.packages.length > 0 && up({ pkgSecOpen: !pkgSecOpenEff })}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 20px', cursor: rev.packages.length > 0 ? 'pointer' : 'default', userSelect: 'none' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      {rev.packages.length > 0 && (
                        <Caret open={pkgSecOpenEff} style={{ width: 14, flex: 'none', textAlign: 'center', color: 'var(--text-deco)' }} />
                      )}
                      <Eyebrow>PACKAGES · PYTHON LIBRARIES</Eyebrow>
                    </span>
                    {rev.packages.length > 0 && (
                      <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
                        {rev.packages.filter((p) => p.status === 'installed').length} of {rev.packages.length} installed
                        {rev.packages.filter((p) => p.latest).length > 0 &&
                          ` · ${rev.packages.filter((p) => p.latest).length} update${rev.packages.filter((p) => p.latest).length === 1 ? '' : 's'}`}
                      </span>
                    )}
                  </button>
                  {drafting || isCreateEmpty ? (
                    <div style={{ borderTop: '1px solid var(--hairline)', padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>Packages appear here once the build finishes.</div>
                  ) : rev.packages.length === 0 ? (
                    <div style={{ borderTop: '1px solid var(--hairline)', padding: '14px 20px 16px', font: "400 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                      No extra packages — the steps use only the built-in libraries.
                    </div>
                  ) : (<>
                    <Collapse open={!pkgSecOpenEff}>
                      {/* §11 status-aware collapsed line — the card only collapses when the list is non-empty */}
                      <button className="ad-btn-bare ad-focus-inset" onClick={() => up({ pkgSecOpen: true })} style={{ padding: '0 20px 13px 43px', font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {rev.packages.map((p) => p.pip).join(' · ')}
                      </button>
                    </Collapse>
                    <Collapse open={pkgSecOpenEff}>
                    <div style={{ borderTop: '1px solid var(--hairline)' }}>
                      {rev.packages.map((p) => (
                        <div key={p.pip} style={{ padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ flex: 1, minWidth: 0, font: "500 12px var(--mono)", color: 'var(--text)' }}>
                              {p.pip}
                              {p.version && (
                                <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>{p.version}</span>
                              )}
                              {p.latest && p.status !== 'installing' && (
                                <span style={{ color: 'var(--accent)', marginLeft: 8 }}>→ {p.latest}</span>
                              )}
                            </div>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', whiteSpace: 'nowrap', font: "600 10px var(--mono)",
                              color: p.status === 'installed' ? 'var(--green)'
                                : p.status === 'failed' ? 'var(--red)'
                                  : p.status === 'missing' ? 'var(--amber)' : 'var(--text-faint)' }}>
                              {p.status === 'installed' && <><i className="fa-solid fa-check" style={{ fontSize: 9 }} /> installed</>}
                              {p.status === 'installing' && 'installing…'}
                              {p.status === 'missing' && 'not installed'}
                              {p.status === 'failed' && 'failed'}
                              {!p.status && 'checking…'}
                            </span>
                            {p.latest && p.status !== 'installing' && (
                              <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite}
                                onClick={() => void updatePkgs([p.pip])} style={{ flex: 'none' }}>
                                Update
                              </button>
                            )}
                          </div>
                          {/* §11: the declaration's why — the card explains every install it asks the user to trust */}
                          {p.why && (
                            <div style={{ margin: '3px 0 0', font: "400 11px/1.5 var(--sans)", color: 'var(--text-muted)' }}>{p.why}</div>
                          )}
                          {p.status === 'failed' && p.error && (
                            <div style={{ margin: '6px 0 0', font: "400 10.5px/1.5 var(--mono)", color: 'var(--red-text)', overflowWrap: 'break-word' }}>{p.error}</div>
                          )}
                        </div>
                      ))}
                      {rev.packages.filter((p) => p.latest).length >= 2 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
                          <span style={{ flex: 1, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                            Newer versions are available. Updating applies to every automation that uses the package.
                          </span>
                          <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite}
                            onClick={() => void updatePkgs(rev.packages.filter((p) => p.latest).map((p) => p.pip))} style={{ flex: 'none' }}>
                            Update all
                          </button>
                        </div>
                      )}
                      {rev.packages.some((p) => p.status === 'missing' || p.status === 'failed') && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
                          <span style={{ flex: 1, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                            {rev.packages.some((p) => p.status === 'failed')
                              ? 'A package couldn’t be installed — check your connection, then retry. Saving still works; executions retry on their own too.'
                              : 'Some packages aren’t installed yet. Executions install them automatically — or install now.'}
                          </span>
                          <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite} onClick={() => void installPkgs()} style={{ flex: 'none' }}>
                            {rev.packages.some((p) => p.status === 'failed') ? 'Retry install' : 'Install'}
                          </button>
                        </div>
                      )}
                      <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
                        Your AI picked these Python packages for the steps. They install automatically — nothing for you to run.
                      </div>
                    </div>
                    </Collapse>
                  </>)}
                </div>

              </div>
            </div>
          </div>
          )}
        </div>
      </div>

      {confirmSpecCancel && (
        <ConfirmModal
          title="Discard your spec edits?"
          body="The changes you typed into the spec editor will be lost."
          confirmLabel="Discard edits"
          danger
          onConfirm={() => { setConfirmSpecCancel(false); up({ specEdit: false, specText: '', specTextOrig: '' }) }}
          onCancel={() => setConfirmSpecCancel(false)}
        />
      )}

    </div>
  )
}
