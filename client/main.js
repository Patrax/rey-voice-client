const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Config file path
const configPath = path.join(__dirname, 'config.json');

// Load config from file
function loadConfig() {
  const defaults = {
    serverUrl: 'wss://rey.patriciojeri.com/voice',
    authToken: '',
    hotkey: 'CommandOrControl+Shift+R',
    hotkeyMode: 'push_to_talk',
    replayHotkey: '',
    transcriptHotkey: '',
    toggleWindowHotkey: '',
    wakeWordEnabled: true
  };
  
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaults, ...fileConfig };
    } catch (e) {
      console.error('Failed to load config.json:', e);
    }
  }
  return defaults;
}

// Save config to file
function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save config.json:', e);
    return false;
  }
}

let config = loadConfig();
let mainWindow = null;
let settingsWindow = null;
let tray = null;

function createWindow() {
  // Start in compact mode (character only)
  const initialSize = { width: 220, height: 240 };
  
  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visibleOnAllWorkspaces: true,  // Follow across macOS Spaces
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  // macOS: ensure it stays on all spaces even after hide/show
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  mainWindow.loadFile('index.html');
  
  // Only open DevTools in development (not in packaged app)
  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  
  // Log renderer crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Renderer crashed:', details);
  });
  
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
  mainWindow.setPosition(width - initialSize.width - 20, height - initialSize.height - 20);
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'settings-preload.js')
    }
  });

  settingsWindow.loadFile('settings.html');
  settingsWindow.setMenu(null);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createTray() {
  // Create a simple tray icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAKoSURBVFiF7ZdNaBNBFMd/s5tsNjFJk9aksdVqi4iCIl4EwYMiXgQvnrzpQfDkxYsH8ebNkyAIgnhRPHj0IIIgngQ/QKRYrYq2tm6apslukt1kdz0k2yZNG1MLHvzDsLOz7/3fezM7M6v8N0klf8qNqlTpPBFa9gYBoB7AdxAENIAAKCJCTdMwTZNyuUwymaS3t5dAIEBraytjY2PcvXuXeDxOc3MzhUIBgEAgQCqVwjRNrl27RmtrK4qi8OHDB7q6ulBVlZs3bzI0NMT58+fp6+tj48aNbN68mWg0SmdnJx0dHRw5coT+/n6i0SjLli0jmUxy6NAhBgcHCYfDLC4u8v79e5YtW4aqqkteoISLTucBD3A7m2FxcZHZ2Vl0XWdoaAhd10mn01itVmKxGK2trbS0tBAKhYjFYrS3txMIBHjy5AlHjx5F13W6u7sJBoO4XC4AmpubKZVKaJpGPp/H7Xbz7ds3XC4X8/PzXL9+na9fv6KqKmNjY6iqyldfn1fJZsukUnkA3G43wWCQbDbLzp07KZfLFAoFnj59itvtJpfLEQgESKfTpFIpCoUC8XicQqHA4OAghUKBVCpFoVDA7/dTLBY5duwYsViMtrY2ampqyGQyxONxVFXl0qVLfP78mUgkgtfr5fnz52iaRigUIplMEolEOHDgAKdPn+bbt29LNkjWNA0ASinsdjtGOU+ydJV0tgLAyMgIiqJQU1NDKpWira0NSikymQzT09O43W6SySSGYeDz+QCIx+Pk83taWloYHBzE4XBgGAaqqpLNZsnn86TTacrlcrUDDENHBdnpUqLF74+Rm1vA7nBQKpVwuVw4nU48Hg9er5dwOIyu62iaRnt7Oz6fj/r6ehRFoa6uDqfTiaZpNDY2YrFYcLvdTE1N4XK5/lkH/I/fAP4R/ATnZsB/EQ9/mwAAAABJRU5ErkJggg=='
  );
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Rey', click: () => mainWindow.show() },
    { label: 'Push to Talk', accelerator: config.hotkey || 'CommandOrControl+Shift+R', click: () => {
      triggerHotkey();
    }},
    { type: 'separator' },
    { label: 'Settings', click: () => createSettingsWindow() },
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

let isListening = false;

function triggerHotkey() {
  if (!mainWindow) return;
  
  mainWindow.show();
  
  if (config.hotkeyMode === 'push_to_wake') {
    mainWindow.webContents.send('push-to-wake');
  } else {
    // Toggle mode: press to start, press again to stop
    if (isListening) {
      mainWindow.webContents.send('push-to-talk-stop');
      isListening = false;
    } else {
      mainWindow.webContents.send('push-to-talk-start');
      isListening = true;
    }
  }
}

// Reset listening state when processing is done
ipcMain.on('listening-stopped', () => {
  isListening = false;
});

