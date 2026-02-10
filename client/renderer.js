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
    this.currentExpression = 'neutral';
    this.hideBtn = document.getElementById('hideBtn');
    this.settingsBtn = document.getElementById('settingsBtn');
    
    this.init();
  }

  async init() {
    // Create visualizer bars
    this.createVisualizerBars();
    
    // Get config from main process
    const config = await window.electronAPI.getConfig();
    this.serverUrl = config.serverUrl;
    this.authToken = config.authToken || '';
    
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
    
    // Set initial expression
    this.setExpression('neutral');
    
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
    if (this.character) {
      // Remove all expr- classes first
      this.character.classList.forEach(cls => {
        if (cls.startsWith('expr-')) {
          this.character.classList.remove(cls);
        }
      });
      this.character.classList.add(`expr-${expression}`);
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
      const url = URL.createObjectURL(blob);
      
      // Use Audio element for reliable MP3 playback
      const audio = new Audio(url);
      
      // Lock into speaking state
      this.isPlayingAudio = true;
      this.setState('speaking', 'Speaking...');
      
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.isPlayingAudio = false;
        this.setState('waiting', "Ready");
      };
      
      audio.onerror = (err) => {
        console.error('Audio playback error:', err);
        URL.revokeObjectURL(url);
        this.isPlayingAudio = false;
      };
      
      await audio.play();
    } catch (err) {
      console.error('Audio playback error:', err);
      this.isPlayingAudio = false;
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
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new ReyVoiceClient();
});
