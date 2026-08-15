// §11 BUILD & TEST panel — the top card of the right column, merging the
// workflow's sync state (build zone, states 1–2) and the draft test (test
// zone, states 3–5) into one build→test surface. Owns the test-setup state
// (the disclosure toggle, the test-only param values, the trigger-message
// mock), the §8 pendingSync/pendingTest action chaining, and the run-settled
// thread entries. Quiet when fine, loud only when blocking.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { useTriggerPreview } from '../../triggers'
import { ParamValueEditor } from '../../steps'
import type { Agent, Automation, ChatEntry, DraftTrigger, ParamDef } from '../../types'
import { Eyebrow, GreenCheck, ProgressBar, Spinner } from '../../ui'
import { type Rev, analyzeTestMessage, applyTestValues, serializeDraft } from './model'
import { cardStyle } from './SectionCards'

// ---------- param value editor wrapper (§4.2 kinds — §11 test values) ----------

function ParamEditor({ p, upd }: { p: ParamDef; upd: (patch: Record<string, unknown>) => void }) {
  const mn = p.min ?? 0
  // shared presentational controls (../../steps); this wrapper owns the §11
  // test-card layout and the immediate value+default writes into the copy
  const valueProps = {
    p, variant: 'draft' as const,
    on: !!p.on,
    lines: p.lines ?? [],
    rows: p.rows ?? [],
    value: String(p.value ?? ''),
    setOn: (v: boolean) => upd({ on: v, default: v }),
    setLines: (next: string[]) => upd({ lines: next, default: next }),
    setRows: (next: { key: string; value: string }[]) => upd({ rows: next, default: next }),
    setText: (v: string) => upd({ value: v, default: v }),
    setNumber: (digits: string) => upd({ value: digits === '' ? '' : Number(digits), default: digits === '' ? mn : Number(digits) }),
  }
  if (p.kind === 'toggle') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <ParamValueEditor {...valueProps} />
      </div>
    )
  }
  if (p.kind === 'number') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '13px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
          <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', marginTop: 3 }}>{p.help}</div>
        </div>
        <ParamValueEditor
          {...valueProps}
          onBlur={() => {
            const n = typeof p.value === 'number' ? p.value : NaN
            if (Number.isNaN(n) || n < mn) upd({ value: mn, default: mn })
          }}
        />
      </div>
    )
  }
  // list / kv / text — stacked label + help over the full-width control
  return (
    <div style={{ padding: '14px 20px 15px', borderBottom: '1px solid var(--hairline-dim)' }}>
      <div style={{ font: "600 13px var(--sans)" }}>{p.label}</div>
      <div style={{ font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)', margin: '3px 0 9px' }}>{p.help}</div>
      <ParamValueEditor {...valueProps} />
    </div>
  )
}

// ---------- the panel ----------

export interface BuildTestPanelProps {
  rev: Rev
  up: (patch: Partial<Rev>) => void
  appendEntry: (e: Omit<ChatEntry, 'id' | 'at'>) => void
  isEdit: boolean
  auto: Automation | null
  outOfSync: boolean
  anyJobBusy: boolean
  busyRewrite: boolean
  viewingOld: boolean
  syncDisabled: boolean
  agentGap: boolean
  lockStyle?: React.CSSProperties
  runSync: () => void
  // §11 hold-and-flush: lands any held workflow chips when the old-version
  // watcher clears the pending sync silently — receipts still reach the thread
  flushHeldChips: () => void
  sendChat: (text?: string, runId?: string) => Promise<void>
  // §11 turn action row: the chat's Test-the-draft pill bumps this counter —
  // the panel starts a draft test (the panel's current setup values, seeded
  // defaults otherwise) and scrolls into view
  runTestSignal: number
}

