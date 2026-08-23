// §9 per-OS copy table, renderer half (src/platformCopyTable.ts): the rows the
// backend serves the same answers for — backend/autowright/paths.py's
// `machine_noun` and `secret_store_name` — must never drift from it. The
// backend half of this drift guard is tests/test_platform.py; both pin the
// same spec table, exactly like the §5 root-table pair
// (platform-roots.test.ts / test_platform.py).
//
// The table itself is store-free (§15), so this reads it directly — no render,
// no store, no platform sniff.
import { describe, expect, it } from 'vitest'

import { platformCopy } from '../src/platformCopyTable'

// §9: 'windows' and 'linux' take their own forms; every other token —
// including the '' boot default and anything unrecognized — keeps the macOS
// copy, so a mac render is byte-identical to a pre-rule one. The backend's
// helpers default the same way (`names.get(token, "Keychain")`).
const MAC_TOKENS = ['macos', '', 'freebsd']

describe('§9 per-OS copy table (drift guard vs backend paths.py)', () => {
  it('machine noun: Mac on macOS, PC on Windows and Linux alike', () => {
    for (const token of MAC_TOKENS) expect(platformCopy(token).machine).toBe('Mac')
    expect(platformCopy('windows').machine).toBe('PC')
    expect(platformCopy('linux').machine).toBe('PC')
  })

  it('secret store: Keychain / Credential Manager / system keyring', () => {
    // The §1 promise, the §4.8 Secrets page and every backend-served line that
    // names where secrets live read one of these three — from here in the
    // renderer, from paths.py in the backend.
    for (const token of MAC_TOKENS) expect(platformCopy(token).secretStore).toBe('Keychain')
    expect(platformCopy('windows').secretStore).toBe('Credential Manager')
    expect(platformCopy('linux').secretStore).toBe('system keyring')
  })

  it('the renderer-only rows keep their per-OS forms', () => {
    // These have no backend counterpart, but they are the same §9 table and a
    // silent edit to any of them is the same class of drift.
    expect(platformCopy('macos')).toMatchObject({
      fileManager: 'Finder', reveal: 'Show in Finder',
      cliBinDir: '~/.local/bin', terminalNoun: 'the Terminal', menuBar: 'menu bar',
    })
    expect(platformCopy('windows')).toMatchObject({
      fileManager: 'Explorer', reveal: 'Show in Explorer',
      cliBinDir: '%LOCALAPPDATA%\\Autowright\\bin', terminalNoun: 'a terminal', menuBar: 'tray',
    })
    expect(platformCopy('linux')).toMatchObject({
      fileManager: 'file manager', reveal: 'Show in file manager',
      cliBinDir: '~/.local/bin', terminalNoun: 'a terminal', menuBar: 'tray',
    })
  })
})
