// Executions list (§7): every execution across all automations — Running and
// Waiting (§6 firing queue) sections above Finished, filter All / Succeeded /
// Failed on finished rows only.
import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Badge, EmptyNotice, PageTitle, PULSE, waitedLabel } from '../ui'
import type { Exec } from '../types'

const FILTERS = ['All', 'Succeeded', 'Failed'] as const
type Filter = (typeof FILTERS)[number]

const GRID = '2fr 1.1fr .8fr .6fr 1fr'

const headCell: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  letterSpacing: '.09em', color: 'var(--text-faint)',
}

function Row({ e, onOpen, waiting }: { e: Exec; onOpen: () => void; waiting?: boolean }) {
  return (
    <div
      className="ad-hover-row"
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '11px 18px',
        borderBottom: '1px solid var(--hairline-dim)', alignItems: 'center', cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.autoName}
          </span>
          {e.autoDeleted && (
            <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 'none' }}>(deleted)</span>
          )}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {e.id}
        </div>
      </div>
      <div>
        <Badge
          status={e.status}
          style={e.status === 'executing' ? { animation: PULSE } : undefined}
        />
      </div>
      {/* §4.5: message-triggered rows read "Discord · Dave · v3"; a test row's
        * trigger and ver labels are both "Test" — print it once (§7). */}
      <span style={{ fontSize: 12, color: 'var(--text-2)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {e.trigger + (e.triggerSender ? ' · ' + e.triggerSender : '') + (e.ver && e.ver !== e.trigger ? ' · ' + e.ver : '')}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>
        {/* A queued row has no duration — it hasn't started (§7). */}
        {waiting ? waitedLabel(Date.now() - (e.queuedMs || e.startedMs)) : e.dur}
      </span>
      {/* Admission stamps started_at = queued_at, and promotion re-stamps it —
        * a row still in this section was never promoted, so `started` is
        * exactly when it was queued. */}
      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{e.started}</span>
    </div>
  )
}

function Table({ rows, go, waiting }: {
  rows: Exec[]; go: (page: 'execution', ids: { execId: string }) => void; waiting?: boolean
}) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 18px',
        borderBottom: '1px solid var(--hairline)',
      }}>
        <span style={headCell}>AUTOMATION</span>
        <span style={headCell}>STATUS</span>
        <span style={headCell}>TRIGGER</span>
        <span style={headCell}>{waiting ? 'WAITING FOR' : 'DURATION'}</span>
        <span style={headCell}>{waiting ? 'QUEUED AT' : 'STARTED'}</span>
      </div>
      {rows.map((e) => (
        <Row key={e.id} e={e} waiting={waiting} onOpen={() => go('execution', { execId: e.id })} />
      ))}
    </div>
  )
}

const sectionLabel: React.CSSProperties = { ...headCell, display: 'block', margin: '0 0 8px 2px' }

export default function ExecutionsList() {
  const { execs, go } = useStore()
  const [filt, setFilt] = useState<Filter>('All')

  const running = execs
    .filter((e) => e.status === 'executing')
    .sort((a, b) => b.startedMs - a.startedMs)
  // §6 firing queue: oldest wait first — the drain order, so the next one to
  // run reads top.
  const waiting = execs
    .filter((e) => e.status === 'queued')
    .sort((a, b) => (a.queuedMs || a.startedMs) - (b.queuedMs || b.startedMs))
  const finished = execs
    .filter((e) => e.status !== 'queued' && e.status !== 'executing')
    .filter((e) =>
      filt === 'All' ? true : filt === 'Succeeded' ? e.status === 'succeeded' : e.status === 'failed')
    // Most recently ended first; startedMs stands in when finished_at was never
    // set (§3 interrupted rows report endedMs 0).
    .sort((a, b) => (b.endedMs || b.startedMs) - (a.endedMs || a.startedMs))

  // §7: the WAITING FOR column counts up — one timer for the whole section,
  // running only while something is actually waiting.
  const [, tick] = useState(0)
  const anyWaiting = waiting.length > 0
  useEffect(() => {
    if (!anyWaiting) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [anyWaiting])

  // Labels appear as soon as the page holds more than one section (§7).
  const labelled = running.length > 0 || waiting.length > 0

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px' }}>
      <PageTitle
        right={
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-input)', borderRadius: 8, overflow: 'hidden' }}>
            {FILTERS.map((f) => (
              <button
                key={f}
                className="ad-btn-text"
                onClick={() => setFilt(f)}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 500, borderRadius: 0,
                  ...(filt === f ? { background: 'var(--bg-active)', color: 'var(--text)' } : null),
                }}
              >
                {f}
              </button>
            ))}
          </div>
        }
      >
        Executions
      </PageTitle>

      {running.length > 0 && (
        <>
          <span style={sectionLabel}>RUNNING</span>
          <Table rows={running} go={go} />
        </>
      )}
      {waiting.length > 0 && (
        <>
          <span style={{ ...sectionLabel, marginTop: running.length > 0 ? 22 : 0 }}>WAITING</span>
          <Table rows={waiting} go={go} waiting />
        </>
      )}
      {labelled && <span style={{ ...sectionLabel, marginTop: 22 }}>FINISHED</span>}
      {finished.length === 0 ? (
        <EmptyNotice
          title={filt !== 'All' ? `No ${filt.toLowerCase()} executions`
            : labelled ? 'No finished executions yet' : 'No executions yet'}
          body={filt === 'All' && !labelled
            ? 'Execute an automation — every execution will appear right here.'
            : filt === 'All'
              ? 'Finished executions will appear here.'
              : 'Executions matching this filter will appear here.'}
        />
      ) : (
        <Table rows={finished} go={go} />
      )}
    </div>
  )
}
