const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('autowright', {
  backendInfo: () => ipcRenderer.invoke('backend-info'),
  // §3 ensure-backend outcome for the §9 boot splash
  backendStatus: () => ipcRenderer.invoke('backend-status'),
  // §3 CLI on PATH: shim state + explicit privileged install (§10 step 3,
  // §4.9 COMMAND LINE card)
  cliStatus: () => ipcRenderer.invoke('cli-status'),
  cliInstall: () => ipcRenderer.invoke('cli-install'),
  openApp: (hash) => ipcRenderer.invoke('open-app', hash),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
  resizePanel: (h) => ipcRenderer.invoke('resize-panel', h),
  // §5.1 transfer archives: native dialogs + file IO for export/import
  saveFile: (defaultName, data) => ipcRenderer.invoke('save-file', defaultName, data),
  openArchive: () => ipcRenderer.invoke('open-archive'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  // §9.5 report modal: OS details for the info block
  platformInfo: () => ipcRenderer.invoke('platform-info'),
  // §4.9 shell-owned settings effects (login item + tray icon)
  applySettings: (s) => ipcRenderer.invoke('apply-settings', s),
  // §9.3 developer log overlay
  tailLogs: () => ipcRenderer.invoke('tail-logs'),
  listRequestLogs: () => ipcRenderer.invoke('list-request-logs'),
  readRequestLog: (name) => ipcRenderer.invoke('read-request-log', name),
  trayAlert: (on) => ipcRenderer.invoke('tray-alert', on),
  // §9.4 in-app updates (§3): manual check → download → restart-install
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  // Download percent (null = size unknown). Re-registering replaces the
  // previous listener — the About page re-subscribes on every mount.
  onUpdateProgress: (cb) => {
    ipcRenderer.removeAllListeners('update-progress')
    ipcRenderer.on('update-progress', (_e, pct) => cb(pct))
  },
  // §3 update-available: known newer version (or null) + push on later finds.
  updateAvailable: () => ipcRenderer.invoke('update-available'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.removeAllListeners('update-available')
    ipcRenderer.on('update-available', (_e, version) => cb(version))
  },
  // Deep-link target ('/app?auto=<id>') pushed by main when the window already
  // exists — a reload would drop the WS and all renderer state.
  onOpenTarget: (cb) => ipcRenderer.on('open-target', (_e, hash) => cb(hash)),
})
