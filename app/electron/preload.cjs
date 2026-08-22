const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('autowright', {
  backendInfo: () => ipcRenderer.invoke('backend-info'),
  // §3 ensure-backend outcome for the §9 boot splash
  backendStatus: () => ipcRenderer.invoke('backend-status'),
  // §3 CLI on PATH: shim state + explicit privileged install (§10 step 3,
  // §4.9 COMMAND LINE card)
  cliStatus: () => ipcRenderer.invoke('cli-status'),
  cliInstall: () => ipcRenderer.invoke('cli-install'),
  cliUninstall: () => ipcRenderer.invoke('cli-uninstall'),
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
  // §3 Homebrew-managed detection: true while the Caskroom dir exists — the
  // §9.4 row swaps Download for the brew upgrade notice.
  updateBrewManaged: () => ipcRenderer.invoke('update-brew-managed'),
  // §4.9 QUIT card: stop the backend service, then quit the app (§3
  // explicit-quit exception)
  quitAll: () => ipcRenderer.invoke('quit-all'),
  // §4.9 RESET card: erase every §5 file and every secret, then relaunch into
  // onboarding (§3 reset flow)
  resetAll: () => ipcRenderer.invoke('reset-all'),
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
  // Deep-link target ('/app?automation=<id>') pushed by main when the window already
  // exists — a reload would drop the WS and all renderer state. Re-registering
  // replaces the previous listener, like the two above: under §15's renderer
  // dev server a re-evaluated module would otherwise stack subscribers.
  onOpenTarget: (cb) => {
    ipcRenderer.removeAllListeners('open-target')
    ipcRenderer.on('open-target', (_e, hash) => cb(hash))
  },
})
