// Executions list (§7): every execution across all automations. The All
// filter stacks Running and Queued (§6 firing queue) sections above Finished;
// every other segment shows exactly one table — Running/Queued their live
// rows, a terminal segment that status's finished rows. The store holds only
// the §19 window (live rows plus the newest finished page); the terminal
// filters and "Show more" page deeper history in via GET /executions.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, EmptyNotice, PageTitle, PULSE, waitedLabel } from '../ui'
import type { Execution } from '../types'

// §7: the sections' own order — the live segments carry the section names
// ("Running", never "executing"), then the five §4.6 terminal statuses.
const FILTERS = ['All', 'Running', 'Queued', 'Succeeded', 'Failed', 'Cancelled', 'Skipped', 'Interrupted'] as const
type Filter = (typeof FILTERS)[number]

const GRID = '2fr 1.1fr .8fr .6fr 1fr'

const headCell: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  letterSpacing: '.09em', color: 'var(--text-faint)',
}

function Row({ e, onOpen, queued }: { e: Execution; onOpen: () => void; queued?: boolean }) {
  return (
    <button
      className="ad-btn-bare ad-hover-row"
      data-testid="execution-row"
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '11px 18px',
        borderBottom: '1px solid var(--hairline-dim)', alignItems: 'center', cursor: 'pointer',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.automationName}
          </span>
          {e.automationDeleted && (
            <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 'none' }}>(deleted)</span>
          )}
        </div>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {/* §7: short id — first 8 chars, same as the detail page's RECENT EXECUTIONS rows */}
          {e.id.slice(0, 8)}
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
      <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {e.trigger + (e.triggerSender ? ' · ' + e.triggerSender : '') + (e.versionLabel && e.versionLabel !== e.trigger ? ' · ' + e.versionLabel : '')}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>
        {/* A queued row has no duration — it hasn't started (§7). */}
        {queued ? waitedLabel(Date.now() - (e.queuedMs || e.startedMs)) : e.duration}
      </span>
      {/* Admission stamps started_at = queued_at, and promotion re-stamps it —
        * a row still in this section was never promoted, so `started` is
        * exactly when it was queued. */}
      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{e.started}</span>
    </button>
  )
}

function Table({ rows, go, queued }: {
  rows: Execution[]; go: (page: 'execution', ids: { executionId: string }) => void; queued?: boolean
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
        <span style={headCell}>{queued ? 'QUEUED FOR' : 'DURATION'}</span>
        <span style={headCell}>{queued ? 'QUEUED AT' : 'STARTED'}</span>
      </div>
      {rows.map((e) => (
        <Row key={e.id} e={e} queued={queued} onOpen={() => go('execution', { executionId: e.id })} />
      ))}
    </div>
  )
}

const sectionLabel: React.CSSProperties = { ...headCell, display: 'block', margin: '0 0 8px 2px' }

// §7 Finished paging: retention defaults to 90 days and `keepForever` turns
// cleanup off entirely, so history is unbounded — it moves in pages of 200,
// the same size as the §19 /state finished window.
const PAGE = 200

