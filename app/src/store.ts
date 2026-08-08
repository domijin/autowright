// One central model drives everything (§4 top-level, §9 navigation).
import { create } from 'zustand'
import { api, connectInfo, openWs } from './api'
import type { Agent, Automation, Execution, LogLine, SecretMeta, Settings, StateSnapshot } from './types'

type Surface = 'onboard' | 'app' | 'create' | 'menubar'
export type Page =
  | 'automations' | 'automation' | 'executions' | 'execution'
  | 'agents' | 'agentNew' | 'secrets' | 'settings' | 'about'

type CreateFrom = 'app' | 'edit' | null

// §12 agent status badge — cached for the app session so the Agents page
// doesn't re-check on every visit.
export type AgentCheck = 'checking' | 'connecting' | 'ready' | 'needs'

interface NavSnap {
  surface: Surface; page: Page; automationId: string | null; executionId: string | null
  // §4.4/§11: without this, browser-back into the editor would restore
  // surface 'create' with createFrom null — the wrong editor mode.
  createFrom: CreateFrom
  // §12: which agent the agentNew page edits (null = blank add form) — in the
  // snapshot so back/forward re-enters the same edit form, never a blank one.
  agentEditId: string | null
}

interface Model {
  connected: boolean | null
  version: string
  automations: Automation[]
  executions: Execution[]
  agents: Agent[]
  secrets: SecretMeta[]
  settings: Settings | null
  // §4.4 pending create-mode slot — drives the §9.1 Resume draft button
  pendingDraft: { name: string; updatedAt: string | null } | null

  surface: Surface
  page: Page
  automationId: string | null
  executionId: string | null
  createFrom: CreateFrom
  // §12: agent id the agentNew page edits — null renders the blank add form.
  agentEditId: string | null

  toast: string | null
  executionFull: Record<string, Execution>
  // §19 lazy logs, per execution: logKey(step, attempt) → fetched lines,
  // extended live by matching exec.log events (deduped by sequence)
  execLogs: Record<string, Record<string, LogLine[]>>
  // §11 test — the live test execution the editor's Build & test panel tracks.
  // Steps, status, and logs live on the ordinary exec record (executionFull[executionId],
  // kept fresh by exec.* events).
  test: { executionId: string } | null
  // §7/§9.2 Fix with AI: the failed execution id handed to the editor, which
  // seeds the thread and sends the §11 canned analyze chat message on mount,
  // then clears it.
  fixExec: string | null
  ollamaPull: { model: string; line: string; done: boolean; ok?: boolean } | null
  // §19 harness.install stream, latest event per provider id
  harnessInstall: Record<string, { line?: string; percent?: number; done: boolean; ok?: boolean; error?: string }>
  // §12 session cache of agent status checks, keyed by agent id
  agentChecks: Record<string, AgentCheck>

