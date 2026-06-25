"""Voice endpoints — text-to-speech, speech-to-text, and realtime voice.

The TTS/STT endpoints are thin HTTP surfaces over :mod:`deeptutor.services.voice`.
Config comes from the admin-managed model catalog (``services.tts`` /
``services.stt``), so voice is shared infrastructure like embedding/search —
any authenticated user may call it; it is not gated by per-user LLM grants.

The realtime-session endpoint is different: it mints a short-lived OpenAI
Realtime API token derived from the active **LLM** profile's API key (not a
separate TTS/STT provider), so it *is* gated by the same per-user LLM grant
check the rest of the app uses (``has_capability_access("llm")``).
"""

from __future__ import annotations

import io
import logging
import wave

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field

from deeptutor.services.voice import (
    VoiceProviderError,
    synthesize_speech,
    transcribe_audio,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Guard against pathological uploads (the providers cap well below this anyway).
_MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB, matching OpenAI's limit.
_DEFAULT_PCM_SAMPLE_RATE = 24_000
_DEFAULT_PCM_CHANNELS = 1
_PCM16_SAMPLE_WIDTH = 2

# OpenAI's realtime model id. Tracks OpenAI's current GA naming; update here
# if/when it changes rather than threading a setting through the catalog —
# this is the only place it's referenced.
_REALTIME_MODEL = "gpt-realtime-2"
_REALTIME_DEFAULT_VOICE = "marin"
_REALTIME_TRANSCRIBE_MODEL = "gpt-realtime-whisper"
_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"

# Voice-driven in-app actions: navigating between pages, switching
# capabilities, starting a new chat, opening/closing history, and changing
# the theme. The frontend (VoiceOrb.tsx) is what actually performs each
# action once the model decides to call one of these mid-conversation. The
# voice call itself now lives in a sidebar mounted once at the app's root
# layout, so it survives navigation between any of these pages.
_REALTIME_TOOLS = [
    {
        "type": "function",
        "name": "navigate_to",
        "description": (
            "Navigate to a different page/section of the app. Use when the "
            "user asks to open Settings, go to their agents, open the "
            "co-writer, the book, the learning space, notebooks, memory, "
            "the knowledge center, or go back home."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": [
                        "home",
                        "settings",
                        "partners",
                        "agents",
                        "co_writer",
                        "book",
                        "learning_space",
                        "notebooks",
                        "memory",
                        "knowledge_center",
                    ],
                }
            },
            "required": ["page"],
        },
    },
    {
        "type": "function",
        "name": "switch_capability",
        "description": (
            "Switch the chat composer to a different mode/capability. Use "
            "when the user asks to do a quiz, research, solve a problem, "
            "visualize something, work on a mastery path, or go back to "
            "plain chat."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "capability": {
                    "type": "string",
                    "enum": ["chat", "quiz", "research", "solve", "visualize", "mastery_path"],
                }
            },
            "required": ["capability"],
        },
    },
    {
        "type": "function",
        "name": "start_new_chat",
        "description": "Start a brand new chat, clearing the current conversation.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "open_history",
        "description": "Open the panel listing the user's past conversations.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "close_history",
        "description": (
            "Close the history panel and go back to the chat. Use when the "
            "user is in the history/past-conversations panel and asks to go "
            "back, close it, or return to the chat."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "set_theme",
        "description": "Change the app's visual theme.",
        "parameters": {
            "type": "object",
            "properties": {
                "theme": {
                    "type": "string",
                    "enum": ["light", "dark", "glass", "snow", "brand"],
                }
            },
            "required": ["theme"],
        },
    },
]


class TTSRequest(BaseModel):
    """Text-to-speech request body."""

    text: str = Field(..., min_length=1)
    voice: str | None = None
    format: str | None = None


def _parse_pcm_content_type(content_type: str) -> tuple[int, int] | None:
    """Return ``(sample_rate, channels)`` when a provider sent raw PCM audio."""
    media_type, *params = (content_type or "").split(";")
    if media_type.strip().lower() not in {"audio/pcm", "audio/x-pcm", "audio/l16"}:
        return None
    sample_rate = _DEFAULT_PCM_SAMPLE_RATE
    channels = _DEFAULT_PCM_CHANNELS
    for item in params:
        key, sep, value = item.strip().partition("=")
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip().strip('"')
        try:
            parsed = int(value)
        except ValueError:
            continue
        if key in {"rate", "sample-rate", "samplerate"} and parsed > 0:
            sample_rate = parsed
        elif key in {"channels", "channel"} and parsed > 0:
            channels = parsed
    return sample_rate, channels


