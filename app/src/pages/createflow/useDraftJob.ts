// §8/§11 job orchestration for the create/edit editor: one hook owning the
// POST /drafts + poll lifecycle for all three job modes (create, chat, sync)
// and every cancel path. All jobs run through one {start, cancel} core sharing
// jobIdRef / cancelGenRef / stopPoll, so the gen-guard (a cancel landing while
// the POST is in flight), the staleness guard on slow poll ticks, and the
// leave-the-page cleanup behave identically no matter how a job was started.
import { useEffect, useRef } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import type { Agent, Automation, Blocker, ChatEntry, DraftPayload, SpecBlock } from '../../types'
import {
  type Rev, TRIGGER_SETUP_TEXT, answerHeader, applyTriggerOps, chatSinceBoundary, coerceParamValue, jobStageTitle,
  mergeDraftTriggers,
  needsMessageTriggerSetup, newEntry, persistChat,
  seedDrafting, seedEmpty, seedFromPayload, serializeDraft, stageDisplayTitle,
} from './model'

interface PollHandlers {
  onDone: (d: DraftPayload) => void
  onFail: (msg: string, detail?: string[]) => void
  onCancelled?: () => void
  // §8: `notes` is the blocker response's optional notes.md — applied by every
  // handler like a chat notes rewrite, so a blocked build keeps what it learned.
  onBlocked?: (blockers: Blocker[], at: 'spec' | 'steps' | 'chat', spec: SpecBlock[] | null, diagnosed: boolean, notes: string | null) => void
  onSpec?: (spec: SpecBlock[]) => void // §11: create job's call-1 spec, mid-job
}

export interface DraftJobDeps {
  rev: Rev | null
  setRev: React.Dispatch<React.SetStateAction<Rev | null>>
  up: (patch: Partial<Rev>) => void
  agents: Agent[]
  secretNames: string[]
  isEdit: boolean
  auto: Automation | null
  agentId: string | null
  showToast: (msg: string, ms?: number) => void
  chatText: string
  setChatText: React.Dispatch<React.SetStateAction<string>>
  setNameEdit: (v: string | null) => void
  setDescEdit: (v: string | null) => void
  // §11 gating, derived by the page: one agent job at a time, rewrites lock
  // while a test executes, old versions are read-only.
  anyJobBusy: boolean
  testLive: boolean
  viewingOld: boolean
}

