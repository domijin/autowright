// Menu-bar surface (§13): 334px translucent panel — one row per automation.
import { useEffect, useRef } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { badgeOf, Eyebrow, PULSE, ScrollArea } from '../ui'

const dotColor = (s: string) => badgeOf(s).c

export default function MenuBarPanel() {
  const { autos, version } = useStore()
  const ref = useRef<HTMLDivElement>(null)

  const failed = autos.filter((a) => a.lastStatus === 'failed').length
  const aggregate = failed > 0
    ? `${failed} need${failed === 1 ? 's' : ''} attention`
    : `All good · ${autos.length} automation${autos.length === 1 ? '' : 's'}`

  useEffect(() => {
    if (ref.current) void window.autowright?.resizePanel(ref.current.scrollHeight)
  }, [autos.length])

  const openAuto = (id: string) => { void window.autowright?.openApp(`/app?auto=${id}`) }

  return (
    <div
      ref={ref}
      style={{
        width: 334, background: 'rgba(25,28,35,.94)', borderRadius: 12,
        border: '1px solid rgba(255,255,255,.1)', boxShadow: '0 18px 50px rgba(0,0,0,.55)',
        overflow: 'hidden', fontFamily: 'var(--sans)',
        display: 'flex', flexDirection: 'column', maxHeight: 640,
      }}
    >
      <div style={{ padding: '11px 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: 'none' }}>
        <Eyebrow>Autowright</Eyebrow>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500, color: failed ? 'var(--red-text)' : 'var(--text-faint)' }}>{aggregate}</div>
      </div>
      <ScrollArea wrapStyle={{ minHeight: 0 }}>
        {autos.map((a) => {
          const live = a.live.length > 0
          const subColor = a.live.length
            ? 'var(--cyan)'
            : a.lastStatus === 'failed'
              ? 'var(--red-text)'
              : a.resultChip
                ? 'var(--accent)'
                : 'var(--text-faint)'
          return (
            <div
              key={a.id}
              className="ad-hover-row"
              onClick={() => openAuto(a.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                cursor: 'pointer',
              }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: '50%', flex: 'none',
                background: live ? 'var(--cyan)' : dotColor(a.lastStatus),
                animation: live ? PULSE : undefined,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.name}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: subColor, marginTop: 1 }}>
                  {a.live.length ? 'Executing now…' : a.resultChip ?? a.triggerChip}
                </div>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-faint)', width: 56, textAlign: 'right', flex: 'none' }}>
                {a.live.length ? '' : a.lastExecLabel}
              </span>
              <button
                className="ad-btn-exec"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!live) void api.executeNow(a.id, undefined, 'menubar').catch(() => undefined)
                }}
                disabled={live}
                title={live ? 'Executing…' : 'Execute now'}
                style={{ width: 24, height: 24, borderRadius: 6 }}
              >
                <i
                  className={live ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'}
                  style={{ fontSize: 8, marginLeft: live ? 0 : 1 }}
                />
              </button>
            </div>
          )
        })}
        {autos.length === 0 && (
          <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
            No automations yet — open Autowright to create one.
          </div>
        )}
      </ScrollArea>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 16px', borderTop: '1px solid var(--hairline)', flex: 'none',
      }}>
        <button
          className="ad-btn-link"
          onClick={() => void window.autowright?.openApp('/app')}
        >
          Open Autowright
        </button>
        <span style={{ font: '500 11px var(--mono)', color: 'var(--text-faintest)' }}>v{version || '0.1.0'}</span>
      </div>
    </div>
  )
}
