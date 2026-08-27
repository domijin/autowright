// About page (§9.4): APP / UPDATES / LEGAL sections — version, GitHub links,
// update check, privacy policy, open-source libraries, disclaimer. New
// about-ish content lands here, never on Settings.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { usePlatformCopy } from '../platformCopy'
import { useStore } from '../store'
import { BtnGhost, CommandBlock, Eyebrow, Modal, PageTitle, ProgressBar, ScrollArea, Toggle } from '../ui'
import { Markdown } from '../result'
import { REPO_URL } from '../config'

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
  | { state: 'idle' | 'checking' | 'current' }
  // §3: a check can carry an error detail (a platform with no update feed
  // answers the plain no-updates line); without one the generic network copy
  // stands.
  | { state: 'error'; error?: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number | null }
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
  // Per-field selectors (UI-GUIDE): a bare useStore() re-renders this page on
  // every store write anywhere — every toast, every log line of every execution.
  const version = useStore((s) => s.version)
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const updateAvailable = useStore((s) => s.updateAvailable)
  // §9 per-OS copy rule: the machine noun the APP and LEGAL lines name.
  const copy = usePlatformCopy()
  // §9.4 pre-armed: a known update (§3 update-available — an automatic check,
  // or an earlier manual one) renders the `available` state without a press.
  const [upd, setUpd] = useState<UpdateCheck>(() => (
    updateAvailable ? { state: 'available', version: updateAvailable } : { state: 'idle' }
  ))
  const [doc, setDoc] = useState<DocKey | null>(null)
  const [docTexts, setDocTexts] = useState<Partial<Record<DocKey, string>>>({})
  const [docErrs, setDocErrs] = useState<Partial<Record<DocKey, boolean>>>({})
  // §9.4 Homebrew-managed fork (§3): while the Caskroom dir exists, the
  // `available` state shows the brew upgrade command instead of Download.
  // Asked at mount and again on every manual check, so a brew install or
  // uninstall reflects without an app restart.
  const [brew, setBrew] = useState(false)

  useEffect(() => {
    void window.autowright?.updateBrewManaged?.().then((b) => setBrew(!!b))
  }, [])

  // Checks run manually from the button here, or daily via the §3 automatic
  // check the toggle below controls (§9.4). Manual results feed the shared
  // §3 state (the §9 badge): available sets it, uptodate clears it, error
  // leaves it alone.
  const checkForUpdates = async () => {
    setUpd({ state: 'checking' })
    void window.autowright?.updateBrewManaged?.().then((b) => setBrew(!!b))
    const r = await window.autowright?.updateCheck()
    if (!r) setUpd({ state: 'error' })
    else if (r.state === 'error') setUpd({ state: 'error', error: r.error })
    else if (r.state === 'available') {
      useStore.setState({ updateAvailable: r.version })
      setUpd({ state: 'available', version: r.version })
    } else {
      useStore.setState({ updateAvailable: null })
      setUpd({ state: 'current' })
    }
  }

  // The main process streams the zip itself (§3) and pushes percent over
  // update-progress events; the bar holds 100% while Squirrel stages the zip.
  useEffect(() => {
    const off = window.autowright?.onUpdateProgress?.((percent) => {
      setUpd((u) => (u.state === 'downloading' ? { ...u, percent } : u))
    })
    return () => off?.()
  }, [])

  // A §3 automatic check can land while this page is open — arm the row unless
  // a download is already under way.
  useEffect(() => {
    if (!updateAvailable) return
    setUpd((u) => (u.state === 'idle' || u.state === 'checking' || u.state === 'current' || u.state === 'error'
      ? { state: 'available', version: updateAvailable }
      : u))
  }, [updateAvailable])

  const downloadUpdate = async (v: string) => {
    setUpd({ state: 'downloading', version: v, percent: null })
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

  // §9.4: a failed chunk load must not strand "Loading…" — record the failure
  // and offer Retry, which re-attempts the import.
  const loadDoc = (key: DocKey) => {
    setDocErrs((e) => ({ ...e, [key]: false }))
    DOCS[key].load()
      .then((text) => setDocTexts((t) => ({ ...t, [key]: text })))
      .catch(() => setDocErrs((e) => ({ ...e, [key]: true })))
  }

  const openDoc = (key: DocKey) => {
    setDoc(key)
    if (docTexts[key] === undefined) loadDoc(key)
  }

  const updSub = {
    // §9.4: the idle line follows the automatic-check toggle below.
    idle: settings?.automaticUpdateCheck
      ? 'Checks once a day — downloads still start only when you ask.'
      : 'Updates are only checked when you ask — nothing runs in the background.',
    checking: 'Checking…',
    current: "You're up to date.",
    available: 'version' in upd
      ? (brew
          ? `Version ${upd.version} is available. This copy is managed by Homebrew. Update it with:`
          : `Version ${upd.version} is available.`)
      : '',
    downloading: 'version' in upd ? `Version ${upd.version} is available.` : '',
    downloaded: upd.state === 'downloaded' && upd.busy
      ? 'An automation is executing — the update installs when you restart after it finishes.'
      : 'Update downloaded — restarts the app, not your automations.',
    failed: upd.state === 'failed' ? `Update failed: ${upd.error}` : '',
    // §3: a carried detail wins — the no-feed line must never read as a
    // network hiccup the user could retry away.
    error: upd.state === 'error' && upd.error
      ? upd.error
      : "Couldn't reach GitHub — try again later.",
  }[upd.state]

  // One action button for the whole flow: check → download → restart. On a
  // brew-managed copy the `available` state keeps the check button — Homebrew
  // installs the update (§9.4 Homebrew-managed fork).
  const updBtn =
    upd.state === 'available' && !brew ? { label: 'Download update', run: () => downloadUpdate(upd.version), disabled: false }
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
            <div style={rowSub}>Open source, MIT licensed — the whole app runs on this {copy.machine}.</div>
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
                <ProgressBar percent={upd.percent} />
              </div>
            )}
            {upd.state === 'available' && brew && (
              <CommandBlock command="brew upgrade --cask autowright" />
            )}
          </div>
          <button
            className="ad-btn-soft"
            onClick={() => { void updBtn.run() }}
            disabled={updBtn.disabled}
            // §9.4 persistent available-state highlight, same accent border as
            // the selected-card pattern. Not on a brew-managed copy — there is
            // no Download action to point at.
            style={{
              flex: 'none',
              ...(upd.state === 'available' && !brew
                ? { borderColor: 'var(--accent-sel)', color: 'var(--text)' }
                : null),
            }}
          >
            {updBtn.label}
          </button>
        </div>
        <div style={rowDivided}>
          <div style={{ flex: 1 }}>
            <div style={rowTitle}>Check for updates automatically</div>
            <div style={rowSub}>
              Once a day, ask GitHub whether a newer version exists. Downloads still
              start only when you ask.
            </div>
          </div>
          <Toggle
            // §4.9 automaticUpdateCheck: same one-apply path as the Settings
            // toggles — App.tsx pushes applySettings on every settings change,
            // and the shell's reconcile starts or stops the §3 automatic check.
            on={!!settings?.automaticUpdateCheck}
            onChange={(v) => { api.patchSettings({ automaticUpdateCheck: v }).catch((e: Error) => showToast(e.message)) }}
          />
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
          can do on this {copy.machine}. Review every change before you accept and execute it. You are
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
                {docTexts[doc] !== undefined
                  ? <Markdown text={docTexts[doc]} />
                  : docErrs[doc]
                    ? (
                      <div>
                        <div style={{ fontSize: 12.5, color: 'var(--red-text)' }}>Couldn't load the document.</div>
                        <button className="ad-btn-ghost" onClick={() => loadDoc(doc)} style={{ marginTop: 10 }}>
                          Retry
                        </button>
                      </div>
                    )
                    : <div style={rowSub}>Loading…</div>}
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
