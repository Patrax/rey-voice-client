#!/usr/bin/env python3
"""
Rey Voice Server

Handles all voice processing:
- Wake word detection (OpenWakeWord)
- Speech-to-text (faster-whisper)
- OpenClaw integration
- Text-to-speech (piper)

Clients connect via WebSocket and stream audio.
"""

import asyncio
import io
import json
import logging
import struct
import tempfile
import uuid
import wave
from enum import Enum
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

import config

# Lazy imports for heavy dependencies
openwakeword = None
faster_whisper = None
piper = None
hey_rey_detector = None

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
# Reduce noise from HTTP libraries
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("faster_whisper").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

app = FastAPI(title="Rey Voice Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class State(Enum):
    WAITING_FOR_WAKE_WORD = "waiting"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"


class VoiceSession:
    """Manages a single voice client session."""

    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.state = State.WAITING_FOR_WAKE_WORD
        self.audio_buffer = []
        self.silence_frames = 0
        self.oww_model = None
        self.whisper_model = None
        self.tts_voice = None
        self.wake_word_cooldown = False
        # Session management for conversation continuity
        self.session_id = str(uuid.uuid4())
        self.conversation_history = []
        logger.info(f"New session created: {self.session_id}")

    async def initialize(self):
        """Initialize models (lazy load)."""
        global openwakeword, faster_whisper, piper, hey_rey_detector

        # Load Wake Word detector
        if config.WAKE_WORD == "hey_rey":
            # Use custom Hey Rey detector
            if hey_rey_detector is None:
                from hey_rey_detector import HeyReyDetector
                hey_rey_detector = HeyReyDetector
            self.oww_model = hey_rey_detector(threshold=config.WAKE_WORD_THRESHOLD)
            logger.info("Wake word model loaded: hey_rey (custom)")
        else:
            # Use OpenWakeWord
            if openwakeword is None:
                from openwakeword.model import Model as OWWModel
                openwakeword = OWWModel
            self.oww_model = openwakeword()
            logger.info(f"Wake word model loaded: {config.WAKE_WORD}")

        # Load Whisper
        if faster_whisper is None:
            from faster_whisper import WhisperModel
            faster_whisper = WhisperModel
        
        self.whisper_model = faster_whisper(
            config.WHISPER_MODEL, 
            device="cpu",  # or "cuda" if available
            compute_type="int8"
        )
        logger.info(f"Whisper model loaded: {config.WHISPER_MODEL}")

        # Load Piper TTS
        try:
            if piper is None:
                from piper import PiperVoice
                piper = PiperVoice
            
            model_path = Path(f"models/{config.TTS_MODEL}.onnx")
            if model_path.exists():
                self.tts_voice = piper.load(str(model_path))
                logger.info(f"Piper TTS loaded: {config.TTS_MODEL}")
            else:
                logger.warning(f"TTS model not found: {model_path}. Will use OpenClaw TTS.")
        except Exception as e:
            logger.warning(f"Could not load Piper TTS: {e}. Will use OpenClaw TTS.")

    async def send_state(self, state: State, message: str = ""):
        """Send state update to client."""
        self.state = state
        await self.websocket.send_json({
            "type": "state",
            "state": state.value,
            "message": message
        })

    async def send_audio(self, audio_data: bytes):
        """Send audio data to client for playback."""
        await self.websocket.send_bytes(audio_data)

    def process_wake_word(self, audio_chunk: np.ndarray) -> bool:
        """Check for wake word in audio chunk."""
        # OpenWakeWord expects int16 audio
        audio_int16 = (audio_chunk * 32768).astype(np.int16)
        prediction = self.oww_model.predict(audio_int16)
        
        # Check all predictions for any above threshold
        for key, score in prediction.items():
            if score > config.WAKE_WORD_THRESHOLD:
                logger.info(f"Wake word detected! ({key}: {score:.2f})")
                return True
        return False

    def detect_silence(self, audio_chunk: np.ndarray, threshold: float = 0.005) -> bool:
        """Detect if audio chunk is silence."""
        rms = np.sqrt(np.mean(audio_chunk ** 2))
        return rms < threshold

    def detect_expression(self, text: str) -> str:
        """Detect appropriate expression based on response text."""
        text_lower = text.lower()
        
        # Check for various sentiment indicators
        if any(word in text_lower for word in ['sorry', 'unfortunately', 'sad', 'bad news', "can't", 'unable']):
            return 'sad'
        elif any(word in text_lower for word in ['love', 'heart', '❤', '💕', 'amazing', 'wonderful']):
            return 'love'
        elif any(word in text_lower for word in ['haha', 'lol', 'funny', '😂', '🤣', 'hilarious', 'joke']):
            return 'laughing'
        elif any(word in text_lower for word in ['wow', 'whoa', 'amazing', 'incredible', '!!']):
            return 'surprised'
        elif any(word in text_lower for word in ['hmm', 'interesting', 'let me think', 'not sure', 'maybe']):
            return 'confused'
        elif any(word in text_lower for word in ['great', 'awesome', 'perfect', 'excellent', 'yay', '🎉']):
            return 'excited'
        elif any(word in text_lower for word in ['good', 'nice', 'sure', 'okay', 'happy', '😊', '🙂']):
            return 'happy'
        elif any(word in text_lower for word in [';)', 'wink', 'heh', 'between us']):
            return 'wink'
        elif any(word in text_lower for word in ['🦞', 'lobster']):
            return 'excited'  # Rey's signature!
        else:
            return 'happy'  # Default to happy

    async def transcribe(self, audio_data: np.ndarray) -> str:
        """Transcribe audio to text using Whisper."""
        # Save to temp file (faster-whisper needs a file)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio_data, config.SAMPLE_RATE)
            segments, info = self.whisper_model.transcribe(
                f.name,
                beam_size=5,
                language="en",
                vad_filter=True,  # Filter out non-speech
                vad_parameters=dict(min_silence_duration_ms=500),
            )
            text = " ".join([segment.text for segment in segments]).strip()
            Path(f.name).unlink()  # Clean up
        
        logger.info(f"Transcribed: {text}")
        return text

    async def ask_openclaw(self, text: str) -> str:
        """Send text to OpenClaw and get response.
        
        Uses 'user' field for stable session key - OpenClaw maintains history
        and provides full workspace context (MEMORY.md, SOUL.md, etc.)
        """
        # System prompt optimized for voice output
        voice_system_prompt = """You are responding via voice (text-to-speech). Optimize your responses:

- Be concise and conversational - this will be spoken aloud
- NO markdown formatting (no **, ##, -, bullets, etc.)
- NO lists - use natural flowing sentences instead
- Abbreviate where natural: "3 PM" not "3:00 PM", "tomorrow" not "Tuesday, February 10th"
- For calendar: ONLY read from "pjeril@gmail.com" calendar, ignore other linked calendars
- For calendar events: just say the key info (time + brief description), skip full titles
- For multiple items: summarize or mention count ("you have 3 meetings") rather than reading each
- Numbers: say "about 50" not "approximately 49.7"
- Keep responses under 2-3 sentences when possible
- Sound natural, like talking to a friend"""

        async def do_request():
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{config.OPENCLAW_GATEWAY_URL}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {config.OPENCLAW_GATEWAY_TOKEN}",
                        "Content-Type": "application/json",
                        "x-openclaw-agent-id": config.OPENCLAW_AGENT_ID,
                    },
                    json={
                        "model": config.OPENCLAW_MODEL or "openclaw",
                        "messages": [
                            {"role": "system", "content": voice_system_prompt},
                            {"role": "user", "content": text}
                        ],
                        "user": "voice-client",  # Stable session key - enables full workspace context!
                        "stream": False,
                    }
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        
        # Run request with keepalive pings to prevent Cloudflare timeout
        request_task = asyncio.create_task(do_request())
        
        while not request_task.done():
            try:
                # Send keepalive every 5 seconds while waiting
                await asyncio.wait_for(asyncio.shield(request_task), timeout=5.0)
            except asyncio.TimeoutError:
                # Still waiting - send a ping to keep connection alive
                try:
                    await self.websocket.send_json({"type": "keepalive", "status": "thinking"})
                except:
                    pass  # Connection might be closed
        
        return await request_task

    async def synthesize_speech(self, text: str) -> bytes:
        """Convert text to speech audio using ElevenLabs (primary) or OpenAI (fallback)."""
        
        # Try ElevenLabs first
        if config.ELEVENLABS_API_KEY:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        f"https://api.elevenlabs.io/v1/text-to-speech/{config.ELEVENLABS_VOICE_ID}",
                        headers={
                            "xi-api-key": config.ELEVENLABS_API_KEY,
                            "Content-Type": "application/json",
                        },
                        json={
                            "text": text[:5000],
                            "model_id": "eleven_turbo_v2_5",
                            "voice_settings": {
                                "stability": 0.5,
                                "similarity_boost": 0.75,
                            }
                        }
                    )
                    response.raise_for_status()
                    logger.info(f"ElevenLabs TTS generated {len(response.content)} bytes")
                    return response.content
            except Exception as e:
                logger.error(f"ElevenLabs TTS failed: {e}, trying OpenAI fallback")
        
        # Fallback to OpenAI
        if config.OPENAI_API_KEY:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        "https://api.openai.com/v1/audio/speech",
                        headers={
                            "Authorization": f"Bearer {config.OPENAI_API_KEY}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "model": "tts-1",
                            "input": text[:4096],
                            "voice": "nova",
                            "response_format": "mp3",
                        }
                    )
                    response.raise_for_status()
                    logger.info(f"OpenAI TTS generated {len(response.content)} bytes")
                    return response.content
            except Exception as e:
                logger.error(f"OpenAI TTS failed: {e}")
        
        logger.warning("No TTS available, response will be text-only")
        return b""

    async def handle_audio(self, audio_data: bytes):
        """Process incoming audio chunk from client."""
        # Convert bytes to numpy array (assuming 16-bit PCM)
        audio_chunk = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

        if self.state == State.WAITING_FOR_WAKE_WORD:
            if not self.wake_word_cooldown and self.process_wake_word(audio_chunk):
                # Reset wake word model to clear internal buffers
                self.oww_model.reset()
                await self.send_state(State.LISTENING, "I'm listening...")
                self.audio_buffer = []
                self.silence_frames = 0

        elif self.state == State.LISTENING:
            self.audio_buffer.append(audio_chunk)
            
            # Minimum 1 second of audio before checking for silence
            min_frames = config.SAMPLE_RATE / config.CHUNK_SIZE * 1.0
            
            # Check for end of speech (silence detection)
            if len(self.audio_buffer) > min_frames and self.detect_silence(audio_chunk):
                self.silence_frames += 1
                # ~2 seconds of silence = end of speech
                if self.silence_frames > (config.SAMPLE_RATE / config.CHUNK_SIZE * 2.0):
                    await self.process_speech()
            else:
                self.silence_frames = 0
            
            # Timeout after 15 seconds of listening
            if len(self.audio_buffer) > (config.SAMPLE_RATE / config.CHUNK_SIZE * 15):
                await self.process_speech()

    async def process_speech(self):
        """Process captured speech: transcribe, query OpenClaw, respond."""
        import time
        timings = {}
        await self.send_state(State.PROCESSING, "Thinking...")
        pipeline_start = time.time()
        
        try:
            # Combine audio buffer
            audio_data = np.concatenate(self.audio_buffer)
            
            # Check if there's actually speech (not just silence)
            rms = np.sqrt(np.mean(audio_data ** 2))
            if rms < 0.01:
                logger.info("Audio too quiet, skipping transcription")
                # Enable cooldown to prevent rapid re-triggering
                self.wake_word_cooldown = True
                self.oww_model.reset()
                await asyncio.sleep(1.5)
                self.oww_model.reset()
                self.wake_word_cooldown = False
                await self.send_state(State.WAITING_FOR_WAKE_WORD, "Didn't hear anything")
                return
            
            # Transcribe
            t0 = time.time()
            text = await self.transcribe(audio_data)
            timings['stt'] = time.time() - t0
            
            if not text or len(text.strip()) < 2:
                await self.send_state(State.WAITING_FOR_WAKE_WORD, "Didn't catch that")
                return
            
            # Query OpenClaw
            t0 = time.time()
            response = await self.ask_openclaw(text)
            timings['llm'] = time.time() - t0
            logger.info(f"Rey: {response}")
            
            # Detect expression based on response content
            expression = self.detect_expression(response)
            
            # Send text response with expression
            await self.websocket.send_json({
                "type": "response",
                "user_text": text,
                "rey_text": response,
                "expression": expression
            })
            
            # Synthesize and send audio
            await self.send_state(State.SPEAKING, response[:50] + "...")
            t0 = time.time()
            audio = await self.synthesize_speech(response)
            timings['tts'] = time.time() - t0
            if audio:
                await self.send_audio(audio)
            
            # Log timing breakdown
            timings['total'] = time.time() - pipeline_start
            logger.info(f"⏱️ Timing: STT={timings['stt']:.2f}s | LLM={timings['llm']:.2f}s | TTS={timings['tts']:.2f}s | Total={timings['total']:.2f}s")
            
        except Exception as e:
            logger.error(f"Error processing speech: {e}")
            await self.websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        
        finally:
            self.audio_buffer = []
            # Enable cooldown to prevent immediate re-trigger (especially from TTS echo)
            self.wake_word_cooldown = True
            # Reset wake word model
            self.oww_model.reset()
            # Longer delay to let TTS audio finish and clear from mic
            await asyncio.sleep(3.0)
            # Reset again after delay to clear any buffered audio
            self.oww_model.reset()
            self.wake_word_cooldown = False
            await self.send_state(State.WAITING_FOR_WAKE_WORD)


