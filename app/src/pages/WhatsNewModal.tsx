// §9.4 What's-new modal: the shell-mounted doc modal rendering
// docs/CHANGELOG.md — opened by the About page's What's-new row and by the
// post-update auto-open at store boot. Same anatomy as the About page's LEGAL
// doc modal: dynamic ?raw import, first-H1 strip, Retry on a failed load.
import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { BtnGhost, Modal, ScrollArea } from '../ui'
import { Markdown } from '../result'

// Canonical copy in docs/; strip its H1 — the modal title already says it.
const load = () => import('../../../docs/CHANGELOG.md?raw').then((m) => m.default.replace(/^# .*\n/, ''))

const sub: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)' }

export default function WhatsNewModal() {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState(false)

  const loadDoc = () => {
    setErr(false)
    load().then(setText).catch(() => setErr(true))
  }
  useEffect(loadDoc, [])

  return (
    <Modal onClose={() => useStore.setState({ whatsNewOpen: false })} width={680} cardStyle={{ padding: '22px 24px' }}>
      {(close) => (
        <>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--text)' }}>
            What&rsquo;s new
          </h2>
          <ScrollArea wrapStyle={{ marginTop: 12 }} style={{ maxHeight: '62vh' }}>
            {text !== null
              ? <Markdown text={text} />
              : err
                ? (
                  <div>
                    <div style={{ fontSize: 12.5, color: 'var(--red-text)' }}>Couldn't load the document.</div>
                    <button className="ad-btn-ghost" onClick={loadDoc} style={{ marginTop: 10 }}>
                      Retry
                    </button>
                  </div>
                )
                : <div style={sub}>Loading…</div>}
          </ScrollArea>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
            <BtnGhost onClick={close}>Close</BtnGhost>
          </div>
        </>
      )}
    </Modal>
  )
}
