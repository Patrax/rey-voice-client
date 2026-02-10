/**
 * Rey Voice Client - Settings Renderer
 * Handles settings UI interactions
 */

class SettingsManager {
  constructor() {
    // UI elements
    this.serverUrlInput = document.getElementById('serverUrl');
    this.authTokenInput = document.getElementById('authToken');
    this.toggleTokenBtn = document.getElementById('toggleToken');
    this.hotkeyDisplay = document.getElementById('hotkeyDisplay');
    this.recordHotkeyBtn = document.getElementById('recordHotkey');
    this.clearHotkeyBtn = document.getElementById('clearHotkey');
    this.saveBtn = document.getElementById('saveBtn');
    this.cancelBtn = document.getElementById('cancelBtn');
    this.statusMessage = document.getElementById('statusMessage');
    
    this.isRecordingHotkey = false;
    this.currentHotkey = '';
    
    this.init();
  }

  async init() {
    // Load current config
    const config = await window.settingsAPI.getConfig();
    this.populateFields(config);
    
    // Set up event listeners
    this.toggleTokenBtn.addEventListener('click', () => this.toggleTokenVisibility());
    this.recordHotkeyBtn.addEventListener('click', () => this.startHotkeyRecording());
    this.clearHotkeyBtn.addEventListener('click', () => this.clearHotkey());
    this.saveBtn.addEventListener('click', () => this.saveSettings());
    this.cancelBtn.addEventListener('click', () => window.settingsAPI.closeSettings());
    
    // Listen for hotkey capture from main process
    window.settingsAPI.onHotkeyCaptured((accelerator) => {
      this.hotkeyRecorded(accelerator);
    });
    
    // Keyboard listener for recording
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  populateFields(config) {
    this.serverUrlInput.value = config.serverUrl || '';
    this.authTokenInput.value = config.authToken || '';
    
    if (config.hotkey) {
      this.currentHotkey = config.hotkey;
      this.updateHotkeyDisplay(config.hotkey);
    }
    
    if (config.hotkeyMode) {
      const radio = document.querySelector(`input[name="hotkeyMode"][value="${config.hotkeyMode}"]`);
      if (radio) radio.checked = true;
    }
  }

  toggleTokenVisibility() {
    const isPassword = this.authTokenInput.type === 'password';
    this.authTokenInput.type = isPassword ? 'text' : 'password';
    this.toggleTokenBtn.textContent = isPassword ? '🔒' : '👁';
  }

  startHotkeyRecording() {
    this.isRecordingHotkey = true;
    this.hotkeyDisplay.classList.add('recording');
    this.hotkeyDisplay.innerHTML = '<span class="placeholder">Press any key combination...</span>';
    this.recordHotkeyBtn.textContent = 'Cancel';
    this.recordHotkeyBtn.onclick = () => this.cancelHotkeyRecording();
    
    // Tell main process to start capturing
    window.settingsAPI.startHotkeyCapture();
  }

  cancelHotkeyRecording() {
    this.isRecordingHotkey = false;
    this.hotkeyDisplay.classList.remove('recording');
    this.updateHotkeyDisplay(this.currentHotkey);
    this.recordHotkeyBtn.textContent = 'Record';
    this.recordHotkeyBtn.onclick = () => this.startHotkeyRecording();
    
    window.settingsAPI.stopHotkeyCapture();
  }

  handleKeyDown(e) {
    if (!this.isRecordingHotkey) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Build accelerator string
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    
    // Get the key
    let key = e.key;
    
    // Normalize key names
    if (key === ' ') key = 'Space';
    else if (key === 'ArrowUp') key = 'Up';
    else if (key === 'ArrowDown') key = 'Down';
    else if (key === 'ArrowLeft') key = 'Left';
    else if (key === 'ArrowRight') key = 'Right';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key.startsWith('F') && key.length <= 3) key = key; // F1-F24
    else if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
      // Don't record modifier-only presses
      return;
    }
    
    parts.push(key);
    
    const accelerator = parts.join('+');
    this.hotkeyRecorded(accelerator);
  }

  hotkeyRecorded(accelerator) {
    this.isRecordingHotkey = false;
    this.currentHotkey = accelerator;
    this.hotkeyDisplay.classList.remove('recording');
    this.updateHotkeyDisplay(accelerator);
    this.recordHotkeyBtn.textContent = 'Record';
    this.recordHotkeyBtn.onclick = () => this.startHotkeyRecording();
  }

  updateHotkeyDisplay(hotkey) {
    if (hotkey) {
      // Make it look nice
      const display = hotkey
        .replace('CommandOrControl', '⌘/Ctrl')
        .replace('Shift', '⇧')
        .replace('Alt', '⌥')
        .replace(/\+/g, ' + ');
      this.hotkeyDisplay.innerHTML = `<span>${display}</span>`;
    } else {
      this.hotkeyDisplay.innerHTML = '<span class="placeholder">No hotkey set</span>';
    }
  }

  clearHotkey() {
    this.currentHotkey = '';
    this.updateHotkeyDisplay('');
  }

  async saveSettings() {
    const hotkeyMode = document.querySelector('input[name="hotkeyMode"]:checked')?.value || 'push_to_talk';
    
    const config = {
      serverUrl: this.serverUrlInput.value.trim(),
      authToken: this.authTokenInput.value.trim(),
      hotkey: this.currentHotkey,
      hotkeyMode: hotkeyMode
    };
    
    try {
      await window.settingsAPI.saveConfig(config);
      this.showStatus('Settings saved! Restart may be required for some changes.', 'success');
      
      // Close after a brief delay
      setTimeout(() => {
        window.settingsAPI.closeSettings();
      }, 1500);
    } catch (err) {
      this.showStatus('Failed to save settings: ' + err.message, 'error');
    }
  }

  showStatus(message, type) {
    this.statusMessage.textContent = message;
    this.statusMessage.className = `status-message show ${type}`;
    
    setTimeout(() => {
      this.statusMessage.classList.remove('show');
    }, 3000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new SettingsManager();
});
