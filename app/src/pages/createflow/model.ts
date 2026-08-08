// §11 create/edit flow — the pure editor model: the Rev working copy, its
// seeds, draft serialization, the §4.3 trigger merge, spec-text helpers, and
// the chat-thread/blocker helpers. No React here — everything is plain data
// in/data out, unit-tested via the CreateFlow page's re-exports.
import type { Agent, Automation, Blocker, ChatEntry, DraftPayload, DraftTest, DraftTrigger, PackageDep, ParamDef, SpecBlock, Step, Trigger, VersionInfo } from '../../types'
import { stepSecretNames, stepSecretTags } from '../../steps'

// The step-secret scanners live in the shared step-list module (../../steps)
// — the automation detail page reads the same tags — and re-export here so
// the model stays the one import for the editor's pure helpers.
export { stepSecretNames, stepSecretTags }

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

export const blockerLine = (b: Blocker) => `${b.reason.trim()} — ${b.fix.trim()}`

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

export interface SecretRef { name: string; steps: number[] }
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

// "steps 1, 3" formatter for the grant warning copy
export const stepList = (idx: number[]) => idx.map((i) => i + 1).join(', ')

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
// pre-fill). Loaded from the backend (GET /instructions) once per app session — the page
// fills this cache so both cards always show exactly what the agent is told, and the
// seeds below pre-fill new drafts from it.
export const instructionCache = { framework: null as string | null, defaultBuild: '' }

// ---------- review working-copy state ----------

export interface Rev {
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
    instructions: instructionCache.defaultBuild,
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
    // Backend seeds instructions from default-build-instructions.md; the §19
    // shared draft serializer answers "" when the container holds none.
    instructions: d.instructions || instructionCache.defaultBuild,
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
  // §4.4/§19: the draft container payload when one is kept, else the current version
  const src: Pick<DraftPayload, 'spec' | 'steps' | 'instructions' | 'notes' | 'params' | 'packages'> =
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

export function loadVersionInto(r: Rev, snap: { spec: SpecBlock[]; steps: Step[]; instructions: string; notes?: string; params?: VersionInfo['params']; packages?: VersionInfo['packages'] }, viewing: Rev['viewing']): Rev {
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
export function holdsDraftEdits(r: Rev, a: Automation): boolean {
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
