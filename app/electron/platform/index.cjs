// §2 platform layer (shell half): select the per-OS module once. macOS is the
// original platform; Windows and Linux carry their own builds and any other
// platform composes the degraded fallback.
module.exports = process.platform === 'darwin'
  ? require('./darwin.cjs')
  : process.platform === 'win32'
    ? require('./win32.cjs')
    : process.platform === 'linux'
      ? require('./linux.cjs')
      : require('./fallback.cjs')
