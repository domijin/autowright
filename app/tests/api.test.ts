// Tests for src/api.ts request plumbing. `req` is module-private, so it is
// exercised through the thin api.* wrappers (api.state, api.executeNow) with
// global fetch stubbed. Discovery reads window.autowright.backendInfo() —
// stubbed before connectInfo() is called, which fills the module-level
// base/token used by every request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, connectInfo } from '../src/api'

const setBackendInfo = (info: { port: number; token: string } | null) => {
  ;(window as unknown as Record<string, unknown>).autowright = {
    backendInfo: async () => info,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('connectInfo', () => {
  it('returns false when the preload has no backend info', async () => {
    setBackendInfo(null)
    expect(await connectInfo()).toBe(false)
  })
  it('returns true and stores port + token', async () => {
    setBackendInfo({ port: 4242, token: 'tok' })
    expect(await connectInfo()).toBe(true)
  })
})

describe('req (via api.state / api.executeNow)', () => {
  beforeEach(async () => {
    setBackendInfo({ port: 4242, token: 'tok' })
    await connectInfo()
  })

  it('ok path: GET hits base+path with the bearer token and returns the JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '1.0' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const s = await api.state()
    expect(s).toEqual({ version: '1.0' })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/state', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
      body: undefined,
    })
  })

  it('a body adds Content-Type and JSON-serializes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ executionId: 'e1' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.executeNow('a1')
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/automations/a1/execute', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: undefined, trigger: 'manual' }),
    })
  })

  it('error with a JSON {detail} body → Error message is the detail, .status attached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => ({ detail: 'automation not found' }),
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toBe('automation not found')
    expect(err!.status).toBe(404)
  })

  it('error with a non-JSON body falls back to statusText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json') },
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err!.message).toBe('Internal Server Error')
    expect(err!.status).toBe(500)
  })

  it('error with JSON but empty detail also falls back to statusText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, statusText: 'Conflict',
      json: async () => ({}),
    }) as unknown as Response))
    const err = await api.state().then(() => null, (e: Error & { status?: number }) => e)
    expect(err!.message).toBe('Conflict')
    expect(err!.status).toBe(409)
  })
})

// ---- §10/§12/§19 request shapes: harness install, sign-in, Ollama, drafting ----
// Every wrapper is asserted down to the exact URL, method, and JSON body the
// backend contract (§19) expects.
describe('agent/harness/ollama/draft request shapes', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    setBackendInfo({ port: 4242, token: 'tok' })
    await connectInfo()
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
  })
  const call = () => fetchMock.mock.calls[0] as unknown as [string, RequestInit]

  it('detectAgents GETs /agents/detect', async () => {
    await api.detectAgents()
    expect(call()[0]).toBe('http://127.0.0.1:4242/agents/detect')
    expect(call()[1].method).toBe('GET')
  })

  it('installHarness POSTs the provider id', async () => {
    await api.installHarness('opencode')
    expect(call()[0]).toBe('http://127.0.0.1:4242/agents/install')
    expect(call()[1].body).toBe(JSON.stringify({ id: 'opencode' }))
  })

  it('installStatus GETs the per-provider snapshot (remount reattach)', async () => {
    await api.installStatus('claude')
    expect(call()[0]).toBe('http://127.0.0.1:4242/agents/install/claude')
    expect(call()[1].method).toBe('GET')
  })

  it('loginHarness POSTs the id; signinStatus polls GET', async () => {
    await api.loginHarness('codex')
    expect(call()[0]).toBe('http://127.0.0.1:4242/agents/login')
    expect(call()[1].body).toBe(JSON.stringify({ id: 'codex' }))
    await api.signinStatus('codex')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4242/agents/signin/codex')
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('GET')
  })

  it('checkHarness POSTs harness + mode + model (§10 found-card auto-check)', async () => {
    await api.checkHarness('OpenCode', 'qwen3:8b', 'ollama')
    expect(call()[0]).toBe('http://127.0.0.1:4242/agents/check-harness')
    expect(call()[1].body).toBe(JSON.stringify({ harness: 'OpenCode', mode: 'ollama', model: 'qwen3:8b' }))
  })

  it('checkHarness defaults mode to `default`', async () => {
    await api.checkHarness('Claude Code', null)
    expect(call()[1].body).toBe(JSON.stringify({ harness: 'Claude Code', mode: 'default', model: null }))
  })

  it('ollamaStatus GETs /ollama/status; ollamaPull POSTs the model', async () => {
    await api.ollamaStatus()
    expect(call()[0]).toBe('http://127.0.0.1:4242/ollama/status')
    await api.ollamaPull('qwen3:8b')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4242/ollama/pull')
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(JSON.stringify({ model: 'qwen3:8b' }))
  })

  it('postDraftJob passes grant arrays through verbatim — empty stays empty', async () => {
    // §19: an explicit [] means "unchecked" and must reach the backend as [],
    // never dropped from the JSON (absent would fall back to all-on defaults).
    await api.postDraftJob({
      mode: 'sync', automationId: 'a1', agentId: 'g1',
      enabledAgents: [], allowedSecrets: [],
    })
    expect(call()[0]).toBe('http://127.0.0.1:4242/drafts')
    expect(call()[1].body).toBe(JSON.stringify({
      mode: 'sync', automationId: 'a1', agentId: 'g1',
      enabledAgents: [], allowedSecrets: [],
    }))
  })

  it('getDraftJob / cancelDraftJob address the job id', async () => {
    await api.getDraftJob('j1')
    expect(call()[0]).toBe('http://127.0.0.1:4242/drafts/j1')
    await api.cancelDraftJob('j1')
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:4242/drafts/j1')
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE')
  })

  it('putSecret sends description only when given (§4.8: absent description edits nothing)', async () => {
    await api.putSecret('MY_TOKEN', 'v')
    expect(call()[1].body).toBe(JSON.stringify({ value: 'v' }))
    await api.putSecret('MY_TOKEN', 'v', 'what it is for')
    expect((fetchMock.mock.calls[1][1] as RequestInit).body)
      .toBe(JSON.stringify({ value: 'v', description: 'what it is for' }))
  })
})