@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    """WebSocket endpoint for voice streaming."""
    # Authentication check
    if config.AUTH_TOKEN:
        # Check query parameter: ws://server/voice?token=xxx
        token = websocket.query_params.get("token", "")
        if token != config.AUTH_TOKEN:
            logger.warning(f"Unauthorized connection attempt from {websocket.client.host}")
            await websocket.close(code=4001, reason="Unauthorized")
            return
    
    await websocket.accept()
    logger.info(f"Client connected from {websocket.client.host}")
    
    session = VoiceSession(websocket)
    connected_sessions.append(session)
    
    try:
        await session.initialize()
        await session.send_state(State.WAITING_FOR_WAKE_WORD, "Ready")
        
        while True:
            data = await websocket.receive()
            
            if "bytes" in data:
                await session.handle_audio(data["bytes"])
            elif "text" in data:
                # Handle text commands (e.g., push-to-talk trigger, keepalive)
                msg = json.loads(data["text"])
                if msg.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                elif msg.get("type") == "push_to_talk":
                    # Push to talk: immediately start listening (bypass wake word)
                    if session.state == State.WAITING_FOR_WAKE_WORD:
                        await session.send_state(State.LISTENING, "I'm listening...")
                        session.audio_buffer = []
                        session.silence_frames = 0
                    elif session.state == State.LISTENING:
                        # Already listening - process what we have
                        await session.process_speech()
                elif msg.get("type") == "push_to_talk_start":
                    # Start listening (first press)
                    if session.state == State.WAITING_FOR_WAKE_WORD:
                        logger.info("Push to talk: START")
                        await session.send_state(State.LISTENING, "I'm listening...")
                        session.audio_buffer = []
                        session.silence_frames = 0
                elif msg.get("type") == "push_to_talk_stop":
                    # Stop listening and process (second press)
                    if session.state == State.LISTENING:
                        logger.info("Push to talk: STOP - processing")
                        await session.process_speech()
                elif msg.get("type") == "push_to_wake":
                    # Push to wake: same as detecting wake word (trigger listening mode)
                    if session.state == State.WAITING_FOR_WAKE_WORD:
                        logger.info("Push to wake triggered")
                        session.oww_model.reset()
                        await session.send_state(State.LISTENING, "I'm listening...")
                        session.audio_buffer = []
                        session.silence_frames = 0
                        
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if session in connected_sessions:
            connected_sessions.remove(session)
        logger.info(f"Active clients: {len(connected_sessions)}")