function registerShortcuts() {
  // Unregister all first
  globalShortcut.unregisterAll();
  
  // Register custom hotkey if set
  if (config.hotkey) {
    try {
      const registered = globalShortcut.register(config.hotkey, () => {
        triggerHotkey();
      });
      
      if (!registered) {
        console.error('Failed to register hotkey:', config.hotkey);
      } else {
        console.log('Registered hotkey:', config.hotkey);
      }
    } catch (err) {
      console.error('Invalid hotkey:', config.hotkey, err);
    }
  }
  
  // Settings shortcut (Cmd+, on Mac, Ctrl+, on others)
  globalShortcut.register('CommandOrControl+,', () => {
    createSettingsWindow();
  });
  
  // Replay last message hotkey
  if (config.replayHotkey) {
    try {
      const registered = globalShortcut.register(config.replayHotkey, () => {
        if (mainWindow) {
          mainWindow.webContents.send('replay-last-message');
          mainWindow.show();
        }
      });
      if (registered) {
        console.log('Registered replay hotkey:', config.replayHotkey);
      }
    } catch (err) {
      console.error('Invalid replay hotkey:', config.replayHotkey, err);
    }
  }
  
  // Toggle transcript hotkey
  if (config.transcriptHotkey) {
    try {
      const registered = globalShortcut.register(config.transcriptHotkey, () => {
        if (mainWindow) {
          mainWindow.webContents.send('toggle-transcript');
          mainWindow.show();
        }
      });
      if (registered) {
        console.log('Registered transcript hotkey:', config.transcriptHotkey);
      }
    } catch (err) {
      console.error('Invalid transcript hotkey:', config.transcriptHotkey, err);
    }
  }
  
  // Toggle window visibility hotkey
  if (config.toggleWindowHotkey) {
    try {
      const registered = globalShortcut.register(config.toggleWindowHotkey, () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
          }
        }
      });
      if (registered) {
        console.log('Registered toggle window hotkey:', config.toggleWindowHotkey);
      }
    } catch (err) {
      console.error('Invalid toggle window hotkey:', config.toggleWindowHotkey, err);
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();
  
  // macOS: Add app menu with Settings
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: 'About Rey', role: 'about' },
          { type: 'separator' },
          { label: 'Settings...', accelerator: 'CommandOrControl+,', click: () => createSettingsWindow() },
          { type: 'separator' },
          { label: 'Hide Rey', accelerator: 'CommandOrControl+H', role: 'hide' },
          { type: 'separator' },
          { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => { app.isQuitting = true; app.quit(); } }
        ]
      }
    ]);
    Menu.setApplicationMenu(appMenu);
  }
  
  // Send config to renderer when ready
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config', { 
      serverUrl: config.serverUrl, 
      authToken: config.authToken,
      wakeWordEnabled: config.wakeWordEnabled
    });
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

// IPC handlers for main window
ipcMain.handle('get-config', () => {
  return { 
    serverUrl: config.serverUrl, 
    authToken: config.authToken,
    wakeWordEnabled: config.wakeWordEnabled
  };
});

// IPC handlers for settings window
ipcMain.handle('get-full-config', () => {
  return config;
});

ipcMain.handle('save-config', (event, newConfig) => {
  config = { ...config, ...newConfig };
  const success = saveConfig(config);
  
  if (success) {
    // Re-register shortcuts with new hotkey
    registerShortcuts();
    
    // Update main window config
    if (mainWindow) {
      mainWindow.webContents.send('config', { 
        serverUrl: config.serverUrl, 
        authToken: config.authToken 
      });
    }
    
    // Rebuild tray menu with new accelerator
    if (tray) {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Rey', click: () => mainWindow.show() },
        { label: config.hotkeyMode === 'push_to_wake' ? 'Push to Wake' : 'Push to Talk', 
          accelerator: config.hotkey || undefined, 
          click: () => triggerHotkey() 
        },
        { type: 'separator' },
        { label: 'Settings', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => {
          app.isQuitting = true;
          app.quit();
        }}
      ]);
      tray.setContextMenu(contextMenu);
    }
  }
  
  return success;
});

ipcMain.on('close-settings', () => {
  if (settingsWindow) {
    settingsWindow.close();
  }
});

ipcMain.on('hide-window', () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

ipcMain.on('open-settings', () => {
  createSettingsWindow();
});

// Window resizing for compact/expanded modes
const WINDOW_SIZES = {
  compact: { width: 220, height: 240 },
  expanded: { width: 400, height: 450 }
};

ipcMain.on('resize-window', (event, mode) => {
  if (!mainWindow) return;
  
  const size = WINDOW_SIZES[mode];
  if (!size) return;
  
  // Get current position to keep bottom-right anchored
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentWidth, currentHeight] = mainWindow.getSize();
  
  // Calculate new position to anchor bottom-right corner
  const newX = currentX + (currentWidth - size.width);
  const newY = currentY + (currentHeight - size.height);
  
  mainWindow.setBounds({
    x: newX,
    y: newY,
    width: size.width,
    height: size.height
  }, true); // animate
});
