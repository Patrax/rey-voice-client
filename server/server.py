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
import wave
from enum import Enum
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import config

# Lazy imports for heavy dependencies
openwakeword = None
faster_whisper = None
piper = None

logging.basicConfig(level=logging.INFO)
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

    async def initialize(self):
        """Initialize models (lazy load)."""
        global openwakeword, faster_whisper, piper

        # Load OpenWakeWord
        if openwakeword is None:
            from openwakeword.model import Model as OWWModel
            global openwakeword
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
        
        # Check the specific wake word we're looking for
        wake_word_key = config.WAKE_WORD
        if wake_word_key in prediction and prediction[wake_word_key] > config.WAKE_WORD_THRESHOLD:
            logger.info(f"Wake word detected! ({wake_word_key}: {prediction[wake_word_key]:.2f})")
            return True
        return False

    def detect_silence(self, audio_chunk: np.ndarray, threshold: float = 0.01) -> bool:
        """Detect if audio chunk is silence."""
        rms = np.sqrt(np.mean(audio_chunk ** 2))
        return rms < threshold

    async def transcribe(self, audio_data: np.ndarray) -> str:
        """Transcribe audio to text using Whisper."""
        # Save to temp file (faster-whisper needs a file)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            sf.write(f.name, audio_data, config.SAMPLE_RATE)
            segments, info = self.whisper_model.transcribe(
                f.name,
                beam_size=5,
                language="en"
            )
            text = " ".join([segment.text for segment in segments]).strip()
            Path(f.name).unlink()  # Clean up
        
        logger.info(f"Transcribed: {text}")
        return text

    async def ask_openclaw(self, text: str) -> str:
        """Send text to OpenClaw and get response."""
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{config.OPENCLAW_GATEWAY_URL}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {config.OPENCLAW_GATEWAY_TOKEN}",
                    "Content-Type": "application/json",
                    "x-openclaw-agent-id": config.OPENCLAW_AGENT_ID,
                },
                json={
                    "model": "openclaw",
                    "messages": [{"role": "user", "content": text}],
                    "stream": False,
                }
            )
            response.raise_for_status()
            data = response.json()
            return data["choices"][0]["message"]["content"]

    async def synthesize_speech(self, text: str) -> bytes:
        """Convert text to speech audio."""
        if self.tts_voice:
            # Use local Piper TTS
            audio_buffer = io.BytesIO()
            with wave.open(audio_buffer, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(22050)
                self.tts_voice.synthesize(text, wav)
            return audio_buffer.getvalue()
        else:
            # Use OpenClaw's TTS endpoint
            async with httpx.AsyncClient(timeout=30.0) as client:
                # This would need to be implemented based on OpenClaw's TTS API
                # For now, fall back to a simple beep or use ElevenLabs directly
                logger.warning("Local TTS not available, response will be text-only")
                return b""

    async def handle_audio(self, audio_data: bytes):
        """Process incoming audio chunk from client."""
        # Convert bytes to numpy array (assuming 16-bit PCM)
        audio_chunk = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

        if self.state == State.WAITING_FOR_WAKE_WORD:
            if self.process_wake_word(audio_chunk):
                await self.send_state(State.LISTENING, "I'm listening...")
                self.audio_buffer = []
                self.silence_frames = 0

        elif self.state == State.LISTENING:
            self.audio_buffer.append(audio_chunk)
            
            # Check for end of speech (silence detection)
            if self.detect_silence(audio_chunk):
                self.silence_frames += 1
                # ~1.5 seconds of silence = end of speech
                if self.silence_frames > (config.SAMPLE_RATE / config.CHUNK_SIZE * 1.5):
                    await self.process_speech()
            else:
                self.silence_frames = 0
            
            # Timeout after 15 seconds of listening
            if len(self.audio_buffer) > (config.SAMPLE_RATE / config.CHUNK_SIZE * 15):
                await self.process_speech()

    async def process_speech(self):
        """Process captured speech: transcribe, query OpenClaw, respond."""
        await self.send_state(State.PROCESSING, "Thinking...")
        
        try:
            # Combine audio buffer
            audio_data = np.concatenate(self.audio_buffer)
            
            # Transcribe
            text = await self.transcribe(audio_data)
            if not text:
                await self.send_state(State.WAITING_FOR_WAKE_WORD, "Didn't catch that")
                return
            
            # Query OpenClaw
            response = await self.ask_openclaw(text)
            logger.info(f"Rey: {response}")
            
            # Send text response first
            await self.websocket.send_json({
                "type": "response",
                "user_text": text,
                "rey_text": response
            })
            
            # Synthesize and send audio
            await self.send_state(State.SPEAKING, response[:50] + "...")
            audio = await self.synthesize_speech(response)
            if audio:
                await self.send_audio(audio)
            
        except Exception as e:
            logger.error(f"Error processing speech: {e}")
            await self.websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        
        finally:
            self.audio_buffer = []
            await self.send_state(State.WAITING_FOR_WAKE_WORD)


@app.websocket("/voice")
async def voice_endpoint(websocket: WebSocket):
    """WebSocket endpoint for voice streaming."""
    await websocket.accept()
    logger.info("Client connected")
    
    session = VoiceSession(websocket)
    
    try:
        await session.initialize()
        await session.send_state(State.WAITING_FOR_WAKE_WORD, "Say 'Hey Rey' to start")
        
        while True:
            data = await websocket.receive()
            
            if "bytes" in data:
                await session.handle_audio(data["bytes"])
            elif "text" in data:
                # Handle text commands (e.g., push-to-talk trigger)
                msg = json.loads(data["text"])
                if msg.get("type") == "push_to_talk":
                    if session.state == State.WAITING_FOR_WAKE_WORD:
                        await session.send_state(State.LISTENING, "I'm listening...")
                        session.audio_buffer = []
                        session.silence_frames = 0
                    elif session.state == State.LISTENING:
                        await session.process_speech()
                        
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