  boot(): Promise<void>
  runAgentCheck(id: string, pending?: AgentCheck): Promise<'ready' | 'needs'>
  disconnect(): void
  refresh(): Promise<void>
  applyEvent(msg: Record<string, unknown>): void
  go(page: Page, ids?: { automationId?: string | null; executionId?: string | null; agentEditId?: string | null }): void
  setSurface(s: Surface, from?: CreateFrom): void
  showToast(msg: string, ms?: number): void
  loadExecution(executionId: string): Promise<void>
  loadExecLogs(executionId: string, step?: number, attempt?: number): Promise<void>
  loadAuto(automationId: string): Promise<void>
  beginTest(executionId: string): void
  clearTest(): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
let bootTimer: ReturnType<typeof setTimeout> | undefined
let closeWs: (() => void) | null = null
let passedOnboard = false
let restoring = false
// Monotonic refresh sequence: only the newest in-flight /state snapshot may
// land — an older response resolving late would clobber fresher data.
let refreshSeq = 0

// Execution cache eviction: full records and log buckets are kept only for
// the currently viewed execution plus the 5 most recently viewed (MRU head is
// the current one, so its live-streaming buckets are never evicted mid-view);
// the rest are dropped on navigation. A tracked §11 test execution is always
// kept while the test is live. Re-opening an evicted execution refetches
// through the ordinary load paths, which already handle absence.
const EXECUTION_CACHE_KEEP = 6
let executionMru: string[] = []

function touchExecutionMru(id: string) {
  executionMru = [id, ...executionMru.filter((x) => x !== id)].slice(0, EXECUTION_CACHE_KEEP)
}

function evictExecutionCaches(
  m: Pick<Model, 'executionFull' | 'execLogs' | 'test'>,
): Pick<Model, 'executionFull' | 'execLogs'> | null {
  const keep = new Set(executionMru)
  if (m.test) keep.add(m.test.executionId)
  const staleFull = Object.keys(m.executionFull).filter((id) => !keep.has(id))
  const staleLogs = Object.keys(m.execLogs).filter((id) => !keep.has(id))
  if (staleFull.length === 0 && staleLogs.length === 0) return null
  const executionFull = { ...m.executionFull }
  const execLogs = { ...m.execLogs }
  for (const id of staleFull) delete executionFull[id]
  for (const id of staleLogs) delete execLogs[id]
  return { executionFull, execLogs }
}

// '/app?auto=<uuid>' — the §13 menu-bar row deep link.
function autoIdFromHash(hash: string): string | null {
  const m = hash.match(/auto=([0-9a-f-]{36})/)
  return m ? m[1] : null
}

export const useStore = create<Model>((set, get) => ({
  connected: null,
  version: '',
  automations: [],
  executions: [],
  agents: [],
  secrets: [],
  settings: null,
  pendingDraft: null,
  surface: 'app',
  page: 'automations',
  automationId: null,
  executionId: null,
  createFrom: null,
  agentEditId: null,
  toast: null,
  executionFull: {},
  execLogs: {},
  test: null,
  fixExec: null,
  ollamaPull: null,
  harnessInstall: {},
  agentChecks: {},

  // §12: the one place a status check runs — badge goes to `pending` while the
  // real §19 /agents/{id}/check call is in flight, result lands in the cache.
  async runAgentCheck(id, pending = 'checking') {
    set({ agentChecks: { ...get().agentChecks, [id]: pending } })
    let st: 'ready' | 'needs'
    try {
      const r = await api.checkAgent(id)
      st = r.status === 'ready' ? 'ready' : 'needs'
    } catch { st = 'needs' }
    set({ agentChecks: { ...get().agentChecks, [id]: st } })
    return st
  },

  async boot() {
    // One retry chain only: a re-entrant boot (StrictMode re-mount) must not
    // leave a second timer chain hammering discovery in parallel.
    clearTimeout(bootTimer)
    const ok = await connectInfo()
    if (!ok) { set({ connected: false }); bootTimer = setTimeout(() => get().boot(), 1200); return }
    try {
      const s: StateSnapshot = await api.state()
      // Existing automations do NOT bypass onboarding: step 1 always shows; with
      // prior data its Continue goes straight to the app (§10).
      const onboarded = localStorage.getItem('ad-onboarded') === '1'
      const hash = location.hash
      const deepAuto = onboarded ? autoIdFromHash(hash) : null
      set({
        connected: true, version: s.version, automations: s.automations, executions: s.executions,
        agents: s.agents, secrets: s.secrets, settings: s.settings,
        pendingDraft: s.pendingDraft,
        surface: hash.includes('menubar') ? 'menubar' : onboarded ? 'app' : 'onboard',
        ...(deepAuto ? { page: 'automation' as const, automationId: deepAuto } : {}),
      })
      if (onboarded) passedOnboard = true
      // Exactly one live socket: a re-entrant boot (StrictMode re-mount,
      // backend restart) must not stack subscriptions — every stacked socket
      // applies each event once more (duplicate log lines, double toasts).
      closeWs?.()
      closeWs = openWs((msg) => get().applyEvent(msg))
      updateTrayAlert(s.automations)
    } catch {
      set({ connected: false })
      bootTimer = setTimeout(() => get().boot(), 1200)
    }
  },

  disconnect() {
    clearTimeout(bootTimer)
    closeWs?.()
    closeWs = null
  },

  async refresh() {
    const n = ++refreshSeq
    try {
      const s = await api.state()
      // A newer refresh started while this one was in flight — its snapshot is
      // fresher (or will be); applying this one would roll state backwards.
      if (n !== refreshSeq) return
      set({ automations: s.automations, executions: s.executions, agents: s.agents, secrets: s.secrets, settings: s.settings, pendingDraft: s.pendingDraft })
      updateTrayAlert(s.automations)
    } catch { /* backend restarting; ws reconnect will re-trigger */ }
  },

  applyEvent(msg) {
    const ev = msg.event as string
    const m = get()
    if (ev === 'ws.open') {
      void m.refresh()
      // A reconnect means events were missed (backend restart, dropped
      // socket): a cached full record can be stuck "executing" for an
      // execution the backend already repaired to interrupted, and open log
      // buckets can hold silent gaps. Refetch what can actually be stale —
      // non-terminal records plus whatever the current page shows.
      const staleIds = new Set(
        Object.values(m.executionFull).filter((e) => e.status === 'executing').map((e) => e.id),
      )
      if (m.executionId && m.executionFull[m.executionId]) staleIds.add(m.executionId)
      for (const id of staleIds) {
        void m.loadExecution(id)
        for (const key of Object.keys(m.execLogs[id] ?? {})) {
          if (key === 'x.0') void m.loadExecLogs(id)
          else {
            const [s, a] = key.split('.')
            void m.loadExecLogs(id, Number(s), Number(a))
          }
        }
      }
      return
    }
    // §6 exec.queued (a firing admitted to the queue) carries the same header
    // shape as exec.started — the record lands in the list the same way, which
    // is what the §7 Waiting section and the §9.2 "N waiting" line count.
    if (ev === 'execution.started' || ev === 'execution.finished' || ev === 'execution.queued') {
      const ej = msg.execution_json as Execution | undefined
      if (ej) {
        const rest = m.executions.filter((e) => e.id !== ej.id)
        set({ executions: [ej, ...rest].sort((a, b) => b.startedMs - a.startedMs) })
        const full = m.executionFull[ej.id]
        // ej is a header (no steps/result) — merging keeps the full record's body
        if (full) set({ executionFull: { ...m.executionFull, [ej.id]: { ...full, ...ej } } })
        // §7 retry re-publish (and §6 promotion, same id): re-fetch steps/attempts.
        if (ev === 'execution.started' && full) void m.loadExecution(ej.id)
        if (ev === 'execution.finished') {
          void m.refresh()
          // Refresh the body only when someone has opened this execution —
          // unviewed executions would otherwise accumulate a full record each.
          if (full) void m.loadExecution(ej.id)
          // §7: the finished execution gets a summary toast (prototype pattern:
          // "<name> finished — <chip>."). Cancelled executions are user-initiated —
          // no toast; §11 tests report in the Test card instead.
          if (!ej.test && (ej.status === 'succeeded' || ej.status === 'failed')) {
            const aj = msg.automation_json as Automation | null | undefined
            const name = aj?.name ?? m.automations.find((a) => a.id === ej.automationId)?.name ?? 'Automation'
            m.showToast(ej.status === 'failed'
              ? `${name} failed — needs attention.`
              : aj?.resultChip ? `${name} finished — ${aj.resultChip}.` : `${name} finished.`)
          }
        } else {
          void m.refresh()
        }
      }
      return
    }
    if (ev === 'execution.step') {
      // Steps live only on the full record (§19: list headers carry none).
      const executionId = msg.executionId as string
      const idx = msg.index as number
      const step = msg.step as NonNullable<Execution['steps']>[number]
      const full = m.executionFull[executionId]
      if (full?.steps) {
        set({
          executionFull: {
            ...m.executionFull,
            [executionId]: { ...full, steps: full.steps.map((s, i) => (i === idx ? step : s)) },
          },
        })
      }
      return
    }
    if (ev === 'execution.log') {
      const executionId = msg.executionId as string
      const key = logKey(msg.stepIndex as number | null, msg.attempt as number | null)
      const buckets = m.execLogs[executionId]
      const bucket = buckets?.[key]
      if (bucket) {
        const line = msg.line as LogLine
        // sequence dedupe: a line already covered by a fetched snapshot is dropped
        const last = bucket.length ? bucket[bucket.length - 1].sequence : 0
        if (line.sequence > last) {
          set({ execLogs: { ...m.execLogs, [executionId]: { ...buckets, [key]: [...bucket, line] } } })
        }
      }
      return
    }
    if (ev === 'harness.install') {
      const id = msg.id as string
      set({
        harnessInstall: {
          ...get().harnessInstall,
          [id]: {
            line: msg.line as string | undefined, percent: msg.percent as number | undefined,
            done: !!msg.done, ok: msg.ok as boolean | undefined, error: msg.error as string | undefined,
          },
        },
      })
      return
    }
    if (ev === 'ollama.pull') {
      set({
        ollamaPull: {
          model: msg.model as string, line: msg.line as string,
          done: !!msg.done, ok: msg.ok as boolean | undefined,
        },
      })
      return
    }
    if (ev === 'automation.changed' || ev === 'agents.changed' || ev === 'secrets.changed' || ev === 'settings.changed' || ev === 'draft.changed') {
      void m.refresh()
    }
  },

  go(page, ids = {}) {
    // Page nav always lands in the app shell — leaving the create/edit
    // surface here is what lets sidebar tabs escape the editor (§9).
    const leavingCreate = get().surface === 'create'
    set({
      page,
      automationId: ids.automationId !== undefined ? ids.automationId : get().automationId,
      executionId: ids.executionId !== undefined ? ids.executionId : get().executionId,
      // Unlike automationId/executionId this never persists across navigations — a plain
      // go('agentNew') must be the blank add form (§12).
      agentEditId: ids.agentEditId !== undefined ? ids.agentEditId : null,
      ...(leavingCreate ? { surface: 'app' as const, createFrom: null } : {}),
    })
    const m = get()
    if (m.executionId) touchExecutionMru(m.executionId)
    const evicted = evictExecutionCaches(m)
    if (evicted) set(evicted)
    syncHistory(get())
  },

  setSurface(surface, from = null) {
    if (surface !== 'onboard') passedOnboard = true
    if (surface === 'app' && get().surface === 'onboard') localStorage.setItem('ad-onboarded', '1')
    set({ surface, createFrom: from })
    syncHistory(get())
  },

  showToast(msg, ms = 2800) {
    set({ toast: msg })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { if (get().toast === msg) set({ toast: null }) }, ms)
  },

  async loadExecution(executionId) {
    try {
      const e = await api.getExecution(executionId)
      set({ executionFull: { ...get().executionFull, [executionId]: e } })
    } catch { /* deleted */ }
  },

  async loadExecLogs(executionId, step, attempt) {
    const key = logKey(step ?? null, attempt ?? null)
    // Open the bucket before the fetch: the exec.log handler drops lines with
    // no bucket, so a line streamed while the snapshot request is in flight —
    // and written after the backend read the snapshot — would vanish for good.
    // With the bucket open it buffers here and the sequence merge below keeps it.
    {
      const all = get().execLogs
      const buckets = all[executionId] ?? {}
      if (!buckets[key]) set({ execLogs: { ...all, [executionId]: { ...buckets, [key]: [] } } })
    }
    try {
      const { lines } = await api.getExecutionLogs(executionId, step, attempt)
      const all = get().execLogs
      const buckets = all[executionId] ?? {}
      const bucket = buckets[key]
      // keep WS lines that streamed in past the fetched snapshot
      const sequence = lines.length ? lines[lines.length - 1].sequence : 0
      const tail = bucket ? bucket.filter((l) => l.sequence > sequence) : []
      set({ execLogs: { ...all, [executionId]: { ...buckets, [key]: [...lines, ...tail] } } })
    } catch { /* deleted */ }
  },

  async loadAuto(automationId) {
    try {
      const a = await api.getAutomation(automationId)
      const automations = get().automations
      set({
        automations: automations.some((x) => x.id === automationId)
          ? automations.map((x) => (x.id === automationId ? a : x))
          : [...automations, a],
      })
    } catch { /* deleted */ }
  },

  beginTest(executionId) {
    touchExecutionMru(executionId) // counts as a view — survives eviction after clearTest too
    set({ test: { executionId } })
    void get().loadExecution(executionId) // steps/status render off the ordinary record
  },

  clearTest() { set({ test: null }) },
}))

