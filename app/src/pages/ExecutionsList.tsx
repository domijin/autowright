// Executions list (§7): every execution across all automations. The All
// filter stacks Executing and Queued (§6 firing queue) sections above Finished;
// every other segment shows exactly one table — Executing/Queued their live
// rows, a terminal segment that status's finished rows. The store holds only
// the §19 window (live rows plus the newest finished page); the terminal
// filters and the pager bring deeper history in via GET /executions.
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { Badge, EmptyNotice, Eyebrow, HeaderActions, PageTitle, PULSE, waitedLabel } from '../ui'
import type { Execution } from '../types'

// §7: the sections' own order — the live segments carry the section names.
// Labels are the §4.6 words capitalized ("Executing", "Queued"), then the five
// terminal statuses.
const FILTERS = ['All', 'Executing', 'Queued', 'Succeeded', 'Failed', 'Cancelled', 'Skipped', 'Interrupted'] as const
type Filter = (typeof FILTERS)[number]

const GRID = '2fr 1.1fr .8fr .6fr 1fr'

function Row({ e, onOpen, queued }: { e: Execution; onOpen: () => void; queued?: boolean }) {
  return (
    <button
      className="ad-btn-bare ad-hover-row ad-focus-inset"
      data-testid="execution-row"
      onClick={onOpen}
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '9px 18px',
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
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', marginTop: 2,
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
    <div className="ad-card" style={{ overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 18px',
        borderBottom: '1px solid var(--hairline)',
      }}>
        <Eyebrow>AUTOMATION</Eyebrow>
        <Eyebrow>STATUS</Eyebrow>
        <Eyebrow>TRIGGER</Eyebrow>
        <Eyebrow>{queued ? 'QUEUED FOR' : 'DURATION'}</Eyebrow>
        <Eyebrow>{queued ? 'QUEUED AT' : 'STARTED'}</Eyebrow>
      </div>
      {rows.map((e) => (
        <Row key={e.id} e={e} queued={queued} onOpen={() => go('execution', { executionId: e.id })} />
      ))}
    </div>
  )
}

// §14 section rhythm: the eyebrow sits 10 px above its table, and
// eyebrow-labelled sections are 26 px apart.
const sectionLabel: React.CSSProperties = { marginBottom: 10 }

