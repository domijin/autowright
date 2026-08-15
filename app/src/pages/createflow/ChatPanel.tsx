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
import { type Rev, answerHeader, jobStageTitle } from './model'

/** §11 action row — left-aligned wrapping pill row beneath an agent block
    (the turn action row and the per-entry rows share the layout). */
function ActionRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, justifyContent: 'flex-start', ...style }}>
      {children}
    </div>
  )
}

/** §11 block glyph box — the 13px box every block header leads with, so
    titles align across kinds and a glyph swap never shifts the text. */
function GlyphBox({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </span>
  )
}

/** §11 operation-block bullet — `• `-prefixed description line running the
    pane's full width, flush left with the glyph (never indented under the
    title). `ellipsis` keeps activity-feed lines single-line. */
function OpBullet({ text, first, ellipsis, size, color }: {
  text: string; first: boolean; ellipsis?: boolean; size?: number; color?: string
}) {
  return (
    <div style={{
      font: `400 ${size ?? 11}px/1.5 var(--sans)`, color: color ?? 'var(--text-faint)',
      marginTop: first ? 3 : 0,
      ...(ellipsis ? { whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } : { overflowWrap: 'break-word' as const }),
    }}>
      • {text}
    </div>
  )
}

/** §11 message-block header — glyph beside the thread's loudest title line. */
function MsgHeader({ icon, color, title }: { icon: string; color: string; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
      <GlyphBox><i className={`fa-solid ${icon}`} style={{ fontSize: 11, color }} /></GlyphBox>
      <span style={{ font: "600 13px var(--sans)", color: 'var(--text)' }}>{title}</span>
    </div>
  )
}

/** §11 two block families: operation blocks (the record of what the agent
    did) vs message blocks (the agent talking to the user) — drives the
    boundary spacing (14px turns / 10px around message blocks / 0 between ops). */
const entryFamily = (e: ChatEntry): 'user' | 'msg' | 'op' =>
  e.kind === 'user' ? 'user'
    : e.kind === 'answer' || e.kind === 'blockers' || e.kind === 'error' ? 'msg' : 'op'
