// §2 platform layer (shell half): select the per-OS module once. macOS is the
// only implemented platform; everything else composes the degraded fallback.
module.exports = process.platform === 'darwin'
  ? require('./darwin.cjs')
  : require('./fallback.cjs')
