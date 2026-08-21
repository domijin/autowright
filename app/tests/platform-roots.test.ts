// §5 per-OS root table, shell half (§2 platform layer): electron/platform/
// roots.cjs must match backend paths.py — the backend half of this drift
// guard is tests/test_platform.py; both pin the same spec table.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(__filename)
const roots = require('../electron/platform/roots.cjs')

const saved: Record<string, string | undefined> = {}
const VARS = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'LOCALAPPDATA']

function clearEnv() {
  for (const v of VARS) {
    if (!(v in saved)) saved[v] = process.env[v]
    delete process.env[v]
  }
}

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
})

describe('§5 per-OS roots (drift guard vs backend paths.py)', () => {
  it('macOS: ~/Library/Application Support + ~/Library/Logs', () => {
    clearEnv()
    expect(roots.dataRootDefault('darwin'))
      .toBe(join(homedir(), 'Library', 'Application Support', 'Autowright'))
    expect(roots.logsRootDefault('darwin'))
      .toBe(join(homedir(), 'Library', 'Logs', 'Autowright'))
  })

  it('Linux: XDG data/state with ~/.local defaults', () => {
    clearEnv()
    expect(roots.dataRootDefault('linux'))
      .toBe(join(homedir(), '.local', 'share', 'autowright'))
    expect(roots.logsRootDefault('linux'))
      .toBe(join(homedir(), '.local', 'state', 'autowright', 'log'))
    process.env.XDG_DATA_HOME = join(homedir(), 'xdg-data')
    process.env.XDG_STATE_HOME = join(homedir(), 'xdg-state')
    expect(roots.dataRootDefault('linux')).toBe(join(homedir(), 'xdg-data', 'autowright'))
    expect(roots.logsRootDefault('linux')).toBe(join(homedir(), 'xdg-state', 'autowright', 'log'))
  })

  it('Windows: %LOCALAPPDATA%\\Autowright with the AppData default', () => {
    clearEnv()
    expect(roots.dataRootDefault('win32'))
      .toBe(join(homedir(), 'AppData', 'Local', 'Autowright'))
    expect(roots.logsRootDefault('win32'))
      .toBe(join(homedir(), 'AppData', 'Local', 'Autowright', 'Logs'))
    process.env.LOCALAPPDATA = join(homedir(), 'LocalAppData')
    expect(roots.dataRootDefault('win32')).toBe(join(homedir(), 'LocalAppData', 'Autowright'))
    expect(roots.logsRootDefault('win32')).toBe(join(homedir(), 'LocalAppData', 'Autowright', 'Logs'))
  })
})
