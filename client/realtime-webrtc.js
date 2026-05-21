/**
 * OpenAI Realtime WebRTC transport for Rey.
 *
 * Conversation-mode design:
 * - F19 starts a long-lived Realtime session.
 * - OpenAI server VAD owns turn detection and auto-response creation.
 * - F19 again ends the conversation/session.
 * - OpenClaw remains available as a private tool relay through Rey's server.
 */
class ReyRealtimeWebRTC {
  constructor({ getServerBaseUrl, getAuthToken, getMediaStream, onEvent, onError }) {
    this.getServerBaseUrl = getServerBaseUrl;
    this.getAuthToken = getAuthToken;
    this.getMediaStream = getMediaStream;
    this.onEvent = onEvent;
    this.onError = onError;

    this.pc = null;
    this.dc = null;
    this.remoteAudio = null;
    this.localStream = null;
    this.inputTrack = null;
    this.active = false;
    this.ownsLocalStream = false;
    this.toolArguments = new Map();
    this.startedAt = 0;
    this.watchdogTimer = null;
    this.resetTurnState();
  }

  resetTurnState() {
    this.userTranscript = '';
    this.responseText = '';
    this.delivered = false;
    this.speechStarted = false;
    this.speechStopped = false;
    this.audioDone = false;
    this.responseDone = false;
  }

  isActive() {
    return this.active;
  }

  isReady() {
    return this.dc?.readyState === 'open';
  }

