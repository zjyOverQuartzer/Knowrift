const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zhixi', {
  invoke: (action, args = {}) => ipcRenderer.invoke('zhixi:invoke', action, args),
  platform: 'desktop'
});