const familyGap = (prev: ChatEntry | null, cur: ChatEntry): number => {
  if (!prev) return 0
  const a = entryFamily(prev); const b = entryFamily(cur)
  if (a === 'user' || b === 'user') return 14
  if (a === 'msg' || b === 'msg') return 10
  return 0
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
  // §11 turn action row: starts a draft test through the Build & test panel —
  // the same run as its Run test button
  runDraftTest: () => void
  // §11 turn action row: sends the canned analyze message — null while the
  // draft's tracked test didn't settle failed (the pill hides)
  analyzeFailure: (() => void) | null
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
  undoDraft, runSync, runDraftTest, analyzeFailure, patchEntry,
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

  // §4.4/§11 history is inert: entries at or before the newest boundary
  // marker belong to a settled draft — they render, but offer no actions.
  let lastBoundaryIdx = -1
  for (let i = rev.chat.length - 1; i >= 0; i--) {
    if (rev.chat[i].boundary) { lastBoundaryIdx = i; break }
  }

  // §11 turn action row — the thread's one suggestion surface: pills beneath
  // the last agent-side entry while nothing runs; hides when no pill applies
  // and when the thread ends on a boundary marker (§11 history-inert rule:
  // no Undo/Sync/Test/Analyze pills dangle under a settled session).
  const rowsAllowed = !anyJobBusy && !viewingOld && !testLive
  const lastEntry = rev.chat.length ? rev.chat[rev.chat.length - 1] : null
  const undoAtEnd = rowsAllowed && !!rev.undo && !!lastEntry && rev.undo.entryId === lastEntry.id
  const showSyncPill = outOfSync && rev.dirty && !syncDisabled && !rev.pendingSync
  const showTestPill = !outOfSync && rev.steps.length > 0 && !drafting && !rev.pendingSync && !rev.pendingTest
  const showTurnRow = rowsAllowed && !!lastEntry && lastEntry.kind !== 'user' && !lastEntry.boundary
    && (undoAtEnd || showSyncPill || showTestPill || !!analyzeFailure)
  const pillGlyph: React.CSSProperties = { fontSize: 9, color: 'var(--text-faint)' }

  return (
    <div style={{
      width: 'clamp(340px, 26vw, 420px)', flex: 'none', alignSelf: 'flex-start',
      position: 'sticky', top: 46, marginTop: 6, marginLeft: 12,
      height: 'calc(100vh - 58px)',
      background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* thread — no header row (§11); the composer below carries the pane's identity */}
      {/* §11 thread spacing: no flex gap — each entry carries its own top margin
          (14px turn gap touching a user bubble, 6px between consecutive
          agent-side entries so one response reads as one group) */}
      <ScrollArea scrollRef={chatScrollRef} testId="chat-thread" wrapStyle={{ flex: 1, minHeight: 0 }} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
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
        {rev.chat.map((e, i) => {
          // §11 thread spacing: 14px turns (touching a user bubble), 10px at
          // family boundaries (around message blocks), 0 between operation blocks
          const prev = i > 0 ? rev.chat[i - 1] : null
          const mt = familyGap(prev, e)
          // §11 history-inert rule: at or before the newest boundary marker
          const history = i <= lastBoundaryIdx
          // §11 draft undo: at the thread's end the pill leads the turn action
          // row (below the map); when later answer-only turns pushed the
          // snapshot's anchor off the end, it renders as its own row beneath
          // the anchor — below everything the request changed
          const undoRow = e.id === rev.undo?.entryId && !undoAtEnd && rowsAllowed ? (
            <ActionRow style={{ marginTop: 10 }}>
              <button className="ad-btn-pill action" onClick={undoDraft}>
                <i className="fa-solid fa-rotate-left" style={{ fontSize: 9, color: 'var(--text-faint)' }} />
                Undo this change
              </button>
            </ActionRow>
          ) : null
          if (e.kind === 'user') {
            return (
              <div key={e.id} style={{
                marginTop: mt,
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
            // §11 message block: header stamped at creation (§4.4 icon/title);
            // older entries derive it at render time — question check, else plain
            const hdr = e.icon && e.title ? { icon: e.icon, title: e.title } : answerHeader(e.text ?? '', false)
            return (
              <div key={e.id} style={{ marginTop: mt }}>
                <MsgHeader icon={hdr.icon} color="var(--accent)" title={hdr.title} />
                <Markdown small text={e.text ?? ''} />
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
              <div key={e.id} style={{ marginTop: mt }}>
                {e.title && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <GlyphBox>
                      <i className={`fa-solid ${failed ? 'fa-xmark' : 'fa-check'}`} style={{ fontSize: 11, color: glyphColor }} />
                    </GlyphBox>
                    <div style={{ flex: 1, minWidth: 0, font: "500 12.5px var(--sans)", color: 'var(--text-muted)' }}>{e.title}</div>
                  </div>
                )}
                {lines.map((t, i) => (
                  <OpBullet key={`${i}-${t}`} text={t} first={i === 0} ellipsis />
                ))}
              </div>
            )
          }
          if (e.kind === 'rewrite') {
            // §11 operation block — glyph + title, the echoed request and the
            // out-of-sync note as flush-left bullets; Sync now lives on the
            // turn action row, never on the entry
            return (
              <React.Fragment key={e.id}>
              <div className="ad-anim-item" style={{ marginTop: mt }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <GlyphBox><i className="fa-solid fa-file-pen" style={{ fontSize: 10, color: 'var(--accent)' }} /></GlyphBox>
                  <span style={{ font: "600 12.5px var(--sans)", color: 'var(--text)', flex: 1, minWidth: 0 }}>Spec updated</span>
                </div>
                {e.text && <OpBullet text={e.text} first size={11.5} color="var(--text-muted)" />}
                {e.id === lastRewriteId && outOfSync && rev.dirty && (
                  <OpBullet
                    text="The workflow is out of sync — sync the steps before saving."
                    first={!e.text} size={11.5} color="var(--amber)"
                  />
                )}
              </div>
              {undoRow}
              </React.Fragment>
            )
          }
          if (e.kind === 'blockers') {
            const blockers = e.blockers ?? []
            // §11: a history blockers entry always collapses to its summary,
            // whatever its stored flag says — the draft it blocked is settled
            if (e.dismissed || history) {
              return (
                <div key={e.id} style={{ marginTop: mt, display: 'flex', alignItems: 'center', gap: 10, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                  <GlyphBox><i className="fa-solid fa-ban" style={{ fontSize: 10, color: 'var(--text-faint)' }} /></GlyphBox>
                  <span>{blockers.length} blocker{blockers.length === 1 ? '' : 's'} — dismissed</span>
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
              <div style={{ margin: '3px 0 8px' }}>
                <Markdown small text={text} />
              </div>
            )
            return (
              <div key={e.id} className="ad-anim-item" style={{ marginTop: mt, textAlign: 'left' }}>
                <MsgHeader icon="fa-ban" color="var(--amber)" title={blockersHeadline(e)} />
                {!allUserAction && (
                  <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-muted)', margin: '0 0 10px' }}>
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
                  <div style={{ margin: '12px 0 0', font: "400 11.5px/1.6 var(--sans)", color: 'var(--text-faint)' }}>
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
            // §11 message block — red glyph + title, the failure message as
            // body prose, Try again as a pill beneath it
            return (
              <div key={e.id} style={{ marginTop: mt }}>
                <MsgHeader icon="fa-circle-xmark" color="var(--red)" title="Something went wrong" />
                <div style={{ font: "400 12.5px/1.6 var(--sans)", color: 'var(--text-2)', overflowWrap: 'break-word' }}>{e.text}</div>
                {/* §11 history-inert rule: no Try again on a settled session's failure */}
                {e.source === 'spec' && !anyJobBusy && !isEdit && !history && (
                  <ActionRow style={{ marginTop: 8 }}>
                    <button className="ad-btn-pill action" onClick={() => void submitCreate(lastCreateRef.current)}>
                      Try again
                    </button>
                  </ActionRow>
                )}
              </div>
            )
          }
          // §11 system chip — an operation block: per-op glyph (stamped at
          // creation, `fa-circle-info` fallback) beside the chip's text as its
          // title; the undo row renders beneath it when it anchors the snapshot.
          // A §4.4 boundary marker is the one chip with a description bullet:
          // the derived history explainer (never persisted).
          return (
            <React.Fragment key={e.id}>
            <div style={{ marginTop: mt, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ width: 13, height: 13, flex: 'none', marginTop: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className={`fa-solid ${e.icon ?? 'fa-circle-info'}`} style={{ fontSize: 10, color: 'var(--text-faint)' }} />
              </span>
              <div style={{ flex: 1, minWidth: 0, font: "500 12.5px/1.5 var(--sans)", color: 'var(--text-muted)', overflowWrap: 'break-word' }}>
                {e.text}
              </div>
            </div>
            {e.boundary && (
              <OpBullet
                first
                size={11.5}
                color="var(--text-faint)"
                text="The messages above are from that draft — your AI starts fresh and no longer reads them."
              />
            )}
            {undoRow}
            </React.Fragment>
          )
        })}
        {/* §11 turn action row — pills beneath the thread's last agent-side
            entry: Undo first (the escape hatch), then the suggested next steps */}
        {showTurnRow && (
          <div data-testid="chat-turn-actions">
            <ActionRow style={{ marginTop: 10 }}>
              {undoAtEnd && (
                <button className="ad-btn-pill action" onClick={undoDraft}>
                  <i className="fa-solid fa-rotate-left" style={pillGlyph} />
                  Undo this change
                </button>
              )}
              {showSyncPill && (
                <button className="ad-btn-pill action" data-testid="chat-sync-now" onClick={runSync}>
                  <i className="fa-solid fa-rotate" style={pillGlyph} />
                  Sync now
                </button>
              )}
              {showTestPill && (
                <button className="ad-btn-pill action" data-testid="chat-test-draft" onClick={runDraftTest}>
                  <i className="fa-solid fa-vial" style={pillGlyph} />
                  Test draft
                </button>
              )}
              {analyzeFailure && (
                <button className="ad-btn-pill action" data-testid="chat-analyze-failure" onClick={analyzeFailure}>
                  <i className="fa-solid fa-magnifying-glass" style={pillGlyph} />
                  Analyze failure
                </button>
              )}
            </ActionRow>
          </div>
        )}
        {/* §11 thread progress entry — the page's only live job surface:
            transient (derived from the job, never persisted), rendered as a
            left-aligned agent block at the bottom of the thread */}
        {anyJobBusy && (
          // §11 thread spacing: an operation block — flush beneath a
          // just-settled op entry (the same job's trail chains), 10px after a
          // message block, 14px after a user bubble
          <div data-testid="chat-progress" style={{ marginTop: rev.chat.length === 0 ? 0 : familyGap(rev.chat[rev.chat.length - 1], { kind: 'activity' } as ChatEntry) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Spinner size={13} style={{ flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0, font: "500 12.5px var(--sans)", color: 'var(--text-muted)' }}>
                {jobStageTitle(rev, installingPkgs)}
              </div>
            </div>
            {(() => {
              // §11 activity feed: the full dim event history over the live
              // detail line (the backend caps events per job), as flush-left
              // operation-block bullets; the newest event hides when detail
              // extends it (same message, growing line count) so it never
              // shows twice.
              const evs = rev.genEvents
              const last = evs.length ? evs[evs.length - 1] : null
              const hist = rev.genDetail && last && rev.genDetail.startsWith(last) ? evs.slice(0, -1) : evs
              return (
                <>
                  {hist.map((t, i) => (
                    <OpBullet key={`${i}-${t}`} text={t} first={i === 0} ellipsis />
                  ))}
                  {rev.genDetail && (
                    <OpBullet text={rev.genDetail} first={hist.length === 0} size={11.5} color="var(--text-muted)" />
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
              <button className="ad-btn-pill action" onClick={cancelJob} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
                Cancel
              </button>
            ) : (
              <button className="ad-btn-pill action" disabled={inputDisabled || !chatText.trim()} onClick={sendMessage} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
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
