// App shell (§9): hover-expanding floating nav rail + independently scrolling content,
// state-driven nav.
import { useEffect, useState } from 'react'
import { useStore } from './store'
import { CountPill, Logo, ScrollArea, Spinner, Toast } from './ui'
import DevLogOverlay from './devlog'
import AboutPage from './pages/AboutPage'
import AgentNewPage from './pages/AgentNewPage'
import AgentsPage from './pages/AgentsPage'
import AutomationDetail from './pages/AutomationDetail'
import AutomationsList from './pages/AutomationsList'
import CreateFlow from './pages/CreateFlow'
import ExecutionPage from './pages/ExecutionPage'
import ExecutionsList from './pages/ExecutionsList'
import MenuBarPanel from './pages/MenuBarPanel'
import Onboarding from './pages/Onboarding'
import ReportModal from './pages/ReportModal'
import SecretsPage from './pages/SecretsPage'
import SettingsPage from './pages/SettingsPage'

const NAV: { page: string; label: string; icon: string }[] = [
  { page: 'automations', label: 'Automations', icon: 'fa-bolt' },
  { page: 'executions', label: 'Executions', icon: 'fa-clock-rotate-left' },
  { page: 'agents', label: 'Agents', icon: 'fa-microchip' },
  { page: 'secrets', label: 'Secrets', icon: 'fa-key' },
  { page: 'settings', label: 'Settings', icon: 'fa-sliders' },
]

// §9: meta, not a working surface — pinned at the sidebar's bottom edge.
const BOTTOM_NAV: typeof NAV = [
  { page: 'about', label: 'About', icon: 'fa-circle-info' },
]

function Sidebar() {
  const page = useStore((s) => s.page)
  const go = useStore((s) => s.go)
  const nAutos = useStore((s) => s.automations.length)
  // §11 test executions never appear in the Executions list — don't count them
  const nExecs = useStore((s) => s.executions.filter((e) => !e.test).length)
  const nAgents = useStore((s) => s.agents.length)
  const nSecrets = useStore((s) => s.secrets.length)
  // §9 "Update available" nav row: appears above About while an update is
  // known and not yet installed (§3 update-available) — the accent icon alone
  // signals in the collapsed rail. Clicking opens About pre-armed (§9.4).
  const updateAvailable = useStore((s) => s.updateAvailable)
  const activeRoot = page === 'automation' ? 'automations' : page === 'execution' ? 'executions' : page === 'agentNew' ? 'agents' : page
  const counts: Record<string, number> = {
    automations: nAutos,
    executions: nExecs,
    agents: nAgents,
    secrets: nSecrets,
  }
  // §9 floating rail: fixed panel below the traffic lights (top 46 > lights' ~28 bottom),
  // square left corners against the window edge, 12px radius on the right. Inner content
  // keeps a fixed 212px width — the .ad-rail hover expansion reveals labels by clip.
  return (
    <div
      className="ad-rail"
      data-testid="nav-rail"
      style={{
        // z 50: above page content, below every modal backdrop (z 60+) so an
        // open modal dims and blocks the rail too (§9).
        position: 'fixed', left: 0, top: 46, bottom: 12, zIndex: 50,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ width: 212, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 18px' }}>
          <Logo />
          <span className="ad-rail-reveal" style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>Autowright</span>
        </div>
        {[
          { rows: NAV, style: { padding: '0 10px' } },
          { rows: BOTTOM_NAV, style: { padding: '0 10px 12px', marginTop: 'auto' } },
        ].map((group, i) => (
          <nav key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, ...group.style }}>
            {i === 1 && updateAvailable && (
              <button
                data-testid="nav-update"
                className="ad-nav-row"
                onClick={() => go('about', { automationId: null, executionId: null })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px',
                  borderRadius: 7, fontSize: 13, fontWeight: 500, textAlign: 'left',
                  color: 'var(--accent)',
                }}
              >
                <i className="fa-solid fa-download" style={{ width: 16, fontSize: 12 }} />
                <span className="ad-rail-reveal" style={{ flex: 1, whiteSpace: 'nowrap' }}>Update available</span>
              </button>
            )}
            {i === 1 && (
              // §9 "Report an issue" row: directly above About (below the update
              // row when both show). Opens the §9.5 modal — not a page: no Page
              // union entry, go() untouched.
              <button
                data-testid="nav-report-issue"
                className="ad-nav-row"
                onClick={() => useStore.setState({ reportOpen: true })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px',
                  borderRadius: 7, fontSize: 13, fontWeight: 500, textAlign: 'left',
                  color: 'var(--text-muted)',
                }}
              >
                <i className="fa-solid fa-bug" style={{ width: 16, fontSize: 12, opacity: 0.85 }} />
                <span className="ad-rail-reveal" style={{ flex: 1, whiteSpace: 'nowrap' }}>Report an issue</span>
              </button>
            )}
            {group.rows.map((n) => {
              const active = activeRoot === n.page
              return (
                <button
                  key={n.page}
                  className={'ad-nav-row' + (active ? ' active' : '')}
                  onClick={() => go(n.page as never, { automationId: null, executionId: null })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 11px',
                    borderRadius: 7, fontSize: 13, fontWeight: 500, textAlign: 'left',
                    color: active ? 'var(--text)' : 'var(--text-muted)',
                    ...(active ? { background: 'var(--accent-hint-bg)' } : null),
                  }}
                >
                  <i className={`fa-solid ${n.icon}`} style={{ width: 16, fontSize: 12, opacity: 0.85 }} />
                  <span className="ad-rail-reveal" style={{ flex: 1, whiteSpace: 'nowrap' }}>{n.label}</span>
                  <span className="ad-rail-reveal" style={{ display: 'inline-flex' }}>
                    <CountPill n={counts[n.page] ?? 0} active={active} />
                  </span>
                </button>
              )
            })}
          </nav>
        ))}
      </div>
    </div>
  )
}

