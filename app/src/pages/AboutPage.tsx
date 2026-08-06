// About page (§9.4): APP / UPDATES / LEGAL sections — version, GitHub links,
// update check, privacy policy, open-source libraries, disclaimer. New
// about-ish content lands here, never on Settings.
import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { BtnGhost, Eyebrow, Modal, PageTitle, ProgressBar, ScrollArea } from '../ui'
import { Markdown } from '../result'

const REPO_URL = 'https://github.com/hansololz/autowright'

// Card chrome comes from the shared .ad-card class; only overflow is local.
const card: React.CSSProperties = { overflow: 'hidden' }

const rowTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }
const rowSub: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)', marginTop: 3 }
const row: React.CSSProperties = {
  padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20,
}
const rowDivided: React.CSSProperties = { ...row, borderBottom: '1px solid var(--hairline-dim)' }
const linkBtn: React.CSSProperties = { flex: 'none', textDecoration: 'none' }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Eyebrow style={{ paddingLeft: 2 }}>{title}</Eyebrow>
      <div className="ad-card" style={card}>{children}</div>
    </div>
  )
}

// §9.4 update flow, driven entirely by the main process over the §3 IPC
// handlers (check → download → restart-install); the renderer never talks to
// GitHub or the feed itself.
type UpdateCheck =
  | { state: 'idle' | 'checking' | 'current' | 'error' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; pct: number | null }
  | { state: 'downloaded'; version: string; busy?: boolean }
  | { state: 'failed'; error: string }

