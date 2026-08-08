// New/Edit agent form (§12): harness radio cards with install gating, mode/model
// choice, Ollama model pulls.
// One form for both — title and submit switch to "Edit agent" / "Save changes" when editing.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Agent } from '../types'
import { BackLink, BtnPrimary, Eyebrow, GreenCheck, LoadingRow, MiniBadge, P, ProgressBar, RadioRing } from '../ui'

type HarnessId = 'claude' | 'gemini' | 'codex' | 'opencode'


const HARNESSES: { id: HarnessId; name: string; desc: string }[] = [
  { id: 'claude', name: 'Claude Code', desc: 'Uses your Claude account. The most capable option — nothing extra to pay.' },
  { id: 'gemini', name: 'Gemini CLI', desc: 'Uses your Google account. Generous free tier.' },
  { id: 'codex', name: 'Codex', desc: 'Uses your ChatGPT account.' },
  { id: 'opencode', name: 'OpenCode', desc: 'Open-source — works with any provider you’ve already set up, or a local model.' },
]

const HARNESS_NAME: Record<HarnessId, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex', opencode: 'OpenCode',
}

const DEFAULT_NOTE: Record<HarnessId, string> = {
  claude: 'Whatever Claude Code is already configured with',
  gemini: 'Whatever Gemini CLI is already configured with',
  codex: 'Whatever Codex is already configured with',
  opencode: 'Whatever OpenCode is already configured with',
}

// §4.7 custom mode: free-text model string, passed verbatim as `--model`
const CUSTOM_PLACEHOLDER: Record<HarnessId, string> = {
  claude: 'e.g. claude-opus-4-8',
  gemini: 'e.g. gemini-2.5-pro',
  codex: 'e.g. gpt-5-codex',
  opencode: 'e.g. anthropic/claude-opus-4-8',
}

const SUGGESTED = [
  { id: 'qwen3-coder:30b', note: 'Best local coding model', meta: '19 GB' },
  { id: 'gemma4:e4b', note: 'Good local default', meta: '9.6 GB' },
  { id: 'deepseek-coder:6.7b', note: 'Light and quick', meta: '3.8 GB' },
]

/** Amber notice card (§12): pulsless dot + body + amber action button — used for
 * the signed-out reconnect banner and the missing-Ollama install prompt. */
function AmberNotice({ body, btn, onBtn, style }: {
  body: string; btn: string; onBtn: () => void; style?: React.CSSProperties
}) {
  return (
    <div className="ad-anim-item" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--notice-amber-bg)', border: '1px solid var(--notice-amber-border)',
      borderRadius: 10, padding: '11px 14px', ...style,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: P.amber, flex: 'none' }} />
      <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>{body}</span>
      <button className="ad-btn-amber" onClick={onBtn} style={{ flex: 'none' }}>
        {btn}
      </button>
    </div>
  )
}

const HARNESS_ID: Record<string, HarnessId> = {
  'Claude Code': 'claude', 'Gemini CLI': 'gemini', 'Codex': 'codex', 'OpenCode': 'opencode',
}

