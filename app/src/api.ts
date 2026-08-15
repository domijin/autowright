// Backend client (§19). Discovers port+token via preload (backend.json).
import type { DraftJob, StateSnapshot, WsEvent } from './types'

declare global {
  interface Window {
    autowright?: {
      backendInfo(): Promise<{ port: number; token: string } | null>
      backendStatus(): Promise<{ state: 'idle' | 'installing' | 'ok' | 'failed'; detail: string }>
      openApp(hash: string): Promise<void>
      pickFolder(defaultPath?: string): Promise<string | null>
      resizePanel(h: number): Promise<void>
      saveFile(defaultName: string, data: ArrayBuffer): Promise<string | null>
      openArchive(): Promise<{ name: string; data: Uint8Array } | null>
      revealPath(p: string): Promise<void>
      applySettings(s: { login?: boolean; menuBarIcon?: boolean; automaticUpdateCheck?: boolean }): Promise<void>
      tailLogs(): Promise<{ name: string; text: string }[]>
      listRequestLogs(): Promise<string[]>
      readRequestLog(name: string): Promise<string | null>
      trayAlert(on: boolean): Promise<void>
      // §9.4 in-app updates (§3)
      updateCheck(): Promise<{ state: 'uptodate' | 'error' } | { state: 'available'; version: string }>
      updateDownload(): Promise<{ ok: true } | { error: string }>
      updateInstall(): Promise<{ ok: true } | { busy: true }>
      onUpdateProgress(cb: (percent: number | null) => void): void
      updateAvailable(): Promise<string | null>
      onUpdateAvailable(cb: (version: string | null) => void): void
      onOpenTarget(cb: (hash: string) => void): void
    }
  }
}

let base = ''
let token = ''

export async function connectInfo(): Promise<boolean> {
  const info = await window.autowright?.backendInfo()
  if (!info) return false
  base = `http://127.0.0.1:${info.port}`
  token = info.token
  return true
}

// §5.1/§5.2 archives ride as raw zip bytes (§19: no multipart)
async function rawPost<T>(path: string, data: Uint8Array): Promise<T> {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: data as unknown as BodyInit,
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json()).detail } catch { /* ignore */ }
    throw Object.assign(new Error(detail || r.statusText), { status: r.status })
  }
  return r.json()
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json()).detail } catch { /* ignore */ }
    throw Object.assign(new Error(detail || r.statusText), { status: r.status })
  }
  return r.json()
}

