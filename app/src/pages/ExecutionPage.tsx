// Execution page (§7): full-width Result card on top, then a single execution
// card joining the selectable STEPS rail (with parameters) and the LOGS pane —
// per-attempt logs, Execution-log pseudo-row, skip-live-step, live log
// streaming with auto-scroll, Cancel / Retry / Execute again. A §6 `queued`
// record renders the waiting state instead of that body.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { logKey, useStore } from '../store'
import { BackLink, Badge, badgeOf, Chip, EmptyNotice, Eyebrow, FailureNotice, HeaderActions, logColor, paramSummary, PULSE, ScrollArea, Spinner, waitedLabel } from '../ui'
import { ResultSection } from '../result'
import type { Exec, ExecStep, LogLine, TriggerPayload } from '../types'

// null = the execution-scoped log (§5 execution.ndjson)
type Sel = { step: number | null; attempt: number | null }

const rowBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', width: '100%',
  textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none',
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
      className="ad-hover-row"
      onClick={onSelect}
      style={{ ...rowBase, ...rowBg(selected) }}
    >
      <i className="fa-solid fa-terminal" style={{ fontSize: 8.5, width: 8, color: 'var(--text-faint)', flex: 'none' }} />
      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>Setup log</span>
    </button>
  )
}

/** Selectable step row (§7): status dot + name + attempt chip + duration —
 * no row actions; skipping lives in the header's Skip-step button. */
function StepRow({ step, selected, onSelect }: {
  step: ExecStep; selected: boolean; onSelect: () => void
}) {
  const executing = step.status === 'executing'
  const dot = step.status === 'queued' ? 'var(--text-deco)' : badgeOf(step.status).c
  return (
    <button
      className="ad-hover-row"
      onClick={onSelect}
      style={{ ...rowBase, ...rowBg(selected) }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%', background: dot, flex: 'none',
        animation: executing ? PULSE : 'none',
      }} />
      <span style={{
        flex: 1, fontSize: 12.5, lineHeight: 1.4, minWidth: 0,
        color: step.status === 'queued' ? 'var(--text-faint)' : 'var(--text-2)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {step.name}
      </span>
      {latestN(step) > 1 && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>
          ×{latestN(step)}
        </span>
      )}
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', flex: 'none' }}>{step.dur}</span>
    </button>
  )
}

function ordinal(n: number): string {
  return ['1st', '2nd', '3rd'][n - 1] ?? `${n}th`
}

// §4.5: attempt `n` is monotonic and old attempts prune — the latest entry's
// `n` is the true attempt count and the newest log's number; never the length.
function latestN(step: ExecStep | undefined): number {
  const atts = step?.attempts
  return atts?.length ? atts[atts.length - 1].n : 1
}

/** §7 attempt pill — hover feedback over the badge colors needs local state,
 * so it's its own component; no instant background jumps. */
function AttemptPill({ a, active, onSelect }: {
  a: ExecStep['attempts'][number]; active: boolean; onSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  const b = badgeOf(a.status)
  return (
    <button
      className="ad-btn-bare"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 'auto', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
        padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
        color: active ? b.c : hover ? 'var(--text-muted)' : 'var(--text-faint)',
        background: active ? b.bg : hover ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.04)',
        transition: 'background var(--t-hover) var(--ease-enter), color var(--t-hover) var(--ease-enter)',
      }}
    >
      Attempt {a.n} · {b.label}{a.dur ? ` · ${a.dur}` : ''}
    </button>
  )
}

