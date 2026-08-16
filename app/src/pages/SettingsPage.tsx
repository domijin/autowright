// Settings page (§4.9, §12): general toggles, notifications, execution
// history retention, the on-this-Mac data section, and the §3 CLI card.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { ConfirmModal, Eyebrow, LoadingRow, PageTitle, RadioRing, Spinner, Toggle } from '../ui'

// Card chrome comes from the shared .ad-card class; only overflow is local.
const card: React.CSSProperties = { overflow: 'hidden' }

const rowTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }
const rowSub: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)', marginTop: 3 }

const pathBox: React.CSSProperties = {
  marginTop: 10, background: 'var(--bg-inset)', border: '1px solid var(--hairline)',
  borderRadius: 7, padding: '7px 11px', font: `400 11.5px var(--mono)`, color: 'var(--text-muted)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

type Cli = { state: 'installed' | 'stale' | 'missing' | 'foreign'; path: string; onPath: boolean }

export default function SettingsPage() {
  const { settings, showToast } = useStore()
  const [days, setDays] = useState('')
  // §4.9 COMMAND LINE card: the shim files on disk are the source of truth —
  // re-read on every Settings visit (this mount).
  const [cli, setCli] = useState<Cli | null>(null)
  const [cliBusy, setCliBusy] = useState(false)
  // §4.9 QUIT card (§3 explicit-quit exception)
  const [quitConfirm, setQuitConfirm] = useState(false)
  const [quitBusy, setQuitBusy] = useState(false)

  useEffect(() => {
    if (settings) setDays(String(settings.days))
  }, [settings?.days])

  useEffect(() => {
    void window.autowright?.cliStatus().then((s) => setCli(s)).catch(() => {})
  }, [])

  // §4.9: fires §3 cli-install — a silent write into ~/.local/bin, no dialog;
  // a failed install just returns to the previous state — never an error
  // banner.
  const cliInstall = () => {
    if (cliBusy) return
    setCliBusy(true)
    void (async () => {
      await window.autowright?.cliInstall().catch(() => null)
      const s = await window.autowright?.cliStatus().catch(() => null)
      if (s) setCli(s)
      setCliBusy(false)
    })()
  }

  // §4.9: stop the backend service, then the app quits (§3). Busy or error
  // leaves everything running — reset and toast.
  const quitAll = () => {
    if (quitBusy) return
    setQuitBusy(true)
    void (async () => {
      const r = await window.autowright?.quitAll().catch((e: Error) => ({ error: e.message }))
      if (r && 'busy' in r) showToast('An automation is executing — quit when it finishes.')
      else if (r && 'error' in r) showToast(r.error)
      // on { ok } the app is exiting — nothing to do
      setQuitBusy(false)
    })()
  }

  // §9: settings arrive over the first store fetch — show the shared busy row,
  // not a blank pane, while they load.
  if (!settings) {
    return (
      <div className="ad-anim-page" style={{ maxWidth: 640, margin: '0 auto', padding: '26px 30px 70px' }}>
        <PageTitle style={{ marginBottom: 0 }}>Settings</PageTitle>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <LoadingRow label="Loading…" />
        </div>
      </div>
    )
  }

  const patch = (p: Record<string, unknown>) => {
    api.patchSettings(p).catch((e: Error) => showToast(e.message))
  }

  const onDaysBlur = () => {
    let n = parseInt(days, 10)
    if (!Number.isFinite(n) || n < 1) n = 90
    setDays(String(n))
    if (n !== settings.days) patch({ days: n })
  }

  // Native folder picker; the chosen directory simply becomes the
  // execution-data location — nothing is moved (§4.9).
  const changeDataPath = async () => {
    try {
      const p = await window.autowright?.pickFolder(settings.dataPath)
      if (!p) return
      await api.setDataPath(p)
      showToast('Execution data location changed.')
    } catch (e) { showToast((e as Error).message) }
  }

  return (
    <div className="ad-anim-page" style={{
      maxWidth: 640, margin: '0 auto', padding: '26px 30px 70px',
      display: 'flex', flexDirection: 'column', gap: 26,
    }}>
      <PageTitle style={{ marginBottom: 0 }}>Settings</PageTitle>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>GENERAL</Eyebrow>
        <div className="ad-card" style={card}>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Launch at login</div>
              <div style={rowSub}>Autowright starts quietly in the menu bar.</div>
            </div>
            <Toggle
              // §4.9: the OS login item follows the stored setting — App.tsx
              // pushes applySettings on every settings change, one apply path.
              on={settings.login}
              onChange={(v) => patch({ login: v })}
            />
          </div>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Show in the menu bar</div>
              <div style={rowSub}>The quickest way to execute an automation.</div>
            </div>
            <Toggle on={settings.menuBarIcon} onChange={(v) => patch({ menuBarIcon: v })} />
          </div>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20, borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Keep this Mac awake</div>
              <div style={rowSub}>Prevents this Mac from sleeping so schedules and message triggers keep firing. The display can still sleep.</div>
            </div>
            <Toggle on={settings.keepAwake} onChange={(v) => patch({ keepAwake: v })} />
          </div>
          <div style={{ padding: '15px 20px' }}>
            <div style={rowTitle}>Notify me</div>
            <div role="radiogroup" aria-label="Notify me" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 11 }}>
              {([
                { value: 'attention' as const, label: 'Only when something needs attention' },
                { value: 'all' as const, label: 'After every execution' },
              ]).map((o) => {
                const on = settings.notifications === o.value
                return (
                  <button
                    key={o.value}
                    className="ad-btn-bare"
                    role="radio"
                    aria-checked={on}
                    onClick={() => patch({ notifications: o.value })}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                      transition: 'background var(--t-hover) var(--ease-enter)',
                    }}
                  >
                    <RadioRing selected={on} size={15} />
                    <span style={{ fontSize: 13, color: on ? 'var(--text)' : 'var(--text-muted)' }}>{o.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>EXECUTION HISTORY</Eyebrow>
        <div className="ad-card" style={card}>
          {!settings.keepForever && (
            <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--hairline-dim)', display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1 }}>
                <div style={rowTitle}>Keep executions for</div>
                <div style={rowSub}>Older executions and logs are removed automatically.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                <input
                  className="ad-input"
                  value={days}
                  onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={onDaysBlur}
                  inputMode="numeric"
                  style={{
                    width: 64, color: 'var(--text)', font: `500 12.5px var(--mono)`,
                    textAlign: 'center', padding: '8px 10px',
                  }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>days</span>
              </div>
            </div>
          )}
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Keep execution history forever</div>
              <div style={rowSub}>
                {settings.keepForever
                  ? 'Nothing is ever removed — execution data grows until you clear it yourself.'
                  : 'Turn on to never remove old executions and logs.'}
              </div>
            </div>
            <Toggle on={settings.keepForever} onChange={(v) => patch({ keepForever: v })} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>ON THIS MAC</Eyebrow>
        <div className="ad-card" style={card}>
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>Automations &amp; settings</div>
                <div style={rowSub}>Your automations and preferences — small, and always on this Mac.</div>
              </div>
              <button
                className="ad-btn-soft"
                onClick={() => { void window.autowright?.revealPath(settings.appPath ?? '~/Library/Application Support/Autowright') }}
                style={{ flex: 'none' }}
              >
                Show in Finder
              </button>
            </div>
            <div style={pathBox}>{settings.appPath ?? '~/Library/Application Support/Autowright'}</div>
          </div>
          <div style={{ padding: '15px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>
                  Execution data
                  <span style={{ font: `500 11px var(--mono)`, color: 'var(--text-faint)', marginLeft: 6 }}>{settings.dataSize}</span>
                </div>
                <div style={rowSub}>Logs and results from every execution. This is the part that grows.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
                <button className="ad-btn-soft" onClick={() => { void changeDataPath() }}>Change</button>
                <button
                  className="ad-btn-soft"
                  onClick={() => { void window.autowright?.revealPath(settings.dataPath) }}
                >
                  Show in Finder
                </button>
              </div>
            </div>
            <div style={pathBox}>{settings.dataPath}</div>
          </div>
        </div>
      </div>

      {cli !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Eyebrow style={{ paddingLeft: 2 }}>COMMAND LINE</Eyebrow>
          <div className="ad-card" style={card}>
            <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>The <code>autowright</code> command</div>
                <div style={{
                  ...rowSub,
                  ...(cli.state === 'stale' ? { color: 'var(--amber)' } : {}),
                }}>
                  {cli.state === 'installed' && (cli.onPath
                    ? `Installed at ${cli.path}`
                    : `Installed at ${cli.path}. Add ~/.local/bin to your PATH to use it: export PATH="$HOME/.local/bin:$PATH"`)}
                  {cli.state === 'missing' && 'Not installed — manage automations from the Terminal. Installs to ~/.local/bin — no password needed.'}
                  {cli.state === 'stale' && 'An old autowright command at /usr/local/bin points at an old location — remove it with sudo rm /usr/local/bin/autowright, then install here.'}
                  {cli.state === 'foreign' && `A different autowright is already at ${cli.path} — Autowright won’t touch it.`}
                </div>
              </div>
              {(cli.state === 'missing' || cli.state === 'stale') && (
                <button className="ad-btn-soft" onClick={cliInstall} disabled={cliBusy} style={{ flex: 'none' }}>
                  {cliBusy ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <Spinner size={12} /> Installing…
                    </span>
                  ) : 'Install'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Eyebrow style={{ paddingLeft: 2 }}>DEVELOPER</Eyebrow>
        <div className="ad-card" style={card}>
          <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Developer mode</div>
              <div style={rowSub}>
                Logs every backend request and every AI request — including the full prompt — to the backend log. Press ` to show the logs panel.
              </div>
            </div>
            <Toggle on={settings.developerMode} onChange={(v) => patch({ developerMode: v })} />
          </div>
        </div>
      </div>

      {window.autowright && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Eyebrow style={{ paddingLeft: 2 }}>QUIT</Eyebrow>
          <div className="ad-card" style={card}>
            <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1 }}>
                <div style={rowTitle}>Quit Autowright entirely</div>
                <div style={rowSub}>
                  Stops the background service too — schedules and message triggers pause until you next log in or open Autowright.
                </div>
              </div>
              <button
                className="ad-btn-soft"
                onClick={() => setQuitConfirm(true)}
                disabled={quitBusy}
                style={{ flex: 'none' }}
              >
                {quitBusy ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <Spinner size={12} /> Stopping…
                  </span>
                ) : 'Quit…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {quitConfirm && (
        <ConfirmModal
          title="Quit Autowright entirely?"
          body="The background service stops too, so schedules and message triggers pause until you next log in or open Autowright."
          confirmLabel="Quit Autowright"
          danger
          onConfirm={() => { setQuitConfirm(false); quitAll() }}
          onCancel={() => setQuitConfirm(false)}
        />
      )}
    </div>
  )
}
