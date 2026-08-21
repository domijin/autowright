// §2 platform layer (shell half): select the per-OS module once. macOS is the
// only fully implemented platform; Windows gets the groundwork build and
// Linux composes the degraded fallback.
module.exports = process.platform === 'darwin'
  ? require('./darwin.cjs')
  : process.platform === 'win32'
    ? require('./win32.cjs')
    : require('./fallback.cjs')
