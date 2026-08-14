// Create / edit flow (§11): one editor screen from birth to save — a floating
// chat panel (the editor's only conversational surface: requests, answers,
// blockers, failure analyses, drafting progress) beside the Review grid.
// This file is the page shell: store wiring, draft persistence, the derived
// dirty-gating block, the title row / lede / banners, and the version menu.
// The pieces live under ./createflow/: model.ts (the pure Rev model + helpers),
// useDraftJob.ts (§8 job orchestration — create/chat/sync + every cancel path),
// ChatPanel.tsx (thread + composer), BuildTestPanel.tsx (sync state + draft
// test), SectionCards.tsx (the left/right review cards). The step list and
// param editors are shared with the detail page via ../steps.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent, ChatEntry } from '../types'
import { BtnPrimary, ConfirmModal, HeaderActions, PULSE, PopMenu, ScrollArea, Spinner, usePopover } from '../ui'
import { nextTriggerShort, useTriggerPreview } from '../triggers'
import {
  type Rev, amendSpec, blockerLine, holdsDraftEdits, instructionCache, loadVersionInto,
  newEntry, secretRefsOf, seedEmpty, seedFromAuto, seedFromPayload, serializeDraft,
} from './createflow/model'
import { useDraftJob } from './createflow/useDraftJob'
import { ChatPanel } from './createflow/ChatPanel'
import { BuildTestPanel } from './createflow/BuildTestPanel'
import { LeftColumn, RightCards } from './createflow/SectionCards'

// The pure helpers moved to ./createflow/model (and ../steps for the shared
// step-secret scanners) — re-exported here so the unit tests and any older
// imports keep one stable import path.
export {
  specToText, textToSpec, amendSpec, newEntry, persistChat,
  stepSecretTags, stepSecretNames, secretRefsOf, instrToMd,
  seedEmpty, seedDrafting, seedFromPayload, seedFromAuto,
  stripTrigger, mergeDraftTriggers, serializeDraft, applyTestValues,
  needsMessageTriggerSetup,
} from './createflow/model'

// ---------- the page ----------