export default function AgentNewPage() {
  const { go, showToast, ollamaPull, runAgentCheck, agents, agentEditId, agentChecks } = useStore()
  // Edit mode is addressed by nav state (§12): agentEditId names the agent, so
  // back/forward re-enters the same edit form. Form fields initialize once on
  // mount — the page remounts on every navigation, so that's a fresh snapshot.
  const [editAgent] = useState<Agent | null>(
    () => (agentEditId ? agents.find((a) => a.id === agentEditId) ?? null : null))
  // Editing an agent that no longer exists (deleted, or a stale history entry
  // restored before boot loaded the list) — bail out to the Agents page.
  const missingEdit = !!agentEditId && !editAgent
  useEffect(() => { if (missingEdit) go('agents') }, [missingEdit, go])
  const editHid = editAgent ? (HARNESS_ID[editAgent.harness] ?? 'claude') : null
  const [harness, setHarness] = useState<HarnessId | null>(editHid)
  const [mode, setMode] = useState<'default' | 'ollama' | 'custom' | null>(
    editAgent ? editAgent.mode : null)
  const [model, setModel] = useState<string | null>(editAgent?.model ?? null)
  const [name, setName] = useState(editAgent ? (editAgent.name || editAgent.harness) : '')
  const [desc, setDesc] = useState(editAgent?.desc ?? '')
  const [nameErr, setNameErr] = useState(false)
  const [fix, setFix] = useState<'needs' | 'busy' | 'done'>(
    () => (editAgent && agentChecks[editAgent.id] === 'needs' ? 'needs' : 'done'))
  const [st, setSt] = useState<{ ready: boolean; models: string[] } | null>(null)
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullText, setPullText] = useState('')
  const [inst, setInst] = useState<'idle' | 'installing' | 'failed'>('idle')
  const [instPct, setInstPct] = useState<number | null>(null)
  const [instErr, setInstErr] = useState<string | null>(null)
  // §12 install gating: real per-harness install state (§19 GET /agents/detect)
  // and the picked harness's download-and-set-up machine.
  const [det, setDet] = useState<Record<string, { installed: boolean; signedIn: boolean | null }> | null>(null)
  const [hInst, setHInst] = useState<'idle' | 'installing' | 'signin' | 'failed'>('idle')
  const [hPct, setHPct] = useState<number | null>(null)
  const [hErr, setHErr] = useState<string | null>(null)
  const [hMethod, setHMethod] = useState<'browser' | 'terminal'>('terminal')
  const harnessInstall = useStore((s) => s.harnessInstall)
  const pullingRef = useRef<string | null>(null)
  pullingRef.current = pulling

  // Inline Ollama install (§12) — the real §19 backend install; progress
  // arrives on the `harness.install` WS stream.
  const installOllama = () => {
    setInst('installing')
    setInstPct(null)
    setInstErr(null)
    // A previous attempt's terminal harness.install event may still sit in the
    // store — clear it or the effect below would instantly fail this retry.
    useStore.setState((s) => ({ harnessInstall: Object.fromEntries(Object.entries(s.harnessInstall).filter(([k]) => k !== 'ollama')) }))
    api.installHarness('ollama').catch((e: Error & { status?: number }) => {
      // 409 = an install is already running — its stream still lands here.
      if (e.status !== 409) { setInst('failed'); setInstErr(e.message) }
    })
  }
  useEffect(() => {
    const evt = harnessInstall.ollama
    if (!evt || inst !== 'installing') return
    if (!evt.done) {
      if (evt.pct !== undefined) setInstPct(evt.pct)
    } else if (evt.ok) {
      setInst('idle')
      // Done — re-poll status so the Ollama-gated options ungate.
      void api.ollamaStatus().then(setSt).catch(() => setSt(null))
    } else {
      setInst('failed')
      setInstErr(evt.error ?? 'install failed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessInstall])

  useEffect(() => {
    api.ollamaStatus().then(setSt).catch(() => setSt({ ready: false, models: [] }))
  }, [])

  // §12 install gating: load real install state once; a failed detect gates nothing.
  const refreshDet = () =>
    api.detectAgents()
      .then((l) => setDet(Object.fromEntries(l.map((p) => [p.id, { installed: p.installed, signedIn: p.signedIn }]))))
      .catch(() => { /* gate nothing */ })
  useEffect(() => { void refreshDet() }, [])

  const hInstalled = !harness || !det || (det[harness]?.installed ?? true)

  const setupDone = (h: HarnessId) => {
    setHInst('idle')
    void refreshDet()
    showToast(`${HARNESS_NAME[h]} is set up — ready to save.`)
  }
  const startHarnessSignin = (h: HarnessId) => {
    void api.loginHarness(h)
      .then((r) => { setHMethod(r.method); setHInst('signin') })
      .catch((e: Error & { status?: number }) => {
        // 409 = already signed in (or no account needed) — setup is done.
        if (e.status === 409) setupDone(h)
        else { setHInst('idle'); void refreshDet(); showToast(e.message) }
      })
  }
  const installPicked = () => {
    const h = harness
    if (!h) return
    setHInst('installing')
    setHPct(null)
    setHErr(null)
    // A previous attempt's terminal harness.install event may still sit in the
    // store — clear it or the effect below would instantly fail this retry.
    useStore.setState((s) => ({ harnessInstall: Object.fromEntries(Object.entries(s.harnessInstall).filter(([k]) => k !== h)) }))
    api.installHarness(h).catch((e: Error & { status?: number }) => {
      // 409 = an install is already running — its stream still lands here.
      if (e.status !== 409) { setHInst('failed'); setHErr(e.message) }
    })
  }
  useEffect(() => {
    if (!harness || hInst !== 'installing') return
    const evt = harnessInstall[harness]
    if (!evt) return
    if (!evt.done) {
      if (evt.pct !== undefined) setHPct(evt.pct)
    } else if (evt.ok) {
      // Installed — sign-in help only when it's needed (§12).
      const h = harness
      void api.signinStatus(h)
        .then((s) => { if (s.signedIn === false) startHarnessSignin(h); else setupDone(h) })
        .catch(() => setupDone(h))
    } else {
      setHInst('failed')
      setHErr(evt.error ?? 'install failed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessInstall])

  // Sign-in poll (§12): every 2 s until the harness's sign-in rule flips.
  useEffect(() => {
    if (hInst !== 'signin' || !harness) return
    const h = harness
    const id = setInterval(() => {
      void api.signinStatus(h).then((s) => {
        if (s.signedIn === true) setupDone(h)
      }).catch(() => { /* backend hiccup — keep polling */ })
    }, 2000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hInst, harness])

  // A picked uninstalled harness whose install is already running (started
  // elsewhere, or before a remount) — reattach to the stream (§19).
  useEffect(() => {
    if (!harness || !det || det[harness]?.installed !== false) return
    void api.installStatus(harness).then((s) => {
      if (s.state === 'running') { setHInst('installing'); setHPct(s.pct ?? null) }
    }).catch(() => { /* no install to reattach */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, det])

  // Success confirmation: poll status every 2s while a pull is in progress —
  // the model appearing in the installed list is the source of truth.
  useEffect(() => {
    if (!pulling) return
    const id = setInterval(() => {
      api.ollamaStatus().then((s) => {
        setSt(s)
        const nm = pullingRef.current
        if (nm && s.models.includes(nm)) {
          setPulling(null)
          setModel(nm)
          showToast(`${nm} installed — selected for this agent.`)
        }
      }).catch(() => { /* backend hiccup — keep polling */ })
    }, 2000)
    return () => clearInterval(id)
  }, [pulling, showToast])

  // Failure: the backend's terminal `ollama.pull` event carries ok=false —
  // without this the "Downloading…" card and the poll would spin forever.
  useEffect(() => {
    if (!pulling || !ollamaPull?.done || ollamaPull.model !== pulling) return
    if (ollamaPull.ok === false) {
      setPulling(null)
      showToast(`Download failed — ${ollamaPull.line || `couldn't pull ${pulling}`}`)
    }
  }, [ollamaPull, pulling, showToast])

  const ready = st?.ready ?? false
  const models = st?.models ?? []
  const needsOllama = mode === 'ollama'
  const canAdd = !!harness && !!mode
    && hInstalled
    && (!needsOllama || ready)
    && (mode === 'default' || !!model?.trim())
    && !!name.trim()

  const startPull = (raw: string) => {
    const nm = raw.trim()
    if (!nm) { showToast('Type a model name, like qwen3-coder:30b.'); return }
    if (pulling) { showToast(`One download at a time — ${pulling} is still downloading.`); return }
    if (models.includes(nm)) { showToast(`${nm} is already installed.`); return }
    // A previous attempt's terminal ollama.pull event may still sit in the
    // store — clear it or the failure effect would instantly kill this retry.
    useStore.setState({ ollamaPull: null })
    setPulling(nm)
    setPullText('')
    api.ollamaPull(nm).catch((e: Error) => { setPulling(null); showToast(e.message) })
  }

  // §12 reconnect flow, started from the form banner when editing a signed-out
  // agent. Runs through the store check so the cached Agents-page badge updates too.
  const reconnect = () => {
    if (!editAgent) return
    setFix('busy')
    const t0 = Date.now()
    void runAgentCheck(editAgent.id, 'connecting').then((st) => {
      const ok = st === 'ready'
      window.setTimeout(() => {
        setFix(ok ? 'done' : 'needs')
        showToast(ok
          ? 'Connected — signed in as you.'
          : 'Still signed out — finish signing in, then try again.', 2600)
      }, Math.max(0, 1700 - (Date.now() - t0)))
    })
  }

  const addAgent = async () => {
    if (!canAdd) {
      const needsName = harness && mode && !name.trim()
      const missingOllama = needsOllama && !ready
      if (needsName) setNameErr(true)
      if (harness && !hInstalled) showToast(`Download and set up ${HARNESS_NAME[harness]} first.`)
      else if (missingOllama) showToast('Install Ollama first.')
      else if (!needsName) showToast('Pick a harness and a model first.')
      return
    }
    const h = harness as HarnessId
    const payload = {
      harness: HARNESS_NAME[h],
      mode,
      model: mode === 'default' ? null : (model?.trim() ?? null),
      name: name.trim(),
      desc: desc.trim(),
    }
    try {
      if (editAgent) {
        await api.patchAgent(editAgent.id, payload)
        // Saved config may change readiness — refresh the cached badge (§12).
        void runAgentCheck(editAgent.id, 'connecting')
        go('agents')
        showToast(`Changes saved — ${payload.name} is ready.`)
      } else {
        await api.addAgent(payload)
        go('agents')
        showToast(`${payload.name} added — ready to write automations.`)
      }
    } catch (e) { showToast((e as Error).message) }
  }

  const olMissingMsg = 'Local models need Ollama, which isn’t installed on this Mac yet.'

  const sugRows = SUGGESTED.filter((sg) => !models.includes(sg.id) && pulling !== sg.id)

  // Pull progress from the backend's `ollama.pull` WS lines — render a real %
  // bar when the line carries one ("… 45% …"), slide otherwise.
  const pullLine = pulling && ollamaPull && ollamaPull.model === pulling ? ollamaPull.line : ''
  const pullPct = (() => {
    const m = pullLine.match(/(\d{1,3})%/)
    return m ? Math.min(100, parseInt(m[1], 10)) : null
  })()

  if (missingEdit) return null // redirecting to Agents (effect above)

  return (
    <div className="ad-anim-page" style={{ maxWidth: 720, margin: '0 auto', padding: '20px 30px 70px' }}>
      <BackLink label="Agents" onClick={() => go('agents')} style={{ marginBottom: 10 }} />
      <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: '0 0 6px' }}>
        {editAgent ? 'Edit agent' : 'Add an agent'}
      </h1>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 22px' }}>
        Pick the harness that writes your automations, then choose which model it uses. The agent never executes anything — Autowright does.
      </p>

      {fix === 'needs' && (
        <AmberNotice
          body="This agent is signed out — reconnect it to create or edit automations."
          btn="Reconnect"
          onBtn={reconnect}
          style={{ marginBottom: 22 }}
        />
      )}
      {fix === 'busy' && (
        <LoadingRow label="Reconnecting…" style={{ marginBottom: 22 }} />
      )}

      <Eyebrow style={{ margin: '0 0 10px' }}>NAME</Eyebrow>
      <input
        className={`ad-input${nameErr ? ' invalid' : ''}`}
        value={name}
        onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameErr(false) }}
        placeholder="Name this agent"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '11px 14px', fontWeight: 500, fontSize: 13,
          color: 'var(--text)', marginBottom: 16,
        }}
      />
      {nameErr && (
        <div className="ad-anim-item" style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '-10px 0 16px' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: P.red, flex: 'none' }} />
          <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--red-text)' }}>
            A name is required — give this agent a name before saving.
          </span>
        </div>
      )}

      <Eyebrow style={{ margin: '0 0 10px' }}>DESCRIPTION <span style={{ color: 'var(--text-faint)' }}>· OPTIONAL</span></Eyebrow>
      <textarea
        className="ad-input"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="What this agent is for — shown on the Agents page and given to the drafting agent"
        rows={2}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '11px 14px',
          fontWeight: 400, fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
          resize: 'vertical', marginBottom: 22,
        }}
      />

      <Eyebrow style={{ margin: '0 0 10px' }}>HARNESS</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {HARNESSES.map((h) => {
          const on = harness === h.id
          return (
            <button
              key={h.id}
              className="ad-btn-bare ad-card-click"
              onClick={() => {
                if (harness !== h.id) { setHInst('idle'); setHPct(null); setHErr(null) }
                setHarness(h.id); setMode('default'); setModel(null)
              }}
              style={{
                // Selected chrome overrides .ad-card-click's base + hover.
                ...(on ? { background: 'var(--bg-card-sel)', borderColor: 'var(--accent-sel)' } : {}),
                borderRadius: 12, padding: '16px 18px',
                display: 'flex', flexDirection: 'column', gap: 7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <RadioRing selected={on} />
                <span style={{ fontWeight: 600, fontSize: 15 }}>{h.name}</span>
                {det?.[h.id]?.installed === false && (
                  <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT INSTALLED</MiniBadge>
                )}
              </div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>{h.desc}</p>
            </button>
          )
        })}
      </div>

      {/* §12 install gating: an uninstalled picked harness hides the model
          section and offers the real download-and-set-up flow instead. */}
      {harness && !hInstalled && (
        hInst === 'installing' ? (
          <div className="ad-anim-item" style={{
            background: 'var(--notice-amber-bg)', border: '1px solid var(--notice-amber-border)',
            borderRadius: 10, padding: '11px 14px', marginBottom: 16,
          }}>
            <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>
              Installing {HARNESS_NAME[harness]}…{' '}
              {hPct !== null && (
                <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>{Math.round(hPct)}%</span>
              )}
            </div>
            <ProgressBar pct={hPct} />
          </div>
        ) : hInst === 'signin' ? (
          <AmberNotice
            body={`Finish signing in — Autowright opened ${hMethod === 'browser' ? 'your browser' : 'Terminal'}. Waiting for the sign-in…`}
            btn="Reopen"
            onBtn={() => startHarnessSignin(harness)}
            style={{ marginBottom: 16 }}
          />
        ) : (
          <AmberNotice
            body={hInst === 'failed'
              ? `Install failed — ${hErr ?? 'something went wrong'}`
              : `${HARNESS_NAME[harness]} isn’t installed on this Mac yet — Autowright can download and set it up for you.`}
            btn={hInst === 'failed' ? 'Try again' : 'Download & set up'}
            onBtn={installPicked}
            style={{ marginBottom: 16 }}
          />
        )
      )}

      {harness && hInstalled && (
        <>
          <Eyebrow style={{ margin: '0 0 10px' }}>MODEL</Eyebrow>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-card)',
            borderRadius: 12, overflow: 'hidden', marginBottom: 16,
          }}>
            {([
              { id: 'default' as const, name: 'Default model', note: DEFAULT_NOTE[harness] },
              // §4.7: a user-typed model string — valid with every harness
              { id: 'custom' as const, name: 'A specific model', note: 'Type the model this harness should use' },
              // §4.7: local models run only through OpenCode (Ollama behind it)
              ...(harness === 'opencode'
                ? [{ id: 'ollama' as const, name: 'A local model', note: 'Pick a model served on this Mac through Ollama — best for simple steps' }]
                : []),
            ]).map((md, i, arr) => {
              const on = mode === md.id
              return (
                <button
                  key={md.id}
                  className="ad-btn-bare ad-hover-row ad-focus-inset"
                  onClick={() => { setMode(md.id); setModel(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
                    borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--hairline-dim)',
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                  }}
                >
                  <RadioRing selected={on} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: on ? 'var(--text)' : 'var(--text-2)' }}>{md.name}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: 2 }}>{md.note}</div>
                  </div>
                </button>
              )
            })}
          </div>

          {mode === 'custom' && (
            <>
              <Eyebrow style={{ margin: '0 0 10px' }}>MODEL NAME</Eyebrow>
              <input
                className="ad-input"
                value={model ?? ''}
                onChange={(e) => setModel(e.target.value)}
                placeholder={CUSTOM_PLACEHOLDER[harness]}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '11px 14px',
                  font: `500 13px var(--mono)`, color: 'var(--text)', marginBottom: 16,
                }}
              />
            </>
          )}

          {needsOllama && st && !ready && (
            inst === 'installing' ? (
              <div className="ad-anim-item" style={{
                background: 'var(--notice-amber-bg)', border: '1px solid var(--notice-amber-border)',
                borderRadius: 10, padding: '11px 14px', marginBottom: 16,
              }}>
                <div style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>
                  Installing Ollama…{' '}
                  {instPct !== null && (
                    <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>{Math.round(instPct)}%</span>
                  )}
                </div>
                <ProgressBar pct={instPct} />
              </div>
            ) : (
              <AmberNotice
                body={inst === 'failed' ? `Install failed — ${instErr ?? 'something went wrong'}` : olMissingMsg}
                btn={inst === 'failed' ? 'Try again' : 'Install Ollama'}
                onBtn={() => installOllama()}
                style={{ marginBottom: 16 }}
              />
            )
          )}
          {needsOllama && ready && (
            <div style={{ marginBottom: 16 }}>
              <GreenCheck label="Ollama is installed and active." />
            </div>
          )}

          {mode === 'ollama' && ready && (
            <>
              <Eyebrow style={{ margin: '0 0 10px' }}>LOCAL MODEL</Eyebrow>
              {models.length > 0 ? (
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-card)',
                  borderRadius: 12, overflow: 'hidden', marginBottom: 14,
                }}>
                  {models.map((n, i) => {
                    const on = model === n
                    const sug = SUGGESTED.find((s) => s.id === n)
                    return (
                      <button
                        key={n}
                        className="ad-btn-bare ad-hover-row ad-focus-inset"
                        onClick={() => setModel(n)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 11, padding: '12px 16px',
                          borderBottom: i === models.length - 1 ? 'none' : '1px solid var(--hairline-dim)',
                          cursor: 'pointer',
                        }}
                      >
                        <RadioRing selected={on} />
                        <span style={{ flex: 1, font: `500 13px var(--mono)`, color: on ? 'var(--text)' : 'var(--text-2)', textAlign: 'left' }}>{n}</span>
                        <span style={{ font: `400 11px var(--mono)`, color: 'var(--text-faint)' }}>{sug?.meta ?? ''}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div style={{
                  background: 'var(--bg-card)', border: '1px dashed var(--border-dashed)', borderRadius: 10,
                  padding: '13px 16px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)',
                }}>
                  No local models installed yet — download one below and it will show up here.
                </div>
              )}

              <Eyebrow style={{ margin: '0 0 10px' }}>DOWNLOAD A MODEL</Eyebrow>
              {!pulling ? (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    className="ad-input"
                    value={pullText}
                    onChange={(e) => setPullText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') startPull(pullText) }}
                    placeholder="e.g. qwen3-coder:30b"
                    style={{
                      flex: 1, padding: '11px 14px', font: `500 13px var(--mono)`, color: 'var(--text)',
                    }}
                  />
                  <BtnPrimary onClick={() => startPull(pullText)} style={{ flex: 'none' }}>
                    Download
                  </BtnPrimary>
                </div>
              ) : (
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 10,
                  padding: '13px 16px', marginBottom: 12,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 12.5, color: 'var(--text-2)' }}>
                      Downloading <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{pulling}</span>…
                    </span>
                    {pullPct !== null && (
                      <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-muted)' }}>
                        {pullPct}%
                      </span>
                    )}
                  </div>
                  <ProgressBar pct={pullPct} />
                </div>
              )}

              {sugRows.length > 0 && (
                <>
                  <Eyebrow style={{ margin: '0 0 10px' }}>SUGGESTED</Eyebrow>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                    {sugRows.map((sg) => (
                      <button
                        key={sg.id}
                        title={sg.note}
                        className="ad-chip-btn"
                        onClick={() => setPullText(sg.id)}
                      >
                        <span style={{ font: `500 12px var(--mono)`, color: 'var(--text-2)' }}>{sg.id}</span>
                        <span style={{ font: `400 10.5px var(--mono)`, color: 'var(--text-faint)' }}>{sg.meta}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <a
                href="https://ollama.com/library"
                target="_blank"
                rel="noopener noreferrer"
                className="ad-chip-btn"
                style={{ textDecoration: 'none', marginBottom: 22 }}
              >
                Browse more models on Ollama <span style={{ fontWeight: 400, fontSize: 11 }}>↗</span>
              </a>
            </>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {/* §12: disabled-styled until valid but stays clickable — submitting
            early surfaces the inline name error / the missing-piece toast */}
        <button
          className={`ad-btn-primary${canAdd ? '' : ' looks-disabled'}`}
          onClick={() => { void addAgent() }}
        >
          {editAgent ? 'Save changes' : 'Add agent'}
        </button>
        <button
          className="ad-btn-text dim"
          onClick={() => go('agents')}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