export const api = {
  state: () => req<StateSnapshot>('GET', '/state'),
  instructions: () => req<{ framework: string; defaultBuild: string }>('GET', '/instructions'),
  // §4.5/§19: the machine kind — the API serializes the display label
  // §6/§19 `queue`: the §9.2 capacity popup's Queue action — at capacity the
  // start joins the firing queue instead of answering 409.
  executeNow: (automationId: string, version?: string, trigger: 'manual' | 'menubar' = 'manual', queue?: boolean) =>
    req<{ executionId: string; queued: boolean }>('POST', `/automations/${automationId}/execute`,
      { version, trigger, queue: queue || undefined }),
  cancelExecution: (executionId: string) => req('POST', `/executions/${executionId}/cancel`),
  // §7 in-place retry: same execution record, from the failed step
  retryExecution: (executionId: string) => req<{ executionId: string }>('POST', `/executions/${executionId}/retry`),
  // §7 skip: index must be the currently executing step (409 otherwise)
  skipStep: (executionId: string, index: number) =>
    req('POST', `/executions/${executionId}/skip-step`, { index }),
  getExecution: (executionId: string) => req<import('./types').Execution>('GET', `/executions/${executionId}`),
  // §19 lazy logs: both params → that step attempt's file; neither → the execution log
  getExecutionLogs: (executionId: string, step?: number, attempt?: number) =>
    req<{ lines: import('./types').LogLine[] }>('GET', `/executions/${executionId}/logs`
      + (step !== undefined ? `?step=${step}&attempt=${attempt ?? 1}` : '')),
  getAutomation: (automationId: string) => req<import('./types').Automation>('GET', `/automations/${automationId}`),
  patchAutomation: (automationId: string, patch: Record<string, unknown>) =>
    req<import('./types').Automation>('PATCH', `/automations/${automationId}`, patch),
  // §19 pure function endpoint: validate + label §4.3-shaped trigger dicts —
  // the renderer's only source of trigger display strings and next occurrences
  triggersPreview: (triggers: object[]) =>
    req<{ triggers: import('./types').TriggerPreview[] }>('POST', '/triggers/preview', { triggers }),
  // §19 iMessage permission checklist (§9.2): status probe + Automation prompt
  imessagePermissions: () =>
    req<{ fullDisk: boolean; automation: 'granted' | 'denied' | 'unknown' }>(
      'GET', '/imessage/permissions'),
  imessageAutomationProbe: () =>
    req<{ automation: 'granted' | 'denied' }>('POST', '/imessage/permissions/automation-probe'),
  deleteAutomation: (automationId: string) => req('DELETE', `/automations/${automationId}`),
  clearMemory: (automationId: string) => req('POST', `/automations/${automationId}/memory/clear`),
  // §6 firing queue — cancels every waiting entry; running executions are untouched
  clearQueue: (automationId: string) =>
    req<{ cancelled: number }>('POST', `/automations/${automationId}/queue/clear`),
  // §6.3 memory snapshots
  createSnapshot: (automationId: string, name?: string) =>
    req<{ snapshot: import('./types').MemorySnapshot }>('POST', `/automations/${automationId}/memory/snapshots`, { name }),
  renameSnapshot: (automationId: string, sid: string, name: string | null) =>
    req<{ snapshot: import('./types').MemorySnapshot }>('PATCH', `/automations/${automationId}/memory/snapshots/${sid}`, { name }),
  restoreSnapshot: (automationId: string, sid: string) =>
    req('POST', `/automations/${automationId}/memory/snapshots/${sid}/restore`),
  deleteSnapshot: (automationId: string, sid: string) =>
    req('DELETE', `/automations/${automationId}/memory/snapshots/${sid}`),
  createAutomation: (body: Record<string, unknown>) => req<import('./types').Automation>('POST', '/automations', body),
  saveVersion: (automationId: string, body: Record<string, unknown>) =>
    req<{ version: number }>('POST', `/automations/${automationId}/versions`, body),
  // §19 the one draft-container surface: owner = automation id | 'pending'
  // (the §4.4 create-mode slot <root>/draft/). agentId rides beside the
  // pending payload only — the identity no automation record exists to hold.
  getDraft: (owner: string) =>
    req<{ draft: import('./types').DraftPayload | null; agentId: string | null }>('GET', `/draft/${owner}`),
  putDraft: (owner: string, draft: unknown, agentId?: string | null) =>
    req('PUT', `/draft/${owner}`, { draft, ...(agentId !== undefined ? { agentId } : {}) }),
  openDraft: (owner: string) => req('POST', `/draft/${owner}/open`),
  deleteDraft: (owner: string) => req('DELETE', `/draft/${owner}`),
  // §19/§4.4 the chat-thread surface — the thread lives at the container root
  // and outlives the draft; an empty list unlinks it (§11 Clear chat).
  getChat: (owner: string) => req<{ chat: import('./types').ChatEntry[] }>('GET', `/chat/${owner}`),
  putChat: (owner: string, chat: import('./types').ChatEntry[]) => req('PUT', `/chat/${owner}`, { chat }),
  restore: (automationId: string, v: number) => req<{ version: number }>('POST', `/automations/${automationId}/restore`, { version: v }),
  // §19 test: starts a §4.5 test execution record of the sent draft's steps;
  // progress via the ordinary exec.* events, cancel via POST /executions/{id}/cancel
  postTest: (body: Record<string, unknown>) => req<{ executionId: string }>('POST', '/tests', body),
  // §6.2 declared packages: fast installed-check / blocking ensure (§19)
  checkPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/check', { packages }),
  installPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/install', { packages }),
  // §6.2 updates: read-only PyPI check / pip install --upgrade, no manifest writes (§19)
  outdatedPackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/outdated', { packages }),
  updatePackages: (packages: { pip: string; import: string }[]) =>
    req<{ packages: import('./types').PackageDep[] }>('POST', '/packages/update', { packages }),
  postDraftJob: (body: Record<string, unknown>) => req<{ jobId: string }>('POST', '/drafts', body),
  getDraftJob: (jobId: string) => req<DraftJob>('GET', `/drafts/${jobId}`),
  cancelDraftJob: (jobId: string) => req('DELETE', `/drafts/${jobId}`),
  addAgent: (body: Record<string, unknown>) => req<import('./types').Agent>('POST', '/agents', body),
  patchAgent: (id: string, body: Record<string, unknown>) => req('PATCH', `/agents/${id}`, body),
  deleteAgent: (id: string) => req('DELETE', `/agents/${id}`),
  checkAgent: (id: string) => req<{ status: string }>('POST', `/agents/${id}/check`),
  // §19 §4.7 readiness check before an agent record exists (§10 found cards)
  checkHarness: (harness: string, model?: string | null, mode: string = 'default') =>
    req<{ status: string }>('POST', '/agents/check-harness', { harness, mode, model }),
  detectAgents: () =>
    req<{ id: string; name: string; installed: boolean; signedIn: boolean | null; detail: string }[]>(
      'GET', '/agents/detect'),
  // §19 real installs + sign-in help (§10 step 2)
  installHarness: (id: string) => req('POST', '/agents/install', { id }),
  installStatus: (id: string) =>
    req<{ state: 'idle' | 'running' | 'done' | 'failed'; percent?: number; line?: string; error?: string }>(
      'GET', `/agents/install/${id}`),
  loginHarness: (id: string) => req<{ ok: boolean; method: 'browser' | 'terminal' }>('POST', '/agents/login', { id }),
  signinStatus: (id: string) => req<{ installed: boolean; signedIn: boolean | null }>('GET', `/agents/signin/${id}`),
  ollamaStatus: () => req<{ ready: boolean; installed: boolean; models: string[] }>('GET', '/ollama/status'),
  ollamaPull: (model: string) => req('POST', '/ollama/pull', { model }),
  putSecret: (name: string, value: string, description?: string) =>
    req('PUT', `/secrets/${name}`, description === undefined ? { value } : { value, description }),
  deleteSecret: (name: string) => req('DELETE', `/secrets/${name}`),
  patchSettings: (patch: Record<string, unknown>) =>
    req<import('./types').Settings>('PATCH', '/settings', patch),
  setDataPath: (path: string) => req<import('./types').Settings>('POST', '/settings/data-path', { path }),
  // §5.1 transfer archives — raw zip bytes both ways (§19: no multipart)
  exportAutomation: async (automationId: string, values: boolean): Promise<ArrayBuffer> => {
    const r = await fetch(`${base}/automations/${automationId}/export?values=${values ? 1 : 0}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    return r.arrayBuffer()
  },
  importAutomation: (data: Uint8Array) =>
    rawPost<{ automation: import('./types').Automation; summary: import('./types').ImportSummary }>(
      '/automations/import', data),
  // §5.2 two-phase import — preview (URL or file bytes), then confirm by token
  importPreview: (data: Uint8Array) =>
    rawPost<{ token: string; preview: import('./types').ImportPreview }>(
      '/automations/import/preview', data),
  importFromUrl: (url: string) =>
    req<{ token: string; preview: import('./types').ImportPreview }>(
      'POST', '/automations/import/url', { url }),
  importConfirm: (tok: string) =>
    req<{ automation: import('./types').Automation; summary: import('./types').ImportSummary }>(
      'POST', '/automations/import/confirm', { token: tok }),
  // Raw result-dir file (§4.5) — Response, not JSON: callers .text() or .blob() it.
  resultFile: async (executionId: string, name: string): Promise<Response> => {
    const r = await fetch(`${base}/executions/${executionId}/result/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) throw new Error(r.statusText)
    return r
  },
}

export function openWs(onEvent: (msg: WsEvent) => void): () => void {
  let sock: WebSocket | null = null
  let closed = false
  const connect = () => {
    if (closed) return
    sock = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`)
    sock.onmessage = (e) => onEvent(JSON.parse(e.data))
    sock.onclose = () => {
      if (closed) return
      // A backend restart binds a NEW port and token — re-read backend.json
      // before each reconnect attempt or the loop retries a dead address forever.
      setTimeout(() => { void connectInfo().finally(connect) }, 1500)
    }
    sock.onopen = () => onEvent({ event: 'ws.open' })
  }
  connect()
  return () => { closed = true; sock?.close() }
}
