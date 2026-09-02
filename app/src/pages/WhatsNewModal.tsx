// §9.4 What's-new modal: the shell-mounted doc modal rendering
// docs/CHANGELOG.md — opened by the About page's What's-new row and by the
// post-update auto-open at store boot. Same anatomy as the About page's LEGAL
// doc modal: dynamic ?raw import, first-H1 strip, Retry on a failed load.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { DocModal } from '../ui'
import { Markdown } from '../result'

// Canonical copy in docs/; strip its H1 — the modal title already says it.
const load = () => import('../../../docs/CHANGELOG.md?raw').then((m) => m.default.replace(/^# .*\n/, ''))

export default function WhatsNewModal() {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState(false)

  const loadDoc = () => {
    setErr(false)
    load().then(setText).catch(() => setErr(true))
  }
  useEffect(loadDoc, [])

  return (
    <DocModal
      title={<>What&rsquo;s new</>}
      text={text}
      error={err}
      onRetry={loadDoc}
      onClose={() => useStore.setState({ whatsNewOpen: false })}
      render={(t) => <Markdown text={t} />}
    />
  )
}
