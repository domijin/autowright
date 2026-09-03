// §11 BUILD card and TEST card — the top two cards of the right column.
// BUILD holds the workflow's sync state (out of sync: amber dot + reason +
// Sync now; in sync: the quiet line + faint Sync spec). TEST launches the
// test-run modal and reports the outcome (never tested / executing with
// progress / settled / a resumed last test); it owns the test-setup values
// (test-only param values, the trigger-message mock), the §8
// pendingSync/pendingTest action chaining, and the run-settled thread
// entries. Quiet when fine, loud only when blocking.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { usePlatformCopy } from '../../platformCopy'
import { useStore } from '../../store'
import { useTriggerPreview } from '../../triggers'
import type { Automation, ChatEntry, DraftTrigger, ParamDef } from '../../types'
import { Eyebrow, LoadingRow, ProgressBar, Spinner, StatusLine } from '../../ui'
import { type Rev, analyzeTestMessage, applyTestValues, serializeDraft } from './model'
import { type MsgTrigger, type TestMock, TestRunModal } from './TestRunModal'

// §11 card buttons: compact borderless text buttons (the card-header
// treatment — never bordered or filled boxes); the class owns the padding,
// and the rows wrap so a button is never clipped.
const btnStyle: React.CSSProperties = { flex: 'none', whiteSpace: 'nowrap' }
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 10px' }
const hintFont = "400 11.5px/1.5 var(--sans)"

function CardHeader({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid var(--hairline)' }}>
      <Eyebrow>{label}</Eyebrow>
    </div>
  )
}

// ---------- BUILD card ----------

export interface BuildCardProps {
  rev: Rev
  outOfSync: boolean
  syncDisabled: boolean
  agentGap: boolean
  runSync: () => void
}

