// Automations list (§4, prototype "Automations list" screen).
import React, { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { Auto, ImportSummary } from '../types'
import { Badge, BtnGhost, BtnPrimary, ConfirmModal, EmptyState, Eyebrow, HeaderActions, MiniBadge, Modal, PageTitle, PULSE, resultChipColors, executingToast } from '../ui'

// §5.1/§9.1 import summary modal — only the sections that apply render.
function ImportSummaryModal({ name, autoId, summary, onClose }: {
  name: string
  autoId: string
  summary: ImportSummary
  onClose: () => void
}) {
  const go = useStore((s) => s.go)
  const section = (title: string, body: React.ReactNode) => (
    <div style={{ marginTop: 16 }}>
      <Eyebrow style={{ margin: '0 0 8px' }}>{title}</Eyebrow>
      {body}
    </div>
  )
  const nameRow = (n: string, extra?: React.ReactNode) => (
    <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
      <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{n}</span>
      {extra}
    </div>
  )
  return (
    <Modal onClose={onClose} width={460} cardStyle={{ padding: '22px 24px' }}>
      {(close) => (
        <>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--text)' }}>
            Imported “{name}”
          </h2>
          <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Its triggers are off until you enable them.
          </p>
          {summary.secretsCreated.length > 0 && section('SECRETS THAT NEED VALUES', (
            <>
              {summary.secretsCreated.map((n) => nameRow(n, (
                <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>
              )))}
              <p style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)', margin: '6px 0 0' }}>
                Add their values on the Secrets page.
              </p>
            </>
          ))}
          {(summary.secretsExisting.length > 0 || summary.agentsReused.length > 0) && section('ALREADY ON THIS MAC — NOT GRANTED', (
            <>
              {[...summary.secretsExisting, ...summary.agentsReused].map((n) => nameRow(n))}
              <p style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)', margin: '6px 0 0' }}>
                Review and grant them on the edit page.
              </p>
            </>
          ))}
          {summary.agentsCreated.length > 0 && section('AGENTS ADDED', (
            summary.agentsCreated.map((n) => nameRow(n))
          ))}
          {summary.packages.length > 0 && (
            <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)', margin: '16px 0 0' }}>
              {summary.packages.length} package{summary.packages.length === 1 ? '' : 's'} install on the first execution.
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
            <BtnGhost onClick={close}>Close</BtnGhost>
            <BtnPrimary onClick={() => { close(); go('automation', { autoId }) }}>
              Open automation
            </BtnPrimary>
          </div>
        </>
      )}
    </Modal>
  )
}


function AutoCard({ a }: { a: Auto }) {
  const go = useStore((s) => s.go)
  const showToast = useStore((s) => s.showToast)
  const executing = a.live.length > 0

  const execute = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (executing) return
    void (async () => {
      try {
        await api.executeNow(a.id)
      } catch (err) {
        const er = err as Error & { status?: number }
        showToast(er.status === 409 ? executingToast(a.maxParallel, a.maxQueued) : er.message)
      }
    })()
  }

  return (
    <div
      className="ad-card-click"
      onClick={() => go('automation', { autoId: a.id })}
      style={{
        borderRadius: 12, padding: '18px 20px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, minWidth: 0 }}>{a.name}</div>
        <button
          className="ad-btn-exec"
          onClick={execute}
          disabled={executing}
          title={executing ? 'Executing…' : 'Execute now'}
        >
          {/* play glyph sits 1px right of center optically */}
          <i
            className={executing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'}
            style={{ fontSize: 9, marginLeft: executing ? 0 : 1 }}
          />
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-muted)', minHeight: 39 }}>{a.desc}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 11,
          color: (a.triggersOff || a.triggers.length === 0) ? 'var(--text-faint)' : 'var(--text-muted)',
          background: 'var(--hairline-dim)', borderRadius: 6, padding: '3px 8px',
        }}>
          {a.triggerChip}
        </span>
        {a.triggersOff && (
          <MiniBadge c="var(--gray)" bg="var(--gray-bg)">OFF</MiniBadge>
        )}
        <Badge
          status={a.lastStatus}
          style={{
            animation: a.lastStatus === 'executing' ? PULSE : 'none',
          }}
        />
        {a.resultChip && (
          <span style={{
            fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 11.5, letterSpacing: '.03em',
            color: resultChipColors(a.resultStatus).c,
            background: resultChipColors(a.resultStatus).bg,
            borderRadius: 6, padding: '3px 10px',
          }}>
            {a.resultChip}
          </span>
        )}
      </div>
    </div>
  )
}

export default function AutomationsList() {
  const autos = useStore((s) => s.autos)
  const setSurface = useStore((s) => s.setSurface)
  const pendingDraft = useStore((s) => s.pendingDraft)
  const showToast = useStore((s) => s.showToast)
  const refresh = useStore((s) => s.refresh)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [imported, setImported] = useState<{ name: string; autoId: string; summary: import('../types').ImportSummary } | null>(null)

  // §4.4/§9.1: with a kept pending draft, New automation starts fresh —
  // confirm, delete the slot, then open the create flow empty.
  const startFresh = async () => {
    setConfirmFresh(false)
    try { await api.deletePendingDraft() } catch { /* backend restarting */ }
    setSurface('create', 'app')
  }

  // §5.1/§9.1 import: native open dialog → raw archive bytes → the backend.
  const doImport = async () => {
    const data = await window.autowright?.openArchive()
    if (!data) return
    try {
      const r = await api.importAuto(data)
      await refresh()
      setImported({ name: r.auto.name, autoId: r.auto.id, summary: r.summary })
    } catch (e) { showToast((e as Error).message) }
  }

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px' }}>
      <PageTitle
        right={(
          <HeaderActions>
            <BtnGhost onClick={() => { void doImport() }}>
              Import…
            </BtnGhost>
            {pendingDraft && (
              <BtnGhost onClick={() => setSurface('create', 'app')}>
                Resume draft
              </BtnGhost>
            )}
            <BtnPrimary
              onClick={() => (pendingDraft ? setConfirmFresh(true) : setSurface('create', 'app'))}
            >
              New automation
            </BtnPrimary>
          </HeaderActions>
        )}
      >
        Automations
      </PageTitle>
      {imported && (
        <ImportSummaryModal
          name={imported.name}
          autoId={imported.autoId}
          summary={imported.summary}
          onClose={() => setImported(null)}
        />
      )}
      {confirmFresh && (
        <ConfirmModal
          title="Start a new automation?"
          body={`Your unsaved draft${pendingDraft?.name ? ` “${pendingDraft.name}”` : ''} will be discarded. This can't be undone.`}
          confirmLabel="Discard and start new"
          danger
          onConfirm={() => void startFresh()}
          onCancel={() => setConfirmFresh(false)}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(310px,1fr))', gap: 14 }}>
        {autos.map((a) => <AutoCard key={a.id} a={a} />)}
      </div>
      {autos.length === 0 && (
        <EmptyState
          text="No automations yet. Describe a job in plain words — your AI writes it as scripts you can read, and Autowright executes them on your schedule."
          cta={<BtnPrimary onClick={() => setSurface('create', 'app')}>Create your first automation</BtnPrimary>}
        />
      )}
    </div>
  )
}