// §7 canonical order: startedMs desc, id asc on ties — the §19 keyset order,
// which is what lets fetched pages line up with the live window.
const byCanonicalOrder = (a: Execution, b: Execution) =>
  b.startedMs - a.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export default function ExecutionsList() {
  const executions = useStore((s) => s.executions)
  const executionsTotal = useStore((s) => s.executionsTotal)
  const showToast = useStore((s) => s.showToast)
  const go = useStore((s) => s.go)
  const [filt, setFilt] = useState<Filter>('All')
  // §7 fetched pages: view state only — reset on unmount and on every filter
  // change. `serverTotal` is the current filter's match count from the last
  // fetch (null until one lands).
  const [fetched, setFetched] = useState<Execution[]>([])
  const [serverTotal, setServerTotal] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const fetchSeq = useRef(0)

  const running = executions
    .filter((e) => e.status === 'executing')
    .sort((a, b) => b.startedMs - a.startedMs)
  // §6 firing queue: oldest wait first — the drain order, so the next one to
  // run reads top.
  const queued = executions
    .filter((e) => e.status === 'queued')
    .sort((a, b) => (a.queuedMs || a.startedMs) - (b.queuedMs || b.startedMs))

  // §7: the live segments read the window directly; only All and the terminal
  // segments deal in finished rows (and only those ever fetch).
  const liveSegment = filt === 'Running' || filt === 'Queued'
  const matchesFilter = (e: Execution) =>
    e.status !== 'queued' && e.status !== 'executing' &&
    (filt === 'All' || e.status === filt.toLowerCase())
  // §7 merge: fetched pages join the live window, window wins on an id both
  // hold (it is fresher — events land there), in the canonical order.
  const windowFinished = executions.filter(matchesFilter)
  const windowIds = new Set(windowFinished.map((e) => e.id))
  const finished = [...windowFinished, ...fetched.filter((e) => !windowIds.has(e.id) && matchesFilter(e))]
    .sort(byCanonicalOrder)

  // §7: a terminal filter fetches its own first page — the window may hold
  // only a slice of that status (it shows its matching rows while this is in
  // flight). All needs no fetch (the window is its first page), and the live
  // segments never fetch (the window always holds every live row).
  useEffect(() => {
    const n = ++fetchSeq.current
    setFetched([])
    setServerTotal(null)
    if (filt === 'All' || filt === 'Running' || filt === 'Queued') return
    void api.listExecutions({ status: filt.toLowerCase(), limit: PAGE }).then((r) => {
      if (n !== fetchSeq.current) return
      setFetched(r.executions)
      setServerTotal(r.total)
    }, (err: Error) => { if (n === fetchSeq.current) showToast(err.message) })
  }, [filt])

  // §7: the QUEUED FOR column counts up — one timer for the whole section,
  // running only while something is actually queued.
  const [, tick] = useState(0)
  const anyQueued = queued.length > 0
  useEffect(() => {
    if (!anyQueued) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [anyQueued])

  // Labels appear as soon as the page holds more than one section — and the
  // three-section stack belongs to the All filter alone (§7).
  const labelled = filt === 'All' && (running.length > 0 || queued.length > 0)

  // §7 "Show more (N hidden)": the filter's match total minus what's on
  // screen. All derives its total from the pill count minus live rows until a
  // fetch supplies the server's exact number.
  const total = serverTotal ?? (filt === 'All'
    ? Math.max(0, executionsTotal - running.length - queued.length)
    : finished.length)
  const hidden = Math.max(0, total - finished.length)

  const showMore = () => {
    if (busy || finished.length === 0) return
    const last = finished[finished.length - 1]
    const n = fetchSeq.current
    setBusy(true)
    void api.listExecutions({
      // §19: `finished` = any terminal status — the All filter's page query.
      status: filt === 'All' ? 'finished' : filt.toLowerCase(),
      limit: PAGE,
      before: { startedMs: last.startedMs, id: last.id },
    }).then((r) => {
      if (n !== fetchSeq.current) return
      setFetched((f) => [...f, ...r.executions])
      setServerTotal(r.total)
    }, (err: Error) => { if (n === fetchSeq.current) showToast(err.message) })
      .finally(() => setBusy(false))
  }

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px' }}>
      <PageTitle
        right={
          <div className="ad-seg" role="group" aria-label="Filter executions">
            {FILTERS.map((f) => (
              <button
                key={f}
                className="ad-seg-btn"
                aria-pressed={filt === f}
                onClick={() => setFilt(f)}
              >
                {f}
              </button>
            ))}
          </div>
        }
      >
        Executions
      </PageTitle>

      {filt === 'All' && running.length > 0 && (
        <>
          <span style={sectionLabel}>RUNNING</span>
          <Table rows={running} go={go} />
        </>
      )}
      {filt === 'All' && queued.length > 0 && (
        <>
          <span style={{ ...sectionLabel, marginTop: running.length > 0 ? 22 : 0 }}>QUEUED</span>
          <Table rows={queued} go={go} queued />
        </>
      )}
      {liveSegment ? (
        // §7 live segments: one table, no section label, never fetched or
        // paged — the window always holds every live row.
        (filt === 'Running' ? running : queued).length === 0 ? (
          <EmptyNotice
            title={`No ${filt.toLowerCase()} executions`}
            body="Executions matching this filter will appear here."
          />
        ) : (
          <Table
            rows={filt === 'Running' ? running : queued}
            go={go}
            queued={filt === 'Queued'}
          />
        )
      ) : (
        <>
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
            <>
              <Table rows={finished} go={go} />
              {hidden > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                  <button
                    className="ad-btn-text dim"
                    disabled={busy}
                    onClick={showMore}
                  >
                    {`Show more (${hidden.toLocaleString('en-US')} hidden)`}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
