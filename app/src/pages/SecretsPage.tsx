// Secrets page (§4.8, §12): Keychain-backed name/value pairs — values are
// never fetched back; rows only ever show a mask.
import { useState } from 'react'
import { api } from '../api'
import { usePlatformCopy } from '../platformCopy'
import { SecretModal, type SecretModalState } from '../SecretModal'
import { useStore } from '../store'
import type { SecretMeta } from '../types'
import { BtnPrimary, ConfirmModal, EmptyState, Eyebrow, MiniBadge, PageTitle } from '../ui'

const MASK = '••••••••••••'

type ModalState = SecretModalState | null

export default function SecretsPage() {
  // Per-field selectors (UI-GUIDE): a bare useStore() re-renders this page on
  // every store write anywhere — every toast, every log line of every execution.
  const secrets = useStore((s) => s.secrets)
  const showToast = useStore((s) => s.showToast)
  // §9 per-OS copy rule: the secret-store name and machine noun.
  const copy = usePlatformCopy()
  const [modal, setModal] = useState<ModalState>(null)
  const [del, setDel] = useState<SecretMeta | null>(null)

  const confirmDelete = async () => {
    if (!del) return
    const s = del
    setDel(null)
    try {
      await api.deleteSecret(s.id)
      showToast(`Removed from your ${copy.secretStore}.`)
    } catch (e) { showToast((e as Error).message) }
  }

  return (
    <div className="ad-anim-page" style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 30px 70px' }}>
      <PageTitle
        style={{ marginBottom: 6 }}
        right={<BtnPrimary onClick={() => setModal({ mode: 'add' })}>Add secret</BtnPrimary>}
      >
        Secrets
      </PageTitle>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 20px' }}>
        Stored in your {copy.machine}’s {copy.secretStore}. Scripts read them at execution time — the values never appear in logs.
      </p>
      {secrets.length === 0 ? (
        <EmptyState
          text="No secrets yet. Add a password or API key once, and your automations use it wherever they need it — the value never appears in a script or a log."
          cta={<BtnPrimary onClick={() => setModal({ mode: 'add' })}>Add your first secret</BtnPrimary>}
        />
      ) : (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
          padding: '10px 18px', borderBottom: '1px solid var(--hairline)',
        }}>
          <Eyebrow style={{ fontSize: 9.5 }}>NAME</Eyebrow>
          <Eyebrow style={{ fontSize: 9.5 }}>USED BY</Eyebrow>
          <Eyebrow style={{ fontSize: 9.5 }}>VALUE</Eyebrow>
          <span />
        </div>
        {secrets.map((s) => (
          <div
            key={s.name}
            style={{
              display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.7fr 64px', gap: 10,
              padding: '11px 18px', borderBottom: '1px solid var(--hairline-dim)', alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{s.name}</span>
                {!s.set && (
                  <MiniBadge c="var(--amber)" bg="var(--amber-bg)">NOT SET</MiniBadge>
                )}
              </div>
              {s.description && (
                <div style={{
                  fontSize: 11.5, color: 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.description}
                </div>
              )}
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {s.usedBy.map((u) => u.name).join(', ') || 'Not used yet'}
            </span>
            <span style={{
              font: `400 12px var(--mono)`,
              color: s.set ? 'var(--text-muted)' : 'var(--text-faint)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {s.set ? MASK : '—'}
            </span>
            <div style={{ display: 'flex', gap: 4, justifySelf: 'end', alignItems: 'center' }}>
              <button
                className="ad-btn-icon"
                onClick={() => setModal({ mode: 'edit', id: s.id, name: s.name, description: s.description, set: s.set, usedBy: s.usedBy })}
                title="Edit"
                aria-label="Edit secret"
              >
                <i className="fa-solid fa-pen" style={{ fontSize: 11 }} />
              </button>
              <button
                className="ad-btn-icon danger"
                onClick={() => setDel(s)}
                title="Delete"
                aria-label="Delete secret"
              >
                <i className="fa-solid fa-trash-can" style={{ fontSize: 11 }} />
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
      {modal && <SecretModal key={modal.mode === 'edit' ? modal.name : 'add'} modal={modal} onClose={() => setModal(null)} />}
      {del && (
        <ConfirmModal
          title="Delete this secret?"
          body={(
            <>
              <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{del.name}</span>
              {' '}will be removed from your {copy.secretStore}. This can’t be undone.
              {del.usedBy.length > 0 && (
                <p style={{ color: 'var(--red-text)', margin: '8px 0 0' }}>
                  “{del.usedBy.map((u) => u.name).join(', ')}” uses it and will stop working.
                </p>
              )}
            </>
          )}
          confirmLabel="Delete secret"
          danger
          onConfirm={() => { void confirmDelete() }}
          onCancel={() => setDel(null)}
        />
      )}
    </div>
  )
}
