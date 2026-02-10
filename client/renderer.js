/**
 * Rey Voice Client - Renderer Process
 * Handles microphone capture, WebSocket streaming, and audio playback
 */

class ReyVoiceClient {
  constructor() {
    this.serverUrl = null;
    this.socket = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.state = 'waiting';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isPlayingAudio = false;
    
    // UI elements
    this.app = document.getElementById('app');
    this.connectionDot = document.getElementById('connection-dot');
    this.statusText = document.getElementById('status');
    this.message = document.getElementById('message');
    this.visualizer = document.getElementById('visualizer');
    this.errorDiv = document.getElementById('error');
    this.character = document.getElementById('character');
    this.characterImage = document.getElementById('characterImage');
    this.currentExpression = 'neutral';
    this.hideBtn = document.getElementById('hideBtn');
    this.settingsBtn = document.getElementById('settingsBtn');
    this.transcriptBtn = document.getElementById('transcriptBtn');
    this.replayBtn = document.getElementById('replayBtn');
    this.transcriptPanel = document.getElementById('transcriptPanel');
    
    // Transcript history (load from localStorage)
    this.transcript = this.loadTranscript();
    this.lastResponse = null;
    this.lastAudio = null;
    
    this.init();
  }

  async init() {
    // Create visualizer bars
    this.createVisualizerBars();
    
    // Get config from main process
    const config = await window.electronAPI.getConfig();
    this.serverUrl = config.serverUrl;
    this.authToken = config.authToken || '';
    this.wakeWordEnabled = config.wakeWordEnabled !== false; // default true
    
    // Set up event listeners
    window.electronAPI.onPushToTalk(() => this.handlePushToTalk());
    window.electronAPI.onPushToTalkStart(() => this.handlePushToTalkStart());
    window.electronAPI.onPushToTalkStop(() => this.handlePushToTalkStop());
    window.electronAPI.onPushToWake(() => this.handlePushToWake());
    
    // Window control buttons
    if (this.hideBtn) {
      this.hideBtn.addEventListener('click', () => window.electronAPI.hideWindow());
    }
    if (this.settingsBtn) {
      this.settingsBtn.addEventListener('click', () => window.electronAPI.openSettings());
    }
    if (this.transcriptBtn) {
      this.transcriptBtn.addEventListener('click', () => this.toggleTranscript());
    }
    if (this.replayBtn) {
      this.replayBtn.addEventListener('click', () => this.replayLastMessage());
    }
    
    // Hotkeys from main process
    window.electronAPI.onReplayLastMessage(() => this.replayLastMessage());
    window.electronAPI.onToggleTranscript(() => this.toggleTranscript());
    
    // Set initial expression
    this.setExpression('neutral');
    
    // Enable copy in transcript panel
    this.setupTranscriptCopy();
    
    // Connect first, then start audio
    this.connect();
    setTimeout(() => this.setupAudio(), 500);
  }

  createVisualizerBars() {
    if (!this.visualizer) return;
    const numBars = 30;
    this.visualizer.innerHTML = '';
    for (let i = 0; i < numBars; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = '4px';
      this.visualizer.appendChild(bar);
    }
    this.bars = this.visualizer.querySelectorAll('.bar');
  }