def _pcm16_to_wav(audio: bytes, *, sample_rate: int, channels: int) -> bytes:
    """Wrap provider PCM16 bytes in a WAV container browsers can play."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(_PCM16_SAMPLE_WIDTH)
        wav.setframerate(sample_rate)
        wav.writeframes(audio)
    return buffer.getvalue()


@router.post("/tts")
async def text_to_speech(payload: TTSRequest) -> Response:
    """Synthesize ``text`` to audio using the active TTS provider."""
    try:
        audio, content_type = await synthesize_speech(
            payload.text,
            voice=payload.voice,
            response_format=payload.format,
        )
    except ValueError as exc:  # missing/invalid configuration
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("TTS provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    pcm_info = _parse_pcm_content_type(content_type)
    if pcm_info:
        sample_rate, channels = pcm_info
        audio = _pcm16_to_wav(audio, sample_rate=sample_rate, channels=channels)
        content_type = "audio/wav"
    return Response(
        content=audio,
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> dict[str, str]:
    """Transcribe an uploaded audio clip using the active STT provider."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty audio upload.")
    if len(audio) > _MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Audio exceeds the 25 MB limit.",
        )
    try:
        text = await transcribe_audio(
            audio,
            filename=file.filename or "audio.webm",
            content_type=file.content_type or "application/octet-stream",
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("STT provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return {"text": text}


@router.post("/realtime-session")
async def create_realtime_session() -> dict[str, object]:
    """Mint a short-lived OpenAI Realtime API token for a direct browser↔OpenAI
    WebRTC connection. Our long-lived account key never reaches the browser —
    only this ephemeral ``client_secret`` does.

    Requires the active LLM profile to be a real OpenAI account (``binding ==
    "openai"``); the Realtime API doesn't work with Azure/other bindings.
    """
    from deeptutor.multi_user.context import get_current_user
    from deeptutor.multi_user.model_access import has_capability_access
    from deeptutor.services.llm.config import get_llm_config
    from deeptutor.services.llm.exceptions import LLMConfigError

    current_user = get_current_user()
    if not current_user.is_admin and not has_capability_access("llm"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No LLM model is assigned to your account. Please contact an administrator.",
        )

    try:
        llm_config = get_llm_config()
    except LLMConfigError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if llm_config.binding != "openai" or not llm_config.api_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Real-time voice requires the active LLM model to use a direct "
                "OpenAI account (Settings > Catalog). Configure an OpenAI API "
                "key there to enable it."
            ),
        )

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                _REALTIME_CLIENT_SECRETS_URL,
                headers={
                    "Authorization": f"Bearer {llm_config.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "session": {
                        "type": "realtime",
                        "model": _REALTIME_MODEL,
                        "audio": {
                            "input": {
                                # Without this, the API never emits
                                # conversation.item.input_audio_transcription.*
                                # events — the model still hears the user fine,
                                # but we'd have no text to save into chat history.
                                "transcription": {"model": _REALTIME_TRANSCRIBE_MODEL}
                            },
                            "output": {"voice": _REALTIME_DEFAULT_VOICE},
                        },
                        "tools": _REALTIME_TOOLS,
                    }
                },
            )
    except httpx.HTTPError as exc:
        logger.warning("Realtime client secret mint request error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not reach OpenAI to start the voice call: {exc}",
        ) from exc

    if resp.status_code >= 400:
        logger.warning(
            "Realtime client secret mint failed: HTTP %s %s", resp.status_code, resp.text[:500]
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenAI rejected the request to start the voice call.",
        )

    data = resp.json()
    client_secret = data.get("value")
    if not client_secret:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenAI did not return a usable token for the voice call.",
        )
    return {
        "client_secret": client_secret,
        "expires_at": data.get("expires_at"),
        "model": _REALTIME_MODEL,
    }