const bodyCard: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-card)',
  borderRadius: 12, padding: 22,
}

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
    <div style={bodyCard}>
      <Eyebrow style={{ marginBottom: 10 }}>TRIGGER MESSAGE</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
        <div style={{
          fontSize: 12.5, color: 'var(--text-2)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {payload.sender}
          {origin && <span style={{ color: 'var(--text-faint)' }}>{` in ${origin}`}</span>}
        </div>
        {discord && (
          <a
            href={`https://discord.com/channels/${discord.guildId ?? '@me'}/${discord.channel}/${discord.messageId}`}
            target="_blank" rel="noopener noreferrer"
            style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}
          >
            Open in Discord ↗
          </a>
        )}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 10 }}>
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
      <div style={{ ...bodyCard, textAlign: 'center' }}>
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
  const { execId, execs, execFull, execLogs, autos, go, showToast, loadExec, loadExecLogs } = useStore()
  const full = execId ? execFull[execId] : undefined
  const e = full ?? (execId ? execs.find((x) => x.id === execId) : undefined)
  const auto = e ? autos.find((a) => a.id === e.autoId) : undefined

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

  // Mount / execId change: guard, reset, (re)fetch the full record.
  useEffect(() => {
    if (!execId) { go('executions'); return }
    manualSel.current = false
    stickRef.current = true
    setSel(null)
    setMissing(false)
    void loadExec(execId).then(() => {
      // loadExec swallows the 404 — if nothing landed anywhere, the record is
      // gone (deleted by retention): show that instead of a forever-spinner.
      const st = useStore.getState()
      if (!st.execFull[execId] && !st.execs.some((x) => x.id === execId)) setMissing(true)
    })
  }, [execId])

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
    if (!execId || sel === null) return
    void loadExecLogs(execId, sel.step ?? undefined, sel.attempt ?? undefined)
  }, [execId, sel])

  const logs: LogLine[] = (execId && sel !== null
    ? execLogs[execId]?.[logKey(sel.step, sel.attempt)]
    : undefined) ?? []
  const liveSelected = executing && sel?.step === liveIdx && liveIdx >= 0
    && sel.attempt === latestN(steps[liveIdx])

  // Live auto-scroll — only while executing and only if the user hasn't scrolled up.
  useEffect(() => {
    const el = logRef.current
    if (el && liveSelected && stickRef.current) el.scrollTop = el.scrollHeight
  }, [logs.length, liveSelected])

  if (!execId) return null

  const shell = (body: React.ReactNode) => (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 30px 70px' }}>
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
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner /></div>
      ),
    )
  }

  const cancelExecution = () => {
    void api.cancelExec(e.id).catch((err: Error) => showToast(err.message))
  }
  const skipStep = (i: number) => {
    void api.skipStep(e.id, i).catch((err: Error) => showToast(err.message))
  }
  const retry = () => {
    // §7 in-place retry: same execution record — stay on this page, the
    // re-published exec.started flips the badge back to Executing.
    manualSel.current = false
    void api.retryExec(e.id).catch((err: Error) => showToast(err.message))
  }
  const executeAgain = () => {
    if (!e.autoId) return // §4.5: create-mode tests have no automation to re-execute
    const autoId = e.autoId
    void (async () => {
      try {
        const r = await api.executeNow(autoId)
        go('execution', { execId: r.execId })
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

  const canOpenAuto = !e.autoDeleted && !!auto
  // §11: tests aren't re-executable from here — iteration lives in the editor's Test card.
  const retryPrimary = e.status === 'failed' && !e.autoDeleted && !e.test
  const againQuiet = ['succeeded', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(e.status) && !e.autoDeleted && !e.test
  // §7: values as used by this execution — snapshotted on the record; older records fall back
  // to the automation's current params.
  const params = (full?.params?.length ? full.params : auto?.params) ?? []
  const result = full?.result ?? null

  // §6 queue position — the queue *is* the automation's `queued` records, drained
  // oldest first, so the list gives the position without a second endpoint.
  const queue: Exec[] = queued
    ? execs
      .filter((x) => x.autoId === e.autoId && x.status === 'queued')
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
    <Chip style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 500 }}>
      <i className="fa-solid fa-key" style={{ fontSize: 8.5 }} />
      secrets redacted: {e.redact?.join(', ')}
    </Chip>
  )

  const selStep = sel?.step != null ? steps[sel.step] : undefined
  const attempts = selStep?.attempts ?? []

  return shell(
    <>
      {/* §7: the row never wraps — the name ellipsizes so the actions stay on
        * the title line at the same height as every other page header. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '14px 0 6px' }}>
        <h1
          className={canOpenAuto ? 'ad-link-title' : undefined}
          onClick={() => { if (canOpenAuto) go('automation', { autoId: e.autoId }) }}
          title={canOpenAuto ? `Open automation — ${e.autoName}` : e.autoName}
          style={{
            fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0,
            cursor: canOpenAuto ? 'pointer' : 'default',
            minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {e.autoName}
        </h1>
        {e.test && (
          /* §11 draft test — a create-mode test has no automation by design */
          <Chip style={{ fontSize: 10.5, fontWeight: 600 }}>Draft test</Chip>
        )}
        {e.autoDeleted && !e.test && (
          <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>(deleted)</span>
        )}
        <Badge
          status={e.status}
          style={executing ? { animation: PULSE } : undefined}
        />
        <div style={{ flex: 1 }} />
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
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 18 }}>
        <span>{e.id}</span>
        {` · ${e.trigger}`}{e.ver ? ` · ${e.ver}` : ''}
        {/* A queued record has not started and has no duration (§7) — it reports
          * when it was queued and how long it has been waiting instead. */}
        {queued
          ? <> · queued {e.started} · waiting {waitedLabel(Date.now() - (e.queuedMs || e.startedMs))}</>
          : <> · started {e.started} · {e.dur}</>}
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
                  go('automation', { autoId: auto.id })
                  useStore.getState().setSurface('create', 'edit')
                } : undefined}
              />
            </div>
          )}

          {/* Full-width RESULT card (§7) — the execution's outcome, above the machinery */}
          {!full ? (
            <div style={{
              background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
              padding: 26, display: 'flex', justifyContent: 'center',
            }}>
              <Spinner />
            </div>
          ) : result ? (
            <ResultSection label="RESULT" result={result} execId={e.id} stamp={`${e.status}:${e.dur}`} />
          ) : (
            <EmptyNotice title="No result" body={noResultWhy} />
          )}

          {/* §7 TRIGGER MESSAGE — the run's input (steps read it via the §6.1
              SDK): below the outcome, above the machinery. */}
          {full?.triggerPayload && <TriggerMessage payload={full.triggerPayload} />}

          {/* Execution card (§7): STEPS rail + LOGS pane in one card — the rail's
              selection drives the pane, so they share a border. */}
          <div style={{
            display: 'grid', gridTemplateColumns: '250px 1fr', alignItems: 'stretch',
            background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden',
          }}>
            <div style={{ padding: '14px 0', borderRight: '1px solid var(--hairline)', minWidth: 0 }}>
              <Eyebrow style={{ padding: '0 18px', marginBottom: 10 }}>STEPS</Eyebrow>
              {!full ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 10px' }}><Spinner size={14} /></div>
              ) : steps.length === 0 ? (
                <div style={{ padding: '2px 18px 6px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)' }}>
                  {e.note ? `Nothing executed — ${e.note}.` : 'Nothing executed.'}
                </div>
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
                      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{p.label}</span>
                      {p.help && <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>{p.help}</span>}
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>{paramSummary(p)}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-muted)', paddingTop: 8, borderTop: '1px solid var(--hairline-dim)' }}>
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
                    Show workspace in Finder
                  </button>
                </div>
              )}
            </div>

            <div style={{ background: 'var(--bg-code)', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 18px', borderBottom: '1px solid var(--hairline-dim)',
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
                        key={a.n}
                        a={a}
                        active={sel?.attempt === a.n}
                        onSelect={() => { manualSel.current = true; setSel({ step: sel!.step, attempt: a.n }) }}
                      />
                    ))}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {e.redact && redactNote}
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
                  <Spinner size={14} />
                ) : (
                  <>
                    {logs.map((l) => (
                      <div key={l.seq} style={{ display: 'flex', gap: 12 }}>
                        <span style={{ color: 'var(--text-deco)', flex: 'none' }}>{l.t}</span>
                        <span style={{
                          color: logColor(l.k), whiteSpace: 'pre-wrap', minWidth: 0,
                          fontStyle: l.k === 'sys' ? 'italic' : 'normal',
                        }}>
                          {l.text}
                        </span>
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <div style={{ color: 'var(--text-muted)' }}>
                        {steps.length === 0
                          ? 'No logs — this execution never started.'
                          : sel?.step == null
                            ? 'No setup events — installs, retries, and failures would appear here.'
                            : 'No log lines here.'}
                      </div>
                    )}
                    {liveSelected && (
                      <span style={{
                        display: 'inline-block', width: 7, height: 13, background: 'var(--cyan)',
                        animation: 'adBlink 1s step-end infinite', verticalAlign: 'middle', marginLeft: 2,
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
