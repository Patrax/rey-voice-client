const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

// Server configuration
const SERVER_URL = process.env.REY_SERVER_URL || 'ws://ubuntuserver:8765/voice';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
  
  // Hide instead of close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Position in bottom right corner
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  mainWindow.setPosition(width - 420, height - 320);
}

function createTray() {
  // Create a simple tray icon (🦞 lobster emoji as placeholder)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAKoSURBVFiF7ZdNaBNBFMd/s5tsNjFJk9aksdVqi4iCIl4EwYMiXgQvnrzpQfDkxYsH8ebNkyAIgnhRPHj0IIIgngQ/QKRYrYq2tm6apslukt1kdz0k2yZNG1MLHvzDsLOz7/3fezM7M6v8N0klf8qNqlTpPBFa9gYBoB7AdxAENIAAKCJCTdMwTZNyuUwymaS3t5dAIEBraytjY2PcvXuXeDxOc3MzhUIBgEAgQCqVwjRNrl27RmtrK4qi8OHDB7q6ulBVlZs3bzI0NMT58+fp6+tj48aNbN68mWg0SmdnJx0dHRw5coT+/n6i0SjLli0jmUxy6NAhBgcHCYfDLC4u8v79e5YtW4aqqkteoISLTucBD3A7m2FxcZHZ2Vl0XWdoaAhd10mn01itVmKxGK2trbS0tBAKhYjFYrS3txMIBHjy5AlHjx5F13W6u7sJBoO4XC4AmpubKZVKaJpGPp/H7Xbz7ds3XC4X8/PzXL9+na9fv6KqKmNjY6iqyldfn1fJZsukUnkA3G43wWCQbDbLzp07KZfLFAoFnj59itvtJpfLEQgESKfTpFIpCoUC8XicQqHA4OAghUKBVCpFoVDA7/dTLBY5duwYsViMtrY2ampqyGQyxONxVFXl0qVLfP78mUgkgtfr5fnz52iaRigUIplMEolEOHDgAKdPn+bbt29LNkjWNA0ASinsdjtGOU+ydJV0tgLAyMgIiqJQU1NDKpWira0NSikymQzT09O43W6SySSGYeDz+QCIx+Pk83laWloYHBzE4XBgGAaqqpLNZsnn86TTacrlcrUDDENHBdnpUqLF74+Rm1vA7nBQKpVwuVw4nU48Hg9er5dwOIyu62iaRnt7Oz6fj/r6ehRFoa6uDqfTiaZpNDY2YrFYcLvdTE1N4XK5/lkH/I/fAP4R/ATnZsB/EQ9/mwAAAABJRU5ErkJggg=='
  );
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Rey', click: () => mainWindow.show() },
    { label: 'Push to Talk', accelerator: 'CommandOrControl+Shift+R', click: () => {
      mainWindow.webContents.send('push-to-talk');
    }},
    { type: 'separator' },
    { label: 'Settings', click: () => { /* TODO */ }},
    { type: 'separator' },
    { label: 'Quit', click: () => {
      app.isQuitting = true;
      app.quit();
    }}
  ]);
  
  tray.setToolTip('Rey Voice Assistant');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function registerShortcuts() {
  // Global push-to-talk shortcut
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    mainWindow.webContents.send('push-to-talk');
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();
  
  // Send server URL to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config', { serverUrl: SERVER_URL });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC handlers
ipcMain.handle('get-config', () => {
  return { serverUrl: SERVER_URL };
});