// §19 log buckets: step+attempt select an attempt file, null/null the execution log.
export function logKey(step: number | null, attempt: number | null) {
  return step === null ? 'x.0' : `${step}.${attempt ?? 1}`
}

function updateTrayAlert(automations: Automation[]) {
  void window.autowright?.trayAlert(automations.some((a) => a.lastStatus === 'failed'))
}

// ---------- history (§9: back works, never re-enters onboarding) ----------
let lastNav: NavSnap | null = null

function navSame(a: NavSnap | null, b: NavSnap | null) {
  return !!a && !!b && a.surface === b.surface && a.page === b.page
    && a.automationId === b.automationId && a.executionId === b.executionId && a.createFrom === b.createFrom
    && a.agentEditId === b.agentEditId
}

function syncHistory(m: Model) {
  if (restoring) return
  const s: NavSnap = {
    surface: m.surface, page: m.page, automationId: m.automationId, executionId: m.executionId,
    createFrom: m.createFrom, agentEditId: m.agentEditId,
  }
  if (navSame(s, lastNav)) return
  lastNav = s
  try { history.pushState({ adNav: s }, '') } catch { /* file:// quirks */ }
}

window.addEventListener('popstate', (e) => {
  const s = (e.state && (e.state as { adNav?: NavSnap }).adNav) || null
  if (!s) return
  if (s.surface === 'onboard' && passedOnboard) {
    try { history.pushState({ adNav: lastNav }, '') } catch { /* ignore */ }
    return
  }
  restoring = true
  useStore.setState({
    surface: s.surface, page: s.page, automationId: s.automationId, executionId: s.executionId,
    createFrom: s.createFrom ?? null, agentEditId: s.agentEditId ?? null,
  })
  const m = useStore.getState()
  if (m.executionId) touchExecutionMru(m.executionId)
  const evicted = evictExecutionCaches(m)
  if (evicted) useStore.setState(evicted)
  lastNav = s
  restoring = false
})

// §13: main pushes the menu-bar row's target here when the window already
// exists (a reload would drop the WS); fresh windows carry it in the hash.
window.autowright?.onOpenTarget?.((hash) => {
  const m = useStore.getState()
  if (m.surface === 'onboard' || m.surface === 'menubar') return
  const automationId = autoIdFromHash(hash)
  if (automationId) m.go('automation', { automationId })
})