export function BuildTestPanel({
  rev, up, appendEntry, isEdit, auto,
  outOfSync, anyJobBusy, busyRewrite, viewingOld, syncDisabled,
  agentGap, lockStyle, runSync, flushHeldChips, sendChat, runTestSignal,
}: BuildTestPanelProps) {
  const { executions, executionFull, go, showToast, test, beginTest } = useStore()

  // §11 test-setup section: the Test draft disclosure toggle —
  // expanding shows the Run test row first, then every test option at once
  // (param editors, trigger message). Values survive a collapse; only Run test
  // starts a test.
  const [testOpen, setTestOpen] = useState(false)
  // §11 test parameter values: seeded when the setup section first opens; the
  // values ride §19 `paramValues` and apply to this test only.
  const [testParams, setTestParams] = useState<ParamDef[] | null>(null)
  // §11 test trigger message: the mock rides §19 `triggerMock` only when the
  // message text is nonempty — an empty message runs the test without a payload.
  const [testMock, setTestMock] = useState<{ idx: number; text: string; sender: string } | null>(null)

  // §11: the tracked test is an ordinary execution record — steps/status render
  // off it (executionFull carries the body; the header list covers the gap before
  // loadExecution lands).
  const testExec = test ? executionFull[test.executionId] ?? executions.find((e) => e.id === test.executionId) : undefined
  const testLive = testExec?.status === 'executing'

  // ---- test (§11: create and edit mode) — executes the draft's REAL steps ----
  // §11 test values: seed from the automation's current values (draft default when a param
  // is new to the draft; create mode has no automation, so pure draft defaults), then the
  // drafted §8 test values (call 2's manifest `test_values`) over that base — edited
  // copies live only in this card.
  const seedTestParams = (): ParamDef[] => {
    const base = (rev?.params ?? []).map((d) => {
      const cur = (auto?.params ?? []).find((p) => p.name === d.name && p.kind === d.kind)
      if (d.kind === 'toggle') return { ...d, on: cur ? !!cur.on : !!d.default }
      if (d.kind === 'list') return { ...d, lines: cur?.lines ?? (Array.isArray(d.default) ? d.default as string[] : []) }
      if (d.kind === 'kv') return { ...d, rows: cur?.rows ?? (Array.isArray(d.default) ? d.default as { key: string; value: string }[] : []) }
      return { ...d, value: cur?.value ?? (d.default as string | number | undefined) }
    })
    return rev?.testValues ? applyTestValues(base, rev.testValues) : base
  }
  // A synced/reloaded draft may rename or retype params — collapse the setup
  // section and drop its values.
  useEffect(() => { setTestOpen(false); setTestParams(null) }, [rev.params])
  // §11 test trigger message: mock only against a message trigger in the editor's
  // list (off state irrelevant); a changed trigger list collapses the section.
  const msgTriggers = (rev.triggers ?? []).filter(
    (t): t is Extract<DraftTrigger, { kind: 'discord' | 'imessage' }> =>
      t.kind === 'discord' || t.kind === 'imessage')
  const mockSenderSeed = (t: DraftTrigger) => (t.kind === 'imessage' ? t.from : 'Test')
  // §19: the trigger-tab labels come from POST /triggers/preview (§4.3 — no
  // renderer trigger math); the kind name stands in until the response lands
  const msgPreviews = useTriggerPreview(msgTriggers)
  useEffect(() => { setTestOpen(false); setTestMock(null) }, [rev.triggers])
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
  // §11 test-setup disclosure: Test draft never starts a test —
  // it expands the setup section below the action row — the Run test row first,
  // then every option at once (param editors, trigger message). Entered values survive a
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
    <button className="ad-btn-text" data-testid="test-draft-toggle" disabled={busyRewrite} onClick={toggleTestSetup} style={panelBtnStyle}>
      {label}{' '}
      <i className={`fa-solid ${testOpen ? 'fa-caret-down' : 'fa-caret-left'}`} style={{ fontSize: 10 }} />
    </button>
  )
  // §11: in the in-sync states the build zone is gone — sync access stays as
  // this faint text button riding the test action rows (disabled, never hidden).
  const syncGhostBtn = (
    <button
      className="ad-btn-text dim" disabled={syncDisabled}
      onClick={runSync}
      style={panelBtnStyle}
    >
      Sync spec
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
    if (!rev || rev.steps.length === 0 || testLive || busyRewrite || outOfSync) return
    try {
      // §11: with the setup section never opened, drafted §8 test values still
      // apply — the closed-section run sends the seeded values (drafted map on
      // top of the stored/default base); without them the backend resolves as
      // before (stored values in edit mode, draft defaults in create).
      const values = valuesOverride ?? (testParams ? testParamValues(testParams)
        : rev.testValues && Object.keys(rev.testValues).length ? testParamValues(seedTestParams())
          : undefined)
      const mock = testMock ? testTriggerMock(testMock) : undefined
      // §11: a typed message with a blanked From must not silently run
      // without the mock — the user believes it was delivered.
      if (testMock?.text && !mock) {
        showToast('Add a From name for the test message — or clear the message to run without it.')
        return
      }
      // The tracked settled test is replaced only once the POST succeeds
      // (beginTest below) — a 409/error must not erase the last outcome.
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
    void sendChat(analyzeTestMessage(testExec?.error?.step), test.executionId)
  }

  // §11 turn action row: the chat's Test-the-draft pill — start the test
  // right away (the same run as Run test, with the panel's current setup
  // values or the seeded defaults) and bring the panel on screen so its live
  // test UI takes over.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!runTestSignal) return
    void runTest()
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [runTestSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11 chat-action chaining (§8 actions.yaml): pendingSync fires as soon as
  // nothing runs; pendingTest fires once the workflow is in sync (right away,
  // or after the chained sync lands) and is dropped with a system chip when
  // the sync didn't — a chat-armed test never runs stale steps.
  useEffect(() => {
    if (!rev || anyJobBusy || testLive) return
    if (!rev.pendingSync && !rev.pendingTest) return
    if (viewingOld) { up({ pendingSync: false, pendingTest: null }); flushHeldChips(); return }
    if (rev.pendingSync) {
      up({ pendingSync: false })
      runSync()
      return
    }
    if (outOfSync) {
      // chained sync failed / blocked / cancelled, or something rewrote first
      up({ pendingTest: null })
      appendEntry({ kind: 'system', icon: 'fa-rotate', text: 'Test skipped — the steps aren’t in sync with the spec.' })
      return
    }
    if (rev.steps.length === 0) { up({ pendingTest: null }); return }
    const values = rev.pendingTest?.values ?? null
    up({ pendingTest: null })
    if (values) setTestParams(applyTestValues(seedTestParams(), values)) // §11: pre-fill the panel's editors
    void runTest(values ?? undefined)
  }, [rev, anyJobBusy, testLive, viewingOld, outOfSync]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11 test-settled thread anchor: when the tracked test finishes, a
  // run-settled system entry lands so follow-up chat has the run in context.
  const prevTestStatus = useRef<string | null>(null)
  useEffect(() => {
    const st = testExec?.status ?? null
    const prev = prevTestStatus.current
    prevTestStatus.current = st
    if (!rev || !st || st === prev || prev !== 'executing') return
    if (st === 'succeeded') appendEntry({ kind: 'system', icon: 'fa-vial', text: 'Test succeeded.' })
    else if (st === 'failed') {
      appendEntry({
        kind: 'system',
        icon: 'fa-vial',
        text: `Test failed${testExec?.error?.step ? ` at step ${testExec.error.step}` : ''} — ${testExec?.error?.message ?? 'see the run'}.`,
      })
    }
  }, [testExec?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={rootRef} style={cardStyle}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--hairline)' }}>
        <Eyebrow>BUILD &amp; TEST</Eyebrow>
      </div>
      {/* build zone — states 1–2 only (sync in flight, out of
          sync); an in-sync workflow shows no indicator at all */}
      {(rev.syncBusy || outOfSync) && (
      <div style={{ padding: '12px 20px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* the indicator sits in an 18px box matching the title's line-height,
              so it stays centered on the first line even when the text wraps */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            <span style={{ height: 18, display: 'flex', alignItems: 'center', flex: 'none' }}>
              {/* §11: never a spinner here (the live surface is the chat
                  footer's action block) and never green — a faint dot
                  marks a job, amber marks out of sync */}
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: rev.syncBusy ? 'var(--text-faint)' : 'var(--amber)' }} />
            </span>
            <span style={{
              minWidth: 0,
              font: "500 12.5px/18px var(--sans)",
              color: rev.syncBusy ? 'var(--text-muted)' : 'var(--text)',
            }}>
              {rev.syncBusy
                ? 'Syncing the workflow…'
                : (rev.dirty ? 'The workflow is out of sync — these steps still match the old spec.'
                  : agentGap ? 'The workflow is out of sync — steps call an agent that isn’t enabled.'
                    : 'The workflow is out of sync — steps use a secret that isn’t allowed.')}
            </span>
          </div>
          {!rev.syncBusy && outOfSync && (
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
          className={outOfSync ? 'ad-btn-primary' : 'ad-btn-text dim'} data-testid="sync-steps"
          disabled={syncDisabled}
          onClick={runSync}
          style={outOfSync ? { flex: 'none', whiteSpace: 'nowrap' } : panelBtnStyle}
        >
          {outOfSync ? 'Sync now' : 'Sync spec'}
        </button>
      </div>
      )}
      {/* §11 test zone, out of sync: the test button disabled beside the
          sync-first hint — but a still-executing test keeps its Cancel */}
      {!rev.syncBusy && outOfSync && (
        <div style={{ padding: '12px 20px 14px', borderTop: '1px solid var(--hairline)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {testLive ? (
            <button className="ad-btn-text" onClick={cancelTest} style={panelBtnStyle}>
              Cancel
            </button>
          ) : (
            <button className="ad-btn-text" data-testid="test-draft-toggle" disabled style={panelBtnStyle}>
              Test draft
            </button>
          )}
          <span style={{ minWidth: 0, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
            Sync first — a test executes the steps as generated from the spec.
          </span>
        </div>
      )}
      {/* test zone — in-sync states only. One hairline opens the zone;
          the Test draft disclosure on the action row
          expands the test-setup section (Run test, then param editors and
          trigger message) as sub-blocks over dim dividers. */}
      {!rev.syncBusy && !outOfSync && (
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
                      {/* §11 state 4: Sync spec, then the Test draft
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
                          {testToggleBtn('Test draft')}
                          {/* §11: sends the canned analyze chat message — the
                              whole repair loop lives in the thread. Disabled
                              while a job runs, never hidden. */}
                          {testExec.status === 'failed' && (
                            <button className="ad-btn-text dim" disabled={anyJobBusy} onClick={runAnalyze} style={panelBtnStyle}>
                              <i className="fa-solid fa-magnifying-glass" style={{ fontSize: 10 }} /> Analyze failure
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
                  {testToggleBtn('Test draft')}
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
                {testToggleBtn('Test draft')}
                <span style={{ flex: '1 1 320px', minWidth: 0, font: "400 11.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
                  In sync with the spec. A test executes the real steps on this Mac — emails send, files move; memory is a scratch copy.
                </span>
              </div>
            )}
          </div>
          {/* §11 run row — opens the setup section, above the option
              sub-blocks so it's never buried under a long param list:
              Run test is the only control that starts a test; View run
              rides beside it when a test record exists */}
          {testOpen && !testLive && (
            <div className="ad-anim-item" style={{ borderTop: '1px solid var(--hairline-dim)', padding: '8px 20px 10px', ...lockStyle }}>
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
          {/* §11 test-setup option sub-blocks — expanded by the Test draft
              disclosure toggle, hidden while a test executes;
              every option at once below the run row */}
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
                        // .ad-btn-tab owns size + resting/hover colors; aria-pressed
                        // marks the active tab (accent text on the accent chip wash)
                        className="ad-btn-tab"
                        aria-pressed={i === testMock.idx}
                        onClick={() => setTestMock({ ...testMock, idx: i, sender: mockSenderSeed(t) })}
                      >
                        {msgPreviews[i]?.label ?? (t.kind === 'discord' ? 'Discord' : 'iMessage')}
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
        </>
      )}
    </div>
  )
}
