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
    
    // UI elements
    this.app = document.getElementById('app');
    this.connectionStatus = document.getElementById('connection-status');
    this.message = document.getElementById('message');
    this.visualizer = document.getElementById('visualizer');
    this.errorDiv = document.getElementById('error');
    
    this.init();
  }

  async init() {
    // Create visualizer bars
    this.createVisualizerBars();
    
    // Get config from main process
    const config = await window.electronAPI.getConfig();
    this.serverUrl = config.serverUrl;
    
    // Set up event listeners
    window.electronAPI.onPushToTalk(() => this.handlePushToTalk());
    
    // Start audio and connect
    await this.setupAudio();
    this.connect();
  }

  createVisualizerBars() {
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
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Create script processor for raw audio access
      this.processor = this.audioContext.createScriptProcessor(512, 1, 1);
      
      this.processor.onaudioprocess = (e) => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Convert float32 to int16
          const int16Data = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            int16Data[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
          }
          
          // Send to server
          this.socket.send(int16Data.buffer);
          
          // Update visualizer
          this.updateVisualizer(inputData);
        }
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      
      console.log('Audio setup complete');
    } catch (err) {
      console.error('Audio setup failed:', err);
      this.showError('Microphone access denied. Please enable microphone permissions.');
    }
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    
    this.connectionStatus.textContent = 'Connecting...';
    this.connectionStatus.className = 'status';
    
    try {
      this.socket = new WebSocket(this.serverUrl);
      
      this.socket.onopen = () => {
        console.log('Connected to Rey server');
        this.connectionStatus.textContent = 'Connected';
        this.connectionStatus.className = 'status connected';
        this.reconnectAttempts = 0;
        this.hideError();
      };
      
      this.socket.onclose = () => {
        console.log('Disconnected from Rey server');
        this.connectionStatus.textContent = 'Disconnected';
        this.connectionStatus.className = 'status disconnected';
        this.attemptReconnect();
      };
      
      this.socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.showError('Connection error. Is the Rey server running?');
      };
      
      this.socket.onmessage = (event) => {
        if (event.data instanceof Blob) {
          // Audio data - play it
          this.playAudio(event.data);
        } else {
          // JSON message
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        }
      };
    } catch (err) {
      console.error('Connection failed:', err);
      this.showError('Failed to connect to server');
      this.attemptReconnect();
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
        this.setState(data.state, data.message);
        break;
      case 'response':
        this.message.textContent = data.rey_text.substring(0, 100) + (data.rey_text.length > 100 ? '...' : '');
        break;
      case 'error':
        this.showError(data.message);
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
          this.message.textContent = 'Say "Hey Rey" to start';
          break;
        case 'listening':
          this.message.textContent = 'Listening...';
          break;
        case 'processing':
          this.message.textContent = 'Thinking...';
          break;
        case 'speaking':
          this.message.textContent = 'Speaking...';
          break;
      }
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

  async playAudio(blob) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.start();
      
      source.onended = () => {
        // Audio finished playing
        if (this.state === 'speaking') {
          this.setState('waiting');
        }
      };
    } catch (err) {
      console.error('Audio playback error:', err);
    }
  }

  handlePushToTalk() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    
    this.socket.send(JSON.stringify({ type: 'push_to_talk' }));
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
