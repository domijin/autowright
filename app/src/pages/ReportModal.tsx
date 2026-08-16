// Report bug modal (§9.5): opened by the §9 "Report bug" nav row — type
// toggle, "What happened?", include-app-info block, and a prefilled GitHub
// new-issue link. The app itself sends nothing anywhere: opening the browser
// is the only outbound action, and the user reviews the issue on GitHub
// before submitting.
import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { BtnGhost, Modal, RadioRing, Toggle } from '../ui'
import { REPO_URL } from '../config'

// §9.5: GitHub prefill URLs cap around 8 KB — clamp the body before encoding.
const BODY_CAP = 6_000

const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }

export default function ReportModal() {
  const version = useStore((s) => s.version)

  const [kind, setKind] = useState<'bug' | 'feature'>('bug')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [includeInfo, setIncludeInfo] = useState(true)
  const [os, setOs] = useState<{ platform: string; release: string; arch: string } | null>(null)

  useEffect(() => {
    void window.autowright?.platformInfo?.().then(setOs)
  }, [])

  // §9.5 environment block — exactly two lines: app version + OS. Never the
  // backend token, secrets, or raw logs.
  const infoBlock = [
    `Autowright v${version}`,
    os ? `macOS ${os.release} (${os.arch})` : 'macOS (version unknown)',
  ].join('\n')

  // §9.5 open action: plain anchor — the §9.4 external-URL policy routes it to
  // the default browser.
  const issueBody = [
    '### What happened',
    text.trim() || '(describe it here)',
    ...(includeInfo ? ['', '### Environment', '```', infoBlock, '```'] : []),
  ].join('\n')
  const href = `${REPO_URL}/issues/new?` + new URLSearchParams({
    labels: kind === 'bug' ? 'bug' : 'enhancement',
    title: title.trim(),
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
            <span style={label}>Title</span>
            {/* §9.5: standard text-field dimensions — the §12 agent-form values */}
            <input
              className="ad-input" value={title}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '11px 14px',
                fontWeight: 400, fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
              }}
              placeholder="One-line summary"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>What happened?</span>
            <textarea
              className="ad-input" rows={4} value={text}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '11px 14px',
                fontWeight: 400, fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
                resize: 'vertical',
              }}
              placeholder="What did you expect, and what happened instead?"
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Toggle on={includeInfo} onChange={setIncludeInfo} title="Include environment info" />
              <span style={{ fontSize: 13 }}>Include environment info</span>
            </div>
            {includeInfo && (
              <pre style={{
                margin: 0, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-code)',
                border: '1px solid var(--hairline-dim)', font: '11px var(--mono)',
                color: 'var(--text-muted)', whiteSpace: 'pre-wrap',
              }}>{infoBlock}</pre>
            )}
          </div>

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