export function BuildCard({ rev, outOfSync, syncDisabled, agentGap, runSync }: BuildCardProps) {
  // §11: a sync in flight or armed is never a card state — while one runs
  // (however started) or a chat-armed pending sync waits to fire, the
  // workflow counts as in sync for the cards. The sync's live surface is the
  // thread progress entry alone, so the first turn's chat → chained sync →
  // done never moves the card. A failed / blocked / cancelled sync leaves the
  // workflow out of sync and the out-of-sync row renders then.
  const showOutOfSync = outOfSync && !rev.syncBusy && !rev.pendingSync
  return (
    <div className="ad-card" data-testid="build-card" style={{ overflow: 'hidden' }}>
      <CardHeader label="BUILD" />
      {showOutOfSync ? (
        <div style={{ padding: '12px 18px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* the indicator sits in an 18px box matching the title's line-height,
                so it stays centered on the first line even when the text wraps */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
              <span style={{ height: 18, display: 'flex', alignItems: 'center', flex: 'none' }}>
                {/* §11: never a spinner here (the live surface is the thread
                    progress entry) and never green — amber marks out of sync */}
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)' }} />
              </span>
              <span style={{ minWidth: 0, font: "500 12.5px/18px var(--sans)", color: 'var(--text)' }}>
                {rev.dirty ? 'The workflow is out of sync — these steps still match the old spec.'
                  : agentGap ? 'The workflow is out of sync — steps call an agent that isn’t enabled.'
                    : 'The workflow is out of sync — steps use a secret that isn’t allowed.'}
              </span>
            </div>
            <div style={{ font: hintFont, color: 'var(--text-muted)', margin: '2px 0 0 16px' }}>
              {rev.dirty ? 'Sync the steps to the new spec, then review them. Saving is locked until you do — nothing ships unreviewed.'
                : agentGap ? 'Re-enable the agent, or sync the steps so they only call agents available here. Saving is locked until you do.'
                  : 'Re-allow the secret, or sync the steps so they only use secrets allowed here. Saving is locked until you do.'}
            </div>
          </div>
          {/* §11: the one accent-primary button — Sync now; disabled per Dirty
              gating (another job in flight, an old version, a live test), never
              hidden. Its own sync hides this row (above). */}
          <button
            className="ad-btn-primary" data-testid="sync-steps"
            disabled={syncDisabled}
            onClick={runSync}
            style={btnStyle}
          >
            Sync now
          </button>
        </div>
      ) : (
        <div style={{ ...rowStyle, padding: '10px 18px 12px', justifyContent: 'space-between' }}>
          <span style={{ flex: '1 1 200px', minWidth: 0, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text-muted)' }}>
            In sync with the spec.
          </span>
          {/* §11: sync access on demand — faint, disabled per Dirty gating, never hidden */}
          <button className="ad-btn-text dim" disabled={syncDisabled} onClick={runSync} style={btnStyle}>
            Sync spec
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- TEST card ----------

export interface TestCardProps {
  rev: Rev
  up: (patch: Partial<Rev>) => void
  appendEntry: (e: Omit<ChatEntry, 'id' | 'at'>) => void
  isEdit: boolean
  auto: Automation | null
  outOfSync: boolean
  anyJobBusy: boolean
  busyRewrite: boolean
  viewingOld: boolean
  lockStyle?: React.CSSProperties
  runSync: () => void
  // §11 hold-and-flush: lands any held workflow chips when the old-version
  // watcher clears the pending sync silently — receipts still reach the thread
  flushHeldChips: () => void
  sendChat: (text?: string, executionId?: string) => Promise<void>
  // §11 turn action row: the chat's Test-the-draft pill bumps this counter —
  // the card starts a draft test (the current setup values, seeded defaults
  // otherwise) and opens the modal on the live run
  runTestSignal: number
  // §11: the create empty state has no draft to test — the modal closes
  isCreateEmpty: boolean
}

export function TestCard({
  rev, up, appendEntry, isEdit, auto,
  outOfSync, anyJobBusy, busyRewrite, viewingOld,
  lockStyle, runSync, flushHeldChips, sendChat, runTestSignal, isCreateEmpty,
}: TestCardProps) {
  // Per-field selectors (UI-GUIDE): a bare useStore() re-renders the whole
  // card on every store write anywhere — every toast, every log line.
  const executions = useStore((s) => s.executions)
  const executionFull = useStore((s) => s.executionFull)
  const go = useStore((s) => s.go)
  const showToast = useStore((s) => s.showToast)
  const test = useStore((s) => s.test)
  const beginTest = useStore((s) => s.beginTest)
  // §9 per-OS copy rule: the machine noun the side-effects line names.
  const copy = usePlatformCopy()

  // §11 test-run modal: open/closed is card state; its setup values live
  // here too so closing the modal keeps them.
  const [modalOpen, setModalOpen] = useState(false)
  // §11 test parameter values: seeded when the modal first opens; the values
  // ride §19 `paramValues` and apply to this test only.
  const [testParams, setTestParams] = useState<ParamDef[] | null>(null)
  // §11 test trigger message: the mock rides §19 `triggerMock` only when the
  // message text is nonempty — an empty message runs the test without a payload.
  const [testMock, setTestMock] = useState<TestMock | null>(null)

  // §11: the tracked test is an ordinary execution record — steps/status render
  // off it (executionFull carries the body; the header list covers the gap before
  // loadExecution lands).
  const testExec = test ? executionFull[test.executionId] ?? executions.find((e) => e.id === test.executionId) : undefined
  const testLive = testExec?.status === 'executing'

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
  // A synced/reloaded draft may rename or retype params — drop the values.
  useEffect(() => { setTestParams(null) }, [rev.params])
  // §11 test trigger message: mock only against a message trigger in the editor's
  // list (off state irrelevant); a changed trigger list drops the mock.
  const msgTriggers = (rev.triggers ?? []).filter(
    (t): t is MsgTrigger => t.kind === 'discord' || t.kind === 'imessage')
  const mockSenderSeed = (t: DraftTrigger) => (t.kind === 'imessage' ? t.from : 'Test')
  // §19: the trigger-tab labels come from POST /triggers/preview (§4.3 — no
  // renderer trigger math); the kind name stands in until the response lands
  const msgPreviews = useTriggerPreview(msgTriggers)
  useEffect(() => { setTestMock(null) }, [rev.triggers])
  // §11: the modal never renders during the create empty state
  useEffect(() => { if (isCreateEmpty) setModalOpen(false) }, [isCreateEmpty])
  // Seeding happens only when the modal opens without prior values.
  useEffect(() => {
    if (!modalOpen) return
    if (rev.params.length > 0 && testParams === null) setTestParams(seedTestParams())
    if (msgTriggers.length > 0 && testMock === null) {
      setTestMock({ idx: 0, text: '', sender: mockSenderSeed(msgTriggers[0]) })
    }
  }, [modalOpen, testParams, testMock]) // eslint-disable-line react-hooks/exhaustive-deps
  const testTriggerMock = (m: TestMock) => {
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

  // A live test survives leaving the editor — re-attach the card on entry.
  useEffect(() => {
    if (test) return
    // §4.5: a create-mode test record carries automationId null.
    const live = executions.find((e) => e.test && e.status === 'executing'
      && (isEdit ? e.automationId === auto?.id : !e.automationId))
    if (live) beginTest(live.id)
  }, [executions]) // eslint-disable-line react-hooks/exhaustive-deps
  const runTest = async (valuesOverride?: Record<string, unknown>) => {
    // §11: a test always runs steps that match the spec — never stale ones
    // (out of sync) and never mid-build. An old version is never synced or
    // tested (§11), so a version view can't start one either.
    if (!rev || rev.steps.length === 0 || testLive || busyRewrite || outOfSync || viewingOld) return
    try {
      // §11: with the modal never opened, drafted §8 test values still apply —
      // the run sends the seeded values (drafted map on top of the
      // stored/default base); without them the backend resolves as before
      // (stored values in edit mode, draft defaults in create).
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
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const cancelTest = () => {
    if (test && testLive) void api.cancelExecution(test.executionId).catch(() => { /* already done */ })
  }
  const skipStep = (i: number) => {
    if (test && testLive) void api.skipStep(test.executionId, i).catch((err: Error) => showToast(err.message))
  }
  // §11: analysis runs only when asked, as the canned analyze chat message —
  // an ordinary §8 chat job reading the failing run's RECENT EXECUTIONS context.
  const runAnalyze = () => {
    if (!rev || !test || anyJobBusy || testLive || viewingOld) return
    void sendChat(analyzeTestMessage(copy.machine, testExec?.error?.step), test.executionId)
  }

  // §11 turn action row: the chat's Test-the-draft pill — start the test
  // right away (the same run as Run test, with the current setup values or
  // the seeded defaults) and open the modal on the live run.
  useEffect(() => {
    if (!runTestSignal) return
    void runTest()
    setModalOpen(true)
  }, [runTestSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11 chat-action chaining (§8 actions.yaml): pendingSync fires as soon as
  // nothing runs; pendingTest fires once the workflow is in sync (right away,
  // or after the chained sync lands) and is dropped with a system chip when
  // the sync didn't — a chat-armed test never runs stale steps. A chat-armed
  // test never opens the modal — the agent's answer is being read.
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
    if (values) {
      // §11: pre-fill the modal's editors and send the SAME coerced values —
      // raw yaml shapes (quoted numbers, kv mappings) would fail the backend's
      // kind check and silently fall back to defaults while the editors show
      // the coerced prefill.
      const seeded = applyTestValues(seedTestParams(), values)
      setTestParams(seeded)
      void runTest(testParamValues(seeded))
    } else {
      void runTest()
    }
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

  // §11: the out-of-sync state the BUILD card shows — a sync in flight or
  // armed counts as in sync for both cards.
  const showOutOfSync = outOfSync && !rev.syncBusy && !rev.pendingSync
  // §11 state 4: a resumed last test opens the modal on its run while the
  // record still exists (retention may outlive it).
  const lastTestId = rev.lastTest?.executionId && executions.some((e) => e.id === rev.lastTest!.executionId)
    ? rev.lastTest.executionId : null
  const runExecutionId = test ? test.executionId : lastTestId
  // §11: Test draft never starts a test — it opens the modal; disabled under
  // the inputs lock, while an old version is viewed, and with no steps.
  const launchDisabled = busyRewrite || viewingOld || rev.steps.length === 0
  const launchBtn = (
    <button className="ad-btn-text" data-testid="test-draft-toggle" disabled={launchDisabled} onClick={() => setModalOpen(true)} style={btnStyle}>
      Test draft
    </button>
  )
  const runDisabledReason = rev.steps.length === 0 ? 'Sync the workflow first — there are no steps to test.'
    : showOutOfSync || outOfSync ? 'Sync first — a test executes the steps as generated from the spec.'
      : busyRewrite ? 'Wait for the current request to finish.'
        : testLive ? 'A test is already executing.'
          : viewingOld ? 'An old version is never tested — restore it first.'
            : null

  return (
    <>
      <div className="ad-card" data-testid="test-card" style={{ overflow: 'hidden' }}>
        <CardHeader label="TEST" />
        <div style={{ padding: '12px 18px 14px' }}>
          {test && testLive ? (
            /* state 1 — executing: status + progress; the run itself lives in the modal */
            !testExec ? (
              <LoadingRow label="Loading the test…" />
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: "400 12.5px var(--sans)", color: 'var(--text-2)' }}>
                  <Spinner size={13} />
                  <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Executing
                    {testSteps.length > 0 ? ` — step ${Math.max(testLiveIdx, 0) + 1} of ${testSteps.length}` : ''}
                    {testLiveIdx >= 0 ? ` · ${testSteps[testLiveIdx].name}` : ''}
                  </span>
                </div>
                {testSteps.length > 0 && (
                  <div style={{ margin: '11px 0 3px' }}>
                    <ProgressBar percent={(testDone / testSteps.length) * 100} />
                  </div>
                )}
                <div style={{ ...rowStyle, marginTop: 8 }}>
                  <button className="ad-btn-text" onClick={() => setModalOpen(true)} style={btnStyle}>
                    Open test
                  </button>
                  <button className="ad-btn-text" onClick={cancelTest} style={btnStyle}>
                    Cancel
                  </button>
                </div>
              </>
            )
          ) : showOutOfSync ? (
            /* state 2 — out of sync: the launcher disabled beside the sync-first hint */
            <div style={rowStyle}>
              <button className="ad-btn-text" data-testid="test-draft-toggle" disabled style={btnStyle}>
                Test draft
              </button>
              <span style={{ flex: '1 1 200px', minWidth: 0, font: hintFont, color: 'var(--text-muted)' }}>
                Sync first — a test executes the steps as generated from the spec.
              </span>
            </div>
          ) : test ? (
            /* state 3 — settled */
            !testExec ? (
              <LoadingRow label="Loading the test…" />
            ) : (
              <>
                {testExec.status === 'succeeded' ? (
                  <StatusLine tone="green" label="Test succeeded — the memory copy was discarded." />
                ) : testExec.status === 'failed' ? (
                  <StatusLine tone="amber" label="Test failed." />
                ) : (
                  <div style={{ font: "400 12.5px var(--sans)", color: 'var(--text-faint)' }}>
                    Test {testExec.status}.
                  </div>
                )}
                <div style={{ ...rowStyle, marginTop: 8 }}>
                  {launchBtn}
                  {/* §11: sends the canned analyze chat message — the whole
                      repair loop lives in the thread. Disabled while a job
                      runs, never hidden. */}
                  {testExec.status === 'failed' && (
                    <button className="ad-btn-text dim" disabled={anyJobBusy} onClick={runAnalyze} style={btnStyle}>
                      <i className="fa-solid fa-magnifying-glass" style={{ fontSize: 10 }} /> Analyze failure
                    </button>
                  )}
                </div>
              </>
            )
          ) : rev.lastTest ? (
            /* state 4 — persisted last-test summary (test.yaml): a resumed
               draft shows the outcome instead of throwing it away */
            <>
              {rev.lastTest.status === 'succeeded' ? (
                <StatusLine tone="green" label={`Last test succeeded — ${rev.lastTest.when}.`} />
              ) : (
                <StatusLine tone="amber" label={`Last test failed — ${rev.lastTest.when}.`} />
              )}
              <div style={{ ...rowStyle, marginTop: 8 }}>{launchBtn}</div>
            </>
          ) : (
            /* state 5 — never tested: the quiet launcher (testing never
               shouts — a failed test never blocks saving) beside the
               plain-words side-effects line, which wraps below when space
               runs out */
            <div style={rowStyle}>
              {launchBtn}
              <span style={{ flex: '1 1 200px', minWidth: 0, font: hintFont, color: 'var(--text-muted)' }}>
                A test executes the real steps on this {copy.machine} — emails send, files move; memory is a scratch copy.
              </span>
            </div>
          )}
        </div>
      </div>
      {modalOpen && (
        <TestRunModal
          steps={rev.steps}
          runExecutionId={runExecutionId}
          testParams={testParams}
          setTestParams={setTestParams}
          testMock={testMock}
          setTestMock={setTestMock}
          msgTriggers={msgTriggers}
          msgLabels={msgPreviews.map((p) => p?.label)}
          mockSenderSeed={mockSenderSeed}
          runDisabledReason={runDisabledReason}
          onRun={() => runTest()}
          onCancel={cancelTest}
          onSkip={skipStep}
          onViewExecution={() => { if (runExecutionId) go('execution', { executionId: runExecutionId }) }}
          onAnalyze={test && testExec?.status === 'failed' ? runAnalyze : null}
          analyzeDisabled={anyJobBusy}
          lockStyle={lockStyle}
          machine={copy.machine}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}