// One doc modal for both document rows (§9.4). Dynamic `?raw` imports keep the
// documents out of the main bundle; each loads once, on first open.
const DOCS = {
  privacy: {
    title: 'Privacy policy',
    // Repo-root canonical copy; strip its H1 — the modal title already says it.
    load: () => import('../../../PRIVACY.md?raw').then((m) => m.default.replace(/^# .*\n/, '')),
  },
  libraries: {
    title: 'Open-source libraries',
    load: () => import('../acknowledgements.md?raw').then((m) => m.default),
  },
}
type DocKey = keyof typeof DOCS

export default function AboutPage() {
  const { version } = useStore()
  const [upd, setUpd] = useState<UpdateCheck>({ state: 'idle' })
  const [doc, setDoc] = useState<DocKey | null>(null)
  const [docTexts, setDocTexts] = useState<Partial<Record<DocKey, string>>>({})

  // Manual only — the app never checks for updates in the background (§9.4).
  const checkForUpdates = async () => {
    setUpd({ state: 'checking' })
    const r = await window.autowright?.updateCheck()
    if (!r || r.state === 'error') setUpd({ state: 'error' })
    else if (r.state === 'available') setUpd({ state: 'available', version: r.version })
    else setUpd({ state: 'current' })
  }

  // The main process streams the zip itself (§3) and pushes percent over
  // update-progress events; the bar holds 100% while Squirrel stages the zip.
  useEffect(() => {
    window.autowright?.onUpdateProgress?.((pct) => {
      setUpd((u) => (u.state === 'downloading' ? { ...u, pct } : u))
    })
  }, [])

  const downloadUpdate = async (v: string) => {
    setUpd({ state: 'downloading', version: v, pct: null })
    const r = await window.autowright?.updateDownload()
    if (r && 'ok' in r) setUpd({ state: 'downloaded', version: v })
    else setUpd({ state: 'failed', error: r && 'error' in r ? r.error : 'updater unavailable' })
  }

  const installUpdate = async (v: string) => {
    // A `busy` answer means an automation is executing (§3) — the app keeps
    // running; the update installs on a later restart attempt.
    const r = await window.autowright?.updateInstall()
    if (r && 'busy' in r) setUpd({ state: 'downloaded', version: v, busy: true })
  }

  const openDoc = (key: DocKey) => {
    setDoc(key)
    if (docTexts[key] === undefined) {
      void DOCS[key].load().then((text) => setDocTexts((t) => ({ ...t, [key]: text })))
    }
  }

  const updSub = {
    idle: 'Updates are only checked when you ask — nothing runs in the background.',
    checking: 'Checking…',
    current: "You're up to date.",
    available: 'version' in upd ? `Version ${upd.version} is available.` : '',
    downloading: 'version' in upd ? `Version ${upd.version} is available.` : '',
    downloaded: upd.state === 'downloaded' && upd.busy
      ? 'An automation is executing — the update installs when you restart after it finishes.'
      : 'Update downloaded — restarts the app, not your automations.',
    failed: upd.state === 'failed' ? `Update failed: ${upd.error}` : '',
    error: "Couldn't reach autowright.ai — try again later.",
  }[upd.state]

  // One action button for the whole flow: check → download → restart.
  const updBtn =
    upd.state === 'available' ? { label: 'Download update', run: () => downloadUpdate(upd.version), disabled: false }
    : upd.state === 'downloading' ? { label: 'Downloading…', run: () => {}, disabled: true }
    : upd.state === 'downloaded' ? { label: 'Restart to update', run: () => installUpdate(upd.version), disabled: false }
    : {
        label: upd.state === 'checking' ? 'Checking…' : 'Check for updates',
        run: checkForUpdates,
        disabled: upd.state === 'checking',
      }

  return (
    <div className="ad-anim-page" style={{
      maxWidth: 640, margin: '0 auto', padding: '26px 30px 70px',
      display: 'flex', flexDirection: 'column', gap: 26,
    }}>
      <PageTitle style={{ marginBottom: 0 }}>About</PageTitle>

      <Section title="APP">
        <div style={rowDivided}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>
              Autowright
              <span style={{ font: `500 11px var(--mono)`, color: 'var(--text-faint)', marginLeft: 6 }}>v{version}</span>
            </div>
            <div style={rowSub}>Open source, MIT licensed — the whole app runs on this Mac.</div>
          </div>
          <a className="ad-btn-soft" href={REPO_URL} target="_blank" rel="noopener noreferrer" style={linkBtn}>
            View on GitHub ↗
          </a>
        </div>
        <div style={row}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>Website</div>
            <div style={rowSub}>The project&rsquo;s home page — a quick tour of what Autowright does.</div>
          </div>
          <a className="ad-btn-soft" href="https://autowright.ai" target="_blank" rel="noopener noreferrer" style={linkBtn}>
            autowright.ai ↗
          </a>
        </div>
      </Section>

      <Section title="UPDATES">
        <div style={rowDivided}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>Updates</div>
            <div style={rowSub}>{updSub}</div>
            {upd.state === 'downloading' && (
              <div className="ad-anim-fade" style={{ marginTop: 10, marginBottom: 2 }}>
                <ProgressBar pct={upd.pct} />
              </div>
            )}
          </div>
          <button
            className="ad-btn-soft"
            onClick={() => { void updBtn.run() }}
            disabled={updBtn.disabled}
            style={{ flex: 'none' }}
          >
            {updBtn.label}
          </button>
        </div>
        <div style={row}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>What&rsquo;s new</div>
            <div style={rowSub}>Release notes for every version live on GitHub.</div>
          </div>
          <a className="ad-btn-soft" href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" style={linkBtn}>
            Release notes ↗
          </a>
        </div>
      </Section>

      <Section title="LEGAL">
        <div style={rowDivided}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>Privacy policy</div>
            <div style={rowSub}>What Autowright collects — nothing — and where your data lives.</div>
          </div>
          <button className="ad-btn-soft" onClick={() => openDoc('privacy')} style={{ flex: 'none' }}>
            View
          </button>
        </div>
        <div style={rowDivided}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>Open-source libraries</div>
            <div style={rowSub}>Everything Autowright is built on, with each project&rsquo;s license.</div>
          </div>
          <button className="ad-btn-soft" onClick={() => openDoc('libraries')} style={{ flex: 'none' }}>
            View
          </button>
        </div>
        <div style={{ padding: '13px 20px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-faint)' }}>
          Autowright is provided as is, without warranty of any kind (MIT License). Automations
          execute scripts written by an AI agent — those scripts can do anything your user account
          can do on this Mac. Review every change before you accept and execute it. You are
          responsible for what your automations do; the author accepts no liability for any damage
          or loss they cause.
        </div>
      </Section>

      {doc && (
        <Modal onClose={() => setDoc(null)} width={680} cardStyle={{ padding: '22px 24px' }}>
          {(close) => (
            <>
              <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--text)' }}>
                {DOCS[doc].title}
              </h2>
              <ScrollArea wrapStyle={{ marginTop: 12 }} style={{ maxHeight: '62vh' }}>
                {docTexts[doc] === undefined
                  ? <div style={rowSub}>Loading…</div>
                  : <Markdown text={docTexts[doc]} />}
              </ScrollArea>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
                <BtnGhost onClick={close}>Close</BtnGhost>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
