// Execution page (§7): full-width Result card on top, then a single execution
// card joining the selectable STEPS rail (with parameters) and the LOGS pane —
// per-attempt logs, Execution-log pseudo-row, skip-live-step, live log
// streaming with auto-scroll, Cancel / Retry / Execute again. A §6 `queued`
// record renders the waiting state instead of that body.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { usePlatformCopy } from '../platformCopy'
import { LOG_TAIL, logKey, useStore } from '../store'
import { BackLink, Badge, badgeOf, BLINK, EmptyLine, EmptyNotice, Eyebrow, FailureNotice, HeaderActions, LoadingRow, logColor, MetaChip, PageLoading, PageTitle, paramSummary, PULSE, ScrollArea, waitedLabel } from '../ui'
import { ResultSection } from '../result'
import type { Execution, ExecutionStep, LogLine, TriggerPayload } from '../types'

// null = the execution-scoped log (§5 execution.ndjson)
type Sel = { step: number | null; attempt: number | null }

const rowBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', cursor: 'pointer',
}

// Selected rows keep their inline background — it wins over the ad-hover-row hover.
function rowBg(selected: boolean): React.CSSProperties {
  return selected
    ? { background: 'var(--bg-active)', boxShadow: 'inset 2px 0 0 var(--accent)' }
    : {}
}

/** §7: the "Setup log" pseudo-row above step 1 — selects execution.ndjson. */
function ExecLogRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <button
      className="ad-btn-bare ad-hover-row ad-focus-inset"
      onClick={onSelect}
      style={{ ...rowBase, ...rowBg(selected) }}
    >
      <i className="fa-solid fa-terminal" style={{ fontSize: 9, width: 8, color: 'var(--text-faint)', flex: 'none' }} />
      <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>Setup log</span>
    </button>
  )
}

/** Selectable step row (§7): status dot + name + attempt chip + duration —
 * no row actions; skipping lives in the header's Skip-step button. */
function StepRow({ step, selected, onSelect }: {
  step: ExecutionStep; selected: boolean; onSelect: () => void
}) {
  const executing = step.status === 'executing'
  const dot = step.status === 'queued' ? 'var(--text-deco)' : badgeOf(step.status).c
  return (
    <button
      className="ad-btn-bare ad-hover-row ad-focus-inset"
      onClick={onSelect}
      style={{ ...rowBase, ...rowBg(selected) }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: dot, flex: 'none',
        animation: executing ? PULSE : 'none',
      }} />
      <span style={{
        flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.4, minWidth: 0,
        color: step.status === 'queued' ? 'var(--text-faint)' : 'var(--text-2)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {step.name}
      </span>
      {latestN(step) > 1 && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', flex: 'none' }}>
          ×{latestN(step)}
        </span>
      )}
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', flex: 'none' }}>{step.duration}</span>
    </button>
  )
}

function ordinal(n: number): string {
  return ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`
}

// §4.5: attempt `n` is monotonic and old attempts prune — the latest entry's
// `n` is the true attempt count and the newest log's number; never the length.
function latestN(step: ExecutionStep | undefined): number {
  const atts = step?.attempts
  return atts?.length ? atts[atts.length - 1].number : 1
}

/** §7 attempt pill — `.ad-attempt-pill` owns the resting/hover neutrals; the
 * active pill pins its status badge colors inline (beats the class hover). */
function AttemptPill({ a, active, onSelect }: {
  a: ExecutionStep['attempts'][number]; active: boolean; onSelect: () => void
}) {
  const b = badgeOf(a.status)
  return (
    <button
      className="ad-btn-bare ad-attempt-pill"
      onClick={onSelect}
      style={active ? { color: b.c, background: b.bg } : undefined}
    >
      Attempt {a.number} · {b.label}{a.duration ? ` · ${a.duration}` : ''}
    </button>
  )
}

const bodyCard: React.CSSProperties = { padding: '16px 18px' }

/** §7 TRIGGER MESSAGE block — the input that fired a message-triggered
 * execution. Shared between the queued waiting state and the ordinary page,
 * so the message stays visible after promotion. */
function TriggerMessage({ payload }: { payload: TriggerPayload }) {
  const discord = payload.kind === 'discord' ? payload : null
  // §7: origin is Discord-only — names are best-effort (§6 cache), raw
  // channel id when null; an iMessage payload shows the sender alone.
  const origin = discord && (discord.channelName
    ? `#${discord.channelName}${discord.guildName ? ` · ${discord.guildName}` : ''}`
    : discord.channel)
  return (
    <div className="ad-card" style={bodyCard}>
      <Eyebrow style={{ marginBottom: 10 }}>TRIGGER MESSAGE</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
        <div style={{
          fontSize: 12.5, color: 'var(--text-2)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {payload.sender}
          {origin && <span style={{ color: 'var(--text-faint)' }}>{` in ${origin}`}</span>}
        </div>
        {discord && discord.messageId && (
          <a
            className="ad-btn-ghost"
            href={`https://discord.com/channels/${discord.guildId ?? '@me'}/${discord.channel}/${discord.messageId}`}
            target="_blank" rel="noopener noreferrer"
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flex: 'none' }}
          >
            Open in Discord ↗
          </a>
        )}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 10 }}>
        {new Date(payload.at).toLocaleString()}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.7, color: 'var(--text-muted)',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {payload.text}
      </div>
    </div>
  )
}

