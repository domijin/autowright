// §11 Review grid cards. LeftColumn: spec, notes, agents, secrets, build
// instructions, framework — all through the one shared SectionCard template
// (header row, status-aware collapsed line, body top-hairline). RightCards:
// the display-only steps / triggers / parameters / packages cards under the
// Build & test panel. The page shell wires state and derived gating in.
import React, { useState } from 'react'
import { SecretModal } from '../../SecretModal'
import { api } from '../../api'
import { useStore } from '../../store'
import { useTriggerPreview } from '../../triggers'
import { StepList } from '../../steps'
import type { Agent, SecretMeta } from '../../types'
import { BtnPrimary, Caret, Collapse, Eyebrow, ScrollArea, agName, dispModel, paramSummary, useOverlayThumb } from '../../ui'
import { Markdown, SpecMarkdown } from '../../result'
import { type Rev, type SecretRef, applyTestValues, instrToMd, instructionCache, specToText, stepList, textToSpec } from './model'

export const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden',
}

// §11: one text style for a card's collapsed hint AND its in-card empty
// states — the description never changes size between collapsed and open
export const cardHintFont = "400 11.5px/1.5 var(--sans)"

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
        className="ad-hover-row ad-focus-inset"
        // §9: keyboard parity for a clickable row — no nested control here,
        // so the row itself carries the button semantics.
        role="button" tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}
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

// ---------- left column ----------

export interface LeftColumnProps {
  rev: Rev
  up: (patch: Partial<Rev>) => void
  fw: string
  isEdit: boolean
  isCreateEmpty: boolean
  busyRewrite: boolean
  viewingOld: boolean
  testLive: boolean
  lockStyle?: React.CSSProperties
  agents: Agent[]
  secrets: SecretMeta[]
  availAgents: Agent[]
  agentStepIdx: number[]
  agWarn: boolean
  agNone: boolean
  agNotEnabled: SecretRef[]
  agMissing: SecretRef[]
  agFallbackIdx: number[]
  secWarn: boolean
  secNotAllowed: SecretRef[]
  secMissing: SecretRef[]
  secRefs: SecretRef[]
  specOpenEff: boolean
  agSecOpenEff: boolean
  secSecOpenEff: boolean
  instrOpenEff: boolean
  notesOpenEff: boolean
  showToast: (msg: string, ms?: number) => void
  setConfirmSpecCancel: (v: boolean) => void
}

