"""OpenAI Realtime bridge for Rey Voice.

This keeps OpenAI on the low-latency speech path while preserving OpenClaw as
Rey's authority for memory, tools, files, calendar, and home-server actions.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
import time
import wave
from dataclasses import dataclass
from io import BytesIO
from typing import Awaitable, Callable

import websockets

import config

logger = logging.getLogger(__name__)

AskOpenClaw = Callable[[str], Awaitable[str]]
Keepalive = Callable[[], Awaitable[None]]


@dataclass
class RealtimeResult:
    """Speech-to-speech result returned by OpenAI Realtime."""

    user_text: str
    rey_text: str
    audio_wav: bytes


VOICE_INSTRUCTIONS = """You are Rey, Patricio's personal assistant, speaking aloud.

Recognition hint: Patricio often says "Tenpace" (pronounced "ten pace"), the product/company project. Do not reinterpret that as "Tenbase" or "10 days" unless the surrounding context clearly means a duration.

You are the live voice layer. OpenClaw is the private home-server brain.
Use the ask_openclaw tool whenever a request needs Rey's memory, workspace,
files, calendar, messages, devices, project context, or any real action.

When the request is simple conversational small talk, you may answer directly.
For anything personal, factual about Patricio, stateful, or tool/action related,
call ask_openclaw first and speak the result naturally.

Voice style:
- concise, warm, conversational
- no markdown, headings, bullets, or code fences unless explicitly asked
- keep spoken answers short unless Patricio asks for detail
- do not claim to have performed actions unless OpenClaw did them
"""


def pcm16_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    """Wrap raw mono PCM16 bytes in a WAV container for browser playback."""
    if not pcm:
        return b""

    out = BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return out.getvalue()


async def run_realtime_turn(
    *,
    input_pcm16: bytes,
    ask_openclaw: AskOpenClaw,
    keepalive: Keepalive | None = None,
) -> RealtimeResult:
    """Send one captured user utterance through OpenAI Realtime.

    The current client/server still use local wake-word capture. Once an utterance
    is captured, this function lets OpenAI handle speech understanding and speech
    generation directly. Tool calls are bridged back into OpenClaw.
    """
    if not config.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required for VOICE_BACKEND=openai_realtime")

    url = f"wss://api.openai.com/v1/realtime?model={config.OPENAI_REALTIME_MODEL}"
    headers = {
        "Authorization": f"Bearer {config.OPENAI_API_KEY}",
        "OpenAI-Beta": "realtime=v1",
    }

    audio_chunks: list[bytes] = []
    text_chunks: list[str] = []
    user_text = ""
    pending_tool_tasks: set[asyncio.Task] = set()

    async def maybe_keepalive():
        if keepalive:
            try:
                await keepalive()
            except Exception:
                logger.debug("Realtime keepalive failed", exc_info=True)

    connect_kwargs = {
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_size": 16 * 1024 * 1024,
    }
    # websockets 14+ renamed extra_headers to additional_headers. Support both
    # because distro/venv installs vary across machines.
    if "additional_headers" in inspect.signature(websockets.connect).parameters:
        connect_kwargs["additional_headers"] = headers
    else:
        connect_kwargs["extra_headers"] = headers

    async with websockets.connect(url, **connect_kwargs) as ws:
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": VOICE_INSTRUCTIONS,
                "voice": config.OPENAI_REALTIME_VOICE,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": config.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
                },
                "tools": [
                    {
                        "type": "function",
                        "name": "ask_openclaw",
                        "description": "Ask Rey's OpenClaw brain to answer or perform a task with full private context, memory, tools, files, calendar, and home-server access.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "request": {
                                    "type": "string",
                                    "description": "The user's request, rewritten clearly for OpenClaw while preserving intent and relevant context.",
                                }
                            },
                            "required": ["request"],
                            "additionalProperties": False,
                        },
                    }
                ],
                "tool_choice": "auto",
                "temperature": config.OPENAI_REALTIME_TEMPERATURE,
            },
        }))

        await ws.send(json.dumps({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "audio": base64.b64encode(input_pcm16).decode("ascii"),
                    }
                ],
            },
        }))
        await ws.send(json.dumps({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        }))

        async def handle_tool_call(call_id: str, arguments_json: str):
            try:
                args = json.loads(arguments_json or "{}")
                request = (args.get("request") or "").strip()
                if not request:
                    output = "I could not read the tool request. Please ask again."
                else:
                    logger.info("Realtime calling OpenClaw: %s", request[:160])
                    started = time.time()
                    output = await ask_openclaw(request)
                    logger.info(
                        "⏱️ Realtime tool ask_openclaw elapsed=%0.2fs chars=%s",
                        time.time() - started,
                        len(output),
                    )
            except Exception as exc:
                logger.exception("OpenClaw tool call failed")
                output = f"OpenClaw tool call failed: {exc}"

            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                },
            }))
            await ws.send(json.dumps({
                "type": "response.create",
                "response": {"modalities": ["text", "audio"]},
            }))

        done_without_pending_tools = False
        deadline = asyncio.get_running_loop().time() + config.OPENAI_REALTIME_TIMEOUT_SECONDS

        while True:
            if asyncio.get_running_loop().time() > deadline:
                raise TimeoutError("OpenAI Realtime response timed out")

            # Clean up finished tool tasks and surface exceptions.
            finished = {task for task in pending_tool_tasks if task.done()}
            for task in finished:
                pending_tool_tasks.remove(task)
                task.result()

            if done_without_pending_tools and not pending_tool_tasks:
                break

            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            except asyncio.TimeoutError:
                await maybe_keepalive()
                continue

            event = json.loads(raw)
            event_type = event.get("type")

            if event_type == "error":
                logger.error("OpenAI Realtime error: %s", event)
                raise RuntimeError(event.get("error", {}).get("message") or str(event))

            if event_type == "conversation.item.input_audio_transcription.completed":
                user_text = event.get("transcript") or user_text
            elif event_type in {"response.audio_transcript.delta", "response.text.delta"}:
                text_chunks.append(event.get("delta", ""))
            elif event_type == "response.audio.delta":
                audio_chunks.append(base64.b64decode(event.get("delta", "")))
            elif event_type == "response.function_call_arguments.done":
                done_without_pending_tools = False
                call_id = event.get("call_id")
                if call_id:
                    pending_tool_tasks.add(asyncio.create_task(
                        handle_tool_call(call_id, event.get("arguments", "{}"))
                    ))
            elif event_type == "response.done":
                # A response.done after a function-call response is not the final
                # answer; wait for the tool output response we create above.
                response = event.get("response", {})
                output = response.get("output") or []
                has_function_call = any(item.get("type") == "function_call" for item in output)
                if not has_function_call:
                    done_without_pending_tools = True

    rey_text = "".join(text_chunks).strip()
    audio_wav = pcm16_to_wav(b"".join(audio_chunks), sample_rate=24000)
    return RealtimeResult(user_text=user_text.strip(), rey_text=rey_text, audio_wav=audio_wav)
