// Shared secret add/edit modal (§4.8, §12): Keychain-backed name/value pairs —
// values are never fetched back. Opened by the Secrets page and by the §9.2
// Discord trigger editor's New secret button.
import React, { useState } from 'react'
import { api } from './api'
import { useStore } from './store'
import type { SecretMeta } from './types'
import { BtnGhost, BtnPrimary, Eyebrow, Modal } from './ui'

const NAME_RE = /^[A-Z][A-Z0-9_]*$/

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', color: 'var(--text)',
  font: `400 12.5px var(--mono)`, padding: '9px 11px',
}

export type SecretModalState = { mode: 'add' } | { mode: 'edit'; name: string; description: string; usedBy: string[] }

export function SecretModal({ modal, onClose, onSaved }: {
  modal: SecretModalState
  onClose: () => void
  // §19: the PUT response entity — carries the (possibly just-minted) §4.8 id
  onSaved?: (saved: SecretMeta) => void
}) {
  const { showToast, secrets } = useStore()
  const isAdd = modal.mode === 'add'
  const [name, setName] = useState(isAdd ? '' : modal.name)
  const [description, setDesc] = useState(isAdd ? '' : modal.description)
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)

  return (
    <Modal onClose={onClose} width={460} cardStyle={{ padding: '22px 24px' }}>
      {(close) => {
        const save = async () => {
          if (isAdd) {
            if (!name) { showToast('Give the secret a name.'); return }
            if (!NAME_RE.test(name)) { showToast('Secret names must start with a letter — A–Z, 0–9 and _ only.'); return }
            // The backend PUT is an upsert — adding an existing name would
            // silently replace its Keychain value with no undo.
            if (secrets.some((s) => s.name === name)) {
              showToast(`${name} already exists — edit it from the list instead.`)
              return
            }
          }
          try {
            // §4.8: a blank value on edit keeps the stored one (description-only
            // update); a blank value on add creates a placeholder (set: false).
            const saved = await api.putSecret(name, value, description)
            close()
            showToast(isAdd
              ? (value ? 'Saved to your Keychain.' : 'Saved — add the value before an automation needs it.')
              : 'Secret updated.')
            onSaved?.(saved)
          } catch (e) { showToast((e as Error).message) }
        }

        const onKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === 'Enter') void save()
        }

        // Value is a textarea (multi-line values are allowed): Enter inserts a
        // newline, Cmd/Ctrl+Enter saves. Escape is handled by the Modal shell.
        const onValueKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
        }

        return (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 6px', color: 'var(--text)' }}>
              {isAdd ? 'New secret' : 'Edit secret'}
            </h2>
            <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)', margin: '0 0 18px' }}>
              {isAdd
                ? 'A password or API key your automations use — the value itself never appears in a script or a log.'
                : 'A new value is used from the next execution onward — leave the value blank to keep the current one.'}
            </p>
            <Eyebrow style={{ margin: '0 0 6px' }}>NAME</Eyebrow>
            {isAdd ? (
              <input
                className="ad-input"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                onKeyDown={onKeyDown}
                autoFocus
                spellCheck={false}
                placeholder="A short name, like MAIL_PASSWORD or CRM_API_KEY"
                style={inputStyle}
              />
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-inset)',
                border: '1px solid var(--hairline)', borderRadius: 7, padding: '9px 11px',
              }}>
                <i className="fa-solid fa-key" style={{ fontSize: 10, color: 'var(--text-faint)' }} />
                <span style={{ font: `500 12px var(--mono)`, color: 'var(--text)' }}>{name}</span>
                <span style={{
                  fontSize: 11, color: 'var(--text-faint)', marginLeft: 'auto',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {modal.mode === 'edit' ? (modal.usedBy.join(', ') || 'Not used yet') : ''}
                </span>
              </div>
            )}
            <Eyebrow style={{ margin: '16px 0 6px' }}>DESCRIPTION · OPTIONAL</Eyebrow>
            <input
              className="ad-input"
              value={description}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              placeholder="What this secret is for — helps the drafting agent pick the right secret"
              style={inputStyle}
            />
            <Eyebrow style={{ margin: '16px 0 6px' }}>VALUE</Eyebrow>
            <div style={{ position: 'relative' }}>
              <textarea
                className="ad-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onValueKeyDown}
                autoFocus={!isAdd}
                spellCheck={false}
                rows={3}
                placeholder={isAdd
                  ? 'Paste the password or API key — or leave blank to add the value later'
                  : 'Leave blank to keep the current value'}
                style={{
                  ...inputStyle, padding: '9px 62px 9px 11px', resize: 'vertical', minHeight: 60,
                  WebkitTextSecurity: show ? 'none' : 'disc',
                } as React.CSSProperties}
              />
              <button
                className="ad-btn-text small"
                onClick={() => setShow(!show)}
                style={{ position: 'absolute', right: 9, top: 11, borderRadius: 6 }}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 22 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-faint)', marginRight: 'auto' }}>
                <i className="fa-solid fa-lock" style={{ fontSize: 10 }} />
                Stored in your Mac’s Keychain
              </span>
              <BtnGhost onClick={close}>Cancel</BtnGhost>
              <BtnPrimary onClick={() => { void save() }}>
                {isAdd ? 'Save to Keychain' : 'Save changes'}
              </BtnPrimary>
            </div>
          </>
        )
      }}
    </Modal>
  )
}