  async setupAudio() {
    try {
      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      // Create audio context
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      
      // Load AudioWorklet processor
      await this.audioContext.audioWorklet.addModule('audio-processor.js');
      
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Create AudioWorklet node (modern replacement for ScriptProcessorNode)
      this.processor = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
      
      // Handle audio data from worklet
      this.processor.port.onmessage = (event) => {
        try {
          if (event.data.type === 'audio') {
            // Update visualizer
            const float32 = new Float32Array(event.data.data.byteLength / 2);
            const int16 = new Int16Array(event.data.data);
            for (let i = 0; i < int16.length; i++) {
              float32[i] = int16[i] / 32768;
            }
            this.updateVisualizer(float32);
            
            // Send to server if connected
            if (this.socket?.readyState === WebSocket.OPEN) {
              this.socket.send(event.data.data);
            }
          }
        } catch (err) {
          console.error('Audio processing error:', err);
        }
      };

      source.connect(this.processor);
      // No need to connect to destination for capture-only
      
      console.log('Audio setup complete (AudioWorklet)');
    } catch (err) {
      console.error('Audio setup failed:', err);
      this.showError('Microphone access denied. Please enable microphone permissions.');
    }
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    
    this.statusText.textContent = 'Connecting...';
    
    // Build URL with auth token if provided
    let wsUrl = this.serverUrl;
    if (this.authToken) {
      const separator = wsUrl.includes('?') ? '&' : '?';
      wsUrl = `${wsUrl}${separator}token=${this.authToken}`;
    }
    console.log('Attempting to connect to:', this.serverUrl);
    
    try {
      this.socket = new WebSocket(wsUrl);
      this.socket.binaryType = 'arraybuffer';
      
      this.socket.onopen = () => {
        console.log('Connected to Rey server');
        this.connectionDot.classList.add('connected');
        this.statusText.textContent = 'Connected';
        this.reconnectAttempts = 0;
        this.hideError();
        
        // Send wake word preference to server
        this.socket.send(JSON.stringify({ 
          type: 'config', 
          wakeWordEnabled: this.wakeWordEnabled 
        }));
        
        // Start keepalive pings every 30 seconds
        this.startKeepalive();
      };
      
      this.socket.onclose = () => {
        console.log('Disconnected from Rey server');
        this.connectionDot.classList.remove('connected');
        this.statusText.textContent = 'Disconnected';
        this.stopKeepalive();
        this.attemptReconnect();
      };
      
      this.socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.showError('Connection error. Is the Rey server running?');
      };
      
      this.socket.onmessage = (event) => {
        // Check for binary data (Blob or ArrayBuffer)
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
          // Audio data - play it
          this.playAudio(event.data);
        } else if (typeof event.data === 'string') {
          // JSON message
          try {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
          } catch (err) {
            console.error('Failed to parse message:', err, event.data);
          }
        }
      };
    } catch (err) {
      console.error('Connection failed:', err);
      this.showError('Failed to connect to server');
      this.attemptReconnect();
    }
  }

  startKeepalive() {
    this.stopKeepalive(); // Clear any existing
    this.keepaliveInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000); // Every 30 seconds
  }

  stopKeepalive() {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.showError('Could not connect to Rey server. Please check that it\'s running.');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => this.connect(), delay);
  }

  handleMessage(data) {
    switch (data.type) {
      case 'state':
        // Ignore state changes while audio is playing
        if (!this.isPlayingAudio) {
          this.setState(data.state, data.message);
          // Notify main process when we're back to waiting (listening stopped)
          if (data.state === 'waiting') {
            window.electronAPI.listeningStopped();
          }
        }
        break;
      case 'response':
        this.message.textContent = data.rey_text.substring(0, 80) + (data.rey_text.length > 80 ? '...' : '');
        // Set expression from server metadata
        if (data.expression) {
          this.setExpression(data.expression);
        }
        // Add to transcript
        if (data.user_text) {
          this.addToTranscript('user', data.user_text);
        }
        this.addToTranscript('rey', data.rey_text);
        // Store for replay
        this.lastResponse = data.rey_text;
        break;
      case 'error':
        this.showError(data.message);
        break;
      case 'notification':
        // Incoming notification from inbox
        console.log('Notification:', data);
        this.message.textContent = data.message.substring(0, 80) + (data.message.length > 80 ? '...' : '');
        if (data.priority === 'urgent') {
          this.setExpression('surprised');
        } else {
          this.setExpression('happy');
        }
        // Add notification to transcript
        const notifText = data.title ? `[${data.title}] ${data.message}` : data.message;
        this.addToTranscript('rey', notifText);
        this.lastResponse = data.message;
        break;
      case 'keepalive':
        // Ignore keepalive messages
        break;
    }
  }

  setState(state, message) {
    this.state = state;
    this.app.className = `container state-${state}`;
    
    if (message) {
      this.message.textContent = message;
    } else {
      switch (state) {
        case 'waiting':
          this.message.textContent = "Ready";
          this.statusText.textContent = 'READY';
          this.setExpression('neutral');
          break;
        case 'listening':
          this.message.textContent = "I'm listening...";
          this.statusText.textContent = 'LISTENING';
          this.setExpression('listening');
          break;
        case 'processing':
          this.message.textContent = 'Hmm let me think...';
          this.statusText.textContent = 'THINKING';
          this.setExpression('thinking');
          break;
        case 'speaking':
          this.statusText.textContent = 'SPEAKING';
          this.setExpression('speaking');
          break;
      }
    }
  }

  setExpression(expression) {
    if (this.character && this.characterImage) {
      // Remove all expr- classes first
      this.character.classList.forEach(cls => {
        if (cls.startsWith('expr-')) {
          this.character.classList.remove(cls);
        }
      });
      this.character.classList.add(`expr-${expression}`);
      
      // Update the image
      this.characterImage.src = `assets/expressions/${expression}.png`;
      this.currentExpression = expression;
      console.log('Expression:', expression);
    }
  }

  updateVisualizer(audioData) {
    if (!this.bars) return;
    
    // Simple visualization based on audio amplitude
    const step = Math.floor(audioData.length / this.bars.length);
    
    for (let i = 0; i < this.bars.length; i++) {
      const start = i * step;
      const end = start + step;
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(audioData[j]);
      }
      const avg = sum / step;
      const height = Math.max(4, avg * 200);
      this.bars[i].style.height = `${Math.min(height, 50)}px`;
    }
  }

  async playAudio(data) {
    try {
      // Handle both Blob and ArrayBuffer
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'audio/mpeg' });
      
      // Store for replay (clone the data)
      if (data instanceof ArrayBuffer) {
        this.lastAudio = data.slice(0);
      } else if (data instanceof Blob) {
        this.lastAudio = await data.arrayBuffer();
      }
      
      const url = URL.createObjectURL(blob);
      
      // Use Audio element for reliable MP3 playback
      const audio = new Audio(url);
      
      // Lock into speaking state
      this.isPlayingAudio = true;
      this.setState('speaking', 'Speaking...');
      this.updateReplayButton();
      
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.isPlayingAudio = false;
        this.setState('waiting', "Ready");
        this.updateReplayButton();
      };
      
      audio.onerror = (err) => {
        console.error('Audio playback error:', err);
        URL.revokeObjectURL(url);
        this.isPlayingAudio = false;
        this.updateReplayButton();
      };
      
      await audio.play();
    } catch (err) {
      console.error('Audio playback error:', err);
      this.isPlayingAudio = false;
      this.updateReplayButton();
    }
  }

  handlePushToTalk() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    
    this.socket.send(JSON.stringify({ type: 'push_to_talk' }));
  }

  handlePushToTalkStart() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    
    // Start listening immediately
    this.socket.send(JSON.stringify({ type: 'push_to_talk_start' }));
  }

  handlePushToTalkStop() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    
    // Stop listening and process immediately
    this.socket.send(JSON.stringify({ type: 'push_to_talk_stop' }));
  }

  handlePushToWake() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    
    // Push to wake triggers the wake word detection flow
    // (as if the user said the wake word)
    this.socket.send(JSON.stringify({ type: 'push_to_wake' }));
  }

  showError(message) {
    this.errorDiv.textContent = message;
    this.errorDiv.style.display = 'block';
  }

  hideError() {
    this.errorDiv.style.display = 'none';
  }

  toggleTranscript() {
    const isVisible = this.transcriptPanel.classList.contains('show');
    this.transcriptPanel.classList.toggle('show');
    this.transcriptBtn.classList.toggle('active');
    
    if (!isVisible) {
      // Expanding to show transcript
      window.electronAPI.resizeWindow('expanded');
      this.renderTranscript();
    } else {
      // Collapsing to compact character view
      window.electronAPI.resizeWindow('compact');
    }
  }

  setupTranscriptCopy() {
    // Global Cmd/Ctrl+C handler (Electron doesn't provide this by default)
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        const selection = window.getSelection().toString();
        if (selection) {
          navigator.clipboard.writeText(selection).then(() => {
            console.log('Copied to clipboard');
          }).catch(err => {
            console.error('Copy failed:', err);
          });
        }
      }
    });
    
    // Right-click shows "Copied!" feedback
    this.transcriptPanel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const selection = window.getSelection().toString();
      if (selection) {
        navigator.clipboard.writeText(selection).then(() => {
          // Brief visual feedback
          const feedback = document.createElement('div');
          feedback.textContent = 'Copied!';
          feedback.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#333;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;z-index:9999;';
          document.body.appendChild(feedback);
          setTimeout(() => feedback.remove(), 800);
        });
      }
    });
  }

  loadTranscript() {
    try {
      const saved = localStorage.getItem('rey-transcript');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (err) {
      console.error('Failed to load transcript:', err);
    }
    return [];
  }

  saveTranscript() {
    try {
      localStorage.setItem('rey-transcript', JSON.stringify(this.transcript));
    } catch (err) {
      console.error('Failed to save transcript:', err);
    }
  }

  addToTranscript(role, text) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.transcript.push({ role, text, timestamp });
    
    // Keep only last 50 messages
    if (this.transcript.length > 50) {
      this.transcript.shift();
    }
    
    // Persist to localStorage
    this.saveTranscript();
    
    // Update display if visible
    if (this.transcriptPanel.classList.contains('show')) {
      this.renderTranscript();
    }
  }

  renderTranscript() {
    if (this.transcript.length === 0) {
      this.transcriptPanel.innerHTML = '<div class="transcript-empty">No messages yet</div>';
      return;
    }
    
    this.transcriptPanel.innerHTML = this.transcript.map((entry, i) => `
      <div class="transcript-entry ${entry.role}" data-index="${i}">
        <div class="transcript-text">${entry.text}</div>
        <div class="timestamp">${entry.timestamp}</div>
      </div>
    `).join('');
    
    // Click to copy
    this.transcriptPanel.querySelectorAll('.transcript-entry').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't copy if user is selecting text
        if (window.getSelection().toString()) return;
        
        const index = parseInt(el.dataset.index);
        const text = this.transcript[index]?.text;
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            el.style.opacity = '0.5';
            setTimeout(() => el.style.opacity = '1', 200);
          });
        }
      });
    });
    
    // Scroll to bottom
    this.transcriptPanel.scrollTop = this.transcriptPanel.scrollHeight;
  }

  updateReplayButton() {
    if (this.replayBtn) {
      this.replayBtn.disabled = this.isPlayingAudio;
      this.replayBtn.style.opacity = this.isPlayingAudio ? '0.3' : '1';
      this.replayBtn.style.cursor = this.isPlayingAudio ? 'not-allowed' : 'pointer';
    }
  }

  replayLastMessage() {
    // Don't replay while audio is already playing
    if (this.isPlayingAudio) return;
    
    if (this.lastAudio) {
      // Replay stored audio
      this.playAudio(this.lastAudio);
    } else if (this.lastResponse) {
      // Request re-synthesis from server
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ 
          type: 'replay_last',
          text: this.lastResponse 
        }));
      }
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new ReyVoiceClient();
});