export default function CreateFlow() {
  const store = useStore()
  const { agents, secrets, automations, executions, executionFull, createFrom, automationId, go, setSurface, showToast, loadAuto, test } = store
  const isEdit = createFrom === 'edit'
  const auto = isEdit ? automations.find((a) => a.id === automationId) ?? null : null
  // §19: the live-execution banner's "next execution" label reads from
  // POST /triggers/preview — no local trigger math in the renderer (§4.3)
  const trigPreviews = useTriggerPreview(auto?.triggers ?? [])

  const [agentId, setAgentId] = useState<string | null>(() =>
    isEdit ? (auto?.agentId ?? null) : ((agents.find((g) => g.default) ?? agents[0])?.id ?? null))

  const [rev, setRev] = useState<Rev | null>(null)
  const [nameEdit, setNameEdit] = useState<string | null>(null)
  const [descEdit, setDescEdit] = useState<string | null>(null)
  const [chatText, setChatText] = useState('')
  const [confirmSpecCancel, setConfirmSpecCancel] = useState(false)
  const draftSnap = useRef<Rev | null>(null)
  const seededRef = useRef(false)

  // §4.4: any exit path keeps the draft — system back/forward unmounts the editor
  // without going through close(), so the persist lives in unmount cleanup.
  // Discard and save settle the draft so leaving afterwards writes nothing.
  // Create mode keeps to the pending slot (<root>/draft/) once a draft landed.
  const revRef = useRef(rev)
  revRef.current = rev
  const autoRef = useRef(auto)
  autoRef.current = auto
  const agentIdRef = useRef(agentId)
  agentIdRef.current = agentId
  const draftSettled = useRef(false)
  // §4.4 "a discarded or saved draft is never resurrected": the last
  // continuous-persist PUT, awaited before any draft DELETE so an in-flight
  // write can't land after the discard on a slow backend.
  const putInFlight = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => () => {
    const r = revRef.current
    const a = autoRef.current
    if (draftSettled.current) return
    if (isEdit) {
      if (!a) return
      if (r && holdsDraftEdits(r, a)) {
        void api.putDraft(a.id, serializeDraft(r)).catch(() => { /* backend restarting */ })
      }
      return
    }
    if (r && !r.specBusy && (r.spec.length || r.steps.length)) {
      void api.putDraft('pending', serializeDraft(r), agentIdRef.current).catch(() => { /* backend restarting */ })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // §4.4 continuous persistence: once the draft holds anything worth keeping,
  // write it with a debounced PUT ~1 s after the last change — quitting the app
  // mid-edit loses nothing. The unmount save above stays the final flush;
  // settling (discard / save / create / start over) stops this writer.
  useEffect(() => {
    if (!rev || draftSettled.current) return
    const worthKeeping = isEdit
      ? !!auto && holdsDraftEdits(rev, auto)
      : !rev.specBusy && (rev.spec.length > 0 || rev.steps.length > 0)
    if (!worthKeeping) return
    const t = setTimeout(() => {
      if (draftSettled.current) return // settled after the timer armed — never write
      const r = revRef.current
      const a = autoRef.current
      if (!r) return
      if (isEdit) {
        if (a && holdsDraftEdits(r, a)) {
          putInFlight.current = api.putDraft(a.id, serializeDraft(r)).catch(() => { /* backend restarting */ })
        }
        return
      }
      if (!r.specBusy && (r.spec.length || r.steps.length)) {
        putInFlight.current = api.putDraft('pending', serializeDraft(r), agentIdRef.current).catch(() => { /* backend restarting */ })
      }
    }, 1000)
    return () => clearTimeout(t) // each change resets the timer (debounce) and unmount cancels it
  }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11: create mode mounts straight on the empty editor (empty thread,
  // placeholder cards). §4.4: while the pending slot holds a draft it resumes
  // over the untouched empty seed; a fast first message wins the race.
  // Opening also makes the slot's container exist (empty memory/) before any
  // drafting — §11 tests execute as execution records.
  useEffect(() => {
    if (isEdit) return
    setRev((r) => r ?? seedEmpty(agents, secrets.map((s) => s.name)))
    void api.openDraft('pending').catch(() => { /* backend restarting */ })
    let dead = false
    void api.getDraft('pending').then(({ draft, agentId: gid }) => {
      if (dead || !draft || seededRef.current) return
      const cur = revRef.current
      // Only the untouched empty seed may be replaced — never in-flight work.
      if (cur && (cur.touched || cur.specBusy || cur.stepsBusy || cur.chat.length > 0 || cur.spec.length > 0)) return
      seededRef.current = true
      const seeded = seedFromPayload(draft, agents, secrets.map((s) => s.name))
      // A draft kept mid-steps-generation resumes spec-only — mark it out of
      // sync so the §11 sync panel offers the rebuild.
      setRev({ ...seeded, touched: true, ...(seeded.steps.length || !seeded.spec.length ? {} : { dirty: true }) })
      if (gid && agents.some((g) => g.id === gid)) setAgentId(gid)
      showToast('Resumed your unsaved draft — Start over discards it.', 3400)
    }).catch(() => { /* backend restarting; the editor still works */ })
    return () => { dead = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const up = (patch: Partial<Rev>) => setRev((r) => (r ? { ...r, ...patch } : r))

  // ---- thread helpers ----
  const appendEntry = (e: Omit<ChatEntry, 'id' | 'at'>) =>
    setRev((r) => (r ? { ...r, chat: [...r.chat, newEntry(e)] } : r))
  const patchEntry = (id: string, patch: Partial<ChatEntry>) =>
    setRev((r) => (r ? { ...r, chat: r.chat.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : r))

  // ---- review: derived (§11 dirty gating) ----
  // Memoized: the grant scan walks every step's code (regexes included via
  // secRefs) and would otherwise re-run on every keystroke anywhere in the editor.
  const secRefs = useMemo(() => (rev ? secretRefsOf(rev.steps) : []), [rev?.steps]) // eslint-disable-line react-hooks/exhaustive-deps
  const derived = useMemo(() => {
    const availAgents = rev ? rev.enabledAgents.map((id) => agents.find((g) => g.id === id)).filter((g): g is Agent => !!g) : []
    const agName = (g: Agent) => g.name || g.harness
    const agentStepIdx = rev ? rev.steps.map((s, i) => (s.agent ? i : -1)).filter((i) => i >= 0) : []
    // §11: per-name agent references — which steps name which agent, mirroring secRefs.
    const agRefs: { name: string; steps: number[] }[] = []
    if (rev) rev.steps.forEach((s, i) => {
      if (!s.agent) return
      for (const { name: nm } of s.agents ?? []) {
        const r = agRefs.find((x) => x.name === nm)
        r ? r.steps.push(i) : agRefs.push({ name: nm, steps: [i] })
      }
    })
    const agNotEnabled = agRefs.filter((r) => agents.some((g) => agName(g) === r.name) && !availAgents.some((g) => agName(g) === r.name))
    const agMissing = agRefs.filter((r) => !agents.some((g) => agName(g) === r.name))
    // steps with no named agent fall back to the first enabled agent — they only
    // warn when nothing is enabled at all
    const agFallbackIdx = rev ? agentStepIdx.filter((i) => !(rev.steps[i].agents ?? []).length) : []
    const agNone = !!rev && agFallbackIdx.length > 0 && availAgents.length === 0
    const secNotAllowed = secRefs.filter((r) => secrets.some((z) => z.name === r.name) && !(rev?.allowedSecrets ?? []).includes(r.name))
    const secMissing = secRefs.filter((r) => !secrets.some((z) => z.name === r.name))
    const agWarn = !!rev && (agNone || agNotEnabled.length > 0 || agMissing.length > 0)
    const secWarn = !!rev && (secNotAllowed.length > 0 || secMissing.length > 0)
    // §11 dirty gating: grant sync state is derived, never stored — the workflow
    // is out of sync from grants exactly while a step needs a grant it doesn't
    // have. Re-checking the grant clears it instantly; toggles alone never dirty.
    const agentGap = !!rev && agentStepIdx.some((i) => {
      const s = rev.steps[i]
      const names = (s.agents ?? []).map((e) => e.name)
      return names.length
        ? names.some((nm) => !availAgents.some((g) => agName(g) === nm))
        : rev.enabledAgents.length === 0
    })
    const secretGap = secNotAllowed.length > 0
    return { availAgents, agentStepIdx, agNotEnabled, agMissing, agFallbackIdx, agNone, secNotAllowed, secMissing, agWarn, secWarn, agentGap, secretGap }
  }, [rev?.steps, rev?.enabledAgents, rev?.allowedSecrets, agents, secrets, secRefs]) // eslint-disable-line react-hooks/exhaustive-deps
  const { availAgents, agentStepIdx, agNotEnabled, agMissing, agFallbackIdx, agNone, secNotAllowed, secMissing, agWarn, secWarn, agentGap, secretGap } = derived
  // §11: the spec card defaults open and is force-open while the spec is
  // writing or being edited; the agents and secrets cards default collapsed
  // and are forced open while their warnings show (Packages pattern).
  const specOpenEff = !!rev?.specEdit || !!rev?.specBusy
    || ((rev?.specSecOpen ?? null) == null ? true : !!rev?.specSecOpen)
  const agSecOpenEff = !!rev?.agSecOpen || agWarn
  const secSecOpenEff = !!rev?.secSecOpen || secWarn
  // §11 Packages card: default collapsed when everything is installed; forced
  // open while any row is installing, not installed, or failed.
  const pkgProblem = !!rev && rev.packages.some((p) => p.status && p.status !== 'installed')
  const pkgSecOpenEff = (((rev?.pkgSecOpen ?? null) == null ? pkgProblem : !!rev?.pkgSecOpen) || pkgProblem || !!rev?.pkgBusy)
  // §11 BUILD INSTRUCTIONS card: defaults collapsed in create and edit alike
  const instrOpenEff = !!rev?.instrSecOpen
  // §11 NOTES card: defaults collapsed; forced open while being edited
  const notesOpenEff = !!rev?.notesEdit || (((rev?.notesSecOpen ?? null) == null) ? false : !!rev?.notesSecOpen)
  const viewingOld = isEdit && !!rev && !!auto && rev.viewing !== 'draft' && rev.viewing !== auto.version
  // §5: permissions are never versioned — a grant gap never blocks restoring an
  // old version; it fails at execution time instead (the cards still warn).
  const outOfSync = !!rev && (rev.dirty || (!viewingOld && (agentGap || secretGap)))
  const drafting = !!rev && (rev.specBusy || rev.stepsBusy)
  const saveBlocked = !!rev && (outOfSync || rev.syncBusy || rev.chatBusy || rev.specEdit
    || drafting || (!isEdit && rev.steps.length === 0))
  const busyRewrite = !!rev && (rev.syncBusy || rev.chatBusy)
  // §11: one agent job at a time — the chat input and every job starter gate on this.
  const anyJobBusy = !!rev && (rev.specBusy || rev.stepsBusy || rev.syncBusy || rev.chatBusy)
  // §11: the tracked test is an ordinary execution record — steps/status render
  // off it (executionFull carries the body; the header list covers the gap before
  // loadExecution lands).
  const testExec = test ? executionFull[test.executionId] ?? executions.find((e) => e.id === test.executionId) : undefined
  const testLive = testExec?.status === 'executing'
  // Sync panel: the button disables (never hides) while any §8 job runs, while
  // drafting, while viewing an old version, while a draft test is executing
  // (§11 rewrites-lock: nothing rewrites the workflow under a running test),
  // and while steps AND spec are both
  // empty — a spec-only draft (cancelled steps generation, resumed spec-only
  // pending draft) must always be able to rebuild its steps here (§11).
  const syncDisabled = !rev || busyRewrite || drafting || viewingOld || testLive
    || (rev.steps.length === 0 && rev.spec.length === 0)
  // §11 inputs-lock: while a sync or spec rewrite runs, every input disables —
  // buttons get `disabled`, non-button rows get this style. One shared look.
  const lockStyle: React.CSSProperties | undefined = busyRewrite ? { opacity: 0.45, pointerEvents: 'none' } : undefined

  // ---- §8 job orchestration (create / chat / sync + every cancel path) ----
  const jobs = useDraftJob({
    rev, setRev, up, agents, secretNames: secrets.map((s) => s.name),
    isEdit, auto, agentId, showToast,
    chatText, setChatText, setNameEdit, setDescEdit,
    anyJobBusy, testLive, viewingOld,
  })

  // ---- guards + edit-mode seeding ----
  useEffect(() => {
    if (agents.length === 0) {
      setSurface('app')
      go('agents')
      showToast('No agent yet — add one here first. Creating and editing automations needs an AI.', 3600)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isEdit && automationId) void loadAuto(automationId)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- instruction files (§8) — fetched once per app session ----
  const [fw, setFw] = useState<string>(instructionCache.framework ?? '')
  useEffect(() => {
    if (instructionCache.framework) return
    api.instructions()
      .then(({ framework, defaultBuild }) => {
        instructionCache.framework = framework
        instructionCache.defaultBuild = defaultBuild
        setFw(framework)
      })
      .catch(() => { /* panel renders empty; next mount retries */ })
  }, [])

  useEffect(() => {
    if (!isEdit || seededRef.current || !auto || !auto.spec) return
    seededRef.current = true
    setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
    if (auto.agentId) setAgentId(auto.agentId)
  }, [auto, isEdit, agents, secrets])

  const selAgent = agents.find((g) => g.id === agentId) ?? agents.find((g) => g.default) ?? agents[0] ?? null

  // §11 Start over (create): cancel any job, discard the pending slot (thread
  // included), return to the empty state with the description in the input.
  const resetCreate = async () => {
    jobs.cancelJob()
    // §4.4: Start over discards the pending slot — after any in-flight
    // continuous-persist PUT, which would otherwise resurrect it.
    await putInFlight.current
    void api.deleteDraft('pending').catch(() => { /* none kept */ })
    setNameEdit(null)
    setDescEdit(null)
    setRev(seedEmpty(agents, secrets.map((s) => s.name)))
    setChatText((cur) => cur || jobs.lastCreateRef.current)
  }

  // §11 title rename — hidden while any job runs and, in edit mode, while
  // viewing anything but the draft (Restore never renames). Create mode:
  // renaming becomes available once drafting has produced a revision — a
  // pre-draft rename would be wiped when the create job seeds and lands.
  const canRename = !!rev && !drafting && !busyRewrite
    && (isEdit ? rev.viewing === 'draft' : rev.spec.length > 0 || rev.steps.length > 0)
  // Create mode: the spec `#` title stands in until the manifest name lands (§11)
  const draftName = !rev ? ''
    : !isEdit && rev.name === 'New automation' && rev.spec.find((b) => b.kind === 'h1')?.text
      ? rev.spec.find((b) => b.kind === 'h1')!.text
      : rev.name
  const titleText = !rev ? ''
    : !isEdit && rev.specBusy ? 'New automation…' : draftName
  const commitTitleRename = () => {
    const name = (nameEdit ?? '').trim()
    setNameEdit(null)
    if (!rev || !name || name === rev.name) return
    up({ name })
    // Edit mode: name is user-owned identity (§4.1) — it applies immediately
    // via PATCH, never rides the draft or waits for Save.
    if (isEdit && auto) void api.patchAutomation(auto.id, { name }).catch((e) => showToast((e as Error).message))
  }
  // §11 lede: the automation's description — same identity rules as the name, but a
  // blank commit clears it (description is optional, §4.1).
  const commitDescEdit = () => {
    const description = (descEdit ?? '').trim()
    setDescEdit(null)
    if (!rev || description === rev.description) return
    up({ description })
    if (isEdit && auto) void api.patchAutomation(auto.id, { description }).catch((e) => showToast((e as Error).message))
  }
  // Build & test panel stage label — §11 drafting stages
  const installingPkgs = rev?.genStage === 'Installing the packages'
  const stageLabel = rev?.specBusy ? 'Waiting for the spec…'
    : installingPkgs ? 'Installing the packages…' : 'Generating the steps…'

  // §11 chat input send: with no spec or steps yet (fresh create), the message
  // is the description and starts the create job; otherwise it's a chat job.
  // A reply while a spec-source blockers entry is open is the clarification
  // answer: it joins the original description and a new create job starts.
  const sendMessage = () => {
    if (!rev || anyJobBusy || testLive || viewingOld) return
    const request = chatText.trim()
    if (!request) return
    const isCreate = !isEdit && rev.spec.length === 0 && rev.steps.length === 0
    if (!isCreate) { void jobs.sendChat(); return }
    setChatText('')
    const specBlock = [...rev.chat].reverse()
      .find((e) => e.kind === 'blockers' && !e.dismissed && e.source === 'spec')
    const entry = newEntry({ kind: 'user', text: request })
    jobs.createEntryRef.current = entry.id
    setRev((r) => r && ({
      ...r,
      // §11 auto-dismiss on reply: the answer settles the clarification
      chat: [...r.chat.map((e) => (specBlock && e.id === specBlock.id ? { ...e, dismissed: true } : e)), entry],
    }))
    // NOTE: lastCreateRef is a ref — a spec-blocked create that left the page
    // loses it, but a spec-blocked draft holds no spec and is never kept, so
    // the entry cannot outlive the ref (pre-existing limitation).
    void jobs.submitCreate(specBlock ? `${jobs.lastCreateRef.current.trim()}\n\n${request}` : request)
  }

  // §11 Clear chat: empties the thread only — the debounced draft persist
  // serializes `chat: []`, which unlinks chat.jsonl backend-side. The undo
  // snapshot clears with it (its anchor row leaves with the thread); the
  // draft documents and dirty state are untouched.
  const clearChat = () => {
    setRev((r) => r && ({ ...r, chat: [], undo: null, touched: true }))
  }

  // §11 draft undo: restore the full pre-request snapshot — the draft looks
  // exactly as it did before the last agent request, chained-sync step
  // rewrites included. Grant sync state is derived, so an intervening
  // agent/secret change keeps its own out-of-sync state regardless.
  const undoDraft = () => {
    setRev((r) => {
      if (!r || !r.undo) return r
      const snap = r.undo
      return {
        ...r,
        spec: snap.spec, steps: snap.steps, params: snap.params, packages: snap.packages,
        triggers: snap.triggers, instructions: snap.instructions, notes: snap.notes,
        dirty: snap.dirty, undo: null, touched: true,
        // §11: the thread records the rollback — persisted, so the agent's §8
        // CONVERSATION context never assumes the undone rewrites still stand
        chat: [...r.chat, newEntry({ kind: 'system', text: 'Last change undone — the rewrites above no longer apply.' })],
      }
    })
    showToast('Last change undone.', 3200)
  }

  // §11 Packages card: check statuses once per package list (§19 /packages/check,
  // fast, no pip) — a saved automation whose packages went missing shows
  // "not installed" without waiting for an execution to self-heal.
  // The keys carry the transient-field presence too: switching versions resets
  // statuses/badges without changing the pip list, and must re-trigger the
  // fetch — a pip-only key would leave every row on "checking…" forever.
  const pkgKey = rev ? rev.packages.map((p) => `${p.pip}\t${p.status ? 1 : 0}`).join('\n') : ''
  const pkgOutdatedKey = rev ? rev.packages.map((p) => `${p.pip}\t${p.latest ? 1 : 0}`).join('\n') : ''
  useEffect(() => {
    if (!rev || rev.packages.length === 0 || !rev.packages.some((p) => !p.status)) return
    let stale = false
    void api.checkPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return p.status || !c ? p : { ...p, status: c.status, version: c.version }
          }),
        }))
      })
      .catch(() => { /* statuses stay unknown; the engine still ensures at execution (§7) */ })
    return () => { stale = true }
  }, [pkgKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 update badges: one read-only PyPI check per package list (§19
  // /packages/outdated) — advisory, a failure just leaves the badges off.
  useEffect(() => {
    if (!rev || rev.packages.length === 0) return
    let stale = false
    void api.outdatedPackages(rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp })))
      .then(({ packages }) => {
        if (stale) return
        setRev((r) => r && ({
          ...r,
          packages: r.packages.map((p) => {
            const c = packages.find((z) => z.pip === p.pip)
            return c ? { ...p, latest: c.latest } : p
          }),
        }))
      })
      .catch(() => { /* badges stay off */ })
    return () => { stale = true }
  }, [pkgOutdatedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11/§6.2 Update / Update all — pip install --upgrade in the shared
  // directory; no manifest writes, the installed version is the truth. The
  // new version applies to every automation using the package.
  const updatePkgs = async (pips: string[]) => {
    if (!rev || rev.pkgBusy) return
    const targets = rev.packages.filter((p) => p.latest && pips.includes(p.pip))
    if (targets.length === 0) return
    const before = rev.packages
    const list = targets.map(({ pip, import: imp }) => ({ pip, import: imp }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (targets.includes(p) ? { ...p, status: 'installing' as const, error: undefined } : p)),
    })
    try {
      const { packages } = await api.updatePackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => {
          const c = p.status === 'installing' && packages.find((z) => z.pip === p.pip)
          // merge onto the row — the §19 response carries no `why`
          return c ? { ...p, ...c, latest: undefined } : p
        }),
      }))
      showToast('Updated — the new version applies to every automation using the package.', 3600)
    } catch (e) {
      setRev((r) => r && ({ ...r, pkgBusy: false, packages: before }))
      showToast((e as Error).message)
    }
  }

  // §11: Install / Retry on the Packages card — the blocking §19 ensure; rows
  // show spinners while it runs. An install failure never blocks saving (§6.2).
  const installPkgs = async () => {
    if (!rev || rev.pkgBusy) return
    const list = rev.packages.map(({ pip, import: imp }) => ({ pip, import: imp }))
    up({
      pkgBusy: true,
      packages: rev.packages.map((p) => (p.status === 'installed' ? p : { ...p, status: 'installing' as const, error: undefined })),
    })
    try {
      const { packages } = await api.installPackages(list)
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => {
          const c = packages.find((z) => z.pip === p.pip)
          // merge onto the row — the §19 response carries no `why`
          return c ? { ...p, ...c } : p
        }),
      }))
    } catch (e) {
      setRev((r) => r && ({
        ...r, pkgBusy: false,
        packages: r.packages.map((p) => (p.status === 'installing' ? { ...p, status: 'missing' as const } : p)),
      }))
      showToast((e as Error).message)
    }
  }

  // §11 blockers-entry apply — same door for every non-clarification source:
  // write the blockers into the spec's "Constraints & resolutions" section,
  // collapse the entry, then sync the steps. §8 user-action blockers are
  // skipped — the Mac isn't ready, there is nothing to amend.
  const applyBlockersEntry = (entry: ChatEntry) => {
    if (!rev) return
    const blockers = (entry.blockers ?? []).filter((b) => b.kind !== 'user-action')
    if (!blockers.length) return
    setRev((r) => r && ({
      ...r,
      resolved: [...r.resolved, ...blockers.map(blockerLine)],
      chat: r.chat.map((e) => (e.id === entry.id ? { ...e, dismissed: true } : e)),
    }))
    void jobs.runSync(amendSpec(rev.spec, blockers))
  }

  // §7/§9.2 Fix with AI: the editor opened from a failed execution seeds the
  // thread with the failure and sends the §11 canned analyze chat message —
  // an ordinary §8 chat job whose RECENT RUNS context carries this execution
  // in full detail (§19 runId). While another job is already in flight only
  // the seed lands; the user asks when it settles.
  const fixConsumed = useRef(false)
  useEffect(() => {
    if (!rev || fixConsumed.current) return
    const fx = useStore.getState().fixExec
    if (!fx) return
    fixConsumed.current = true
    useStore.setState({ fixExec: null })
    const ex = executionFull[fx] ?? executions.find((e) => e.id === fx)
    const failure = ex?.error
      ? `Execution failed at step ${ex.error.step ?? '?'} — ${ex.error.message}`
      : 'The execution failed.'
    appendEntry({ kind: 'system', text: failure })
    if (anyJobBusy || testLive || !ex || ex.status !== 'failed') return
    // The seed entry above already names the failing step — don't repeat it here.
    void jobs.sendChat('This execution failed — figure out why. If the automation is at fault, change it so it won’t happen again; if the fix is something I need to do on this Mac (install or start an app, sign in), tell me what to do and how instead.', fx)
  }, [rev != null]) // eslint-disable-line react-hooks/exhaustive-deps

  // §11: settled runs seed the thread — entering the editor after the newest
  // Draft execution finished (later than the thread's last entry) appends a
  // run-settled system entry, so the conversation picks up where the run left off.
  const draftRunSeeded = useRef(false)
  useEffect(() => {
    if (!isEdit || !rev || draftRunSeeded.current) return
    draftRunSeeded.current = true
    const lastAt = rev.chat.length ? Date.parse(rev.chat[rev.chat.length - 1].at ?? '') || 0 : 0
    const dr = executions
      .filter((e) => e.automationId === automationId && e.ver === 'Draft'
        && (e.status === 'failed' || e.status === 'succeeded'))
      .sort((a, b) => b.startedMs - a.startedMs)[0]
    if (!dr || Math.max(dr.endedMs, dr.startedMs) <= lastAt) return
    appendEntry({
      kind: 'system',
      text: dr.status === 'failed'
        ? `Draft execution failed${dr.error?.step ? ` at step ${dr.error.step}` : ''} — ${dr.error?.message ?? 'see the run'}`
        : 'Draft execution succeeded.',
    })
  }, [rev != null]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- version menu (edit mode) ----
  const [verOpen, setVerOpen, verRef] = usePopover()
  const pickVersion = (key: 'draft' | number) => {
    if (!auto || !rev) return
    setVerOpen(false)
    if (rev.viewing === key) return
    if (holdsDraftEdits(rev, auto)) {
      draftSnap.current = rev
      void api.putDraft(auto.id, serializeDraft(rev)).catch(() => { /* keep local snapshot */ })
    }
    if (key === 'draft') {
      if (draftSnap.current) setRev({ ...draftSnap.current, viewing: 'draft' })
      else if (auto.draft) setRev(seedFromAuto(auto, agents, secrets.map((s) => s.name)))
      else setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instructions: auto.instructions, notes: auto.notes, params: auto.params, packages: auto.packages }, 'draft'))
    } else if (key === auto.version) {
      setRev((r) => r && loadVersionInto(r, { spec: auto.spec ?? [], steps: auto.steps ?? [], instructions: auto.instructions, notes: auto.notes, params: auto.params, packages: auto.packages }, key))
    } else {
      const s = (auto.versions ?? []).find((v) => v.version === key)
      if (s) setRev((r) => r && loadVersionInto(r, s, key))
    }
  }

  // ---- leave / start over / save ----
  const close = async () => {
    jobs.stopPoll()
    // Leaving create mid-generation abandons the job — kill the harness.
    if (!isEdit && jobs.jobIdRef.current && drafting) {
      void api.cancelDraftJob(jobs.jobIdRef.current).catch(() => { /* already gone */ })
      jobs.jobIdRef.current = null
    }
    if (isEdit && auto) {
      if (rev && holdsDraftEdits(rev, auto)) {
        try { await api.putDraft(auto.id, serializeDraft(rev)) } catch { /* backend restarting */ }
        draftSettled.current = true
        showToast('Draft kept — resume it from this automation anytime.', 3400)
      }
      setSurface('app')
      go('automation')
      return
    }
    // §4.4: leaving create mode after a draft landed keeps the pending slot.
    if (!isEdit && rev && !rev.specBusy && (rev.spec.length || rev.steps.length)) {
      try { await api.putDraft('pending', serializeDraft(rev), agentId) } catch { /* backend restarting */ }
      draftSettled.current = true
      showToast('Draft kept — Resume draft picks it up anytime.', 3400)
    }
    setSurface('app')
    go('automations')
  }

  const startOver = async () => {
    if (isEdit && auto) {
      // Discard draft → back to detail. Settle BEFORE the awaits — the 1 s
      // debounce timer checks the flag at fire time, and a PUT landing after
      // the DELETE would resurrect the discarded draft (§4.4).
      draftSettled.current = true
      await putInFlight.current
      try { await api.deleteDraft(auto.id) } catch { /* none saved yet */ }
      draftSnap.current = null
      setSurface('app')
      go('automation')
      showToast(`Changes discarded — back to v${auto.version} as saved.`, 3200)
      return
    }
    await resetCreate()
  }

  const doSave = async () => {
    if (!rev || saveBlocked) return
    try {
      draftSettled.current = true
      if (isEdit && auto) {
        if (typeof rev.viewing === 'number' && rev.viewing !== auto.version) {
          const { version } = await api.restore(auto.id, rev.viewing)
          setSurface('app')
          go('automation')
          showToast(`v${rev.viewing} restored as version ${version} — earlier versions stay in the Version menu.`, 3200)
        } else {
          const { version } = await api.saveVersion(auto.id, {
            draft: serializeDraft(rev), agentId,
            stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
          })
          setSurface('app')
          go('automation')
          showToast(auto.live.length
            ? `Version ${version} saved. ${auto.live.length === 1 ? 'The execution in progress finishes' : `The ${auto.live.length} executions in progress finish`} on v${version - 1} — v${version} applies from the next execution.`
            : `Version ${version} saved — earlier versions are in the Version menu when you edit.`, 3200)
        }
      } else {
        const created = await api.createAutomation({
          draft: serializeDraft(rev), name: rev.name, agentId,
          stepAgents: rev.enabledAgents, allowedSecrets: rev.allowedSecrets,
        })
        // The detail page guards against unknown ids — make sure the store
        // knows the new automation before navigating (WS refresh may lag).
        await useStore.getState().loadAuto(created.id)
        setSurface('app')
        go('automation', { automationId: created.id })
        showToast('Created — nothing has executed yet. Press Execute now when you’re ready.', 3600)
      }
    } catch (e) {
      draftSettled.current = false
      showToast((e as Error).message)
    }
  }

  // ---------- render ----------
  const backLabel = isEdit ? (auto?.name ?? 'Automation') : 'Automations'
  // §11 create empty state: no spec, no steps, nothing drafting — the chat
  // pane shows the headline + example chips and the first message creates.
  const isCreateEmpty = !isEdit && !!rev && rev.spec.length === 0 && rev.steps.length === 0 && !drafting
  const inputDisabled = anyJobBusy || testLive || viewingOld
  const lastRewriteId = rev ? [...rev.chat].reverse().find((e) => e.kind === 'rewrite')?.id : undefined

  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'flex-start' }}>
        {/* ===== chat panel (§11) — floating card matching the §9 rail rhythm:
            top 46 / bottom 12, 12px radius, 12px left gap; starts below the drag
            strips and the traffic lights, so no header padding or no-drag needed ===== */}
        {rev && (
          <ChatPanel
            rev={rev}
            agents={agents}
            selAgent={selAgent}
            isEdit={isEdit}
            isCreateEmpty={isCreateEmpty}
            anyJobBusy={anyJobBusy}
            busyRewrite={busyRewrite}
            drafting={drafting}
            installingPkgs={installingPkgs}
            testLive={testLive}
            viewingOld={viewingOld}
            inputDisabled={inputDisabled}
            outOfSync={outOfSync}
            syncDisabled={syncDisabled}
            lastRewriteId={lastRewriteId}
            chatText={chatText}
            setChatText={setChatText}
            sendMessage={sendMessage}
            submitCreate={jobs.submitCreate}
            lastCreateRef={jobs.lastCreateRef}
            undoDraft={undoDraft}
            runSync={() => void jobs.runSync()}
            patchEntry={patchEntry}
            applyBlockersEntry={applyBlockersEntry}
            clearChat={clearChat}
            cancelChat={jobs.cancelChat}
            cancelCreate={jobs.cancelCreate}
            cancelSync={jobs.cancelSync}
            setAgentId={setAgentId}
            up={up}
            showToast={showToast}
          />
        )}

        {/* ===== review pane ===== */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* header */}
          <div className="ad-anim-page" style={{ padding: '20px 0 0' }}>
            <div style={{
              maxWidth: 1800, margin: '0 auto', padding: '0 30px 0 18px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <button className="ad-btn-text" onClick={() => void close()}>
                <i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /> {backLabel}
              </button>
            </div>
          </div>
          {!rev && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
              <Spinner size={24} />
            </div>
          )}
          {rev && (
          <div className="ad-anim-page" style={{ maxWidth: 1800, margin: '0 auto', padding: '14px 30px 60px 18px' }}>
            {/* title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, margin: '0 0 6px' }}>
              {nameEdit !== null ? (
                <input
                  className="ad-input"
                  value={nameEdit}
                  onChange={(e) => setNameEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTitleRename()
                    if (e.key === 'Escape') setNameEdit(null)
                  }}
                  onBlur={commitTitleRename}
                  autoFocus
                  style={{
                    font: "600 20px var(--sans)", letterSpacing: '-.01em', padding: '2px 10px',
                    minWidth: 0, flex: '0 1 auto', width: 420,
                  }}
                />
              ) : canRename ? (
                <div className="ad-title-rename always" title={draftName}>
                  <h1 style={{
                    font: "600 20px var(--sans)", letterSpacing: '-.01em', margin: 0,
                    minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {titleText}
                  </h1>
                  <button className="pencil" title="Rename" onClick={() => setNameEdit(draftName)}>
                    <i className="fa-solid fa-pencil" />
                  </button>
                </div>
              ) : (
                <h1 style={{
                  font: "600 20px var(--sans)", letterSpacing: '-.01em', margin: 0,
                  minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {titleText}
                </h1>
              )}
              {isEdit && auto && (
                <div ref={verRef} style={{ position: 'relative' }}>
                  <button className="ad-btn-pill" data-testid="version-menu" disabled={busyRewrite} onClick={() => setVerOpen(!verOpen)}>
                    <span>{rev.viewing === 'draft' ? 'Draft' : `v${rev.viewing}${rev.viewing === auto.version ? ' · current' : ''}`}</span>
                    <i className="fa-solid fa-caret-down" style={{ color: 'var(--text-faint)', fontSize: 9 }} />
                  </button>
                  <PopMenu show={verOpen} style={{ top: 'calc(100% + 6px)', left: 0, minWidth: 360 }}>
                    {/* a long version history scrolls inside the menu instead of past the window */}
                    <ScrollArea style={{ maxHeight: '60vh' }}>
                      {([
                        {
                          key: 'draft' as const, label: 'Draft',
                          sub: 'your working copy — unsaved',
                        },
                        {
                          key: auto.version, label: `v${auto.version}`,
                          sub: 'current · ' + (((auto.specMeta || '').split('·')[1] || '').trim()),
                        },
                        ...(auto.versions ?? []).map((v) => ({
                          key: v.version, label: `v${v.version}`, sub: v.when + (v.note ? ' · ' + v.note : ''),
                        })),
                      ]).map((it) => {
                        const sel = rev.viewing === it.key
                        return (
                          <button
                            key={String(it.key)}
                            className="ad-btn-bare ad-hover-row"
                            onClick={() => pickVersion(it.key)}
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
                              <div style={{ font: "600 12.5px var(--mono)", color: sel ? 'var(--text)' : 'var(--text-2)' }}>{it.label}</div>
                              <div style={{ font: "400 11.5px/1.45 var(--sans)", color: 'var(--text-muted)', marginTop: 1 }}>{it.sub}</div>
                            </div>
                          </button>
                        )
                      })}
                    </ScrollArea>
                  </PopMenu>
                </div>
              )}
              <div style={{ flex: 1 }} />
              <HeaderActions>
                {saveBlocked && !isCreateEmpty && (
                  <span style={{ font: "400 12px var(--sans)", color: 'var(--amber)' }}>
                    {rev.specBusy ? 'Writing the spec…'
                      : rev.stepsBusy ? (installingPkgs ? 'Installing the packages…' : 'Generating the steps…')
                        : rev.syncBusy ? (installingPkgs ? 'Installing the packages…' : 'Syncing steps…')
                          : rev.chatBusy ? 'Working on the request…'
                            : rev.specEdit ? 'Finish editing the spec first — save or cancel your edits'
                              : 'Sync and review the steps before saving'}
                  </span>
                )}
                <button className="ad-btn-text dim" disabled={busyRewrite} onClick={() => void startOver()}>
                  {isEdit ? 'Discard draft' : 'Start over'}
                </button>
                {isEdit && (rev.touched || !!auto?.draft) && (
                  <button className="ad-btn-ghost" onClick={() => void close()}>
                    Keep draft
                  </button>
                )}
                <BtnPrimary onClick={() => void doSave()} disabled={saveBlocked}>
                  {isEdit && auto
                    ? (viewingOld ? `Restore v${rev.viewing} as v${auto.version + 1}` : `Save as v${auto.version + 1}`)
                    : 'Create automation'}
                </BtnPrimary>
              </HeaderActions>
            </div>
            {/* lede: the automation's description (§4.1) — editable like the name; create mode
                shows the static drafting lede until drafting settles. The row is
                height-stable: every state shares one fixed-height box. The drafting-agent
                picker lives in the chat pane composer, not here. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, height: 26, minWidth: 0, margin: '0 0 20px' }}>
              {!isEdit && drafting ? (
                <p style={{
                  font: "400 13.5px/1.6 var(--sans)", color: 'var(--text-muted)', margin: 0, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  Read what your AI wrote. Change anything — nothing executes until you create it.
                </p>
              ) : descEdit !== null ? (
                <input
                  className="ad-input"
                  value={descEdit}
                  onChange={(e) => setDescEdit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitDescEdit()
                    if (e.key === 'Escape') setDescEdit(null)
                  }}
                  onBlur={commitDescEdit}
                  autoFocus
                  placeholder="What this automation does — one line"
                  style={{ font: "400 13.5px/1.6 var(--sans)", height: 26, padding: '0 10px', width: 640, maxWidth: '100%' }}
                />
              ) : (
                <div
                  className={canRename ? 'ad-title-rename always' : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}
                >
                  <p style={{
                    font: "400 13.5px/1.6 var(--sans)", margin: 0, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    color: rev.description ? 'var(--text-muted)' : 'var(--text-faint)',
                  }}>
                    {rev.description || (canRename ? 'No description yet — press the pencil to add one.' : 'No description yet.')}
                  </p>
                  {canRename && (
                    <button className="pencil" title="Edit the description" onClick={() => setDescEdit(rev.description)}>
                      <i className="fa-solid fa-pencil" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* old-version banner */}
            {viewingOld && auto && (
              <div className="ad-anim-item" style={{
                background: 'var(--notice-accent-bg)', border: '1px solid var(--notice-accent-border)',
                borderRadius: 10, padding: '11px 14px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`Loaded v${rev.viewing} from history. Saving restores it as v${auto.version + 1} — your draft stays in the Version menu.`}
                </span>
                <button className="ad-btn-soft" disabled={busyRewrite} onClick={() => pickVersion('draft')} style={{ flex: 'none' }}>
                  Back to draft
                </button>
              </div>
            )}

            {/* live-execution note */}
            {isEdit && !!auto?.live.length && (
              <div className="ad-anim-item" style={{
                background: 'var(--notice-cyan-bg)', border: '1px solid var(--notice-cyan-border)',
                borderRadius: 10, padding: '11px 14px', margin: '0 0 18px',
                display: 'flex', alignItems: 'center', gap: 11,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', animation: PULSE, flex: 'none' }} />
                <span style={{ flex: 1, font: "400 12.5px/1.5 var(--sans)", color: 'var(--text)' }}>
                  {`An execution is happening right now on v${auto.version}. Saving won’t interrupt it — that execution finishes on v${auto.version}. v${auto.version + 1} takes over from the next execution (${nextTriggerShort(auto.triggers, trigPreviews) ?? auto.triggerChip}).`}
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,.95fr)', gap: 18, alignItems: 'start' }}>
              {/* ===== left column ===== */}
              <LeftColumn
                rev={rev}
                up={up}
                fw={fw}
                isEdit={isEdit}
                isCreateEmpty={isCreateEmpty}
                busyRewrite={busyRewrite}
                viewingOld={viewingOld}
                testLive={testLive}
                lockStyle={lockStyle}
                selAgent={selAgent}
                agents={agents}
                secrets={secrets}
                availAgents={availAgents}
                agentStepIdx={agentStepIdx}
                agWarn={agWarn}
                agNone={agNone}
                agNotEnabled={agNotEnabled}
                agMissing={agMissing}
                agFallbackIdx={agFallbackIdx}
                secWarn={secWarn}
                secNotAllowed={secNotAllowed}
                secMissing={secMissing}
                secRefs={secRefs}
                specOpenEff={specOpenEff}
                agSecOpenEff={agSecOpenEff}
                secSecOpenEff={secSecOpenEff}
                instrOpenEff={instrOpenEff}
                notesOpenEff={notesOpenEff}
                cancelStepsGen={jobs.cancelStepsGen}
                showToast={showToast}
                setConfirmSpecCancel={setConfirmSpecCancel}
              />

              {/* ===== right column ===== */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <BuildTestPanel
                  rev={rev}
                  up={up}
                  appendEntry={appendEntry}
                  isEdit={isEdit}
                  auto={auto}
                  drafting={drafting}
                  outOfSync={outOfSync}
                  anyJobBusy={anyJobBusy}
                  busyRewrite={busyRewrite}
                  viewingOld={viewingOld}
                  syncDisabled={syncDisabled}
                  agentGap={agentGap}
                  stageLabel={stageLabel}
                  lockStyle={lockStyle}
                  runSync={() => void jobs.runSync()}
                  sendChat={jobs.sendChat}
                />
                <RightCards
                  rev={rev}
                  up={up}
                  liveParams={auto?.params}
                  drafting={drafting}
                  isCreateEmpty={isCreateEmpty}
                  outOfSync={outOfSync}
                  busyRewrite={busyRewrite}
                  availAgents={availAgents}
                  pkgSecOpenEff={pkgSecOpenEff}
                  runSync={() => void jobs.runSync()}
                  updatePkgs={(pips) => void updatePkgs(pips)}
                  installPkgs={() => void installPkgs()}
                />
              </div>
            </div>
          </div>
          )}
        </div>
      </div>

      {confirmSpecCancel && (
        <ConfirmModal
          title="Discard your spec edits?"
          body="The changes you typed into the spec editor will be lost."
          confirmLabel="Discard edits"
          danger
          onConfirm={() => { setConfirmSpecCancel(false); up({ specEdit: false, specText: '', specTextOrig: '' }) }}
          onCancel={() => setConfirmSpecCancel(false)}
        />
      )}

    </div>
  )
}