# Track connected clients for broadcasting
connected_sessions: list[VoiceSession] = []


@app.get("/health")
async def health():
    return {"status": "ok", "clients": len(connected_sessions)}


class InboxMessage(BaseModel):
    """Incoming message from external service."""
    message: str
    priority: str = "normal"  # normal, urgent
    speak: bool = True  # Whether to speak via TTS
    title: str = None  # Optional title/source


@app.post("/inbox")
async def inbox(msg: InboxMessage, authorization: str = Header(None)):
    """
    Receive messages from external services and broadcast to connected clients.
    
    POST /inbox
    Headers:
      Authorization: Bearer <token>
    Body:
      {
        "message": "You have a visitor at the front door",
        "title": "Home Security",  // optional
        "priority": "normal",      // normal or urgent
        "speak": true              // speak via TTS
      }
    """
    # Auth check
    if config.AUTH_TOKEN:
        if not authorization or not authorization.startswith("Bearer "):
            return {"error": "Unauthorized"}, 401
        token = authorization.replace("Bearer ", "")
        if token != config.AUTH_TOKEN:
            return {"error": "Unauthorized"}, 401
    
    if not connected_sessions:
        logger.warning(f"Inbox message received but no clients connected: {msg.message[:50]}")
        return {"status": "queued", "clients": 0, "note": "No clients connected"}
    
    logger.info(f"Inbox message from {msg.title or 'unknown'}: {msg.message[:50]}...")
    
    # Format the announcement
    announcement = msg.message
    if msg.title:
        announcement = f"{msg.title}: {msg.message}"
    
    # Broadcast to all connected clients
    delivered = 0
    for session in connected_sessions:
        try:
            # Send text notification
            await session.websocket.send_json({
                "type": "notification",
                "title": msg.title,
                "message": msg.message,
                "priority": msg.priority,
                "speak": msg.speak
            })
            
            # If speak is enabled and client is idle, synthesize and send audio
            if msg.speak and session.state == State.WAITING_FOR_WAKE_WORD:
                audio = await session.synthesize_speech(announcement)
                if audio:
                    await session.send_state(State.SPEAKING, announcement[:50] + "...")
                    await session.send_audio(audio)
                    await session.send_state(State.WAITING_FOR_WAKE_WORD)
            
            delivered += 1
        except Exception as e:
            logger.error(f"Failed to deliver to client: {e}")
    
    return {"status": "delivered", "clients": delivered}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
