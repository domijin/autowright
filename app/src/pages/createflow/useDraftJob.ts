// §8/§11 job orchestration for the create/edit editor: one hook owning the
// POST /drafts + poll lifecycle for all three job modes (create, chat, sync)
// and every cancel path. All jobs run through one {start, cancel} core sharing
// jobIdRef / cancelGenRef / stopPoll, so the gen-guard (a cancel landing while
// the POST is in flight), the staleness guard on slow poll ticks, and the
// leave-the-page cleanup behave identically no matter how a job was started.
import { useEffect, useRef } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import type { Agent, Automation, Blocker, DraftPayload, SpecBlock } from '../../types'
import {
  type Rev, TRIGGER_SETUP_TEXT, jobStageTitle, mergeDraftTriggers,
  needsMessageTriggerSetup, newEntry, persistChat,
  seedDrafting, seedEmpty, seedFromPayload, serializeDraft,
} from './model'

interface PollHandlers {
  onDone: (d: DraftPayload) => void
  onFail: (msg: string, detail?: string[]) => void
  onCancelled?: () => void
  onBlocked?: (blockers: Blocker[], at: 'spec' | 'steps' | 'chat', spec: SpecBlock[] | null, diagnosed: boolean) => void
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
          // ("Installing the packages…" after the steps land); `detail` is the
          // finer live-progress line under it, `events` the feed's history.
          const evs = j.events ?? []
          const evKey = evs.length ? `${evs.length}:${evs[evs.length - 1].text}` : ''
          if (j.status === 'building' && (j.stage !== lastStage || (j.detail ?? null) !== lastDetail || evKey !== lastEvKey)) {
            lastStage = j.stage
            lastDetail = j.detail ?? null
            lastEvKey = evKey
            const texts = evs.map((e) => e.text)
            setRev((r) => (r ? { ...r, genStage: j.stage, genDetail: lastDetail, genEvents: texts } : r))
          }
          if (onSpec && !specDelivered && j.status === 'building' && j.draft?.spec) {
            specDelivered = true
            onSpec(j.draft.spec)
          }
          // §11 activity entry: a settled job persists its final stage label
          // (rendered with a check where the spinner was) plus its full event
          // feed, before the outcome entries the handlers append; a cancelled
          // job leaves none — its request returns to the input.
          if (j.status === 'done' || j.status === 'blocked' || j.status === 'failed') {
            setRev((r) => {
              if (!r) return r
              const title = jobStageTitle(r, r.genStage === 'Installing the packages')
              const feed = newEntry({ kind: 'activity', title, text: evs.map((e) => e.text).join('\n'), outcome: j.status as 'done' | 'blocked' | 'failed' })
              return { ...r, chat: [...r.chat, feed] }
            })
          }
          if (j.status === 'done') {
            stopPoll()
            if (j.draft) onDone(j.draft)
            else onFail('The agent returned an empty draft.')
          } else if (j.status === 'blocked') {
            stopPoll()
            if (onBlocked) onBlocked(j.blockers ?? [], j.blockedAt ?? 'steps', j.draft?.spec ?? null, j.diagnosed ?? false)
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
            newEntry({ kind: 'system', text: 'Draft generated — review the spec and steps, then create it.' }),
            // §11 trigger-setup reminder: the agent omitted a message trigger
            // it lacked details for — the user adds it on the automation page
            ...(needsMessageTriggerSetup(d.steps ?? [], d.triggers ?? [])
              ? [newEntry({ kind: 'system', text: TRIGGER_SETUP_TEXT })] : []),
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
        // thread blockers entries.
        onBlocked: (blockers, at, spec, diagnosed) => setRev((r) => r && (at === 'spec'
          ? {
            ...r, specBusy: false, stepsBusy: false,
            chat: [...r.chat, newEntry({ kind: 'blockers', source: 'spec', blockers, diagnosed, resolved: r.resolved })],
          }
          : {
            ...r, stepsBusy: false, spec: spec ?? r.spec, dirty: true,
            chat: [...r.chat, newEntry({ kind: 'blockers', source: 'steps', blockers, diagnosed, resolved: r.resolved })],
          })),
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
    const history = persistChat(rev.chat) // the thread BEFORE this message
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
      chatBusy: true, genStage: null, genDetail: null, genEvents: [], touched: true,
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
            if (dft.answer) chat.push(newEntry({ kind: 'answer', text: dft.answer }))
            // §8 undo action: arrives alone (validation) — run the §11
            // restore exactly like the undo row's button, or say there is
            // nothing left to undo
            if (actions.undo) {
              const snap = r.undo
              if (snap) {
                next = {
                  ...next,
                  spec: snap.spec, steps: snap.steps, params: snap.params, packages: snap.packages,
                  triggers: snap.triggers, instructions: snap.instructions, notes: snap.notes,
                  dirty: snap.dirty, undo: null,
                }
                chat.push(newEntry({ kind: 'system', text: 'Last change undone — the rewrites above no longer apply.' }))
              } else {
                chat.push(newEntry({ kind: 'system', text: 'Nothing to undo.' }))
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
              const entry = newEntry({ kind: 'system', text: 'Build instructions updated.' })
              anchorId = entry.id
              // like a manual Build-instructions save — same dirty gating (§11)
              next = { ...next, instructions: dft.instructions, dirty: true }
              chat.push(entry)
            }
            if (dft.notes != null && dft.notes !== r.notes) {
              const entry = newEntry({ kind: 'system', text: 'Notes updated.' })
              anchorId = entry.id
              // notes never mark the workflow out of sync (§4.1)
              next = { ...next, notes: dft.notes }
              chat.push(entry)
            }
            if (actions.name && actions.name !== r.name) {
              const entry = newEntry({ kind: 'system', text: `Renamed to “${actions.name}”.` })
              if (anchorId) anchorId = entry.id // the row sits below every chip the request produced
              next = { ...next, name: actions.name }
              chat.push(entry)
            }
            if (actions.description && actions.description !== r.description) {
              const entry = newEntry({ kind: 'system', text: 'Description updated.' })
              if (anchorId) anchorId = entry.id
              next = { ...next, description: actions.description }
              chat.push(entry)
            }
            // an answer-only response leaves the existing snapshot untouched
            if (anchorId) {
              next = {
                ...next,
                undo: {
                  spec: r.spec, steps: r.steps, params: r.params, packages: r.packages,
                  triggers: r.triggers, instructions: r.instructions, notes: r.notes,
                  dirty: r.dirty, entryId: anchorId,
                },
              }
            }
            if (empty) chat.push(newEntry({ kind: 'error', text: 'The agent returned an empty response.' }))
            // §11 action chaining: arm the sync/test pendings; the watcher
            // effect (Build & test panel) fires them against fresh state.
            if (actions.sync || (actions.test && next.dirty)) next = { ...next, pendingSync: true }
            if (actions.test) next = { ...next, pendingTest: { values: actions.testValues ?? null } }
            return { ...next, chat, touched: true }
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
        // §11: a blocked chat call lands as a blockers entry — draft untouched.
        onBlocked: (blockers, _at, _spec, diagnosed) => setRev((r) => r && ({
          ...r, chatBusy: false,
          chat: [...r.chat, newEntry({ kind: 'blockers', source: 'chat', blockers, diagnosed, resolved: r.resolved })],
        })),
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
          setRev((r) => {
            if (!r) return r
            const steps = dft.steps ?? r.steps
            const triggers = dft.triggers ? mergeDraftTriggers(r.triggers, dft.triggers) : r.triggers
            const syncedEntry = newEntry({ kind: 'system', text: 'Steps synced with the spec.' })
            const notesEntry = dft.notes != null && dft.notes !== r.notes
              ? newEntry({ kind: 'system' as const, text: 'Notes updated.' }) : null
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
              undo: r.undo ? { ...r.undo, entryId: (notesEntry ?? syncedEntry).id } : r.undo,
              steps, params: dft.params ?? r.params, packages: dft.packages ?? [],
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
                ...(remind ? [newEntry({ kind: 'system', text: TRIGGER_SETUP_TEXT })] : []),
              ],
            }
          })
          showToast('Steps synced with the spec — review them, then save.', 3600)
        },
        onFail: (msg) => {
          setRev((r) => r && ({ ...r, syncBusy: false }))
          showToast(`The draft didn’t validate — try again or rephrase.${msg ? ' ' + msg : ''}`, 4500)
        },
        onCancelled: () => setRev((r) => r && ({ ...r, syncBusy: false })),
        onBlocked: (blockers, _at, _spec, diagnosed) => setRev((r) => r && ({
          ...r, syncBusy: false,
          chat: [...r.chat, newEntry({ kind: 'blockers', source: 'sync', blockers, diagnosed, resolved: r.resolved })],
        })),
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
    submitCreate, sendChat, runSync,
    cancelChat, cancelCreate, cancelSync, cancelStepsGen, cancelJob,
    stopPoll, jobIdRef, lastCreateRef, createEntryRef,
  }
}
