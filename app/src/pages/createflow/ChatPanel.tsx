// §11 chat pane — the editor's only conversational surface: the floating card
// beside the review grid holding the thread (user/answer/rewrite/blockers/
// system/error entries, the standalone undo row), the create empty state, and
// the pinned composer with the drafting-agent picker and the in-flight job's
// progress block + activity feed (the page's only live job surface).
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Agent, Blocker, ChatEntry } from '../../types'
import { BtnGhost, BtnPrimary, Eyebrow, PopMenu, ScrollArea, Spinner, agName, dispModel, usePopover } from '../../ui'
import { Markdown } from '../../result'
import type { Rev } from './model'
import { cardStyle } from './SectionCards'

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

export interface ChatPanelProps {
  rev: Rev
  agents: Agent[]
  selAgent: Agent | null
  isEdit: boolean
  isCreateEmpty: boolean
  anyJobBusy: boolean
  busyRewrite: boolean
  drafting: boolean
  installingPkgs: boolean
  testLive: boolean
  viewingOld: boolean
  inputDisabled: boolean
  outOfSync: boolean
  syncDisabled: boolean
  lastRewriteId: string | undefined
  chatText: string
  setChatText: (v: string) => void
  sendMessage: () => void
  submitCreate: (request: string) => Promise<void>
  lastCreateRef: React.MutableRefObject<string>
  undoDraft: () => void
  runSync: () => void
  patchEntry: (id: string, patch: Partial<ChatEntry>) => void
  patchEntryBlocker: (id: string, i: number, patch: Partial<Blocker>) => void
  answerBlockersEntry: (entry: ChatEntry) => void
  applyBlockersEntry: (entry: ChatEntry) => void
  cancelChat: () => void
  cancelCreate: () => void
  cancelSync: () => void
  setAgentId: (id: string) => void
  up: (patch: Partial<Rev>) => void
  showToast: (msg: string, ms?: number) => void
}

export function ChatPanel({
  rev, agents, selAgent, isEdit, isCreateEmpty, anyJobBusy, busyRewrite, drafting,
  installingPkgs, testLive, viewingOld, inputDisabled, outOfSync, syncDisabled,
  lastRewriteId, chatText, setChatText, sendMessage, submitCreate, lastCreateRef,
  undoDraft, runSync, patchEntry, patchEntryBlocker, answerBlockersEntry,
  applyBlockersEntry, cancelChat, cancelCreate, cancelSync, setAgentId, up, showToast,
}: ChatPanelProps) {
  // §11 thread auto-scroll: newest at the bottom, scrolled on new content.
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatLen = rev.chat.length
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
                      <button className="ad-btn-text" data-testid="chat-sync-now" onClick={runSync} style={{ flex: 'none' }}>
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
  )
}
