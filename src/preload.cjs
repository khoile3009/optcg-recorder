// Bridges for both windows. The library UI uses window.recorder; the hidden
// recorder window uses window.capture.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recorder', {
  status: () => ipcRenderer.invoke('app:status'),
  leaders: () => ipcRenderer.invoke('app:leaders'),
  list: () => ipcRenderer.invoke('lib:list'),
  update: (id, patch) => ipcRenderer.invoke('lib:update', id, patch),
  remove: (id) => ipcRenderer.invoke('lib:delete', id),
  reveal: (id) => ipcRenderer.invoke('lib:reveal', id),
  start: () => ipcRenderer.invoke('rec:manualStart'),
  stop: () => ipcRenderer.invoke('rec:manualStop'),
  listSources: () => ipcRenderer.invoke('app:listSources'),
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
  chooseSourceDir: () => ipcRenderer.invoke('app:chooseSourceDir'),
  useSourceDir: (dir) => ipcRenderer.invoke('app:useSourceDir', dir),
  chooseLibDir: () => ipcRenderer.invoke('app:chooseLibDir'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  openUpdatePage: () => ipcRenderer.invoke('app:openUpdatePage'),
  crewlogSet: (patch) => ipcRenderer.invoke('crewlog:set', patch),
  crewlogCheck: () => ipcRenderer.invoke('crewlog:check'),
  crewlogForget: () => ipcRenderer.invoke('crewlog:forget'),
  crewlogOpen: (url) => ipcRenderer.invoke('crewlog:open', url),
  onEvent: (cb) => {
    const l = (_e, ev) => cb(ev)
    ipcRenderer.on('app:event', l)
    return () => ipcRenderer.removeListener('app:event', l)
  },
})

contextBridge.exposeInMainWorld('capture', {
  onStart: (cb) => ipcRenderer.on('rec:start', (_e, opts) => cb(opts)),
  onStop: (cb) => ipcRenderer.on('rec:stop', (_e, opts) => cb(opts)),
  chunk: (id, bytes) => ipcRenderer.send('rec:chunk', id, bytes),
  stopped: (id) => ipcRenderer.send('rec:stopped', id),
  error: (id, message) => ipcRenderer.send('rec:error', id, message),
  warn: (id, message) => ipcRenderer.send('rec:warn', id, message),
  started: (id, atMs) => ipcRenderer.send('rec:started', id, atMs),
})