function Content() {
  const page = useStore((s) => s.page)
  switch (page) {
    case 'automations': return <AutomationsList />
    case 'automation': return <AutomationDetail />
    case 'executions': return <ExecutionsList />
    case 'execution': return <ExecutionPage />
    case 'agents': return <AgentsPage />
    case 'agentNew': return <AgentNewPage />
    case 'secrets': return <SecretsPage />
    case 'settings': return <SettingsPage />
    case 'about': return <AboutPage />
    default: return <AutomationsList />
  }
}

// Boot gate: plain window background while connecting. The logo/spinner only
// appears if boot is still pending after 300 ms, so a fast boot shows no flash.
// §9: 15 s of failed attempts adds a hint line — relaunching re-runs the §3
// ensure-backend step. Retrying never stops.
function BootSplash({ waiting }: { waiting: boolean }) {
  const [show, setShow] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [failDetail, setFailDetail] = useState<string | null>(null)
  useEffect(() => {
    const id = window.setTimeout(() => setShow(true), 300)
    return () => clearTimeout(id)
  }, [])
  useEffect(() => {
    if (!waiting) return
    const id = window.setTimeout(() => setStuck(true), 15_000)
    return () => clearTimeout(id)
  }, [waiting])
  // §3 ensure-backend outcome: a failed install/verify replaces the stuck hint
  // with the actual failure. Connection retries continue regardless.
  useEffect(() => {
    if (!waiting) return
    const id = window.setInterval(async () => {
      const s = await window.autowright?.backendStatus()
      setFailDetail(s?.state === 'failed' ? s.detail : null)
    }, 2000)
    return () => clearInterval(id)
  }, [waiting])
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-window)' }} className="ad-drag">
      {show && (
        <div className="ad-anim-fade" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <Logo size={40} />
          <Spinner size={18} />
          <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            {waiting ? 'Waiting for the Autowright backend…' : 'Connecting…'}
          </div>
          {waiting && (failDetail || stuck) && (
            <div className="ad-anim-fade">
              <div style={{ color: 'var(--text-muted)', fontSize: 12.5, opacity: 0.7, maxWidth: 420, textAlign: 'center' }}>
                {failDetail ?? 'Still waiting — quitting and reopening Autowright restarts the backend service.'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const connected = useStore((s) => s.connected)
  const surface = useStore((s) => s.surface)
  const toast = useStore((s) => s.toast)
  const reportOpen = useStore((s) => s.reportOpen)
  const boot = useStore((s) => s.boot)
  const disconnect = useStore((s) => s.disconnect)
  const login = useStore((s) => s.settings?.login)
  const menuBarIcon = useStore((s) => s.settings?.menuBarIcon)
  const automaticUpdateCheck = useStore((s) => s.settings?.automaticUpdateCheck)

  useEffect(() => { void boot(); return disconnect }, [])

  // §4.9: the shell owns the OS-side settings effects (login item, tray icon,
  // §3 automatic update check) — push the stored values on every load/change
  // so OS state never drifts from the toggles (a fresh install's default
  // login:true registers here).
  useEffect(() => {
    if (login === undefined && menuBarIcon === undefined) return
    void window.autowright?.applySettings({ login, menuBarIcon, automaticUpdateCheck })
  }, [login, menuBarIcon, automaticUpdateCheck])

  if (connected === null || connected === false) {
    return <BootSplash waiting={connected === false} />
  }

  // §13: the panel renders its own Toast — a failed tray execute is never silent
  if (surface === 'menubar') return <><MenuBarPanel /><Toast msg={toast} /></>
  if (surface === 'onboard') return <><Onboarding /><Toast msg={toast} /><DevLogOverlay /></>

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-window)' }}>
      <div className="ad-drag" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 18, zIndex: 100, pointerEvents: 'none' }} />
      {/* §9: layout reserves a constant 58px for the rail; the fixed panel inside
          Sidebar overlays the content pane when hover-expanded — content never reflows. */}
      <div style={{ width: 58, flex: 'none' }}>
        <Sidebar />
      </div>
      <ScrollArea wrapStyle={{ flex: 1, minWidth: 0 }} style={{ background: 'var(--bg-content)', position: 'relative' }}>
        {/* Pure OS drag surface (§9): pointer-transparent so overlays beneath it
            stay DOM-clickable; must never hold children. */}
        <div className="ad-drag" style={{ position: 'sticky', top: 0, height: 40, zIndex: 101, pointerEvents: 'none' }} />
        {surface === 'create' ? <CreateFlow /> : <Content />}
      </ScrollArea>
      <Toast msg={toast} />
      {/* §9.5 report bug modal — opened by the nav row, never a page */}
      {reportOpen && <ReportModal />}
      {/* §9.3 developer log overlay — main-window surfaces only */}
      <DevLogOverlay />
    </div>
  )
}