/** §7 queued execution body — the waiting state, in place of the RESULT card
 * and the steps/logs card. A queued record has no steps, no logs and no
 * duration, so an ordinary body would be a page of empty machinery. */
function WaitingBody({ pos, total, payload }: {
  pos: number; total: number; payload: TriggerPayload | null
}) {
  return (
    <>
      <div className="ad-card" style={{ ...bodyCard, textAlign: 'center' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>Waiting for a free slot</div>
        {pos > 0 && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>
            {ordinal(pos)} of {total} waiting
          </div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Every slot is busy. This runs as soon as one frees up.
        </div>
      </div>
      {payload && <TriggerMessage payload={payload} />}
    </>
  )
}

export default function ExecutionPage() {
  // Per-field selectors (UI-GUIDE): a bare useStore() would re-render this page
  // on every store write anywhere — including each execution.log event of every
  // other execution.
  // §9 per-OS copy rule: the workspace reveal button's file-manager name.
  const copy = usePlatformCopy()
  const executionId = useStore((s) => s.executionId)
  const executions = useStore((s) => s.executions)
  const executionFull = useStore((s) => s.executionFull)
  const execLogs = useStore((s) => s.execLogs)
  const automations = useStore((s) => s.automations)
  const go = useStore((s) => s.go)
  const showToast = useStore((s) => s.showToast)
  const loadExecution = useStore((s) => s.loadExecution)
  const loadExecLogs = useStore((s) => s.loadExecLogs)
  const full = executionId ? executionFull[executionId] : undefined
  const e = full ?? (executionId ? executions.find((x) => x.id === executionId) : undefined)
  const auto = e ? automations.find((a) => a.id === e.automationId) : undefined

  const [sel, setSel] = useState<Sel | null>(null)
  const [missing, setMissing] = useState(false) // fetched and truly gone (retention-purged deep link)
  const manualSel = useRef(false) // a user click stops the live auto-follow (§7)
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const steps = full?.steps ?? []
  const executing = e?.status === 'executing'
  const queued = e?.status === 'queued'
  const liveIdx = steps.findIndex((s) => s.status === 'executing')

  // §7: the waiting elapsed counts up while the page is open. Promotion clears
  // `queued` and the timer stops with it.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!queued) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [queued])

  // Mount / executionId change: guard, reset, (re)fetch the full record.
  useEffect(() => {
    if (!executionId) { go('executions'); return }
    let stale = false
    manualSel.current = false
    stickRef.current = true
    setSel(null)
    setMissing(false)
    void loadExecution(executionId).then(() => {
      // loadExecution swallows the 404 — if nothing landed anywhere, the record is
      // gone (deleted by retention): show that instead of a forever-spinner. A
      // late resolution must not mark the execution the page moved on to missing.
      const st = useStore.getState()
      if (!stale && !st.executionFull[executionId] && !st.executions.some((x) => x.id === executionId)) setMissing(true)
    })
    return () => { stale = true }
  }, [executionId])

  // Selection (§7): auto-follow the live step until the user picks a row; a
  // failed execution auto-selects the failed step's latest attempt.
  useEffect(() => {
    if (!full?.steps?.length) return
    const latest = (i: number) => latestN(full.steps![i])
    if (executing && liveIdx >= 0 && !manualSel.current) {
      if (sel?.step !== liveIdx || sel.attempt !== latest(liveIdx)) {
        setSel({ step: liveIdx, attempt: latest(liveIdx) })
      }
      return
    }
    if (sel !== null) return
    const failedIdx = full.steps.findIndex((s) => s.status === 'failed')
    const pick = failedIdx >= 0 ? failedIdx
      : [...full.steps].reduce((acc, s, i) => (s.attempts.length ? i : acc), -1)
    setSel(pick >= 0 ? { step: pick, attempt: latest(pick) } : { step: null, attempt: null })
  }, [full, executing, liveIdx])

  // Fetch the selected log lazily (§19); live lines append via exec.log events.
  useEffect(() => {
    if (!executionId || sel === null) return
    void loadExecLogs(executionId, sel.step ?? undefined, sel.attempt ?? undefined)
  }, [executionId, sel])

  const logs: LogLine[] = (executionId && sel !== null
    ? execLogs[executionId]?.[logKey(sel.step, sel.attempt)]
    : undefined) ?? []
  const liveSelected = executing && sel?.step === liveIdx && liveIdx >= 0
    && sel.attempt === latestN(steps[liveIdx])
  // §7 log cap: the store keeps only the last LOG_TAIL lines (fetched tail plus
  // trimmed live appends). Sequences are gapless from 1 (§5), so a kept head
  // past 1 means earlier lines were dropped — say so, like the §7 text preview.
  const logsTruncated = logs.length > 0 && logs[0].sequence > 1

  // Live auto-scroll — only while executing and only if the user hasn't scrolled up.
  // Keyed on the newest line, not the length: past the §7 cap the length stops
  // changing (each append trims one off the head) and the follow would freeze.
  const lastSeq = logs.length ? logs[logs.length - 1].sequence : 0
  useEffect(() => {
    const el = logRef.current
    if (el && liveSelected && stickRef.current) el.scrollTop = el.scrollHeight
  }, [logs.length, lastSeq, liveSelected])

  if (!executionId) return null

  const shell = (body: React.ReactNode) => (
    <div className="ad-anim-page" style={{ maxWidth: 1200, padding: '20px 30px 70px' }}>
      <BackLink label="Executions" onClick={() => go('executions')} />
      {body}
    </div>
  )

  if (!e) {
    return shell(
      missing ? (
        <EmptyNotice
          title="This execution no longer exists"
          body="It was removed — most likely by retention cleanup."
          style={{ marginTop: 20 }}
        />
      ) : (
        <PageLoading />
      ),
    )
  }

  const cancelExecution = () => {
    void api.cancelExecution(e.id).catch((err: Error) => showToast(err.message))
  }
  const skipStep = (i: number) => {
    void api.skipStep(e.id, i).catch((err: Error) => showToast(err.message))
  }
  const retry = () => {
    // §7 in-place retry: same execution record — stay on this page, the
    // re-published exec.started flips the badge back to Executing.
    manualSel.current = false
    void api.retryExecution(e.id).catch((err: Error) => showToast(err.message))
  }
  const executeAgain = () => {
    if (!e.automationId) return // §4.5: create-mode tests have no automation to re-execute
    const automationId = e.automationId
    void (async () => {
      try {
        const r = await api.executeNow(automationId)
        go('execution', { executionId: r.executionId })
      } catch (err) {
        showToast((err as Error).message)
      }
    })()
  }
  const selectRow = (step: number | null) => {
    manualSel.current = true
    const attempt = step === null ? null : latestN(steps[step])
    setSel({ step, attempt })
  }

  const canOpenAuto = !e.automationDeleted && !!auto
  // §11: tests aren't re-executable from here — iteration lives in the editor's Test card.
  const retryPrimary = e.status === 'failed' && !e.automationDeleted && !e.test
  const againQuiet = ['succeeded', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(e.status) && !e.automationDeleted && !e.test
  // §7: values as used by this execution — snapshotted on the record; older records fall back
  // to the automation's current params.
  const params = (full?.params?.length ? full.params : auto?.params) ?? []
  const result = full?.result ?? null

  // §6 queue position — the queue *is* the automation's `queued` records, drained
  // oldest first, so the list gives the position without a second endpoint.
  const queue: Execution[] = queued
    ? executions
      .filter((x) => x.automationId === e.automationId && x.status === 'queued')
      .sort((a, b) => (a.queuedMs || a.startedMs) - (b.queuedMs || b.startedMs))
    : []
  const queuePos = queue.findIndex((x) => x.id === e.id) + 1

  const noResultWhy = e.status === 'executing'
    ? 'The execution is still going — the result appears when it finishes.'
    : e.status === 'failed'
      ? 'The execution failed before a result was built. The logs show what happened.'
      : e.status === 'cancelled'
        ? (steps.length === 0 && e.note
          ? `The execution was cancelled before it started — ${e.note}.`
          : 'The execution was cancelled before a result was built.')
        : 'This execution didn’t produce a result.'

  const redactNote = (
    <MetaChip>
      <i className="fa-solid fa-key" style={{ fontSize: 8.5 }} />
      secrets redacted: {e.redactedSecrets?.join(', ')}
    </MetaChip>
  )

  const selStep = sel?.step != null ? steps[sel.step] : undefined
  const attempts = selStep?.attempts ?? []

  return shell(
    <>
      {/* §7: the row never wraps — the name ellipsizes so the actions stay on
        * the title line at the same height as every other page header. */}
      <PageTitle
        raw
        style={{ marginBottom: 6 }}
        right={
          <HeaderActions>
            {/* §9 rising prominence: ghosts, then danger-ghost, primary last. */}
            {executing && liveIdx >= 0 && (
              <button
                className="ad-btn-ghost"
                onClick={() => skipStep(liveIdx)}
                title="Skip this step — kills it and continues with the next one"
              >
                Skip step
              </button>
            )}
            {againQuiet && (
              <button
                className="ad-btn-ghost"
                onClick={executeAgain}
                title="Executes the automation again from the start"
              >
                Execute again
              </button>
            )}
            {/* §6: one endpoint covers both — a queued entry leaves the queue and
              * finishes skipped, a running one is killed. */}
            {(executing || queued) && (
              <button className="ad-btn-danger-ghost" onClick={cancelExecution}>
                Cancel
              </button>
            )}
            {retryPrimary && (
              <button
                className="ad-btn-primary"
                onClick={retry}
                title="Retries this execution from the failed step. Steps that already succeeded keep their results."
              >
                Retry
              </button>
            )}
          </HeaderActions>
        }
      >
        <h1
          className={`ad-h1${canOpenAuto ? ' ad-link-title' : ''}`}
          onClick={() => { if (canOpenAuto) go('automation', { automationId: e.automationId }) }}
          title={canOpenAuto ? `Open automation — ${e.automationName}` : e.automationName}
          style={{
            cursor: canOpenAuto ? 'pointer' : 'default',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {e.automationName}
        </h1>
        {e.test && (
          /* §11 draft test — a create-mode test has no automation by design */
          <MetaChip>Draft test</MetaChip>
        )}
        {e.automationDeleted && !e.test && (
          <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>(deleted)</span>
        )}
        <Badge
          status={e.status}
          style={executing ? { animation: PULSE } : undefined}
        />
      </PageTitle>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 20 }}>
        <span>{e.id}</span>
        {` · ${e.trigger}`}{e.versionLabel ? ` · ${e.versionLabel}` : ''}
        {/* A queued record has not started and has no duration (§7) — it reports
          * when it was queued and how long it has been waiting instead. */}
        {queued
          ? <> · queued {e.started} · waiting {waitedLabel(Date.now() - (e.queuedMs || e.startedMs))}</>
          : <> · started {e.started} · {e.duration}</>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {queued ? (
          <WaitingBody
            pos={queuePos}
            total={queue.length}
            payload={full?.triggerPayload ?? null}
          />
        ) : (
        <>
          {e.status === 'failed' && e.error && (
            <div className="ad-anim-item">
              <FailureNotice
                error={e.error}
                // §7 Fix with AI — failed non-test executions whose automation
                // still exists; tests iterate from the editor already
                onFix={!e.test && auto ? () => {
                  useStore.setState({ fixExec: e.id })
                  go('automation', { automationId: auto.id })
                  useStore.getState().setSurface('create', 'edit')
                } : undefined}
              />
            </div>
          )}

          {/* Full-width RESULT card (§7) — the execution's outcome, above the machinery */}
          {!full ? (
            <div className="ad-card" style={{ padding: '16px 18px' }}>
              <LoadingRow label="Loading…" />
            </div>
          ) : result ? (
            <ResultSection label="RESULT" result={result} executionId={e.id} stamp={`${e.status}:${e.duration}`} />
          ) : (
            <EmptyNotice title="No result" body={noResultWhy} />
          )}

          {/* §7 TRIGGER MESSAGE — the run's input (steps read it via the §6.1
              SDK): below the outcome, above the machinery. */}
          {full?.triggerPayload && <TriggerMessage payload={full.triggerPayload} />}

          {/* Execution card (§7): STEPS rail + LOGS pane in one card — the rail's
              selection drives the pane, so they share a border. */}
          <div className="ad-card" style={{
            display: 'grid', gridTemplateColumns: '250px 1fr', alignItems: 'stretch', overflow: 'hidden',
          }}>
            <div style={{ paddingBottom: 14, borderRight: '1px solid var(--hairline)', minWidth: 0 }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)' }}>
                <Eyebrow>STEPS</Eyebrow>
              </div>
              {!full ? (
                <LoadingRow label="Loading steps…" style={{ padding: '14px 18px' }} />
              ) : steps.length === 0 ? (
                <EmptyLine>
                  {e.note ? `Nothing executed — ${e.note}.` : 'Nothing executed.'}
                </EmptyLine>
              ) : (
                <>
                  <ExecLogRow
                    selected={sel !== null && sel.step === null}
                    onSelect={() => selectRow(null)}
                  />
                  {steps.map((s, i) => (
                    <StepRow
                      key={i}
                      step={s}
                      selected={sel?.step === i}
                      onSelect={() => selectRow(i)}
                    />
                  ))}
                </>
              )}
              {params.length > 0 && (
                <div style={{ margin: '14px 18px 0' }}>
                  <Eyebrow style={{ marginBottom: 4 }}>PARAMETERS</Eyebrow>
                  {params.map((p) => (
                    <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '7px 0', borderTop: '1px solid var(--hairline-dim)' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{p.label}</span>
                      {p.help && <span style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>{p.help}</span>}
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-2)' }}>{paramSummary(p)}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)', paddingTop: 8, borderTop: '1px solid var(--hairline-dim)' }}>
                    Values as used by this execution.
                  </div>
                </div>
              )}
              {/* §7 workspace link — quiet, so it never competes with the RESULT
                  card's Show in Finder (the user-facing output) */}
              {full?.workspace && (
                <div style={{ margin: '14px 18px 0', paddingTop: 10, borderTop: '1px solid var(--hairline-dim)' }}>
                  <button
                    className="ad-btn-ghost"
                    onClick={() => { void window.autowright?.revealPath(full.workspace!) }}
                    title="Opens the scratch directory the steps ran in"
                  >
                    <i className="fa-solid fa-folder-open" style={{ fontSize: 10, marginRight: 6 }} />
                    Show workspace in {copy.fileManager}
                  </button>
                </div>
              )}
            </div>

            <div style={{ background: 'var(--bg-code)', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '12px 18px', borderBottom: '1px solid var(--hairline)',
              }}>
                <Eyebrow style={{ display: 'inline-block' }}>
                  {sel?.step != null ? selStep?.name : 'Setup log'}
                  {liveSelected ? ' · LIVE' : ''}
                </Eyebrow>
                {/* §7 attempt control — pills only when the step retried */}
                {attempts.length > 1 && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    {attempts.map((a) => (
                      <AttemptPill
                        key={a.number}
                        a={a}
                        active={sel?.attempt === a.number}
                        onSelect={() => { manualSel.current = true; setSel({ step: sel!.step, attempt: a.number }) }}
                      />
                    ))}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {e.redactedSecrets && redactNote}
              </div>
              <ScrollArea
                scrollRef={logRef}
                onScroll={() => {
                  const el = logRef.current
                  if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                }}
                wrapStyle={{ flex: 1, maxHeight: 420 }}
                style={{ maxHeight: 420, padding: '13px 18px', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.75 }}
              >
                {!full ? (
                  <LoadingRow label="Loading log…" />
                ) : (
                  <>
                    {/* §7 truncation notice — the dropped lines are the oldest,
                        so it sits above the kept tail (and clear of the live
                        auto-scroll at the bottom). */}
                    {logsTruncated && (
                      <div style={{
                        marginBottom: 8, fontFamily: 'var(--sans)', fontSize: 11.5,
                        lineHeight: 1.6, color: 'var(--text-faint)',
                      }}>
                        Truncated — showing the last {LOG_TAIL} lines. The full log is on disk.
                      </div>
                    )}
                    {logs.map((l) => (
                      <div key={l.sequence} style={{ display: 'flex', gap: 12 }}>
                        <span style={{ color: 'var(--text-deco)', flex: 'none' }}>{l.time}</span>
                        <span style={{
                          color: logColor(l.kind), whiteSpace: 'pre-wrap', minWidth: 0,
                          fontStyle: l.kind === 'sys' ? 'italic' : 'normal',
                        }}>
                          {l.text}
                        </span>
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <EmptyLine style={{ padding: 0 }}>
                        {steps.length === 0
                          ? 'No logs — this execution never started.'
                          : sel?.step == null
                            ? 'No setup events — installs, retries, and failures would appear here.'
                            : 'No log lines here.'}
                      </EmptyLine>
                    )}
                    {liveSelected && (
                      <span style={{
                        display: 'inline-block', width: 7, height: 13, background: 'var(--cyan)',
                        animation: BLINK, verticalAlign: 'middle', marginLeft: 2,
                      }} />
                    )}
                  </>
                )}
              </ScrollArea>
            </div>
          </div>
        </>
        )}
      </div>
    </>,
  )
}
