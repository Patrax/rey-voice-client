const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onConfig: (callback) => ipcRenderer.on('config', (_, data) => callback(data)),
  onPushToTalk: (callback) => ipcRenderer.on('push-to-talk', () => callback())
});
