// §11 chat pane — the editor's only conversational surface: the floating card
// beside the review grid holding the thread (user bubbles right; every
// agent-side entry left-aligned in the Claude-output style with option-button
// rows, plus the transient in-thread progress entry — the page's only live job
// surface), the create empty state, and the pinned composer with the
// drafting-agent picker and Clear chat.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent, ChatEntry } from '../../types'
import { BtnGhost, BtnPrimary, ConfirmModal, Eyebrow, PopMenu, ScrollArea, Spinner, agName, anyModalOpen, dispModel, usePopover } from '../../ui'
import { devlogOverlayOpen } from '../../devlog'
import { Markdown } from '../../result'
import { type Rev, jobStageTitle } from './model'

/** §11 option-button row — left-aligned quiet actions beneath an agent block. */
function ActionRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, justifyContent: 'flex-start', ...style }}>
      {children}
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
  applyBlockersEntry: (entry: ChatEntry) => void
  clearChat: () => void
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
  undoDraft, runSync, patchEntry,
  applyBlockersEntry, clearChat, cancelChat, cancelCreate, cancelSync, setAgentId, up, showToast,
}: ChatPanelProps) {
  // §11 thread auto-scroll: newest at the bottom, scrolled on new content and
  // when the transient progress entry appears (a job starts).
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatLen = rev.chat.length
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLen, anyJobBusy])
  // §11: while the progress entry's feed grows, follow it only when already at
  // (or near) the bottom — a user who scrolled up is never yanked back down.
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el || !anyJobBusy) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
  }, [anyJobBusy, rev.genDetail, rev.genEvents])
  // §11 Clear chat: confirm step before the thread is emptied.
  const [confirmClear, setConfirmClear] = useState(false)

  // §11 composer cancel — one dispatch for the Cancel button and Esc. Marks the
  // input for refocus once the cancel re-enables it (effect below the auto-grow
  // block), so editing the returned request text picks up where it left off.
  const focusAfterCancelRef = useRef(false)
  const cancelJob = () => {
    focusAfterCancelRef.current = true
    if (rev.chatBusy) cancelChat()
    else if (rev.syncBusy) cancelSync()
    else cancelCreate()
  }

  // §11 Esc-to-cancel: a keyboard shortcut for the composer's Cancel while a §8
  // job is in flight — never the draft test's Cancel — yielding to surfaces
  // that own Esc while open (the modal stack, the §9.3 developer log overlay).
  useEffect(() => {
    if (!anyJobBusy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || anyModalOpen() || devlogOverlayOpen()) return
      cancelJob()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [anyJobBusy, rev.chatBusy, rev.syncBusy, cancelChat, cancelSync, cancelCreate])

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

  // §11: after a composer cancel re-enables the input, focus it with the caret
  // at the end of the returned request text (the auto-grow above already sized
  // the box to it).
  useLayoutEffect(() => {
    if (anyJobBusy || !focusAfterCancelRef.current) return
    focusAfterCancelRef.current = false
    const el = chatInputRef.current
    if (!el || el.disabled) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [anyJobBusy])

  // §11 blockers-entry copy, by source and kind
  const blockersHeadline = (e: ChatEntry) => {
    const bl = e.blockers ?? []
    // §8 kind: user-action — the Mac isn't ready, the automation is fine
    if (bl.length > 0 && bl.every((b) => b.kind === 'user-action')) return 'Your AI needs you to do something first'
    if (e.diagnosed) return 'The build failed — your AI suggests these fixes'
    return bl.length > 1 ? `Your AI hit ${bl.length} blockers` : 'Your AI hit a blocker'
  }
  const blockersExplainer = (e: ChatEntry) =>
    e.source === 'spec' ? 'It couldn’t write a spec for this request. Reply below — your answer is added to the request and the spec is rewritten.'
      : e.source === 'chat' ? 'Reply below — your answer is sent back and the spec is rewritten.'
        : e.source === 'steps' ? 'It couldn’t build the steps as the spec asks.'
          : 'It couldn’t sync the steps with the spec.'

  return (
    <div style={{
      width: 'clamp(340px, 26vw, 420px)', flex: 'none', alignSelf: 'flex-start',
      position: 'sticky', top: 46, marginTop: 6, marginLeft: 12,
      height: 'calc(100vh - 58px)',
      background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* thread — no header row (§11); the composer below carries the pane's identity */}
      <ScrollArea scrollRef={chatScrollRef} testId="chat-thread" wrapStyle={{ flex: 1, minHeight: 0 }} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                { label: 'Track manga chapters', icon: 'fa-solid fa-book-open', s: 'Check the manga I follow for new chapters every morning at 8.' },
                { label: 'Back up a folder every night', icon: 'fa-solid fa-box-archive', s: 'Back up my Projects folder to the Vault drive every night at 2.' },
                { label: 'Email me a weekly report', icon: 'fa-solid fa-envelope', s: 'Gather the week’s numbers and email the team a summary every Monday at 9.' },
                { label: 'Watch a product’s price', icon: 'fa-solid fa-tag', s: 'Watch the price of the keyboard I want and tell me when it drops below €120.' },
                { label: 'Tidy my screenshots folder', icon: 'fa-solid fa-broom', s: 'File my desktop screenshots into monthly folders every Sunday night.' },
                { label: 'Log ideas from Discord', icon: 'fa-brands fa-discord', s: 'When a message in my Discord #ideas channel starts with “idea:”, append it to my ideas file and react with a thumbs-up.' },
              ].map((c) => (
                <button key={c.label} className="ad-chip-btn" onClick={() => setChatText(c.s)}>
                  <i className={c.icon} />
                  {c.label}
                </button>
              ))}
            </div>
            <div style={{ font: "400 11.5px/1.6 var(--sans)", color: 'var(--text-muted)', marginTop: 14 }}>
              Your AI writes the steps — Autowright still executes everything on this Mac.
            </div>
          </div>
        ) : (
          <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-muted)', padding: '26px 4px' }}>
            Ask anything, or describe a change — your AI answers here and rewrites the spec when you ask for changes.
          </div>
        ))}
        {rev.chat.map((e) => {
          // §11 draft undo: the standalone undo row — the page's only
          // undo affordance — beneath the snapshot's anchor entry
          // §11: tag-style pill — lighter than the option buttons; an
          // escape hatch, not a suggested next step
          const undoRow = e.id === rev.undo?.entryId && !anyJobBusy && !viewingOld && !testLive ? (
            <ActionRow>
              <button className="ad-btn-pill" onClick={undoDraft}>
                <i className="fa-solid fa-rotate-left" style={{ fontSize: 9, color: 'var(--text-faint)' }} />
                Undo this change
              </button>
            </ActionRow>
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
          if (e.kind === 'activity') {
            // §11: a settled job — the live progress entry's exact layout with
            // an outcome glyph in the spinner's 13px box (same size, no text
            // shift): green check done, amber check blocked, red X failed (a
            // pre-outcome-field entry renders as done), the stage label kept,
            // and the full event feed beneath, flush left with the glyph
            const lines = (e.text ?? '').split('\n').filter(Boolean)
            const failed = e.outcome === 'failed'
            const glyphColor = failed ? 'var(--red)' : e.outcome === 'blocked' ? 'var(--amber)' : 'var(--green)'
            return (
              <div key={e.id}>
                {e.title && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <i className={`fa-solid ${failed ? 'fa-xmark' : 'fa-check'}`} style={{ fontSize: 11, color: glyphColor }} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0, font: "500 12.5px var(--sans)", color: 'var(--text-muted)' }}>{e.title}</div>
                  </div>
                )}
                {lines.map((t, i) => (
                  <div key={`${i}-${t}`} style={{ font: "400 11px/1.5 var(--sans)", color: 'var(--text-faint)', marginTop: i === 0 ? 3 : 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
                ))}
              </div>
            )
          }
          if (e.kind === 'rewrite') {
            // §11: left-aligned agent event block — no card chrome
            return (
              <React.Fragment key={e.id}>
              <div className="ad-anim-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="fa-solid fa-file-pen" style={{ fontSize: 10, color: 'var(--accent)' }} />
                  <span style={{ font: "600 12px var(--sans)", flex: 1, minWidth: 0 }}>Spec updated</span>
                </div>
                {e.text && (
                  <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3, overflowWrap: 'break-word' }}>{e.text}</div>
                )}
                {e.id === lastRewriteId && outOfSync && rev.dirty && (
                  <>
                    <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--amber)', marginTop: 3 }}>
                      The workflow is out of sync — sync the steps before saving.
                    </div>
                    {/* §11: the most common next step sits on the event itself */}
                    {!syncDisabled && !rev.pendingSync && (
                      <ActionRow style={{ marginTop: 8 }}>
                        <button className="ad-btn-soft" data-testid="chat-sync-now" onClick={runSync}>
                          Sync now
                        </button>
                      </ActionRow>
                    )}
                  </>
                )}
              </div>
              {undoRow}
              </React.Fragment>
            )
          }
          if (e.kind === 'blockers') {
            const blockers = e.blockers ?? []
            if (e.dismissed) {
              return (
                <div key={e.id} style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                  {blockers.length} blocker{blockers.length === 1 ? '' : 's'} — dismissed
                </div>
              )
            }
            const clarify = e.source === 'spec' || e.source === 'chat'
            const allUserAction = blockers.length > 0 && blockers.every((b) => b.kind === 'user-action')
            // §11: a mixed entry keeps the source's primary button — it applies
            // only the ordinary blockers' resolutions; a pure user-action entry
            // offers Dismiss only (there is nothing to amend)
            const ordinary = blockers.filter((b) => b.kind !== 'user-action')
            const mdBody = (text: string) => (
              <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-2)', margin: '3px 0 8px' }}>
                <Markdown text={text} />
              </div>
            )
            return (
              <div key={e.id} className="ad-anim-item" style={{ textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                  <span style={{ font: "600 13.5px var(--sans)", color: 'var(--text)' }}>{blockersHeadline(e)}</span>
                </div>
                {!allUserAction && (
                  <div style={{ font: "400 12px/1.6 var(--sans)", color: 'var(--text-muted)', margin: '0 0 10px 15px' }}>
                    {blockersExplainer(e)}
                  </div>
                )}
                {/* §11: blockers render as agent output — reason/fix/details
                    through the shared Markdown renderer, links clickable */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {blockers.map((b, i) => (
                    <div key={i}>
                      {blockers.length > 1 && (
                        <Eyebrow style={{ color: 'var(--amber)', padding: '10px 0 6px' }}>BLOCKER {i + 1}</Eyebrow>
                      )}
                      <Eyebrow>REASON</Eyebrow>
                      {mdBody(b.reason)}
                      <Eyebrow>HOW TO FIX</Eyebrow>
                      {mdBody(b.fix)}
                      {(b.details ?? '').trim() && (
                        <>
                          <Eyebrow>DETAILS</Eyebrow>
                          {mdBody(b.details!)}
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {(e.resolved ?? []).length > 0 && (
                  <div style={{ margin: '12px 0 0', font: "400 11.5px/1.7 var(--sans)", color: 'var(--text-faint)' }}>
                    <Eyebrow>PREVIOUSLY RESOLVED</Eyebrow>
                    {(e.resolved ?? []).map((s, i) => <div key={i}>– {s}</div>)}
                  </div>
                )}
                <ActionRow style={{ marginTop: 12 }}>
                  <BtnGhost onClick={() => patchEntry(e.id, { dismissed: true })}>Dismiss</BtnGhost>
                  {!clarify && ordinary.length > 0 && (
                    <BtnPrimary
                      disabled={anyJobBusy || viewingOld}
                      onClick={() => applyBlockersEntry(e)}
                    >
                      Apply to the spec & sync
                    </BtnPrimary>
                  )}
                </ActionRow>
              </div>
            )
          }
          if (e.kind === 'error') {
            return (
              <div key={e.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none', marginTop: 5 }} />
                  <span style={{ flex: 1, minWidth: 0, font: "400 12px/1.6 var(--sans)", color: 'var(--text-2)', overflowWrap: 'break-word' }}>{e.text}</span>
                </div>
                {e.source === 'spec' && !anyJobBusy && !isEdit && (
                  <ActionRow style={{ marginTop: 8, marginLeft: 15 }}>
                    <button className="ad-btn-soft" onClick={() => void submitCreate(lastCreateRef.current)}>
                      Try again
                    </button>
                  </ActionRow>
                )}
              </div>
            )
          }
          // system line — left-aligned like all agent output; the standalone
          // undo row renders beneath it when it anchors the snapshot (a
          // response that rewrote instructions or notes without touching the
          // spec, §11)
          return (
            <React.Fragment key={e.id}>
            <div style={{ font: "400 11.5px/1.6 var(--sans)", color: 'var(--text-faint)', overflowWrap: 'break-word' }}>
              {e.text}
            </div>
            {undoRow}
            </React.Fragment>
          )
        })}
        {/* §11 thread progress entry — the page's only live job surface:
            transient (derived from the job, never persisted), rendered as a
            left-aligned agent block at the bottom of the thread */}
        {anyJobBusy && (
          <div data-testid="chat-progress">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Spinner size={13} style={{ flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0, font: "500 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                {jobStageTitle(rev, installingPkgs)}
              </div>
            </div>
            {(() => {
              // §11 activity feed: the full dim event history over the live
              // detail line (the backend caps events per job), flush left
              // with the spinner; the newest event hides when detail extends
              // it (same message, growing line count) so it never shows twice.
              const evs = rev.genEvents
              const last = evs.length ? evs[evs.length - 1] : null
              const hist = rev.genDetail && last && rev.genDetail.startsWith(last) ? evs.slice(0, -1) : evs
              return (
                <>
                  {hist.map((t, i) => (
                    <div key={`${i}-${t}`} style={{ font: "400 11px/1.5 var(--sans)", color: 'var(--text-faint)', marginTop: i === 0 ? 3 : 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
                  ))}
                  {rev.genDetail && (
                    <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: hist.length ? 0 : 3 }}>{rev.genDetail}</div>
                  )}
                </>
              )
            })()}
          </div>
        )}
      </ScrollArea>
      {/* footer composer — while a §8 job runs it keeps its shape (the live
          surface is the thread progress entry above, §11); Send becomes Cancel */}
      <div style={{ flex: 'none', borderTop: '1px solid var(--hairline)', padding: '12px 14px' }}>
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
            {/* §11: left side = conversation meta (picker, clear); right = send/cancel alone */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 1 auto', minWidth: 0 }}>
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
              {/* §11 Clear chat — icon-only dim button with a confirm step */}
              <button
                className="ad-btn-text dim" data-testid="chat-clear"
                title="Clear chat" aria-label="Clear chat"
                disabled={anyJobBusy || testLive || viewingOld || rev.chat.length === 0}
                onClick={() => setConfirmClear(true)}
                style={{ flex: 'none' }}
              >
                <i className="fa-solid fa-eraser" style={{ fontSize: 11 }} />
              </button>
            </div>
            {anyJobBusy ? (
              <button className="ad-btn-pill" onClick={cancelJob} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                Cancel
              </button>
            ) : (
              <button className="ad-btn-pill" disabled={inputDisabled || !chatText.trim()} onClick={sendMessage} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                Send
              </button>
            )}
          </div>
        </div>
      {confirmClear && (
        <ConfirmModal
          title="Clear this conversation?"
          body="The chat thread will be deleted. The draft data will be untouched."
          confirmLabel="Clear chat" danger
          onConfirm={() => { setConfirmClear(false); clearChat() }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
