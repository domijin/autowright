// Shared step-list / param-editor module (§17): one StepList renders the
// read-only step rows on the §11 create/edit flow ('editor' variant — agent
// warning colors, package tags, inline step numbers) and the §9.2 automation
// detail page ('detail' variant — gutter numbers, accent-only tags), and one
// presentational ParamValueEditor renders the five §4.2 value kinds
// (toggle/list/kv/number/text) for both the editor's test-value card and the
// detail page's debounced ParamRow.
import React, { useEffect, useState } from 'react'
import type { Agent, PackageDep, ParamDef, Step } from './types'
import { Caret, Collapse, MiniBadge, PyCode, Tag, Toggle, agName, dispModel, stepTimeoutLabel, stepTimeoutTitle, validUrl } from './ui'

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

// A step's packages are its declared `packages` entries unioned with the §6.2
// declared imports appearing in its code (§4.1). Tags carry the declared
// entry's per-step `why`; a code-matched import with no entry falls back to
// the package declaration's general `why` in the tooltip.
export function stepPackageTags(s: Step, packages: PackageDep[]):
    { import: string; why?: string; version?: string }[] {
  const version = (imp: string) => packages.find((p) => p.import === imp)?.version
  const tags = (s.packages ?? []).map((e) => ({ ...e, version: version(e.import) }))
  for (const p of packages) {
    if (tags.some((t) => t.import === p.import)) continue
    if (new RegExp(`\\b(?:import|from)\\s+${p.import}\\b`).test(s.code || '')) {
      tags.push({ import: p.import, why: p.why, version: p.version })
    }
  }
  return tags
}

// ---------- step rows ----------

type StepRowProps = {
  step: Step
  i: number
  open: boolean
  onToggle: () => void
  last: boolean
} & (
  | { variant: 'editor'; availAgents: Agent[]; packages: PackageDep[] }
  | { variant: 'detail'; fallbackAgent: string }
)

function StepRow(props: StepRowProps) {
  const { step, i, open, onToggle, last } = props
  const stepSecrets = stepSecretTags(step)
  if (props.variant === 'editor') {
    const { availAgents, packages } = props
    // §4.1: one tag per entry in the step's `agents` list; an empty list falls
    // back to the automation's first enabled agent ("no agent" when none is).
    const agentTags: { nm: string | null; why?: string; ag: Agent | null }[] = step.agent
      ? ((step.agents ?? []).length
        ? (step.agents ?? []).map((e) => ({ nm: e.name, why: e.why, ag: availAgents.find((g) => agName(g) === e.name) ?? null }))
        : [{ nm: availAgents[0] ? agName(availAgents[0]) : null, ag: availAgents[0] ?? null }])
      : []
    const stepPkgs = stepPackageTags(step, packages)
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
                  title={`This step uses the ${p.import} Python package${p.version ? `, version ${p.version}` : ''} — ${p.why || 'installed automatically'}`}
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
  // 'detail' variant — §9.2: gutter step number, accent-only agent tags
  const agentTags = step.agents?.length ? step.agents : [{ name: props.fallbackAgent }]
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--hairline-dim)' }}>
      <button className="ad-btn-bare ad-hover-row ad-focus-inset" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', cursor: 'pointer' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11, color: 'var(--text-faint)', width: 14, flex: 'none' }}>{i + 1}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{step.name}</span>
            {step.agent && agentTags.map((t) => (
              <Tag
                key={t.name}
                icon="fa-microchip"
                c="var(--accent)"
                title={t.why || step.why || `This step calls the ${t.name} AI agent.`}
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
              title={stepTimeoutTitle(step)}
              style={{ background: 'var(--hairline-dim)', border: '1px solid var(--border-btn)' }}
            >
              {stepTimeoutLabel(step)}
            </Tag>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 1 }}>{step.description}</div>
        </div>
        <span title={open ? 'Hide script' : 'View script'} style={{ color: 'var(--text-deco)', flex: 'none' }}>
          <Caret open={open} openDeg={180} closedDeg={0} style={{ fontSize: 12 }} />
        </span>
      </button>
      <Collapse open={open}>
        {step.agent && step.why && (
          <div style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', borderTop: '1px solid var(--hairline-dim)',
            background: 'var(--accent-hint-bg)', padding: '10px 18px 10px 45px',
          }}>
            <i className="fa-solid fa-microchip" style={{ color: 'var(--accent-hover)', fontSize: 10, marginTop: 3 }} />
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-muted)' }}>
              <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>Why an agent: </span>{step.why}
            </span>
          </div>
        )}
        <PyCode code={step.code} style={{
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
export type StepListProps = { steps: Step[] } & (
  | { variant: 'editor'; availAgents: Agent[]; packages: PackageDep[] }
  | { variant: 'detail'; fallbackAgent: string }
)

export function StepList(props: StepListProps) {
  const { steps } = props
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  // The editor's list resets its open set when a sync/undo swaps the steps;
  // the detail page's list keeps its open state across store refreshes.
  const editor = props.variant === 'editor'
  useEffect(() => { if (editor) setOpen(new Set()) }, [steps]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  return (
    <>
      {steps.map((s, i) => (
        <StepRow
          {...props}
          key={i} step={s} i={i}
          open={open.has(i)}
          onToggle={() => toggle(i)}
          last={i === steps.length - 1}
        />
      ))}
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
              <button className="ad-btn-x" onClick={() => setLines(lines.filter((_, j) => j !== li), true)}>
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
          <button className="ad-btn-x" onClick={() => setRows(rows.filter((_, j) => j !== ri), true)}>
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
