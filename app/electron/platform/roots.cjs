// §5 per-OS data/log roots — the shell half of the one root table in
// spec/storage.md. Must match backend/autowright/paths.py exactly (§15 drift
// guard pins both sides). AUTOWRIGHT_HOME overrides are applied by the
// caller (main.cjs), not here.
const os = require('os')
const path = require('path')

function dataRootDefault(platform) {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Autowright')
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(local, 'Autowright')
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(xdg, 'autowright')
}

function logsRootDefault(platform) {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'Autowright')
  }
  if (platform === 'win32') {
    return path.join(dataRootDefault(platform), 'Logs')
  }
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(xdg, 'autowright', 'log')
}

module.exports = { dataRootDefault, logsRootDefault }
