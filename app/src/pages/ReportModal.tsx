// Report bug modal (§9.5): opened by the §9 "Report bug" nav row — type
// toggle, "What happened?", include-app-info block, optional AI draft
// (§19 POST /report/draft), and a prefilled GitHub new-issue link. The app
// itself sends nothing anywhere: opening the browser is the only outbound
// action, and the user reviews the issue on GitHub before submitting.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { BtnGhost, Modal, RadioRing, Spinner, Toggle } from '../ui'
import { REPO_URL } from '../config'

// §9.5: GitHub prefill URLs cap around 8 KB — clamp the body before encoding.
const BODY_CAP = 6_000

const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', resize: 'vertical' }

export default function ReportModal() {
  const version = useStore((s) => s.version)
  const surface = useStore((s) => s.surface)
  const page = useStore((s) => s.page)
  const connected = useStore((s) => s.connected)
  const updateAvailable = useStore((s) => s.updateAvailable)
  const noAgent = useStore((s) => s.agents.length === 0)

  const [kind, setKind] = useState<'bug' | 'feature'>('bug')
  const [text, setText] = useState('')
  const [includeInfo, setIncludeInfo] = useState(true)
  const [os, setOs] = useState<{ platform: string; release: string; arch: string } | null>(null)
  const [backendState, setBackendState] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.autowright?.platformInfo?.().then(setOs)
    void window.autowright?.backendStatus().then((s) => setBackendState(s.state))
  }, [])

  // §9.5 info block — surface/page names only, never entity ids or content;
  // never the backend token, secrets, or raw logs.
  const infoBlock = [
    `Autowright v${version}`,
    os ? `macOS ${os.release} (${os.arch})` : 'macOS (version unknown)',
    `Location: ${surface} · ${page}`,
    `Backend: ${connected ? 'connected' : 'disconnected'}${backendState ? ` · ${backendState}` : ''}`,
    `Update available: ${updateAvailable ?? 'no'}`,
  ].join('\n')

  // Poll the draft job while it runs (§19 poll contract, like §11's useDraftJob).
  useEffect(() => {
    if (!jobId) return
    const id = window.setInterval(async () => {
      try {
        const j = await api.getReportDraft(jobId)
        if (j.status === 'running') return
        setJobId(null)
        if (j.status === 'done' && j.draft) setDraft(j.draft)
        else if (j.status === 'failed') setError(j.error || 'Drafting failed.')
      } catch (e) {
        setJobId(null)
        setError((e as Error).message)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [jobId])

  // §9.5: closing the modal cancels a live job.
  const jobRef = useRef<string | null>(null)
  jobRef.current = jobId
  useEffect(() => () => { if (jobRef.current) void api.cancelReportDraft(jobRef.current) }, [])

  const startDraft = () => {
    setError(null)
    setDraft(null)
    void api.postReportDraft({
      kind,
      text: text.trim() || undefined,
      info: includeInfo ? infoBlock : undefined,
    }).then((r) => setJobId(r.jobId)).catch((e: Error) => setError(e.message))
  }
  const cancelDraft = () => {
    const id = jobId
    setJobId(null)
    if (id) void api.cancelReportDraft(id)
  }

  // §9.5 open action: plain anchor — the §9.4 external-URL policy routes it to
  // the default browser. Without a draft the title is empty and the body is
  // assembled from the textarea + info block; a draft's editable fields win.
  const issueBody = draft ? draft.body : [
    '### What happened',
    text.trim() || '(describe it here)',
    ...(includeInfo ? ['', '### Environment', '```', infoBlock, '```'] : []),
  ].join('\n')
  const href = `${REPO_URL}/issues/new?` + new URLSearchParams({
    labels: kind === 'bug' ? 'bug' : 'enhancement',
    title: draft ? draft.title : '',
    body: issueBody.slice(0, BODY_CAP),
  }).toString()

  return (
    <Modal onClose={() => useStore.setState({ reportOpen: false })} width={520} ariaLabel="Report a problem">
      {(close) => (
        <div data-testid="report-modal" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Report a problem</h2>

          <div style={{ display: 'flex', gap: 18 }}>
            {([['bug', 'Bug'], ['feature', 'Feature request']] as const).map(([k, l]) => (
              <button key={k} className="ad-btn-bare" onClick={() => setKind(k)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, width: 'auto', fontSize: 13 }}>
                <RadioRing selected={kind === k} />
                {l}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>What happened?</span>
            <textarea
              className="ad-input" rows={4} style={input} value={text}
              placeholder="What did you expect, and what happened instead?"
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle on={includeInfo} onChange={setIncludeInfo} title="Include app info" />
              <span style={{ fontSize: 13 }}>Include app info</span>
            </div>
            {includeInfo && (
              <pre style={{
                margin: 0, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-code)',
                border: '1px solid var(--hairline-dim)', font: '11px var(--mono)',
                color: 'var(--text-muted)', whiteSpace: 'pre-wrap',
              }}>{infoBlock}</pre>
            )}
          </div>

          {draft ? (
            // §9.5: a finished draft renders as editable fields — edits ride into the URL.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={label}>Drafted title</span>
              <input className="ad-input" style={input} value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <span style={{ ...label, marginTop: 4 }}>Drafted body</span>
              <textarea className="ad-input" rows={8} style={input} value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="ad-btn-ghost"
                data-testid="report-draft"
                disabled={noAgent || jobId !== null}
                title={noAgent ? 'No agent yet — add one on the Agents page first.' : undefined}
                onClick={startDraft}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {jobId ? <>Drafting… <Spinner size={12} /></> : '✦ Draft with AI'}
              </button>
              {jobId && <BtnGhost onClick={cancelDraft}>Cancel</BtnGhost>}
            </div>
          )}
          {error && <div style={{ fontSize: 12.5, color: 'var(--red-text)' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 2 }}>
            <BtnGhost onClick={close}>Cancel</BtnGhost>
            <a
              data-testid="report-open"
              className="ad-btn-primary"
              style={{ textDecoration: 'none' }}
              href={href} target="_blank" rel="noopener noreferrer"
            >
              Open GitHub issue ↗
            </a>
          </div>
        </div>
      )}
    </Modal>
  )
}