export function useDraftJob(d: DraftJobDeps) {
  const {
    rev, setRev, up, agents, secretNames, isEdit, auto, agentId, showToast,
    chatText, setChatText, setNameEdit, setDescEdit, anyJobBusy, testLive, viewingOld,
  } = d

  const jobIdRef = useRef<string | null>(null)
  // Cancel generation: bumped by every cancel path (and unmount). A POST-then-
  // poll flow captures it before the await; if it moved while the POST was in
  // flight, the flow cancels the freshly created job instead of arming the
  // poll — otherwise a cancel that lands mid-POST is silently ignored.
  const cancelGenRef = useRef(0)
  // §11 chat pane input + the description that started the create job (Try
  // again / blocker answers re-run against it).
  const lastCreateRef = useRef('')
  const createEntryRef = useRef<string | null>(null)
  const chatReqRef = useRef<{ text: string; entryId: string } | null>(null)
  const dirtyBeforeSync = useRef(false)
  // §11 workflow chip group (hold-and-flush): a chat response arming a sync
  // holds its staged-change chips here; the sync's settle — any outcome — or
  // the old-version watcher's silent pending-clear flushes them beneath the
  // sync trail, so the workflow group reads contiguously.
  const heldChipsRef = useRef<ChatEntry[]>([])
  const takeHeldChips = (): ChatEntry[] => {
    const held = heldChipsRef.current
    heldChipsRef.current = []
    return held
  }
  // §11: the old-version watcher clears pending sync/test silently — the held
  // receipts still land (the staging already happened at apply time).
  const flushHeldChips = () => {
    const held = takeHeldChips()
    if (held.length) setRev((r) => r && ({ ...r, chat: [...r.chat, ...held] }))
  }

  // ---- polling ----
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  const startPoll = (jobId: string, { onDone, onFail, onCancelled, onBlocked, onSpec }: PollHandlers) => {
    stopPoll()
    jobIdRef.current = jobId
    let specDelivered = false
    let lastStage: string | null = null
    let lastDetail: string | null = null
    let lastEvKey = ''
    // §11 per-stage activity entries: the stages observed so far (chronological
    // — event stamps first, then the live stage) and the ones already settled
    // into the thread, so each stage lands exactly one entry.
    const seenStages: string[] = []
    const settledStages = new Set<string>()
    const noteStage = (s: string | null | undefined) => {
      if (s && !seenStages.includes(s)) seenStages.push(s)
    }
    // Builds (and marks settled) one activity entry per given stage, each
    // carrying its own stage-stamped slice of the feed; only the last stage of
    // a terminal batch takes the job's outcome — earlier stages finished fine.
    // §11: every stage that was on screen settles — a shown block is never
    // removed, even when its feed is empty (a bare title + check is the
    // record that the phase ran).
    const settleStages = (
      mode: 'create' | 'chat' | 'sync', evs: { text: string; stage?: string }[],
      stages: string[], outcome: 'done' | 'blocked' | 'failed' | null,
    ) => stages.map((s, i) => {
      settledStages.add(s)
      // §8 stamps every event; a stampless one (older payloads) belongs to
      // the batch's first stage rather than vanishing
      const text = evs.filter((e) => e.stage === s || (!e.stage && i === 0))
        .map((e) => e.text).join('\n')
      return newEntry({
        kind: 'activity', title: stageDisplayTitle(s),
        // §11: a deciding phase whose stream left no milestones still says
        // what it did — a settled block is never a bare title
        text: text || (s === 'Working on the request' ? 'Choosing what to do' : ''),
        outcome: outcome && i === stages.length - 1 ? outcome : 'done',
      })
    })
    // Staleness guard: a slow in-flight tick may resolve after this job was
    // cancelled/replaced (jobIdRef changed) or after another tick already
    // handled the terminal status (jobIdRef cleared below). Checking the ref
    // covers both — callbacks fire once, and never against a different job.
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const j = await api.getDraftJob(jobId)
          if (jobIdRef.current !== jobId) return
          if (j.status !== 'building') jobIdRef.current = null
          // §8/§11: the job's live stage drives the skeleton + save-hint labels
          // (the unified three-phase set); `detail` is the
          // finer live-progress line under it, `events` the feed's history.
          const evs = j.events ?? []
          // §11: chat/create jobs display "Working on the request…" from the
          // moment of send (the pre-poll default title) — seed it first so the
          // shown block always settles, even when the backend flipped stages
          // before the first poll ever observed the neutral one.
          if (j.mode !== 'sync') noteStage('Working on the request')
          evs.forEach((e) => noteStage(e.stage))
          noteStage(j.stage)
          const evKey = evs.length ? `${evs.length}:${evs[evs.length - 1].text}` : ''
          if (j.status === 'building' && (j.stage !== lastStage || (j.detail ?? null) !== lastDetail || evKey !== lastEvKey)) {
            lastStage = j.stage
            lastDetail = j.detail ?? null
            lastEvKey = evKey
            // §11: a stage the job moved past settles into the thread right
            // away — its title and feed survive the transition — and the live
            // progress entry restarts with only the current stage's events.
            const finished = settleStages(j.mode, evs,
              seenStages.filter((s) => s !== j.stage && !settledStages.has(s)), null)
            const texts = evs.filter((e) => !e.stage || e.stage === j.stage).map((e) => e.text)
            setRev((r) => (r ? {
              ...r, genStage: j.stage, genDetail: lastDetail, genEvents: texts,
              ...(finished.length ? { chat: [...r.chat, ...finished] } : {}),
            } : r))
          }
          if (onSpec && !specDelivered && j.status === 'building' && j.draft?.spec) {
            specDelivered = true
            onSpec(j.draft.spec)
          }
          // §11 activity entries: a settled job persists every stage not yet
          // settled (rendered with a glyph where the spinner was), each with
          // its own feed slice, before the outcome entries the handlers
          // append; only the last takes the job's outcome. A cancelled job
          // leaves none for its in-flight stage — its request returns to the
          // input — but already-settled stages stay.
          if (j.status === 'done' || j.status === 'blocked' || j.status === 'failed') {
            const status = j.status
            const pending = seenStages.filter((s) => !settledStages.has(s))
            const rest = settleStages(j.mode, evs, pending, status)
            setRev((r) => {
              if (!r) return r
              // A payload with no stage at all (belt-and-braces — the backend
              // always sets one) settles the old way: one entry, busy-flag
              // title, the whole feed. A batch emptied by the neutral-stage
              // drop rule appends nothing — the stage existed, and was skipped
              // deliberately.
              const entries = (rest.length || pending.length) ? rest : [newEntry({
                kind: 'activity', title: jobStageTitle(r),
                text: evs.map((e) => e.text).join('\n'), outcome: status,
              })]
              return entries.length ? { ...r, chat: [...r.chat, ...entries] } : r
            })
          }
          if (j.status === 'done') {
            stopPoll()
            if (j.draft) onDone(j.draft)
            else onFail('The agent returned an empty draft.')
          } else if (j.status === 'blocked') {
            stopPoll()
            if (onBlocked) onBlocked(j.blockers ?? [], j.blockedAt ?? 'steps', j.draft?.spec ?? null, j.diagnosed ?? false, j.draft?.notes ?? null)
            else onFail(j.error || 'Your AI hit a blocker.')
          } else if (j.status === 'failed') {
            stopPoll()
            onFail(j.error || '', j.errorDetail)
          } else if (j.status === 'cancelled') {
            stopPoll()
            onCancelled?.()
          }
        } catch (e) {
          if (jobIdRef.current !== jobId) return
          jobIdRef.current = null
          stopPoll()
          onFail((e as Error).message)
        }
      })()
    }, 700)
  }

  // §8 blocker notes: a blocked job's draft.notes applies exactly like a chat
  // notes rewrite — state patch plus a "Notes updated." chip after the
  // blockers entry; notes never mark the workflow out of sync (§4.1).
  const blockerNotes = (r: Rev, notes: string | null) => (notes != null && notes !== r.notes
    // §4.4: an applied notes rewrite is a draft change — it marks touched
    // (the thread itself no longer rides the draft)
    ? { patch: { notes, touched: true }, chip: [newEntry({ kind: 'system' as const, icon: 'fa-note-sticky', text: 'Notes updated.' })] }
    : { patch: {}, chip: [] })

  // The {start} half of the core: POST the job, then arm the poll — unless a
  // cancel landed while the POST was in flight (gen moved), in which case the
  // freshly created job is cancelled instead.
  const startJob = async (body: Parameters<typeof api.postDraftJob>[0], handlers: PollHandlers) => {
    const gen = cancelGenRef.current
    const { jobId } = await api.postDraftJob(body)
    if (cancelGenRef.current !== gen) { void api.cancelDraftJob(jobId).catch(() => { /* already gone */ }); return }
    startPoll(jobId, handlers)
  }

  // The {cancel} half of the core: stop polling, invalidate any in-flight
  // POST via the gen counter, and kill the running job. Every cancel path
  // (chat, create, sync, steps-generation, Start over, unmount) goes through
  // here and layers its own state patch on top.
  const cancelJob = () => {
    stopPoll()
    cancelGenRef.current++
    if (jobIdRef.current) void api.cancelDraftJob(jobIdRef.current).catch(() => { /* already gone */ })
    jobIdRef.current = null
  }

  useEffect(() => () => {
    // Leaving the editor any way (sidebar nav, system back) must not orphan an
    // in-flight §8 drafting job — nobody would poll it and the harness would
    // keep working for a discarded result. Cancelling a finished job is a no-op.
    cancelJob()
    // §11: a live test keeps executing — it's a real record, visible and
    // cancellable from its execution page; re-entering the editor re-attaches.
    useStore.getState().clearTest()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- create job (§11: the first chat message drafts the automation) ----
  // The review pane empties right away; the spec card spins on call 1, renders
  // the spec the moment it validates (onSpec, mid-job), and the right column
  // stays skeleton until call 2 delivers the steps. The thread survives.
  const submitCreate = async (request: string) => {
    lastCreateRef.current = request
    setNameEdit(null)
    setDescEdit(null)
    setRev((r) => ({
      ...seedDrafting(agents, secretNames),
      chat: r?.chat ?? [], resolved: r?.resolved ?? [],
    }))
    // Tracks whether call 1 already landed the spec: a failure before that is
    // a spec-call failure, and §11 returns the description to the input (same
    // restore as cancelCreate).
    let specLanded = false
    try {
      await startJob({ mode: 'create', text: request, agentId }, {
        onDone: (d) => setRev((r) => ({
          ...seedFromPayload(d, agents, secretNames),
          chat: [
            ...(r?.chat ?? []),
            newEntry({ kind: 'system', icon: 'fa-wand-magic-sparkles', text: 'Draft generated — review the spec and steps, then create it.' }),
            // §11 trigger-setup reminder: the agent omitted a message trigger
            // it lacked details for — the user adds it on the automation page
            ...(needsMessageTriggerSetup(d.steps ?? [], d.triggers ?? [])
              ? [newEntry({ kind: 'system', icon: 'fa-clock', text: TRIGGER_SETUP_TEXT })] : []),
          ],
          resolved: r?.resolved ?? [],
          // §11 title: the manifest name replaces the spec-title provisional
          name: d.name || (d.spec ?? []).find((b) => b.kind === 'h1')?.text || 'New automation',
        })),
        onFail: (msg, detail) => {
          // §11: a spec-call failure lands in the thread — red-tinted error
          // entry with Try again (the description also returns to the input).
          if (!specLanded) setChatText((cur) => cur || lastCreateRef.current)
          setRev((r) => r && (r.specBusy
            ? {
              ...r, specBusy: false,
              chat: [...r.chat, newEntry({ kind: 'error', source: 'spec', text: msg || 'The spec didn’t validate — try again or rephrase.' })],
            }
            : { ...r, stepsBusy: false, stepsErr: { msg, detail } }))
        },
        onCancelled: () => setRev((r) => r && ({ ...seedEmpty(agents, secretNames), chat: r.chat })),
        // §11 Blockers: a spec-call block is the clarification case, a
        // steps-call block leaves the workflow out of sync — both land as
        // thread blockers entries (plus the §8 blocker notes when carried).
        onBlocked: (blockers, at, spec, diagnosed, notes) => setRev((r) => {
          if (!r) return r
          const bn = blockerNotes(r, notes)
          return at === 'spec'
            ? {
              ...r, specBusy: false, stepsBusy: false, ...bn.patch,
              chat: [...r.chat, newEntry({ kind: 'blockers', source: 'spec', blockers, diagnosed, resolved: r.resolved }), ...bn.chip],
            }
            : {
              ...r, stepsBusy: false, spec: spec ?? r.spec, dirty: true, ...bn.patch,
              chat: [...r.chat, newEntry({ kind: 'blockers', source: 'steps', blockers, diagnosed, resolved: r.resolved }), ...bn.chip],
            }
        }),
        onSpec: (spec) => {
          specLanded = true
          setRev((r) => r && ({
            ...r, specBusy: false, stepsBusy: true, spec,
            name: spec.find((b) => b.kind === 'h1')?.text || r.name,
          }))
        },
      })
    } catch (e) {
      // POST failed — still the spec call, so the description returns too.
      setChatText((cur) => cur || lastCreateRef.current)
      setRev((r) => r && ({
        ...r, specBusy: false,
        chat: [...r.chat, newEntry({ kind: 'error', source: 'spec', text: (e as Error).message })],
      }))
    }
  }

  // §11: any spec / instruction / agent-ask / grant change while the steps are
  // still generating cancels the in-flight steps call — the landed spec is
  // kept and the standard sync panel rebuilds the steps. Returns true when a
  // steps call was cancelled (callers add stepsBusy:false + dirty to their patch).
  const cancelStepsGen = (): boolean => {
    if (!rev?.stepsBusy) return false
    cancelJob()
    return true
  }

  // §11: a chat message starts one §8 `chat` job — the drafting agent gets the
  // in-editor draft (spec + steps + build instructions + notes), the grants
  // context, and the recent thread; the backend adds the RECENT RUNS and
  // PACKAGES context itself. One response may combine an answer with rewrites
  // (spec / build instructions / notes) and follow-up actions (sync, test,
  // rename) — applied in that order (§11), with the sync/test chain armed as
  // pending flags a watcher effect fires.
  const sendChat = async (textArg?: string, runId?: string) => {
    if (!rev || anyJobBusy || testLive || viewingOld) return
    const request = (textArg ?? chatText).trim()
    if (!request) return
    if (textArg === undefined) setChatText('')
    const entry = newEntry({ kind: 'user', text: request })
    chatReqRef.current = { text: request, entryId: entry.id }
    // §8 undo action: inputs lock while the job runs, so the snapshot at send
    // time is the snapshot at apply time — decides the restore toast below
    const hadSnap = !!rev.undo
    // §8/§4.4: the thread BEFORE this message, clipped at the newest boundary
    // marker — a settled draft session's conversation never reaches the agent
    const history = chatSinceBoundary(persistChat(rev.chat))
    const current = serializeDraft(rev)
    const genCancelled = cancelStepsGen()
    setRev((r) => r && ({
      ...r,
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // one edit at a time
      notesDraft: null, notesEdit: false,
      // §11 auto-dismiss on reply: a sent message answers any open
      // clarification blockers (spec/chat source); steps/sync entries stay
      // open — their Apply button remains useful until a sync lands
      chat: [...r.chat.map((e) => (e.kind === 'blockers' && !e.dismissed
        && (e.source === 'chat' || e.source === 'spec') ? { ...e, dismissed: true } : e)), entry],
      // §4.4 thread lifetime: the thread no longer rides the draft, so sending
      // alone doesn't touch it — a pure Q&A keeps no draft. The response
      // handler marks touched when it actually changes the draft.
      chatBusy: true, genStage: null, genDetail: null, genEvents: [],
      ...(genCancelled ? { stepsBusy: false, dirty: true } : {}),
    }))
    try {
      await startJob({
        mode: 'chat', text: request, ...(isEdit && auto ? { automationId: auto.id } : {}),
        ...(runId ? { runId } : {}),
        agentId, current, chat: history,
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      }, {
        onDone: (dft) => {
          const actions = dft.actions ?? {}
          const rewrote = !!dft.spec || dft.instructions != null || dft.notes != null
          const empty = !dft.answer && !rewrote && !dft.actions
          setRev((r) => {
            if (!r) return r
            let next: Rev = { ...r, chatBusy: false }
            const chat = [...r.chat]
            // §11 answer header: stamped at creation — a reply arriving with
            // rewrites or actions is the plan; a question gets its own glyph
            if (dft.answer) chat.push(newEntry({
              kind: 'answer', text: dft.answer,
              ...answerHeader(dft.answer, rewrote || Object.keys(actions).length > 0),
            }))
            // §8 undo action: arrives alone (validation) — run the §11
            // restore exactly like the undo row's button, or say there is
            // nothing left to undo
            if (actions.undo) {
              const snap = r.undo
              if (snap) {
                next = {
                  ...next,
                  spec: snap.spec, steps: snap.steps, params: snap.params, packages: snap.packages,
                  triggers: snap.triggers, paramValues: snap.paramValues, concurrency: snap.concurrency,
                  testValues: snap.testValues,
                  instructions: snap.instructions, notes: snap.notes,
                  dirty: snap.dirty, undo: null,
                }
                chat.push(newEntry({ kind: 'system', icon: 'fa-rotate-left', text: 'Last change undone — the rewrites above no longer apply.' }))
              } else {
                chat.push(newEntry({ kind: 'system', icon: 'fa-rotate-left', text: 'Nothing to undo.' }))
              }
            }
            // §11 draft undo: a draft-changing response stashes the full
            // pre-request draft as one snapshot, anchored to the LAST
            // document entry it appends — the standalone undo row renders
            // directly beneath it
            let anchorId: string | null = null
            if (dft.spec) {
              const entry = newEntry({ kind: 'rewrite', text: request })
              anchorId = entry.id
              next = { ...next, spec: dft.spec, dirty: true }
              chat.push(entry)
            }
            if (dft.instructions != null && dft.instructions !== r.instructions) {
              const entry = newEntry({ kind: 'system', icon: 'fa-list-check', text: 'Build instructions updated.' })
              anchorId = entry.id
              // like a manual Build-instructions save — same dirty gating (§11)
              next = { ...next, instructions: dft.instructions, dirty: true }
              chat.push(entry)
            }
            if (dft.notes != null && dft.notes !== r.notes) {
              const entry = newEntry({ kind: 'system', icon: 'fa-note-sticky', text: 'Notes updated.' })
              anchorId = entry.id
              // notes never mark the workflow out of sync (§4.1)
              next = { ...next, notes: dft.notes }
              chat.push(entry)
            }
            if (actions.name && actions.name !== r.name) {
              const entry = newEntry({ kind: 'system', icon: 'fa-pen', text: `Renamed to “${actions.name}”.` })
              if (anchorId) anchorId = entry.id // the row sits below every chip the request produced
              next = { ...next, name: actions.name }
              chat.push(entry)
            }
            if (actions.description && actions.description !== r.description) {
              const entry = newEntry({ kind: 'system', icon: 'fa-pen', text: 'Description updated.' })
              if (anchorId) anchorId = entry.id
              next = { ...next, description: actions.description }
              chat.push(entry)
            }
            // §11 workflow chip group: the staged-change chips collect here —
            // held for the chained sync's settle when the response arms one,
            // landed right after the document chips otherwise (hold-and-flush).
            const wfChips: ChatEntry[] = []
            // §8 `param_values`: stage stored values (§4.2) — coerced against
            // today's defs; a name today's defs don't hold stays raw in the
            // map and re-checks after the chained sync lands (§11).
            if (actions.paramValues) {
              const staged = { ...next.paramValues }
              for (const [n, v] of Object.entries(actions.paramValues)) {
                const def = r.params.find((p) => p.name === n)
                staged[n] = def ? coerceParamValue(def, v) : v
                const entry = newEntry({ kind: 'system', icon: 'fa-sliders', text: `Parameter “${n}” staged — applies when you save.` })
                anchorId = entry.id
                wfChips.push(entry)
              }
              next = { ...next, paramValues: staged }
            }
            // §8 `triggers` ops: edit the editor's trigger list (staged like a
            // sync's §4.3 preview — lands only at save), one chip per op.
            if (actions.triggers?.length) {
              const applied = applyTriggerOps(next.triggers, actions.triggers)
              next = { ...next, triggers: applied.triggers }
              for (const text of applied.chips) {
                const entry = newEntry({ kind: 'system', icon: 'fa-clock', text })
                anchorId = entry.id
                wfChips.push(entry)
              }
            }
            // §8 `concurrency`: stage the §4.1 settings — sent keys merge over
            // the staged object, land only at save; the CONCURRENCY card shows
            // the staged values.
            if (actions.concurrency) {
              next = { ...next, concurrency: { ...next.concurrency, ...actions.concurrency } }
              const entry = newEntry({ kind: 'system', icon: 'fa-layer-group', text: 'Concurrency staged — applies when you save.' })
              anchorId = entry.id
              wfChips.push(entry)
            }
            // §11 hold-and-flush: an armed sync takes the workflow chips with
            // it (assignment, not append — idempotent under a re-run updater);
            // no sync means they land now, after the document chips. The undo
            // anchor may point at a held chip — the row stays hidden until the
            // flush lands it in the thread.
            const willSync = !!(actions.sync || (actions.test && next.dirty))
            if (willSync) heldChipsRef.current = wfChips
            else chat.push(...wfChips)
            // §4.4: a response that changed the draft marks it touched — an
            // answer-only reply leaves the draft (and the keep paths) alone.
            // anchorId covers every doc rewrite and staged chip; the undo
            // restore counts only when a snapshot actually restored.
            if (anchorId || (actions.undo && r.undo)) next = { ...next, touched: true }
            // an answer-only response leaves the existing snapshot untouched
            if (anchorId) {
              next = {
                ...next,
                undo: {
                  spec: r.spec, steps: r.steps, params: r.params, packages: r.packages,
                  triggers: r.triggers, paramValues: r.paramValues, concurrency: r.concurrency,
                  testValues: r.testValues,
                  instructions: r.instructions, notes: r.notes,
                  dirty: r.dirty, entryId: anchorId,
                },
              }
            }
            if (empty) chat.push(newEntry({ kind: 'error', text: 'The agent returned an empty response.' }))
            // §11 action chaining: arm the sync/test pendings; the watcher
            // effect (Build & test panel) fires them against fresh state.
            if (willSync) next = { ...next, pendingSync: true }
            if (actions.test) next = { ...next, pendingTest: { values: actions.testValues ?? null } }
            return { ...next, chat }
          })
          // §4.1: name/description are user-owned identity — edit mode applies them
          // immediately via PATCH, exactly like the pencil edits.
          if (isEdit && auto && (actions.name || actions.description)) {
            void api.patchAutomation(auto.id, {
              ...(actions.name ? { name: actions.name } : {}),
              ...(actions.description ? { description: actions.description } : {}),
            }).catch((e) => showToast((e as Error).message))
          }
          if (dft.spec && !actions.sync && !actions.test) {
            showToast('Spec updated — the workflow is out of sync. Sync the steps before saving.', 5800)
          }
          if (actions.undo && hadSnap) showToast('Last change undone.', 3200)
        },
        onFail: (msg) => setRev((r) => r && ({
          ...r, chatBusy: false,
          chat: [...r.chat, newEntry({ kind: 'error', text: msg || 'The request failed — try again or rephrase.' })],
        })),
        onCancelled: () => setRev((r) => r && ({ ...r, chatBusy: false })),
        // §11: a blocked chat call lands as a blockers entry — draft untouched
        // apart from the §8 blocker notes when carried.
        onBlocked: (blockers, _at, _spec, diagnosed, notes) => setRev((r) => {
          if (!r) return r
          const bn = blockerNotes(r, notes)
          return {
            ...r, chatBusy: false, ...bn.patch,
            chat: [...r.chat, newEntry({ kind: 'blockers', source: 'chat', blockers, diagnosed, resolved: r.resolved }), ...bn.chip],
          }
        }),
      })
    } catch (e) {
      setRev((r) => r && ({
        ...r, chatBusy: false,
        chat: [...r.chat, newEntry({ kind: 'error', text: (e as Error).message })],
      }))
    }
  }

  // §11: a blocked sync lands as a thread blockers entry (source: sync);
  // applying amends the in-editor spec (specOverride) and repeats the sync with it.
  const runSync = async (specOverride?: SpecBlock[]) => {
    // §11 rewrites-lock: nothing rewrites the workflow under a running test
    if (!rev || anyJobBusy || testLive) return
    // A cancel must return the panel to the state it was in (§11) — a sync
    // started from a clean draft must not leave it marked out-of-sync.
    dirtyBeforeSync.current = rev.dirty
    up({
      specEdit: false, specText: '', specTextOrig: '', instrDraft: null, instrEdit: false, // discard unsaved edits
      notesDraft: null, notesEdit: false,
      syncBusy: true, genStage: null, genDetail: null, genEvents: [], touched: true, stepsErr: null,
      // §11 draft undo: a repair amend replaces the spec outside the undo flow
      ...(specOverride ? { spec: specOverride, undo: null } : {}),
    })
    try {
      await startJob({
        mode: 'sync', ...(isEdit && auto ? { automationId: auto.id } : {}),
        agentId, current: { ...serializeDraft(rev), spec: specOverride ?? rev.spec },
        enabledAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
      }, {
        onDone: (dft) => {
          // §11 hold-and-flush: taken outside the updater (a ref mutation is
          // not idempotent under a re-run updater) — the held workflow chips
          // land beneath the sync trail, before the drop chips, so a value
          // staged this turn that the rebuild then dropped reads staged → dropped.
          const held = takeHeldChips()
          setRev((r) => {
            if (!r) return r
            const steps = dft.steps ?? r.steps
            const triggers = dft.triggers ? mergeDraftTriggers(r.triggers, dft.triggers) : r.triggers
            const params = dft.params ?? r.params
            // §11: the staged value map re-checks against the rebuilt params —
            // names no drafted param matches are dropped with a chip, the rest
            // re-coerce to the (possibly re-kinded) definitions.
            const stale = Object.keys(r.paramValues).filter((n) => !params.some((p) => p.name === n))
            const paramValues = Object.fromEntries(Object.entries(r.paramValues)
              .filter(([n]) => !stale.includes(n))
              .map(([n, v]) => [n, coerceParamValue(params.find((p) => p.name === n)!, v)]))
            const syncedEntry = newEntry({ kind: 'system', icon: 'fa-rotate', text: 'Steps synced with the spec.' })
            const notesEntry = dft.notes != null && dft.notes !== r.notes
              ? newEntry({ kind: 'system' as const, icon: 'fa-note-sticky', text: 'Notes updated.' }) : null
            const dropEntries = stale.map((n) => newEntry({
              kind: 'system' as const, icon: 'fa-sliders', text: `Value for “${n}” dropped — no such parameter after the rebuild.` }))
            // §11 trigger-setup reminder — only when this sync introduced the
            // gap, so repeated syncs over an unchanged gap never repeat it
            const remind = needsMessageTriggerSetup(steps, triggers)
              && !needsMessageTriggerSetup(r.steps, r.triggers)
            // §8: the manifest's name/description are create-only — a sync never
            // touches them (both are user-owned identity, §4.1).
            return {
              // §11 draft undo: a completed sync keeps the snapshot — Undo
              // reverts the whole request, chained-sync steps included — and
              // re-anchors the undo row below the sync's own chips
              ...r, syncBusy: false, genStage: null, dirty: false,
              undo: r.undo ? { ...r.undo, entryId: (dropEntries.at(-1) ?? held.at(-1) ?? notesEntry ?? syncedEntry).id } : r.undo,
              steps, params, paramValues, packages: dft.packages ?? [],
              // §8/§11: a sync's drafted test values replace the map; absent
              // one, the old map stays (unmatched names simply seed nothing)
              ...(dft.testValues ? { testValues: dft.testValues } : {}),
              triggers,
              // §8: call 2 may return an updated notes.md beside the manifest
              ...(dft.notes != null && dft.notes !== r.notes ? { notes: dft.notes } : {}),
              // §11: a completed sync collapses any pending blockers entry —
              // its blockers describe steps that no longer exist — and lands
              // a quiet system chip in the thread.
              chat: [
                ...r.chat.map((e) => (e.kind === 'blockers' && !e.dismissed ? { ...e, dismissed: true } : e)),
                syncedEntry,
                ...(notesEntry ? [notesEntry] : []),
                ...held,
                ...dropEntries,
                ...(remind ? [newEntry({ kind: 'system', icon: 'fa-clock', text: TRIGGER_SETUP_TEXT })] : []),
              ],
            }
          })
          showToast('Steps synced with the spec — review them, then save.', 3600)
        },
        onFail: (msg) => {
          // §11 hold-and-flush: any outcome flushes the held workflow chips —
          // the staging happened, a failed sync never swallows the receipts.
          const held = takeHeldChips()
          setRev((r) => r && ({ ...r, syncBusy: false, ...(held.length ? { chat: [...r.chat, ...held] } : {}) }))
          showToast(`The draft didn’t validate — try again or rephrase.${msg ? ' ' + msg : ''}`, 4500)
        },
        onCancelled: () => {
          const held = takeHeldChips()
          setRev((r) => r && ({ ...r, syncBusy: false, ...(held.length ? { chat: [...r.chat, ...held] } : {}) }))
        },
        onBlocked: (blockers, _at, _spec, diagnosed, notes) => {
          // §11 hold-and-flush: the held chips land after the settled trail,
          // before the blockers message block.
          const held = takeHeldChips()
          setRev((r) => {
            if (!r) return r
            const bn = blockerNotes(r, notes)
            return {
              ...r, syncBusy: false, ...bn.patch,
              chat: [...r.chat, ...held, newEntry({ kind: 'blockers', source: 'sync', blockers, diagnosed, resolved: r.resolved }), ...bn.chip],
            }
          })
        },
      })
    } catch (e) {
      up({ syncBusy: false })
      showToast((e as Error).message)
    }
  }

  // §11: Cancel on the footer action block — kill the running job. A chat
  // cancel drops the pending user entry and returns the text to the input; a
  // create cancel returns to the empty state (spec call) or keeps the landed
  // spec out of sync (steps call).
  const cancelChat = () => {
    if (!rev?.chatBusy) return
    cancelJob()
    const req = chatReqRef.current
    chatReqRef.current = null
    setRev((r) => r && ({
      ...r, chatBusy: false,
      chat: req ? r.chat.filter((e) => e.id !== req.entryId) : r.chat,
    }))
    if (req) setChatText((cur) => cur || req.text)
    showToast('Edit stopped — the spec is unchanged.', 4200)
  }
  const cancelCreate = () => {
    if (!rev) return
    if (rev.stepsBusy) {
      // steps call only — the landed spec is kept and sync rebuilds later
      if (cancelStepsGen()) up({ stepsBusy: false, dirty: true })
      return
    }
    if (!rev.specBusy) return
    cancelJob()
    const entryId = createEntryRef.current
    createEntryRef.current = null
    setRev((r) => r && ({
      ...seedEmpty(agents, secretNames),
      chat: entryId ? r.chat.filter((e) => e.id !== entryId) : r.chat,
    }))
    setChatText((cur) => cur || lastCreateRef.current)
  }

  // §11: sync Cancel (footer action block) — kill the job, keep the steps
  // and spec untouched, return the panel to the state it was in before.
  const cancelSync = () => {
    if (!rev?.syncBusy) return
    cancelJob()
    const wasDirty = dirtyBeforeSync.current
    setRev((r) => r && ({ ...r, syncBusy: false, dirty: wasDirty }))
    showToast(wasDirty
      ? 'Sync stopped — the workflow is still out of sync.'
      : 'Sync stopped — nothing changed.', 4200)
  }

  return {
    submitCreate, sendChat, runSync, flushHeldChips,
    cancelChat, cancelCreate, cancelSync, cancelStepsGen, cancelJob,
    stopPoll, jobIdRef, lastCreateRef, createEntryRef,
  }
}
