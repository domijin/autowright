// §15 e2e harness: one real backend subprocess (isolated tmp AUTOWRIGHT_HOME,
// fake `claude` CLI on PATH) plus one real Electron app per test. Mirrors
// tests/integration/it_harness.py on the Node side.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, '..')
const REPO = path.resolve(HERE, '..', '..')
const ARTIFACTS = path.join(HERE, 'artifacts')

const PYTHON = path.join(REPO, '.venv', 'bin', 'python')
const FAKE_BIN = path.join(REPO, 'tests', 'bin')

// ---------- generic polling (no fixed sleeps) ----------

export async function waitFor<T>(
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) { lastErr = e }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${String(lastErr)})` : ''}`)
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false) })
    sock.on('error', () => resolve(false))
  })
}

// ---------- backend ----------

export class Backend {
  home = ''
  port = 0
  token = ''
  private proc: ChildProcess | null = null
  private out = ''

  /** Fresh tmp home + real `python -m autowright.main`, ready to answer. */
  async start(): Promise<this> {
    this.home = await mkdtemp(path.join(os.tmpdir(), 'aw-e2e-'))
    return this.spawnAndWait()
  }

  /** §3 restart: SIGKILL the process, then boot a NEW backend on the SAME
   * home — it binds a new port/token and rewrites backend.json. */
  async restart(): Promise<this> {
    if (this.proc && this.proc.exitCode === null) {
      const gone = new Promise<void>((r) => this.proc!.once('exit', () => r()))
      this.proc.kill('SIGKILL')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
    }
    await rm(path.join(this.home, 'backend.json'), { force: true })
    return this.spawnAndWait()
  }

  private async spawnAndWait(): Promise<this> {
    this.out = ''
    this.proc = spawn(PYTHON, ['-m', 'autowright.main'], {
      env: {
        ...process.env,
        AUTOWRIGHT_HOME: this.home,
        PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc.stdout?.on('data', (d: Buffer) => { this.out += d.toString() })
    this.proc.stderr?.on('data', (d: Buffer) => { this.out += d.toString() })

    const info = await waitFor(async () => {
      const raw = await readFile(path.join(this.home, 'backend.json'), 'utf-8').catch(() => null)
      if (!raw) return null
      const j = JSON.parse(raw) as { port: number; token: string; pid: number }
      return (await tcpOpen(j.port)) ? j : null
    }, 20_000, `backend.json + open port (output so far:\n${this.out.slice(-2000)})`)
    this.port = info.port
    this.token = info.token
    return this
  }

  async api(method: string, route: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${await res.text()}`)
    return res.json()
  }

  /** Seed one automation over the real HTTP API (it_harness.make_draft shape).
   * `steps` overrides the default two-step draft; `opts` adds params, the
   * allowed-secrets grant list, or a drafting agent. */
  async createAutomation(
    name: string,
    steps?: Array<{ file: string; name: string; description: string; code: string }>,
    opts?: { params?: unknown[]; allowedSecrets?: string[]; agentId?: string },
  ): Promise<{ id: string }> {
    const draft = {
      description: 'Runs end to end through the real stack.',
      note: 'Created',
      params: opts?.params ?? [],
      steps: steps ?? [
        {
          file: '01-say.py', name: 'Say', description: 'prints',
          code: 'from autowright import log\nlog("e2e says hi")\n',
        },
        {
          file: '02-finish.py', name: 'Finish', description: 'result',
          code: 'from autowright import result\nresult.status("ok")\nresult.chip("All good")\n',
        },
      ],
      spec: [{ kind: 'h1', text: name }, { kind: 'p', text: 'It runs end to end.' }],
      instructions: null,
    }
    return await this.api('POST', '/automations', {
      draft, name,
      ...(opts?.allowedSecrets ? { allowedSecrets: opts.allowedSecrets } : {}),
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    }) as { id: string }
  }

  /** §4.8 placeholder secret — blank value, so NOTHING touches the Keychain. */
  async putSecretPlaceholder(name: string, description: string): Promise<void> {
    await this.api('PUT', `/secrets/${name}`, { value: '', description })
  }

  /** Fire an execution and return its id without waiting. */
  async execute(automationId: string): Promise<string> {
    const { executionId } = await this.api('POST', `/automations/${automationId}/execute`, {}) as { executionId: string }
    return executionId
  }

  /** Execute over HTTP and poll until the execution settles; returns the record. */
  async executeAndWait(automationId: string, timeoutMs = 60_000): Promise<{ id: string; status: string }> {
    const { executionId } = await this.api('POST', `/automations/${automationId}/execute`, {}) as { executionId: string }
    return waitFor(async () => {
      const e = await this.api('GET', `/executions/${executionId}`) as { id: string; status: string }
      return e.status !== 'queued' && e.status !== 'executing' ? e : null
    }, timeoutMs, `execution ${executionId} to settle`)
  }

  /** Seed one config-only agent (fake `claude` on the backend's PATH answers
   * detection and readiness — no install, no login). */
  async createAgent(name: string): Promise<{ id: string }> {
    return await this.api('POST', '/agents', {
      name, harness: 'Claude Code', mode: 'default', model: null, description: '',
    }) as { id: string }
  }

  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      const gone = new Promise<void>((r) => this.proc!.once('exit', () => r()))
      this.proc.kill('SIGKILL')
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
    }
    this.proc = null
    if (this.home) await rm(this.home, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------- electron ----------

export interface AppHandle {
  app: ElectronApplication
  page: Page
}

/** Launch the built app against `home`'s backend.json and pin the renderer's
 * `ad-onboarded` flag. The profile lives inside the tmp home (§15), so a fresh
 * home starts clean — pinning just keeps each test's precondition explicit. */
export async function launchApp(home: string, onboarded: boolean): Promise<AppHandle> {
  const require = createRequire(import.meta.url)
  const app = await _electron.launch({
    // The throttling switches keep renderer timers full-speed even when the
    // window is occluded (screen lock/overlap) — long suite runs otherwise
    // crawl through the onboarding self-check's setTimeout chain.
    args: [
      '.',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    cwd: APP_DIR,
    executablePath: require('electron') as unknown as string,
    env: { ...process.env, AUTOWRIGHT_HOME: home } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((flag: boolean) => {
    localStorage.clear()
    if (flag) localStorage.setItem('ad-onboarded', '1')
  }, onboarded)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export async function closeApp(h: AppHandle | null): Promise<void> {
  if (!h) return
  try {
    await Promise.race([h.app.close(), new Promise((r) => setTimeout(r, 5000))])
  } finally {
    try { h.app.process().kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Click a §9 nav-rail row, then park the mouse over the content area and wait
 * for the hover-expanded rail to collapse — otherwise the 212px overlay keeps
 * covering later click targets near the left edge. */
export async function clickNav(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).click()
  await page.mouse.move(640, 300)
  await waitFor(async () => {
    const w = await page.locator('.ad-rail').evaluate((el) => el.getBoundingClientRect().width)
    return w < 60
  }, 5_000, 'nav rail to collapse')
}

export async function shot(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: path.join(ARTIFACTS, name) }).catch(() => {})
}
