const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('get-full-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  closeSettings: () => ipcRenderer.send('close-settings'),
  startHotkeyCapture: () => ipcRenderer.send('start-hotkey-capture'),
  stopHotkeyCapture: () => ipcRenderer.send('stop-hotkey-capture'),
  onHotkeyCaptured: (callback) => ipcRenderer.on('hotkey-captured', (_, accelerator) => callback(accelerator))
});
