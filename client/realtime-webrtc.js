/**
 * OpenAI Realtime WebRTC transport for Rey.
 *
 * The server mints short-lived OpenAI client secrets and remains the private
 * OpenClaw tool bridge. Browser/Electron audio goes directly to OpenAI for the
 * low-latency speech path.
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
    this.awaitingResponse = false;
    this.pendingStop = false;
    this.responseDone = false;
    this.audioDone = false;
    this.delivered = false;
    this.userTranscript = '';
    this.responseText = '';
    this.toolArguments = new Map();
    this.startedAt = 0;
    this.turnReason = 'manual';
    this.closeTimer = null;
    this.watchdogTimer = null;
  }

  isActive() {
    return this.active;
  }

  isReady() {
    return this.dc?.readyState === 'open';
  }

  async start({ reason = 'manual' } = {}) {
    if (this.active) return;
    this.active = true;
    this.awaitingResponse = false;
    this.pendingStop = false;
    this.responseDone = false;
    this.audioDone = false;
    this.delivered = false;
    this.userTranscript = '';
    this.responseText = '';
    this.toolArguments.clear();
    this.startedAt = performance.now();
    this.turnReason = reason;
    this.clearTimers();
    this.watchdogTimer = setTimeout(() => {
      if (this.active) {
        this.onError?.(new Error('Realtime turn timed out and was reset'));
        this.finishTurn();
      }
    }, 70000);

    try {
      this.onEvent?.({ type: 'state', state: 'listening', message: reason === 'wake' ? "I'm listening..." : 'Realtime listening...' });

      const session = await this.createSession(reason);
      const clientSecret = session?.client_secret?.value;
      if (!clientSecret) {
        throw new Error('Realtime session did not include a client secret');
      }

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
          // MediaStream-backed Audio elements do not reliably fire a useful
          // ended event for OpenAI Realtime. We close from protocol events plus
          // a speech-length estimate instead, which avoids clipping long speech
          // while still preventing stuck turns.
        }
        this.remoteAudio.srcObject = event.streams[0];
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        console.log('Realtime WebRTC connection:', state);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          if (this.active) this.finishTurn();
        }
      };

      this.localStream = this.getMediaStream();
      if (!this.localStream) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
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

  async stopListening() {
    if (!this.active) return;
    if (this.inputTrack) this.inputTrack.enabled = false;
    this.pendingStop = true;
    this.onEvent?.({ type: 'state', state: 'processing', message: 'Thinking...' });
    if (this.turnReason === 'manual') {
      this.send({ type: 'input_audio_buffer.commit' });
    }
    this.requestResponse();
  }

  async interrupt() {
    this.send({ type: 'response.cancel' });
    await this.close();
  }

  async close() {
    this.active = false;
    this.awaitingResponse = false;
    this.pendingStop = false;
    this.clearTimers();
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    if (this.remoteAudio) {
      try { this.remoteAudio.pause(); } catch {}
      this.remoteAudio.srcObject = null;
    }
    if (this.inputTrack) this.inputTrack.enabled = true;
    this.pc = null;
    this.dc = null;
    this.remoteAudio = null;
    this.inputTrack = null;
  }

  clearTimers() {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async createSession(reason = 'manual') {
    const response = await fetch(`${this.getServerBaseUrl()}/realtime/session`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ transport: 'webrtc', reason }),
    });
    if (!response.ok) throw new Error(`Realtime session failed: ${response.status}`);
    return response.json();
  }

  async exchangeSdp(offerSdp, clientSecret, model) {
    const response = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
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
    const turnDetection = this.turnReason === 'manual' ? null : {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 650,
      create_response: false,
    };

    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: turnDetection,
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
              },
              required: ['request'],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: 'auto',
      },
    });

    if (this.pendingStop) {
      // The user released push-to-talk before negotiation finished. Process as
      // soon as the data channel is usable instead of getting stuck in Thinking.
      setTimeout(() => this.requestResponse(), 100);
    }
  }

  handleRealtimeEvent(event) {
    const type = event.type;
    if (type === 'error') {
      const message = event.error?.message || JSON.stringify(event.error || event);
      // Benign race from older/autoresponse sessions: OpenAI may already be
      // speaking when a queued/manual response.create arrives. Do not strand the
      // UI in an error overlay; let the active response finish normally.
      if (/active response in progress/i.test(message)) {
        console.warn('Ignoring duplicate response.create while response is active:', message);
        return;
      }
      this.onError?.(new Error(message));
      return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
      // Toggle push-to-talk must wait for Patricio's second F19 press. Only
      // wake-word turns auto-submit when server VAD hears the end of speech.
      if (this.turnReason === 'wake' && !this.pendingStop) {
        setTimeout(() => this.requestResponse(), 100);
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.userTranscript = event.transcript || this.userTranscript;
      if (this.userTranscript) {
        this.onEvent?.({ type: 'user_transcript', text: this.userTranscript });
      }
      return;
    }

    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') {
      this.responseText += event.delta || '';
      this.onEvent?.({ type: 'partial_response', text: this.responseText });
      return;
    }

    if (type === 'response.audio.done') {
      this.audioDone = true;
      this.deliverFinalResponse();
      // audio.done means OpenAI has finished generating audio, but Electron can
      // still be playing buffered WebRTC media. Mark the UI ready now so F19 is
      // responsive, but keep the peer connection alive long enough to avoid
      // clipping the tail. A new F19 press will close this draining turn first.
      this.onEvent?.({ type: 'state', state: 'waiting', message: 'Ready' });
      this.scheduleFinishTurn(this.estimateRemainingPlaybackMs());
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
      this.awaitingResponse = false;
      this.handleToolCall(event.call_id, args);
      return;
    }

    if (type === 'response.done') {
      this.responseDone = true;
      const output = event.response?.output || [];
      const hasToolCall = output.some((item) => item.type === 'function_call');
      if (!hasToolCall) {
        this.deliverFinalResponse();
        if (!this.audioDone) {
          this.onEvent?.({ type: 'state', state: 'waiting', message: 'Ready' });
          this.scheduleFinishTurn(1000);
        }
      }
    }
  }

  async handleToolCall(callId, argumentsJson) {
    if (!callId) return;
    try {
      const args = JSON.parse(argumentsJson || '{}');
      const request = (args.request || '').trim();
      this.onEvent?.({ type: 'state', state: 'processing', message: 'Checking with OpenClaw...' });
      const output = await this.askOpenClaw(request || 'Please infer the user request from the current voice turn.');
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
      this.requestResponse();
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
      this.requestResponse();
    }
  }

  async askOpenClaw(request) {
    const response = await fetch(`${this.getServerBaseUrl()}/openclaw/ask`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ request }),
    });
    if (!response.ok) throw new Error(`OpenClaw relay failed: ${response.status}`);
    const data = await response.json();
    return data.response || '';
  }

  requestResponse() {
    if (this.awaitingResponse) return false;
    if (!this.isReady()) return false;
    this.awaitingResponse = true;
    this.pendingStop = false;
    this.send({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
    return true;
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

  estimateRemainingPlaybackMs() {
    const text = this.responseText.trim();
    const words = text ? text.split(/\s+/).length : 8;
    // Keep the transport alive for likely buffered playback, but cap it so a
    // broken event stream cannot hold the old peer connection forever.
    return Math.max(1800, Math.min(30000, Math.round((words / 2.6) * 1000 + 900)));
  }

  scheduleFinishTurn(delayMs) {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.finishTurn(), delayMs);
  }

  finishTurn() {
    if (!this.active) return;
    this.close();
    this.onEvent?.({ type: 'state', state: 'waiting', message: 'Ready' });
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