  waitUntilReady(timeoutMs = 10000) {
    if (this.isReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const timer = setInterval(() => {
        if (this.isReady()) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (!this.active || performance.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('Realtime conversation was not ready'));
        }
      }, 50);
    });
  }

  async sendTextMessage(text) {
    const content = (text || '').trim();
    if (!content) return false;
    if (!this.active) await this.start({ reason: 'resend' });
    await this.waitUntilReady();
    this.resetTurnState();
    this.userTranscript = content;
    this.onEvent?.({ type: 'user_transcript', text: content });
    this.onEvent?.({ type: 'state', state: 'processing', message: 'Resending...' });
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: content }],
      },
    });
    this.send({ type: 'response.create', response: { output_modalities: ['audio'] } });
    return true;
  }

  async start({ reason = 'manual' } = {}) {
    if (this.active) return;
    this.active = true;
    this.startedAt = performance.now();
    this.toolArguments.clear();
    this.resetTurnState();
    this.clearTimers();

    this.watchdogTimer = setTimeout(() => {
      if (this.active) {
        this.onError?.(new Error('Realtime conversation timed out and was reset'));
        this.end();
      }
    }, 30 * 60 * 1000);

    try {
      this.onEvent?.({ type: 'state', state: 'listening', message: reason === 'wake' ? "Conversation active — I'm listening" : 'Starting conversation...' });

      const session = await this.createSession(reason);
      const clientSecret = session?.client_secret?.value;
      if (!clientSecret) throw new Error('Realtime session did not include a client secret');

      this.pc = new RTCPeerConnection();
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onopen = () => this.configureSession();
      this.dc.onmessage = (event) => this.handleRealtimeEvent(JSON.parse(event.data));
      this.dc.onerror = (event) => console.error('Realtime data channel error:', event);

      this.pc.ontrack = (event) => {
        if (!this.remoteAudio) {
          this.remoteAudio = new Audio();
          this.remoteAudio.autoplay = true;
          this.remoteAudio.onplaying = () => this.onEvent?.({ type: 'state', state: 'speaking', message: 'Speaking...' });
          this.remoteAudio.onended = () => this.onEvent?.({ type: 'state', state: 'listening', message: 'Conversation active — listening' });
        }
        this.remoteAudio.srcObject = event.streams[0];
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        console.log('Realtime WebRTC connection:', state);
        if (state === 'connected') {
          this.onEvent?.({ type: 'state', state: 'listening', message: 'Conversation active — speak naturally' });
        }
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          if (this.active) this.end();
        }
      };

      this.localStream = this.getMediaStream();
      if (!this.localStream) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.ownsLocalStream = true;
      }
      this.inputTrack = this.localStream.getAudioTracks()[0];
      if (!this.inputTrack) throw new Error('No microphone audio track available');
      this.inputTrack.enabled = true;
      this.pc.addTrack(this.inputTrack, this.localStream);

      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);

      const sdp = await this.exchangeSdp(offer.sdp, clientSecret, session.model);
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      this.onError?.(err);
      await this.close();
    }
  }

  async end() {
    if (!this.active) return;
    await this.close();
    this.onEvent?.({ type: 'state', state: 'waiting', message: 'Ready' });
  }

  async interrupt() {
    this.send({ type: 'response.cancel' });
    await this.end();
  }

  async close() {
    this.active = false;
    this.clearTimers();
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    if (this.remoteAudio) {
      try { this.remoteAudio.pause(); } catch {}
      this.remoteAudio.srcObject = null;
    }
    if (this.inputTrack) this.inputTrack.enabled = true;
    if (this.ownsLocalStream && this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
    this.pc = null;
    this.dc = null;
    this.remoteAudio = null;
    this.inputTrack = null;
    this.localStream = null;
    this.ownsLocalStream = false;
    this.toolArguments.clear();
    this.resetTurnState();
  }

  clearTimers() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async createSession(reason = 'manual') {
    const response = await fetch(`${this.getServerBaseUrl()}/realtime/session`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ transport: 'webrtc', reason, mode: 'conversation' }),
    });
    if (!response.ok) throw new Error(`Realtime session failed: ${response.status}`);
    return response.json();
  }

  async exchangeSdp(offerSdp, clientSecret, model) {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Realtime SDP exchange failed: ${response.status} ${text}`);
    }
    return response.text();
  }

  configureSession() {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
              create_response: true,
            },
          },
        },
        tools: [
          {
            type: 'function',
            name: 'ask_openclaw',
            description: "Ask Rey's OpenClaw brain to answer or perform a task with full private context, memory, tools, files, calendar, and home-server access.",
            parameters: {
              type: 'object',
              properties: {
                request: {
                  type: 'string',
                  description: "The user's request, rewritten clearly for OpenClaw while preserving intent and relevant context.",
                },
                target_area: {
                  type: 'string',
                  description: 'Optional project/channel target when Patricio names one, such as humanslivehere, tenpace, or rey-voice.',
                },
              },
              required: ['request'],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: 'auto',
      },
    });
    this.onEvent?.({ type: 'state', state: 'listening', message: 'Conversation active — speak naturally' });
  }

  handleRealtimeEvent(event) {
    const type = event.type;
    if (type === 'error') {
      const message = event.error?.message || JSON.stringify(event.error || event);
      this.onError?.(new Error(message));
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      this.speechStarted = true;
      this.speechStopped = false;
      this.responseText = '';
      this.userTranscript = '';
      this.delivered = false;
      this.audioDone = false;
      this.responseDone = false;
      this.onEvent?.({ type: 'speech_started' });
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      this.speechStopped = true;
      this.onEvent?.({ type: 'speech_stopped' });
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.userTranscript = event.transcript || this.userTranscript;
      if (this.userTranscript) this.onEvent?.({ type: 'user_transcript', text: this.userTranscript });
      return;
    }

    if (type === 'response.created') {
      this.responseText = '';
      this.delivered = false;
      this.audioDone = false;
      this.responseDone = false;
      this.onEvent?.({ type: 'state', state: 'processing', message: 'Thinking...' });
      return;
    }

    if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta' || type === 'response.output_text.delta' || type === 'response.text.delta') {
      this.responseText += event.delta || '';
      this.onEvent?.({ type: 'partial_response', text: this.responseText });
      return;
    }

    if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      this.audioDone = true;
      this.deliverFinalResponse();
      this.onEvent?.({ type: 'state', state: 'listening', message: 'Conversation active — listening' });
      return;
    }

    if (type === 'response.function_call_arguments.delta') {
      const key = event.call_id || event.item_id;
      this.toolArguments.set(key, (this.toolArguments.get(key) || '') + (event.delta || ''));
      return;
    }

    if (type === 'response.function_call_arguments.done') {
      const key = event.call_id || event.item_id;
      const args = event.arguments || this.toolArguments.get(key) || '{}';
      this.handleToolCall(event.call_id, args);
      return;
    }

    if (type === 'response.done') {
      this.responseDone = true;
      const output = event.response?.output || [];
      const hasToolCall = output.some((item) => item.type === 'function_call');
      if (!hasToolCall) {
        this.deliverFinalResponse();
        if (!this.audioDone) this.onEvent?.({ type: 'state', state: 'listening', message: 'Conversation active — listening' });
      }
    }
  }

  async handleToolCall(callId, argumentsJson) {
    if (!callId) return;
    try {
      const args = JSON.parse(argumentsJson || '{}');
      const request = (args.request || '').trim();
      const targetArea = (args.target_area || '').trim();
      this.onEvent?.({ type: 'state', state: 'processing', message: 'Checking with OpenClaw...' });
      const output = await this.askOpenClaw(request || 'Please infer the user request from the current voice turn.', targetArea);
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
      this.send({ type: 'response.create', response: { output_modalities: ['audio'] } });
    } catch (err) {
      console.error('OpenClaw relay failed:', err);
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: `OpenClaw tool call failed: ${err.message}`,
        },
      });
      this.send({ type: 'response.create', response: { output_modalities: ['audio'] } });
    }
  }

  async askOpenClaw(request, targetArea = '') {
    const response = await fetch(`${this.getServerBaseUrl()}/openclaw/ask`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ request, target_area: targetArea || undefined }),
    });
    if (!response.ok) throw new Error(`OpenClaw relay failed: ${response.status}`);
    const data = await response.json();
    return data.response || '';
  }

  deliverFinalResponse() {
    if (this.delivered) return;
    const text = this.responseText.trim();
    if (!text) return;
    this.delivered = true;
    this.onEvent?.({
      type: 'response',
      user_text: this.userTranscript || '[voice input]',
      rey_text: text,
      elapsed_ms: Math.round(performance.now() - this.startedAt),
    });
  }

  send(payload) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  authHeaders(extra = {}) {
    const headers = { ...extra };
    const token = this.getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
}
