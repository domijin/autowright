// Settings page (§4.9, §12): general toggles, notifications, execution
// history retention, the on-this-Mac data section, and the §3 CLI card.
import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { usePlatformCopy } from '../platformCopy'
import { useStore } from '../store'
import { CommandBlock, ConfirmModal, Eyebrow, LoadingRow, PageTitle, RadioRing, Spinner, Toggle } from '../ui'

// Card chrome comes from the shared .ad-card class; only overflow is local.
const card: React.CSSProperties = { overflow: 'hidden' }

const rowTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }
const rowSub: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--text-muted)', marginTop: 3 }

const pathBox: React.CSSProperties = {
  marginTop: 10, background: 'var(--bg-inset)', border: '1px solid var(--hairline)',
  borderRadius: 7, padding: '7px 11px', font: `400 11.5px var(--mono)`, color: 'var(--text-muted)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

type Cli = { state: 'installed' | 'missing' | 'foreign'; path: string; onPath: boolean }

export default function SettingsPage() {
  const { settings, showToast } = useStore()
  // §9 per-OS copy rule: machine noun, reveal label, and the §4.9 PATH block.
  const copy = usePlatformCopy()
  // §4.9/§2 gating: both rows render only while this OS can honor them — the
  // stored settings stay untouched and CLI-visible either way (§9: hidden,
  // never disabled-with-a-tooltip).
  const keepAwakeOn = useStore((s) => s.platformCapabilities.keepAwake)
  const notificationsOn = useStore((s) => s.platformCapabilities.notifications)
  const [days, setDays] = useState('')
  // §4.9 COMMAND LINE card: the shim files on disk are the source of truth —
  // re-read on every Settings visit (this mount).
  const [cli, setCli] = useState<Cli | null>(null)
  const [cliBusy, setCliBusy] = useState(false)
  // §4.9 disable confirm: turning the toggle off also deletes the command.
  const [cliOffConfirm, setCliOffConfirm] = useState(false)
  // §4.9 QUIT card (§3 explicit-quit exception)
  const [quitConfirm, setQuitConfirm] = useState(false)
  const [quitBusy, setQuitBusy] = useState(false)
  // §4.9 RESET card (§3 reset flow)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)

  useEffect(() => {
    if (settings) setDays(String(settings.days))
  }, [settings?.days])

  useEffect(() => {
    void window.autowright?.cliStatus().then((s) => setCli(s)).catch(() => {})
  }, [])

  // §4.9: fires §3 cli-install — a silent write into ~/.local/bin, no dialog;
  // a failed install just returns to the previous state — never an error
  // banner.
  const cliInstall = (): Promise<boolean> => {
    if (cliBusy) return Promise.resolve(false)
    setCliBusy(true)
    return (async () => {
      const r = await window.autowright?.cliInstall().catch(() => null)
      // §3: a settled card install also settles the first-run one-shot, so a
      // later hand-deletion is never undone at boot.
      if (r?.ok) localStorage.setItem('ad-cli-installed', '1')
      const s = await window.autowright?.cliStatus().catch(() => null)
      if (s) setCli(s)
      setCliBusy(false)
      return Boolean(r?.ok)
    })()
  }

  // §4.9 toggle: turning on also installs, and a failed install flips the
  // setting back — the toggle just returns. Turning off also deletes the
  // command: with an ours shim on disk the flip asks first (confirm below);
  // with nothing installed it just patches false.
  const setCliEnabled = (on: boolean) => {
    if (!on) {
      if (cli && cli.state === 'installed') setCliOffConfirm(true)
      else patch({ cliEnabled: false })
      return
    }
    patch({ cliEnabled: true })
    void cliInstall().then((ok) => { if (!ok) patch({ cliEnabled: false }) })
  }

  // §4.9 disable confirm accepted: patch off, then §3 cli-uninstall removes
  // the ours-marker shim; a failed delete comes back as an error message,
  // toasted — the setting still turns off.
  const cliDisable = () => {
    if (cliBusy) return
    patch({ cliEnabled: false })
    setCliBusy(true)
    void (async () => {
      const r = await window.autowright?.cliUninstall().catch(() => null)
      if (r && !r.ok) showToast(r.hint)
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

  // §4.9 RESET: the §3 reset-all IPC erases every §5 root and every secret,
  // then relaunches the app into onboarding. Busy or error changes nothing —
  // toast and reset the row.
  const resetAll = () => {
    if (resetBusy) return
    setResetBusy(true)
    void (async () => {
      const r = await window.autowright?.resetAll?.().catch((e: Error) => ({ error: e.message }))
      if (r && 'busy' in r) showToast('An automation is executing — reset when it finishes.')
      else if (r && 'error' in r) showToast(r.error)
      // on { ok } the app is relaunching — nothing to do
      setResetBusy(false)
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
              <div style={rowSub}>Autowright starts quietly in the {copy.menuBar}.</div>
            </div>
            <Toggle
              // §4.9: the OS login item follows the stored setting — App.tsx
              // pushes applySettings on every settings change, one apply path.
              on={settings.login}
              onChange={(v) => patch({ login: v })}
            />
          </div>
          <div style={{
            padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20,
            // The card's last visible row never carries a separator — either
            // gated row below can be the one that's gone.
            ...(keepAwakeOn || notificationsOn ? { borderBottom: '1px solid var(--hairline-dim)' } : {}),
          }}>
            <div style={{ flex: 1 }}>
              <div style={rowTitle}>Show in the {copy.menuBar}</div>
              <div style={rowSub}>The quickest way to execute an automation.</div>
            </div>
            <Toggle on={settings.menuBarIcon} onChange={(v) => patch({ menuBarIcon: v })} />
          </div>
          {keepAwakeOn && (
            <div style={{
              padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20,
              ...(notificationsOn ? { borderBottom: '1px solid var(--hairline-dim)' } : {}),
            }}>
              <div style={{ flex: 1 }}>
                <div style={rowTitle}>Keep this {copy.machine} awake</div>
                <div style={rowSub}>Prevents this {copy.machine} from sleeping so schedules and message triggers keep firing. The display can still sleep.</div>
              </div>
              <Toggle on={settings.keepAwake} onChange={(v) => patch({ keepAwake: v })} />
            </div>
          )}
          {notificationsOn && (
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
          )}
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
        <Eyebrow style={{ paddingLeft: 2 }}>ON THIS {copy.machine.toUpperCase()}</Eyebrow>
        <div className="ad-card" style={card}>
          <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--hairline-dim)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={rowTitle}>Automations &amp; settings</div>
                <div style={rowSub}>Your automations and preferences — small, and always on this {copy.machine}.</div>
              </div>
              <button
                className="ad-btn-soft"
                onClick={() => { void window.autowright?.revealPath(settings.appPath ?? '~/Library/Application Support/Autowright') }}
                style={{ flex: 'none' }}
              >
                {copy.reveal}
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
                  {copy.reveal}
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
            {(() => {
              // §4.9: at most one second row — the missing warning (toggle on,
              // no working user-local install) or the PATH row (toggle on,
              // installed). No standalone Delete row: removal rides the
              // disable confirm.
              const warnRow = cli.state === 'missing' && settings.cliEnabled
              // §4.9 PATH row: on + installed, regardless of onPath.
              const pathRow = cli.state === 'installed' && settings.cliEnabled
              return (
                <>
                  <div style={{
                    padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20,
                    ...(warnRow || pathRow ? { borderBottom: '1px solid var(--hairline-dim)' } : {}),
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={rowTitle}>The <code>autowright</code> command</div>
                      <div style={rowSub}>
                        {cli.state === 'installed' && (settings.cliEnabled
                          ? `Installed at ${cli.path}`
                          : `Still installed at ${cli.path} — turn on to keep it up to date.`)}
                        {cli.state === 'missing' && (settings.cliEnabled
                          ? `Not installed — manage automations from ${copy.terminalNoun}.`
                          : `Not installed — manage automations from ${copy.terminalNoun}. Turning this on installs to ${copy.cliBinDir} — no password needed.`)}
                        {cli.state === 'foreign' && `A different autowright is already at ${cli.path} — Autowright won’t touch it.`}
                      </div>
                    </div>
                    {cli.state !== 'foreign' && (
                      <Toggle on={settings.cliEnabled} onChange={setCliEnabled} />
                    )}
                  </div>
                  {pathRow && (
                    <div style={{ padding: '15px 20px' }}>
                      <div style={rowTitle}>Add it to your PATH</div>
                      <div style={rowSub}>{copy.pathHint}</div>
                      <CommandBlock command={copy.pathCommand} />
                    </div>
                  )}
                  {warnRow && (
                    <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ ...rowTitle, color: 'var(--amber)' }}>The <code>autowright</code> CLI is missing</div>
                        <div style={rowSub}>
                          {`autowright wasn’t found in ${copy.cliBinDir} — it may have been deleted or moved. Reinstall it to keep using it from ${copy.terminalNoun}.`}
                        </div>
                      </div>
                      <button className="ad-btn-soft" onClick={() => { void cliInstall() }} disabled={cliBusy} style={{ flex: 'none' }}>
                        {cliBusy ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                            <Spinner size={12} /> Installing…
                          </span>
                        ) : 'Reinstall'}
                      </button>
                    </div>
                  )}
                </>
              )
            })()}
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

      {window.autowright && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <Eyebrow style={{ paddingLeft: 2 }}>RESET</Eyebrow>
          <div className="ad-card" style={card}>
            <div style={{ padding: '15px 20px', display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1 }}>
                <div style={rowTitle}>Delete all data and start over</div>
                <div style={rowSub}>
                  Erases every automation, execution, agent, secret, and setting from this {copy.machine}, then Autowright restarts as new.
                </div>
              </div>
              <button
                className="ad-btn-soft"
                onClick={() => setResetConfirm(true)}
                disabled={resetBusy}
                style={{ flex: 'none' }}
              >
                {resetBusy ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <Spinner size={12} /> Resetting…
                  </span>
                ) : 'Reset…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cliOffConfirm && (
        <ConfirmModal
          title="Turn off the autowright command?"
          body={`This also deletes the command file from this ${copy.machine}. Your automations, settings, and executions aren’t affected.`}
          confirmLabel="Turn off and delete"
          danger
          onConfirm={() => { setCliOffConfirm(false); cliDisable() }}
          onCancel={() => setCliOffConfirm(false)}
        />
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

      {resetConfirm && (
        <ConfirmModal
          title="Delete all data and start over?"
          body={`Every automation, execution, agent, and setting on this ${copy.machine} is deleted, and every secret is removed from your ${copy.secretStore}. Autowright then restarts as if newly installed. This can’t be undone.`}
          confirmLabel="Delete everything"
          danger
          onConfirm={() => { setResetConfirm(false); resetAll() }}
          onCancel={() => setResetConfirm(false)}
        />
      )}
    </div>
  )
}
