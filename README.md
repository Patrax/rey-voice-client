# 🦞 Rey Voice Client

A cross-platform Electron app for hands-free voice interaction with Rey. Open it on any computer with a mic — all processing happens on your server.

## Architecture

```
┌─────────────────────────────────┐         ┌─────────────────────────────────────┐
│   Electron App (your laptop)    │  audio  │   Server (ubuntuserver)             │
│  ┌─────┐    ┌────────────────┐ │ ──────→ │  ┌───────────────┐  ┌─────────────┐ │
│  │ Mic │ →  │ Stream audio   │ │         │  │ Wake Word     │→ │ Whisper STT │ │
│  └─────┘    │ via WebSocket  │ │         │  │ (OpenWakeWord)│  │ (local)     │ │
│             └────────────────┘ │         │  └───────────────┘  └──────┬──────┘ │
│  ┌─────┐    ┌────────────────┐ │  audio  │                            ▼        │
│  │ Spk │ ←  │ Play response  │ │ ←────── │  ┌──────────────┐  ┌─────────────┐  │
│  └─────┘    └────────────────┘ │         │  │ OpenClaw/Rey │→ │ Piper TTS   │  │
│                                │         │  └──────────────┘  └─────────────┘  │
└─────────────────────────────────┘         └─────────────────────────────────────┘
```

Default cost is $0 when `VOICE_BACKEND=local` — everything runs locally except optional hosted TTS. `VOICE_BACKEND=openai_realtime` uses OpenAI's Realtime API for speech-to-speech and bridges back into OpenClaw for Rey's memory/tools.

For lowest latency, the Electron client can use OpenAI Realtime over browser WebRTC. The server mints short-lived Realtime client secrets and relays `ask_openclaw` tool calls, but live microphone and speaker audio travel directly between Electron and OpenAI.

## Quick Start

### 1. Server Setup (one-time, on ubuntuserver)

```bash
cd server
chmod +x setup.sh
./setup.sh

# Edit .env with your OpenClaw Gateway token
nano .env

# Start the server
source venv/bin/activate
python server.py
```

### 2. Client Setup (on any computer)

```bash
cd client
npm install
npm start
```

Or build a standalone app:

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## Configuration

### Server (.env)

```bash
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=your_token_here
OPENCLAW_AGENT_ID=voice

# Voice backend: local or openai_realtime
VOICE_BACKEND=local

# Required for VOICE_BACKEND=openai_realtime
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_VOICE=alloy
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_INTERRUPT_RESPONSE=true
OPENAI_REALTIME_IDLE_TIMEOUT_SECONDS=120

# Compact runtime hints generated from OpenClaw/Memento for voice disambiguation.
VOICE_CONTEXT_SEED_PATH=voice_context_seed.json
VOICE_CONTEXT_GENERATED_PATH=~/.openclaw/runtime/rey-voice/voice_context_hints.generated.json
VOICE_CONTEXT_REFRESH_SECONDS=86400

WAKE_WORD=hey_jarvis        # OpenWakeWord model name
WHISPER_MODEL=base.en       # tiny.en, base.en, small.en
```

### Voice backend modes

- `local`: wake word → local faster-whisper → OpenClaw → ElevenLabs/OpenAI TTS. This preserves the original private/offline-ish pipeline.
- `openai_realtime`: wake word → OpenAI Realtime speech-to-speech. The realtime model gets an `ask_openclaw` tool, so requests that need Rey's real context/actions are routed back through OpenClaw instead of becoming generic ChatGPT voice.

### Realtime transport modes

The client has a separate **Realtime Transport** setting:

- `webrtc` (default): Electron gets an ephemeral token from `POST /realtime/session`, opens a direct WebRTC connection to OpenAI, streams mic audio live, and receives streamed speech back. Tool calls go through `POST /openclaw/ask` on Rey's server.
- `backend`: fallback mode. The client keeps the older WebSocket path where the server captures a whole utterance and runs the backend Realtime bridge.

Keep `backend` available as a safe fallback if WebRTC negotiation, device permissions, or corporate networks get in the way.

Realtime defaults to `gpt-realtime-2.1` with low reasoning effort. Wake word or
the hotkey starts a natural multi-turn session; F19 remains the hard stop.
Sessions also close after two quiet minutes, and "go quiet" ends one immediately.
The model can silently ignore room noise and side conversation with
`wait_for_user`, while barge-in is enabled for natural interruptions.

### Runtime voice context hints

The Realtime layer loads a compact context primer so common workstreams are parsed correctly without injecting full memory. For example, it can treat "taxes" as Patricio's tax filing work rather than "Texas", and route topics like Tenpace or humanslivehere back through OpenClaw.

- Committed seed aliases live in `server/voice_context_seed.json`.
- Generated hints are written to `~/.openclaw/runtime/rey-voice/voice_context_hints.generated.json` and are intentionally not committed.
- The server refreshes generated hints from Memento on startup and every `VOICE_CONTEXT_REFRESH_SECONDS` when needed.
- Debug current hints: `GET /voice-context/hints` with `Authorization: Bearer <AUTH_TOKEN>`.
- Force refresh: `POST /voice-context/refresh` with the same bearer token.

### Client

Set environment variable before running:

```bash
export REY_SERVER_URL=ws://ubuntuserver:8765/voice
npm start
```

## Usage

1. **Launch the app** — It appears in your system tray
2. **Say "Hey Rey"** — Or press `Cmd+Shift+R` (push-to-talk)
3. **Speak your request** — The app will show it's listening
4. **Wait for response** — Rey thinks, then speaks back

## Features

- 🎤 **Always listening** for wake word
- ⌨️ **Push-to-talk** shortcut (Cmd+Shift+R)
- 🎨 **Visual feedback** — Shows listening/thinking/speaking states
- 🖥️ **System tray** — Runs quietly in background
- 🔒 **Private control plane** — OpenClaw memory/tools stay on your server
- ⚡ **Low-latency WebRTC mode** — Direct OpenAI Realtime audio path with server-side ephemeral tokens

## Wake Words

OpenWakeWord supports several pre-trained wake words:

- `hey_jarvis` (default)
- `alexa`
- `hey_mycroft`
- `hey_rhasspy`

For a custom "Hey Rey" wake word, you'll need to train a custom model.

## Troubleshooting

**"Connection error"**
- Is the server running? `python server.py`
- Is the port open? Check firewall settings
- Is the URL correct? Check `REY_SERVER_URL`

**"Microphone access denied"**
- Grant microphone permission in System Preferences (macOS)
- Or browser/app permissions (Windows/Linux)

**Slow response**
- Try a smaller Whisper model: `WHISPER_MODEL=tiny.en`
- Check server CPU usage

## Project Structure

```
rey-voice-client/
├── server/
│   ├── server.py         # Main server (WebSocket, wake word, STT, TTS)
│   ├── config.py         # Configuration
│   ├── requirements.txt  # Python dependencies
│   ├── setup.sh          # Setup script
│   └── .env.example      # Environment template
├── client/
│   ├── main.js           # Electron main process
│   ├── preload.js        # IPC bridge
│   ├── index.html        # UI
│   ├── renderer.js       # Audio capture & WebSocket
│   └── package.json      # Node dependencies
└── README.md
```

## Next Steps

- [ ] Train custom "Hey Rey" wake word
- [ ] Add conversation history / context
- [ ] Mobile companion app (iOS/Android)
- [ ] Home Assistant integration
