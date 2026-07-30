"""Configuration for Rey Voice Server."""
import json
import os
from dotenv import load_dotenv

load_dotenv()

# OpenClaw Gateway
OPENCLAW_GATEWAY_URL = os.getenv("OPENCLAW_GATEWAY_URL", "http://127.0.0.1:18789")
OPENCLAW_GATEWAY_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "")
OPENCLAW_AGENT_ID = os.getenv("OPENCLAW_AGENT_ID", "main")
OPENCLAW_MODEL = os.getenv("OPENCLAW_MODEL", "")  # Empty = use default
OPENCLAW_DELIVERY_CHANNEL = os.getenv("OPENCLAW_DELIVERY_CHANNEL", "")
OPENCLAW_DELIVERY_TO = os.getenv("OPENCLAW_DELIVERY_TO", "")
OPENCLAW_DELIVERY_ACCOUNT_ID = os.getenv("OPENCLAW_DELIVERY_ACCOUNT_ID", "")
OPENCLAW_DELIVERY_THREAD_ID = os.getenv("OPENCLAW_DELIVERY_THREAD_ID", "")
OPENCLAW_AUTHORITATIVE_AGENT_ID = os.getenv("OPENCLAW_AUTHORITATIVE_AGENT_ID", "main")
OPENCLAW_AUTHORITATIVE_SESSION_KEY = os.getenv("OPENCLAW_AUTHORITATIVE_SESSION_KEY", "")
DEFAULT_OPENCLAW_ROUTE_TARGETS = {
    "humanslivehere": {
        "aliases": ["humans live here", "humanslivehere", "humanslivehere.com", "humans livehere"],
        "delivery_channel": "discord",
        "delivery_to": "channel:1500666109643460799",
        "account_id": "default",
        "authoritative_agent_id": "main",
        "authoritative_session_key": "agent:main:discord:channel:1500666109643460799",
    },
    "tenpace": {
        "aliases": ["ten pace", "tenpace", "10 pace"],
        "delivery_channel": "discord",
        "delivery_to": "channel:1500666140492562616",
        "account_id": "default",
        "authoritative_agent_id": "main",
        "authoritative_session_key": "agent:main:discord:channel:1500666140492562616",
    },
    "rey-voice": {
        "aliases": ["rey voice", "voice client", "voice server", "rey-voice"],
        "delivery_channel": "discord",
        "delivery_to": "channel:1501214331759755365",
        "account_id": "default",
        "authoritative_agent_id": "main",
        "authoritative_session_key": "agent:main:discord:channel:1501214331759755365",
    },
}
try:
    OPENCLAW_ROUTE_TARGETS = json.loads(os.getenv("OPENCLAW_ROUTE_TARGETS_JSON", "")) or DEFAULT_OPENCLAW_ROUTE_TARGETS
except json.JSONDecodeError:
    OPENCLAW_ROUTE_TARGETS = DEFAULT_OPENCLAW_ROUTE_TARGETS

# Wake word
WAKE_WORD = os.getenv("WAKE_WORD", "hey_jarvis")  # OpenWakeWord model name
WAKE_WORD_THRESHOLD = float(os.getenv("WAKE_WORD_THRESHOLD", "0.5"))

# Audio settings
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SIZE = 512  # samples per chunk

# Whisper settings
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base.en")  # tiny.en, base.en, small.en

# Voice backend
# local = wake word -> local Whisper -> OpenClaw -> ElevenLabs/OpenAI TTS
# openai_realtime = wake word -> OpenAI Realtime speech-to-speech, with OpenClaw exposed as a tool
VOICE_BACKEND = os.getenv("VOICE_BACKEND", "local").lower()

# TTS settings  
TTS_MODEL = os.getenv("TTS_MODEL", "en_US-lessac-medium")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Rachel default

# OpenAI Realtime settings
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1")
OPENAI_REALTIME_VOICE = os.getenv("OPENAI_REALTIME_VOICE", "alloy")
OPENAI_REALTIME_TRANSCRIPTION_MODEL = os.getenv(
    "OPENAI_REALTIME_TRANSCRIPTION_MODEL",
    "gpt-live-transcribe",
)
OPENAI_REALTIME_REASONING_EFFORT = os.getenv(
    "OPENAI_REALTIME_REASONING_EFFORT",
    "low",
)
OPENAI_REALTIME_INTERRUPT_RESPONSE = os.getenv(
    "OPENAI_REALTIME_INTERRUPT_RESPONSE",
    "true",
).lower() in {"1", "true", "yes", "on"}
OPENAI_REALTIME_IDLE_TIMEOUT_SECONDS = int(
    os.getenv("OPENAI_REALTIME_IDLE_TIMEOUT_SECONDS", "120")
)
OPENAI_REALTIME_TIMEOUT_SECONDS = float(os.getenv("OPENAI_REALTIME_TIMEOUT_SECONDS", "60"))
VOICE_CONTEXT_SEED_PATH = os.getenv("VOICE_CONTEXT_SEED_PATH", "voice_context_seed.json")
VOICE_CONTEXT_GENERATED_PATH = os.getenv(
    "VOICE_CONTEXT_GENERATED_PATH",
    "~/.openclaw/runtime/rey-voice/voice_context_hints.generated.json",
)
VOICE_CONTEXT_REFRESH_SECONDS = int(os.getenv("VOICE_CONTEXT_REFRESH_SECONDS", "86400"))
VOICE_CONTEXT_REFRESH_TIMEOUT_SECONDS = float(os.getenv("VOICE_CONTEXT_REFRESH_TIMEOUT_SECONDS", "20"))
VOICE_CONTEXT_MAX_HINTS = int(os.getenv("VOICE_CONTEXT_MAX_HINTS", "10"))

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8765"))

# Authentication
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "")  # Required for WebSocket connections
