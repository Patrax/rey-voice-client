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

**Cost: $0** — Everything runs locally on your server.

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
WAKE_WORD=hey_jarvis        # OpenWakeWord model name
WHISPER_MODEL=base.en       # tiny.en, base.en, small.en
```

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
- 🔒 **Private** — All processing on your server

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
