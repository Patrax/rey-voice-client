"""Configuration for Rey Voice Server."""
import os
from dotenv import load_dotenv

load_dotenv()

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL = os.getenv("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:18789")
OPENCLAW_GATEWAY_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_AGENT_ID = os.getenv("OPENCLAW_AGENT_ID", "main")
OPENCLAW_MODEL = os.getenv("OPENCLAW_MODEL", "")  # Empty = use default

# Wake word
WAKE_WORD = os.getenv("WAKE_WORD", "hey_jarvis")  # OpenWakeWord model name
WAKE_WORD_THRESHOLD = float(os.getenv("WAKE_WORD_THRESHOLD", "0.5"))

# Audio settings
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SIZE = 512  # samples per chunk

# Whisper settings
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en")  # tiny.en, base.en, small.en

# TTS settings  
TTS_MODEL = os.getenv("TTS_MODEL", "en_US-lessac-medium")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Rachel default

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))

# Authentication
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "")  # Required for WebSocket connections