export function LeftColumn({
  rev, up, fw, isEdit, isCreateEmpty, busyRewrite, viewingOld, testLive, lockStyle,
  agents, secrets, availAgents, agentStepIdx,
  agWarn, agNone, agNotEnabled, agMissing, agFallbackIdx,
  secWarn, secNotAllowed, secMissing, secRefs,
  specOpenEff, agSecOpenEff, secSecOpenEff, instrOpenEff, notesOpenEff,
  showToast, setConfirmSpecCancel,
}: LeftColumnProps) {
  // §11 Secrets card New secret modal — a secret saved here is auto-allowed.
  const [secretModal, setSecretModal] = useState(false)
  // §14 overlay-scrollbar thumb for the spec editor textarea (a textarea can't
  // host the thumb node itself, so the pane wires it up via this hook).
  const specThumb = useOverlayThumb()
  const instrThumb = useOverlayThumb()
  const notesThumb = useOverlayThumb()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* SPEC */}
      <SectionCard
        eyebrow="SPEC"
        open={specOpenEff}
        // §11: inert while the card is force-open being edited
        inert={rev.specEdit}
        onToggle={(o) => up({ specSecOpen: o })}
        hint="What the automation should do, in plain words. The AI regenerates the steps from this document when it changes."
        right={specOpenEff && (!rev.specEdit ? (
            <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <button
              // §11: an old version is browsed read-only — editing
              // here would mark the draft dirty and lock Restore
              // behind a disabled sync button.
              className="ad-btn-text small ad-focus-inset" data-testid="spec-edit"
              disabled={busyRewrite || viewingOld || testLive}
              onClick={(e) => {
                e.stopPropagation()
                if (busyRewrite || viewingOld || testLive) return
                const t = specToText(rev.spec)
                up({
                  instrDraft: null, instrEdit: false, notesDraft: null, notesEdit: false,
                  specText: t, specTextOrig: t, specEdit: true,
                })
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
        {rev.specEdit ? (
          <>
            <div className="ad-scrollwrap" style={{ position: 'relative' }}>
              <textarea
                data-testid="spec-editor"
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
          {notesOpenEff && !rev.notesEdit && (
            <button
              // §11: an old version is browsed read-only — notes saved onto a
              // vX view would vanish on Restore or a version switch.
              className="ad-btn-text small ad-focus-inset" disabled={busyRewrite || viewingOld}
              onClick={(e) => {
                e.stopPropagation()
                if (busyRewrite || viewingOld) return
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
          <div className="ad-scrollwrap" style={{ position: 'relative' }}>
            <textarea
              value={rev.notesDraft ?? rev.notes} rows={1}
              ref={(el) => { notesThumb.attach(el); if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }}
              onChange={(e) => up({ notesDraft: e.target.value })}
              onScroll={notesThumb.onScroll}
              placeholder="Markdown — your AI’s working knowledge for this automation. Prune anything stale or wrong."
              style={{
                width: '100%', background: 'var(--bg-inset)', border: 'none',
                color: 'var(--text-2)', font: "400 12.5px/1.7 var(--mono)", padding: '14px 20px',
                resize: 'none', outline: 'none', display: 'block', minHeight: 92, maxHeight: 440, overflowY: 'auto',
              }}
              className="ad-scrollhide"
            />
            {notesThumb.node}
          </div>
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
                    if (on) {
                      up({ enabledAgents: rev.enabledAgents.filter((z) => z !== g.id), ...(isEdit ? { touched: true } : {}) })
                      if (used.length) showToast(`Step${used.length > 1 ? 's' : ''} ${stepList(used)} ${used.length > 1 ? 'are' : 'is'} out of sync — ${agName(g)} is no longer available here. Re-enable it or sync the steps before saving.`, 5000)
                    } else {
                      up({ enabledAgents: [...rev.enabledAgents, g.id], ...(isEdit ? { touched: true } : {}) })
                      showToast(`${agName(g)} is now available to steps — Sync spec if the steps should be rewritten to use it.`, 3600)
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
                    if (on) {
                      up({ allowedSecrets: rev.allowedSecrets.filter((z) => z !== s.name), ...(isEdit ? { touched: true } : {}) })
                      if (ref) showToast(`Step${ref.steps.length > 1 ? 's' : ''} ${stepList(ref.steps)} use${ref.steps.length > 1 ? '' : 's'} ${s.name} — re-allow it or sync the steps before saving.`, 4500)
                    } else {
                      up({ allowedSecrets: [...rev.allowedSecrets, s.name], ...(isEdit ? { touched: true } : {}) })
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
            up({ allowedSecrets: [...rev.allowedSecrets, name], ...(isEdit ? { touched: true } : {}) })
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
              // §11: an old version is browsed read-only — an instruction save
              // here would mark the draft dirty while Sync now and Restore are
              // both locked (viewingOld), a dead end with no escape.
              className="ad-btn-text small ad-focus-inset" disabled={busyRewrite || viewingOld || testLive}
              onClick={(e) => {
                e.stopPropagation()
                if (busyRewrite || viewingOld || testLive) return
                up({
                  specEdit: false, specText: '', specTextOrig: '', notesDraft: null, notesEdit: false,
                  instrDraft: rev.instructions, instrEdit: true, instrSecOpen: true,
                })
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
                disabled={!instructionCache.defaultBuild || (rev.instrDraft ?? rev.instructions) === instructionCache.defaultBuild}
                onClick={(e) => { e.stopPropagation(); up({ instrDraft: instructionCache.defaultBuild }) }}
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
  )
}

// ---------- right column (below the Build & test panel) ----------

export interface RightCardsProps {
  rev: Rev
  up: (patch: Partial<Rev>) => void
  liveParams?: import('../../types').ParamDef[] // edit mode: the automation's stored values (§16 summary source)
  // edit mode: the automation's stored §4.1 concurrency pair — create mode
  // shows the 1/0 defaults; a chat-staged value (§8) overrides its row
  liveConcurrency?: { maxParallel: number; maxQueued: number }
  drafting: boolean
  isCreateEmpty: boolean
  outOfSync: boolean
  busyRewrite: boolean
  availAgents: Agent[]
  pkgSecOpenEff: boolean
  updatePkgs: (pips: string[]) => void
  installPkgs: () => void
}

export function RightCards({
  rev, up, liveParams, liveConcurrency, drafting, isCreateEmpty, outOfSync, busyRewrite,
  availAgents, pkgSecOpenEff, updatePkgs, installPkgs,
}: RightCardsProps) {
  // §19: the §11 draft-trigger chips label through POST /triggers/preview —
  // the renderer keeps no local trigger-math mirror (§4.3)
  const trigPreviews = useTriggerPreview(rev.triggers)
  return (
    <>
      {/* STEPS */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
          <Eyebrow>STEPS · GENERATED</Eyebrow>
        </div>
        {/* §11 first build on Review: static placeholder — drafting progress
            lives in the thread; also shown on the create empty state */}
        {(drafting || isCreateEmpty) && (
          <div style={{ padding: '14px 20px 16px', font: "400 12px var(--sans)", color: 'var(--text-faint)' }}>
            Steps appear here once the build finishes.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', opacity: outOfSync || busyRewrite ? 0.45 : 1, transition: 'opacity var(--t-hover) var(--ease-enter)', marginBottom: -1 }}>
          <StepList variant="editor" steps={rev.steps} availAgents={availAgents} packages={rev.packages} />
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
            {rev.triggers.map((t, i) => trigPreviews[i] && (
              <span key={i} style={{
                font: "500 12px var(--mono)",
                color: t.enabled ? 'var(--accent)' : 'var(--text-faint)',
                background: t.enabled ? 'var(--accent-chip-bg)' : 'var(--hairline-dim)',
                borderRadius: 6, padding: '3px 9px', whiteSpace: 'nowrap',
              }}>
                {trigPreviews[i].label}
              </span>
            ))}
            <span style={{ font: "400 11.5px var(--sans)", color: 'var(--text-faint)' }}>
              {rev.triggers.length > 0
                ? 'Executes even when the app is closed. Ask the AI in chat to change these, or use the automation page — chat changes apply when you save.'
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
              // match), create mode the drafted default; a chat-staged value
              // (§8 param_values) overrides either, marked so an unsaved value
              // is never mistaken for a stored one
              const live = liveParams?.find((q) => q.name === p.name && q.kind === p.kind)
              const staged = p.name in rev.paramValues
                ? applyTestValues([live ?? p], { [p.name]: rev.paramValues[p.name] })[0]
                : null
              return (
                <div key={p.name} style={{ padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ font: "600 12.5px var(--sans)" }}>{p.label}</div>
                    <div style={{ font: "500 12px var(--mono)", color: 'var(--text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '55%' }}>
                      {staged && (
                        <span style={{ font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--accent)', marginRight: 8 }}>STAGED</span>
                      )}
                      {paramSummary(staged ?? live ?? p)}
                    </div>
                  </div>
                  <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 2 }}>{p.help}</div>
                </div>
              )
            })}
            <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
              Values aren’t part of a version — set them on the automation page, or ask your AI here (staged values apply when you save). For a test, set test-only values in the Build & test panel — or ask your AI, which can also change the parameter definitions and set test values when it runs a test.
            </div>
          </>
        )}
      </div>

      {/* CONCURRENCY — display-only (§11): the §4.1 settings; number inputs
          live on the automation page, chat stages changes (§8 `concurrency`).
          Always the two rows — no empty state, no collapse. */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
          <Eyebrow>CONCURRENCY</Eyebrow>
        </div>
        {([
          { label: 'Run at once', key: 'maxParallel' as const, fallback: 1 },
          { label: 'Queue when busy', key: 'maxQueued' as const, fallback: 0 },
        ]).map(({ label, key, fallback }) => {
          const staged = rev.concurrency?.[key]
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '11px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
              <div style={{ font: "600 12.5px var(--sans)" }}>{label}</div>
              <div style={{ font: "500 12px var(--mono)", color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                {staged != null && (
                  <span style={{ font: "600 10px var(--mono)", letterSpacing: '.09em', color: 'var(--accent)', marginRight: 8 }}>STAGED</span>
                )}
                {staged ?? liveConcurrency?.[key] ?? fallback}
              </div>
            </div>
          )
        })}
        <div style={{ padding: '11px 20px', font: "400 11.5px/1.55 var(--sans)", color: 'var(--text-muted)' }}>
          Not part of a version — change these on the automation page, or ask your AI here (staged changes apply when you save).
        </div>
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
                      onClick={() => updatePkgs([p.pip])} style={{ flex: 'none' }}>
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
                  onClick={() => updatePkgs(rev.packages.filter((p) => p.latest).map((p) => p.pip))} style={{ flex: 'none' }}>
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
                <button className="ad-btn-soft" disabled={rev.pkgBusy || busyRewrite} onClick={installPkgs} style={{ flex: 'none' }}>
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
    </>
  )
}
