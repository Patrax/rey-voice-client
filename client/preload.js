const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onConfig: (callback) => ipcRenderer.on('config', (_, data) => callback(data)),
  onPushToTalk: (callback) => ipcRenderer.on('push-to-talk', () => callback()),
  onPushToTalkStart: (callback) => ipcRenderer.on('push-to-talk-start', () => callback()),
  onPushToTalkStop: (callback) => ipcRenderer.on('push-to-talk-stop', () => callback()),
  onPushToWake: (callback) => ipcRenderer.on('push-to-wake', () => callback()),
  hideWindow: () => ipcRenderer.send('hide-window'),
  openSettings: () => ipcRenderer.send('open-settings'),
  listeningStopped: () => ipcRenderer.send('listening-stopped')
});
