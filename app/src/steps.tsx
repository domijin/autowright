// Shared step-list / param-editor module (§17): one StepList renders the
// read-only step rows and the §9.2 step-script modal on the §11 create/edit
// flow ('editor' variant — agent warning colors, package facts, inline step
// numbers) and the §9.2 automation detail page ('detail' variant — gutter
// numbers, accent-only tags), and one presentational ParamValueEditor renders
// the five §4.2 value kinds (toggle/list/kv/number/text) for both the
// editor's test-value card and the detail page's debounced ParamRow.
import React, { useEffect, useMemo, useState } from 'react'
import { usePlatformCopy } from './platformCopy'
import type { Agent, PackageDep, ParamDef, SecretMeta, Step, UnresolvedRefs } from './types'
import { MiniBadge, Modal, PyCode, ScrollArea, Tag, Toggle, agName, dispModel, stepRetriesLabel, stepRetriesTitle, stepTimeoutLabel, stepTimeoutTitle, validUrl } from './ui'

// §4.1/§6.1 code-reference scan: literal quoted uuid subscripts only.
const SECRET_REF_RE = /\bsecrets\[\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']\s*\]/g
export const shortId = (id: string) => `${id.slice(0, 8)}…`

// A step's secrets are its declared `secrets` entry ids unioned with the
// literal secrets["<id>"] references in its code (§4.1). Tags carry the
// declared entry's per-use `why`; a code-referenced id with no entry has none.
// Display resolves ids to LIVE names; a dangling id renders the red deleted
// state (missing: true) — under the archive record's NAME when the
// automation's §4.1 unresolvedReferences carries the id (imported: true),
// else under its short id prefix.
export function stepSecretTags(s: Step, secrets: SecretMeta[], unresolved?: UnresolvedRefs):
    { id: string; name: string; missing: boolean; imported?: boolean; why?: string }[] {
  const resolve = (id: string, why?: string) => {
    const sec = secrets.find((z) => z.id === id)
    const un = !sec && unresolved?.[id]?.kind === 'secret' ? unresolved[id] : null
    return {
      id, name: sec ? sec.name : un ? un.name : shortId(id), missing: !sec,
      ...(un ? { imported: true } : {}), ...(why ? { why } : {}),
    }
  }
  const tags = (s.secrets ?? []).map((e) => resolve(e.id, e.why))
  for (const m of (s.code || '').matchAll(SECRET_REF_RE)) {
    if (!tags.some((t) => t.id === m[1])) tags.push(resolve(m[1]))
  }
  return tags
}
// The step's referenced secret ids — declared entries plus code references.
export function stepSecretIds(s: Step): string[] {
  const ids = (s.secrets ?? []).map((e) => e.id)
  for (const m of (s.code || '').matchAll(SECRET_REF_RE)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

// A step's packages are its declared `packages` entries unioned with the §6.2
// declared imports appearing in its code (§4.1). Tags carry the declared
// entry's per-step `why`, falling back to the package declaration's general
// `why` (§4.1); with neither, the tooltip drops its why clause.
export function stepPackageTags(s: Step, packages: PackageDep[]):
    { import: string; why?: string; version?: string }[] {
  const version = (imp: string) => packages.find((p) => p.import === imp)?.version
  const general = (imp: string) => packages.find((p) => p.import === imp)?.why
  const tags = (s.packages ?? []).map((e) => ({ ...e, why: e.why || general(e.import), version: version(e.import) }))
  for (const p of packages) {
    if (tags.some((t) => t.import === p.import)) continue
    if (new RegExp(`\\b(?:import|from)\\s+${p.import}\\b`).test(s.code || '')) {
      tags.push({ import: p.import, why: p.why, version: p.version })
    }
  }
  return tags
}

// ---------- step rows + step-script modal ----------

// One descriptor per step fact, shared by the row's Tag chips and the
// step-script modal's tag row — both render the same chips with the same
// tooltip sentences, so row and modal can never drift. `rowHidden` marks
// modal-only facts (§9.2: the detail rows carry no package chips).
type StepTagDesc = {
  key: string
  icon: string
  label: string
  title: string
  tone: 'accent' | 'plain' | 'red'
  rowHidden?: boolean
}

// Per-variant Tag visuals for a tone; the two variants keep their historic
// colors (editor agent chips use --accent-hover, detail uses --accent; detail
// plain chips leave the Tag's default text color).
const tagVisual = (tone: StepTagDesc['tone'], editor: boolean): { c?: string; style: React.CSSProperties } =>
  tone === 'red'
    ? { c: 'var(--red-text)', style: { background: 'var(--red-bg)', border: '1px solid oklch(0.7 0.19 25 / .4)' } }
    : tone === 'accent'
      ? { c: editor ? 'var(--accent-hover)' : 'var(--accent)', style: { background: 'var(--accent-chip-bg)', border: '1px solid var(--border-card-hover)' } }
      : { ...(editor ? { c: 'var(--text-muted)' } : {}), style: { background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' } }

// The full ordered fact list for one step (§9.2/§11): agents, secrets,
// packages (rowHidden on the detail variant), time limit, retries.
function stepTagDescs(props: StepListProps, step: Step, copy: ReturnType<typeof usePlatformCopy>): StepTagDesc[] {
  const unres = props.unresolvedReferences
  // §5.1: a dangling agent id carried by unresolvedReferences shows the
  // archive record's name with the imported-file sentence.
  const unresAgent = (id: string) => (unres?.[id]?.kind === 'agent' ? unres[id] : null)
  const descs: StepTagDesc[] = []
  if (props.variant === 'editor' && step.agent) {
    // §4.1: one tag per entry in the step's `agents` list, resolved BY ID to
    // the live agent (a rename updates the tag); an empty list falls
    // back to the automation's first enabled agent ("no agent" when none is).
    // enabled=false + ag → exists but not enabled; ag=null → deleted agent.
    // §11: why = the entry's role note, falling back to the step's own why.
    const entries: { nm: string | null; why?: string; ag: Agent | null; enabled: boolean; imported?: boolean }[] =
      (step.agents ?? []).length
        ? (step.agents ?? []).map((e) => {
          const ag = props.allAgents.find((g) => g.id === e.id) ?? null
          const un = ag ? null : unresAgent(e.id)
          return {
            nm: ag ? agName(ag) : un ? un.name : shortId(e.id), why: e.why, ag,
            enabled: props.availAgents.some((g) => g.id === e.id), ...(un ? { imported: true } : {}),
          }
        })
        : [{ nm: props.availAgents[0] ? agName(props.availAgents[0]) : null, ag: props.availAgents[0] ?? null, enabled: !!props.availAgents[0] }]
    entries.forEach(({ nm, why, ag, enabled, imported }, j) => descs.push({
      key: `agent-${j}`, icon: 'fa-microchip', label: nm ?? 'no agent',
      tone: ag && enabled ? 'accent' : 'red',
      title: ag && enabled
        ? `This step calls ${agName(ag)} · ${dispModel(ag)} mid-execution${(why || step.why) ? ` — ${why || step.why}` : ''}`
        : ag
          ? `${agName(ag)} isn’t enabled for steps — this step would fail`
          : imported
            ? `This step calls ${nm} from the imported file. No agent on this ${copy.machine} matched it, so this step would fail.`
            : nm
              ? 'This step calls an agent that no longer exists — this step would fail'
              : 'No agent is enabled for steps — this step would fail',
    }))
  }
  if (props.variant === 'detail' && step.agent) {
    // §9.2: accent-only agent tags; entry ids resolve to LIVE names (a rename
    // updates the tag); a dangling id renders the red deleted state, under the
    // archive record's name when unresolvedReferences carries it, else the
    // short id prefix.
    const entries: { name: string; why?: string; missing: boolean; imported?: boolean }[] = step.agents?.length
      ? step.agents.map((e) => {
        const ag = props.agents.find((g) => g.id === e.id)
        const un = ag ? null : unresAgent(e.id)
        return {
          name: ag ? agName(ag) : un ? un.name : shortId(e.id), why: e.why, missing: !ag,
          ...(un ? { imported: true } : {}),
        }
      })
      : [{ name: props.fallbackAgent, missing: false }]
    entries.forEach((t, j) => descs.push({
      key: `agent-${j}`, icon: 'fa-microchip', label: t.name, tone: t.missing ? 'red' : 'accent',
      title: t.missing
        ? t.imported
          ? `This step calls ${t.name} from the imported file. No agent on this ${copy.machine} matched it, so this step would fail.`
          : 'This step calls an agent that no longer exists — this step would fail'
        : `This step calls the ${t.name} AI agent${(t.why || step.why) ? ` — ${t.why || step.why}` : ''}`,
    }))
  }
  for (const t of stepSecretTags(step, props.secrets, unres)) {
    descs.push({
      key: `secret-${t.id}`, icon: 'fa-key', label: t.name, tone: t.missing ? 'red' : 'plain',
      title: t.missing
        ? t.imported
          ? `This step uses ${t.name} from the imported file. No secret on this ${copy.machine} matched it, so this step would fail.`
          : 'This step uses a secret that no longer exists — this step would fail'
        : `This step uses the ${t.name} secret from your ${copy.secretStore}${t.why ? ` — ${t.why}` : ''}`,
    })
  }
  // §9.2: package facts feed both variants' modals — the editor from the
  // draft's declared packages, the detail modal from the automation record's
  // §6.2 list — but the detail ROWS carry no package chips (rowHidden).
  for (const p of stepPackageTags(step, props.packages)) {
    descs.push({
      key: `pkg-${p.import}`, icon: 'fa-cube', label: p.import, tone: 'plain',
      title: `This step uses the ${p.import} Python package${p.version ? `, version ${p.version}` : ''}${p.why ? ` — ${p.why}` : ''}`,
      ...(props.variant === 'detail' ? { rowHidden: true } : {}),
    })
  }
  descs.push({ key: 'timeout', icon: 'fa-clock', label: stepTimeoutLabel(step), title: stepTimeoutTitle(step), tone: 'plain' })
  const retries = stepRetriesLabel(step)
  if (retries) {
    descs.push({ key: 'retries', icon: 'fa-rotate-right', label: retries, title: stepRetriesTitle(step), tone: 'plain' })
  }
  return descs
}

// §9.2/§11 step row: the whole row is a click target opening the step-script
// modal; the only right-edge affordance is the expand glyph ("View script"
// tooltip, no text label, so narrow windows don't crush the middle column).
function StepRow({ step, i, last, editor, tags, onOpen }: {
  step: Step; i: number; last: boolean; editor: boolean; tags: StepTagDesc[]; onOpen: () => void
}) {
  const tagNodes = tags.filter((t) => !t.rowHidden).map((t) => {
    const v = tagVisual(t.tone, editor)
    return <Tag key={t.key} icon={t.icon} c={v.c} title={t.title} style={v.style}>{t.label}</Tag>
  })
  const glyph = (
    <span title="View script" style={{ color: 'var(--text-deco)', flex: 'none' }}>
      <i className="fa-solid fa-expand" style={{ fontSize: 12 }} />
    </span>
  )
  if (editor) {
    // §11: inline step-number prefix, no gutter column.
    return (
      <div style={{ borderBottom: '1px solid var(--hairline-dim)' }}>
        <button
          className="ad-btn-bare ad-focus-inset ad-hover-row"
          onClick={onOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ font: "600 13px var(--sans)" }}>
                <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>{i + 1}.</span> {step.name}
              </div>
              {tagNodes}
            </div>
            <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)' }}>{step.description}</div>
          </div>
          {glyph}
        </button>
      </div>
    )
  }
  // 'detail' variant — §9.2: gutter step number.
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--hairline-dim)' }}>
      <button className="ad-btn-bare ad-hover-row ad-focus-inset" onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', cursor: 'pointer' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }}>{i + 1}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{step.name}</span>
            {tagNodes}
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>{step.description}</div>
        </div>
        {glyph}
      </button>
    </div>
  )
}

// Left / right arrow keys flip the viewed step. Rendered inside the Modal so
// it can see `closing`: the children stay mounted through the ~200 ms exit
// animation, and an arrow press then would flip the step under the fading
// card — same guard shape as the Modal's own Escape handler.
function StepArrowKeys({ i, count, closing, onNav }: {
  i: number; count: number; closing: boolean; onNav: (i: number) => void
}) {
  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); onNav(i - 1) }
      if (e.key === 'ArrowRight' && i < count - 1) { e.preventDefault(); onNav(i + 1) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [i, count, closing]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// §9.2 step-script modal: one large Modal card, content column fixed at 82vh
// so flipping between steps never resizes the frame. No header row: the card
// is one overlay-scrollbar pane leading with the "STEP N OF M" eyebrow and
// the step name (they scroll away with the content), then the description,
// the tag row (the same §14 chips the step row carries, tooltips holding the
// detail, plus the detail variant's modal-only package chips), and the script
// inside a content-sized inset code card whose header line carries the §4.1
// version-folder filename (its one appearance in the UI) and a line count. Prev / next / close float
// as a cluster pinned to the card's top-right corner on a solid backdrop,
// outside the §14 keyed fade that remounts the pane (and resets its scroll)
// when the step switches, so the buttons never flash while flipping.
function StepModal({ steps, i, editor, tags, onNav, onClose }: {
  steps: Step[]; i: number; editor: boolean; tags: StepTagDesc[]
  onNav: (i: number) => void; onClose: () => void
}) {
  const step = steps[i]
  // A script's single trailing final newline is neither rendered nor counted —
  // it would show as a blank last line and count one line too many (§9.2).
  const code = (editor ? (step.code || '# script not written yet') : step.code || '').replace(/\n$/, '')
  const lineCount = code.split('\n').length
  return (
    <Modal
      onClose={onClose} width={1000} ariaLabel={`Step ${i + 1} of ${steps.length}: ${step.name}`}
      cardStyle={{ width: 'min(1000px, 92vw)', overflow: 'hidden' }}
    >
      {(close, closing) => (
        <div className="ad-stepmodal" style={{ height: '82vh', position: 'relative', minWidth: 0 }}>
          <StepArrowKeys i={i} count={steps.length} closing={closing} onNav={onNav} />
          <div style={{
            position: 'absolute', top: 12, right: 14, zIndex: 1,
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--bg-menu)', borderRadius: 8, padding: 2,
          }}>
            <button className="ad-btn-icon" aria-label="Previous step" disabled={i === 0} onClick={() => onNav(i - 1)}>
              <i className="fa-solid fa-chevron-left" />
            </button>
            <button className="ad-btn-icon" aria-label="Next step" disabled={i === steps.length - 1} onClick={() => onNav(i + 1)}>
              <i className="fa-solid fa-chevron-right" />
            </button>
            <button className="ad-btn-icon" aria-label="Close" onClick={close}>
              <i className="fa-solid fa-xmark" style={{ fontSize: 14 }} />
            </button>
          </div>
          <ScrollArea key={i} className="ad-anim-fade" wrapStyle={{ height: '100%' }}>
            <div style={{ padding: '16px 20px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ paddingRight: 108 }}>
                <div style={{ font: "600 10.5px var(--mono)", letterSpacing: '.08em', color: 'var(--text-faint)' }}>
                  STEP {i + 1} OF {steps.length}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, marginTop: 3, letterSpacing: '-.01em' }}>
                  {step.name}
                </div>
              </div>
              {step.description && (
                <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}>{step.description}</div>
              )}
              {/* §9.2 tag row: the same chips the step row carries (tooltips
                  hold the detail), plus package chips in the detail modal. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {tags.map((t) => {
                  const v = tagVisual(t.tone, editor)
                  return <Tag key={t.key} icon={t.icon} c={v.c} title={t.title} style={v.style}>{t.label}</Tag>
                })}
              </div>
            </div>
            <div style={{
              margin: '0 20px 20px', border: '1px solid var(--hairline-dim)', borderRadius: 8,
              background: 'var(--bg-code)', overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                padding: '8px 16px', borderBottom: '1px solid var(--hairline-dim)',
              }}>
                <span style={{ font: "500 10.5px var(--mono)", letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                  {step.file || 'script'}
                </span>
                <span style={{ font: "500 10.5px var(--mono)", color: 'var(--text-faint)', flex: 'none' }}>
                  {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                </span>
              </div>
              <PyCode code={code} style={{
                margin: 0, padding: '14px 16px', font: "400 11.5px/1.75 var(--mono)", color: 'var(--code-text)',
                whiteSpace: 'pre-wrap', overflowWrap: 'break-word', minWidth: 0,
              }} />
            </div>
          </ScrollArea>
        </div>
      )}
    </Modal>
  )
}

// Holds the viewed-step index locally so opening the modal re-renders only
// this list. One step shows at a time; prev / next flips inside the modal.
export type StepListProps = { steps: Step[]; secrets: SecretMeta[]; packages: PackageDep[]; unresolvedReferences?: UnresolvedRefs } & (
  | { variant: 'editor'; availAgents: Agent[]; allAgents: Agent[] }
  | { variant: 'detail'; agents: Agent[]; fallbackAgent: string }
)

export function StepList(props: StepListProps) {
  const { steps } = props
  // §9 per-OS copy rule: the secret-store name in the secret fact sentences.
  const copy = usePlatformCopy()
  const [viewing, setViewing] = useState<number | null>(null)
  // §11: a sync/undo that swaps the steps closes the editor's modal — the
  // index would no longer name the same step. The detail page's modal stays
  // open across store refreshes.
  const editor = props.variant === 'editor'
  useEffect(() => { if (editor) setViewing(null) }, [steps]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = viewing !== null && viewing < steps.length ? viewing : null
  // Deriving the facts scans every script for secret references and package
  // imports, so it only reruns when the steps or the records they resolve
  // against change — an unrelated re-render (the §11 job poll ticks the editor
  // twice a second with the modal open) reuses the descriptors. Rows and modal
  // read the same entry, so they still can never drift.
  const { secrets, packages, unresolvedReferences } = props
  const tagsByStep = useMemo(
    () => steps.map((s) => stepTagDescs(props, s, copy)),
    // The last two are the per-variant agent inputs: the editor resolves entry
    // ids against allAgents and checks them against availAgents, the detail
    // variant against agents with fallbackAgent for an empty list.
    [steps, secrets, packages, unresolvedReferences, editor, copy,
      editor ? props.allAgents : props.agents, editor ? props.availAgents : props.fallbackAgent],
  ) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {steps.map((s, i) => (
        <StepRow
          key={i} step={s} i={i}
          last={i === steps.length - 1}
          editor={editor}
          tags={tagsByStep[i]}
          onOpen={() => setViewing(i)}
        />
      ))}
      {current !== null && (
        <StepModal
          steps={steps} i={current} editor={editor}
          tags={tagsByStep[current]}
          onNav={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}

// ---------- param value editor (§4.2 kinds) ----------

// Presentational value controls for the five param kinds. The wrappers own
// layout (label/help rows), state, and commit semantics: the §11 test-value
// card ('draft' variant) writes value + default immediately into the draft;
// the §9.2 ParamRow ('detail' variant) keeps its local drafts and
// debounce/PATCH plumbing and passes them through here.
export function ParamValueEditor({ p, variant, on, lines, rows, value, setOn, setLines, setRows, setText, setNumber, onFocus, onBlur }: {
  p: ParamDef
  variant: 'draft' | 'detail'
  on: boolean
  lines: string[]
  rows: { key: string; value: string }[]
  value: string // the rendered text/number input value
  setOn: (v: boolean) => void
  setLines: (next: string[], removal?: boolean) => void // removal → the detail variant commits at once
  setRows: (next: { key: string; value: string }[], removal?: boolean) => void
  setText: (v: string) => void
  setNumber: (digits: string) => void
  onFocus?: () => void // detail: text/number focus tracking
  onBlur?: () => void // draft: number clamp; detail: flush (list/kv) or flush+reset (text/number)
}) {
  const detail = variant === 'detail'
  // 'draft' base input style (the create/edit flow's test-value editors)
  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, color: 'var(--text)', font: "400 12px var(--mono)", padding: '7px 10px',
  }
  if (p.kind === 'toggle') {
    return <Toggle on={on} onChange={setOn} />
  }
  if (p.kind === 'number') {
    return (
      <input
        className="ad-input"
        value={value}
        {...(detail ? { inputMode: 'numeric' as const } : {})}
        onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ''))}
        onFocus={onFocus}
        onBlur={onBlur}
        style={detail
          ? { width: 70, fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 13, textAlign: 'center', padding: '6px 10px' }
          : { ...inputStyle, flex: 'none', width: 84, textAlign: 'right' }}
      />
    )
  }
  if (p.kind === 'text') {
    return (
      <input
        className="ad-input"
        value={value} placeholder={detail ? p.placeholder ?? '' : p.placeholder}
        onChange={(e) => setText(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        style={detail
          ? { width: '100%', maxWidth: 520, fontSize: 12.5, padding: '8px 12px' }
          : { ...inputStyle, width: '100%' }}
      />
    )
  }
  if (p.kind === 'list') {
    const good = lines.filter((l) => l.trim() && validUrl(l)).length
    const bad = lines.filter((l) => l.trim() && !validUrl(l)).length
    return (
      <div style={detail
        ? { width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }
        : { display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lines.map((ln, li) => {
          const invalid = !!p.validate && ln.trim() !== '' && !validUrl(ln)
          return (
            <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className={`ad-input${invalid ? ' invalid' : ''}`}
                value={ln}
                onChange={(e) => setLines(lines.map((z, j) => (j === li ? e.target.value : z)))}
                onBlur={detail ? onBlur : undefined}
                style={detail
                  ? {
                    flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 12, padding: '7px 10px',
                    ...(invalid ? { color: 'var(--red-text)' } : {}),
                  }
                  : { ...inputStyle, ...(invalid ? { color: 'var(--red-text)' } : {}) }}
              />
              {invalid && (
                <MiniBadge c="var(--red-text)" bg="var(--red-bg)" style={detail ? { flex: 'none' } : undefined}>NOT A VALID LINK</MiniBadge>
              )}
              <button className="ad-btn-x" onClick={() => setLines(lines.filter((_, j) => j !== li), true)} aria-label="Remove line">
                <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
              </button>
            </div>
          )
        })}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button className="ad-btn-dashed" onClick={() => setLines([...lines, ''])}>
            + Add line
          </button>
          {detail ? (
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)' }}>
              {lines.length}{p.validate ? ` lines · ${good} valid links${bad ? ` · ${bad} needs attention` : ''}` : ' entries'}
            </span>
          ) : p.validate ? (
            <span style={{ font: "500 11px var(--mono)", color: 'var(--text-faint)' }}>
              {lines.length} lines · {good} valid links{bad > 0 ? ` · ${bad} needs attention` : ''}
            </span>
          ) : null}
        </div>
      </div>
    )
  }
  // kv
  return (
    <div style={detail
      ? { width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }
      : { display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, ri) => (
        <div key={ri} style={detail ? { display: 'flex', gap: 6 } : { display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="ad-input"
            value={r.key} placeholder={detail ? undefined : 'Key'}
            onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, key: e.target.value } : z)))}
            onBlur={detail ? onBlur : undefined}
            style={detail
              ? { flex: 1.3, minWidth: 0, color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: 11.5, padding: '7px 10px' }
              : { ...inputStyle, flex: '0 1 38%' }}
          />
          <input
            className="ad-input"
            value={r.value} placeholder={detail ? undefined : 'Value'}
            onChange={(e) => setRows(rows.map((z, j) => (j === ri ? { ...z, value: e.target.value } : z)))}
            onBlur={detail ? onBlur : undefined}
            style={detail
              ? { flex: 1, minWidth: 0, fontSize: 12, padding: '7px 10px' }
              : inputStyle}
          />
          <button className="ad-btn-x" onClick={() => setRows(rows.filter((_, j) => j !== ri), true)} aria-label={r.key.trim() ? `Remove ${r.key}` : 'Remove row'}>
            <i className="fa-solid fa-xmark" style={{ fontSize: 12 }} />
          </button>
        </div>
      ))}
      <button className="ad-btn-dashed" onClick={() => setRows([...rows, { key: '', value: '' }])}>
        {detail ? '+ Add row' : '+ Add pair'}
      </button>
    </div>
  )
}
