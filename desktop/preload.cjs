const { contextBridge, ipcRenderer } = require('electron');
const unwrap = async promise => { const result = await promise; if (!result.ok) throw Object.assign(new Error(result.error || '操作失败'), { code: result.code }); return result.data; };
contextBridge.exposeInMainWorld('zhixi', {
  invoke: (action, args = {}) => ipcRenderer.invoke('zhixi:invoke', action, args),
  platform: 'desktop',
  getRuntime: () => unwrap(ipcRenderer.invoke('zhixi:runtime')),
  retryService: name => unwrap(ipcRenderer.invoke('zhixi:retry-service', name)),
  projects: {
    list: () => unwrap(ipcRenderer.invoke('zhixi:projects', 'list')),
    get: id => unwrap(ipcRenderer.invoke('zhixi:projects', 'get', { id })),
    create: input => unwrap(ipcRenderer.invoke('zhixi:projects', 'create', input)),
    patch: (id, patch) => unwrap(ipcRenderer.invoke('zhixi:projects', 'patch', { id, patch })),
    openFolder: id => unwrap(ipcRenderer.invoke('zhixi:projects', 'openFolder', { id }))
  },
  chooseDirectory: () => unwrap(ipcRenderer.invoke('zhixi:choose-directory')),
  onRuntimeStatus: listener => { const handler = (_event, status) => listener(status); ipcRenderer.on('zhixi:runtime-status', handler); return () => ipcRenderer.removeListener('zhixi:runtime-status', handler); }
});
