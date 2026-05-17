const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  createSession: (payload) => ipcRenderer.invoke('session:create', payload),
  joinSession: (payload) => ipcRenderer.invoke('session:join', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getRuntimeInfo: () => ipcRenderer.invoke('app:getRuntimeInfo'),
  onRuntimeUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('app:runtimeUpdate', handler);
    return () => ipcRenderer.removeListener('app:runtimeUpdate', handler);
  },
});
