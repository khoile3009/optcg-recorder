// Bridges for both windows. The library UI uses window.recorder; the hidden
// recorder window uses window.capture.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recorder', {
  status: () => ipcRenderer.invoke('app:status'),
  list: () => ipcRenderer.invoke('lib:list'),
  update: (id, patch) => ipcRenderer.invoke('lib:update', id, patch),
  remove: (id) => ipcRenderer.invoke('lib:delete', id),
  reveal: (id) => ipcRenderer.invoke('lib:reveal', id),
  start: () => ipcRenderer.invoke('rec:manualStart'),
  stop: () => ipcRenderer.invoke('rec:manualStop'),
  listSources: () => ipcRenderer.invoke('app:listSources'),
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
  chooseSourceDir: () => ipcRenderer.invoke('app:chooseSourceDir'),
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
})