// §7 Finished paging: retention defaults to 90 days and `keepForever` turns
// cleanup off entirely, so history is unbounded — it moves in pages of 50,
// the same size as the §19 /state finished window.
const PAGE = 50

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
  // §7 fetched pages and the page number: view state only — reset on unmount
  // and on every filter change. `serverTotal` is the current filter's match
  // count from the last fetch (null until one lands).
  const [fetched, setFetched] = useState<Execution[]>([])
  const [serverTotal, setServerTotal] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const fetchSeq = useRef(0)

  const executing = executions
    .filter((e) => e.status === 'executing')
    .sort((a, b) => b.startedMs - a.startedMs)
  // §6 firing queue: oldest wait first — the drain order, so the next one to
  // run reads top.
  const queued = executions
    .filter((e) => e.status === 'queued')
    .sort((a, b) => (a.queuedMs || a.startedMs) - (b.queuedMs || b.startedMs))

  // §7: the live segments read the window directly; only All and the terminal
  // segments deal in finished rows (and only those ever fetch).
  const liveSegment = filt === 'Executing' || filt === 'Queued'
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
  // flight, but never the empty card — that means "the server answered
  // empty", not "the answer hasn't arrived"). All needs no fetch (the window
  // is its first page), and the live segments never fetch (the window always
  // holds every live row).
  const [firstFetchDone, setFirstFetchDone] = useState(true)
  useEffect(() => {
    const n = ++fetchSeq.current
    setFetched([])
    setServerTotal(null)
    setPage(0)
    if (filt === 'All' || filt === 'Executing' || filt === 'Queued') {
      setFirstFetchDone(true)
      return
    }
    setFirstFetchDone(false)
    void api.listExecutions({ status: filt.toLowerCase(), limit: PAGE }).then((r) => {
      if (n !== fetchSeq.current) return
      setFetched(r.executions)
      setServerTotal(r.total)
    }, (err: Error) => { if (n === fetchSeq.current) showToast(err.message) })
      .finally(() => { if (n === fetchSeq.current) setFirstFetchDone(true) })
  }, [filt])

  // §7 absorption: a /state refresh replaces the window wholesale, and new
  // finishes push old rows out of it — a row that leaves the window
  // mid-session must survive in the accumulated set, or the page the user is
  // on silently loses it and every deeper page shifts against the readout.
  // The inverse prune rides along: an accumulated row that sorts INSIDE the
  // window's span but isn't in the window can only have been deleted
  // server-side (an automation delete, a retention sweep) — keeping it would
  // show a ghost row.
  useEffect(() => {
    const finishedRows = executions
      .filter((e) => e.status !== 'queued' && e.status !== 'executing')
      .sort(byCanonicalOrder)
    if (finishedRows.length === 0) return
    setFetched((f) => {
      const ids = new Set(finishedRows.map((e) => e.id))
      const oldest = finishedRows[finishedRows.length - 1]
      return [...finishedRows,
              ...f.filter((e) => !ids.has(e.id) && byCanonicalOrder(e, oldest) > 0)]
    })
  }, [executions])

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
  const labelled = filt === 'All' && (executing.length > 0 || queued.length > 0)

  // §7 pager: the filter's match total sizes the readout. All ALWAYS derives
  // its total from the pill count minus live rows — executionsTotal is trued
  // up by every /state refresh, while a fetch's serverTotal freezes at fetch
  // time (pinning it would strand the last page's newest rows behind a
  // disabled Next). Terminal filters have only their fetches to go by.
  const total = filt === 'All'
    ? Math.max(0, executionsTotal - executing.length - queued.length)
    : (serverTotal ?? finished.length)
  // Clamp the page when the total shrinks beneath it (a retention sweep, a
  // filter's true count landing) — never an empty slice with rows in hand.
  const maxPage = Math.max(0, Math.ceil(total / PAGE) - 1)
  const p = Math.min(page, maxPage)
  const visible = finished.slice(p * PAGE, p * PAGE + PAGE)

  // §7 Next: a page whose rows are already in hand re-slices with no request;
  // past the rows in hand it fetches the next keyset page — cursor at the last
  // finished row in hand — and advances only when it lands.
  const next = () => {
    if (busy || finished.length === 0) return
    const target = p + 1
    if (finished.length >= Math.min((target + 1) * PAGE, total)) {
      setPage(target)
      return
    }
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
      if (r.executions.length > 0) setPage(target)
    }, (err: Error) => { if (n === fetchSeq.current) showToast(err.message) })
      .finally(() => setBusy(false))
  }

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, padding: '26px 30px 70px' }}>
      <PageTitle
        right={
          <HeaderActions>
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
          </HeaderActions>
        }
      >
        Executions
      </PageTitle>

      {filt === 'All' && executing.length > 0 && (
        <>
          <Eyebrow style={sectionLabel}>EXECUTING</Eyebrow>
          <Table rows={executing} go={go} />
        </>
      )}
      {filt === 'All' && queued.length > 0 && (
        <>
          <Eyebrow style={{ ...sectionLabel, marginTop: executing.length > 0 ? 26 : 0 }}>QUEUED</Eyebrow>
          <Table rows={queued} go={go} queued />
        </>
      )}
      {liveSegment ? (
        // §7 live segments: one table, no section label, never fetched or
        // paged — the window always holds every live row.
        (filt === 'Executing' ? executing : queued).length === 0 ? (
          <EmptyNotice
            title={`No ${filt.toLowerCase()} executions`}
            body="Executions matching this filter will appear here."
          />
        ) : (
          <Table
            rows={filt === 'Executing' ? executing : queued}
            go={go}
            queued={filt === 'Queued'}
          />
        )
      ) : (
        <>
          {labelled && <Eyebrow style={{ ...sectionLabel, marginTop: 26 }}>FINISHED</Eyebrow>}
          {/* §7: no empty card while the segment's first fetch is on the
            * wire — the card means the server answered empty. */}
          {finished.length === 0 && !firstFetchDone ? null
          : finished.length === 0 ? (
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
              <Table rows={visible} go={go} />
              {/* §7 pager: only when the total exceeds one page — a short
                * table looks exactly as it did before paging existed. */}
              {total > PAGE && (
                <div
                  data-testid="executions-pager"
                  style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }}
                >
                  <button
                    className="ad-btn-text dim"
                    disabled={p === 0}
                    onClick={() => setPage(p - 1)}
                  >
                    Prev
                  </button>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>·</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)' }}>
                    {`${(p * PAGE + 1).toLocaleString('en-US')}–${(p * PAGE + visible.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
                  </span>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>·</span>
                  <button
                    className="ad-btn-text dim"
                    disabled={busy || p * PAGE + visible.length >= total}
                    onClick={next}
                  >
                    Next
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
