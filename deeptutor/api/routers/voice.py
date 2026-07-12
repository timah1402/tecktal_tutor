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

# Left unset, OpenAI's default server VAD (threshold 0.5) is tuned for a quiet
# room close to the mic and readily fires on ambient noise (typing, other
# voices, background TV) picked up by laptop/phone mics in real environments.
# Raising the threshold and padding trades a little responsiveness for far
# fewer false "user is speaking" triggers. Bumped from 0.7 -> 0.8 and
# silence_duration_ms 600 -> 700 after reports of the assistant responding
# to nothing/noise with unrelated rambling — a false speech_started still
# gets transcribed as *something* (even if it's just noise), and the model
# then has to say something in response to that "something". Tune further
# here if users still report the call reacting to background noise, or
# feeling sluggish to respond.
_REALTIME_TURN_DETECTION = {
    "type": "server_vad",
    "threshold": 0.8,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 700,
}

# Voice-driven in-app actions: navigating between pages, switching
# capabilities, starting a new chat, opening/closing history, and changing
# the theme. The frontend (VoiceOrb.tsx) is what actually performs each
# action once the model decides to call one of these mid-conversation. The
# voice call itself now lives in a sidebar mounted once at the app's root
# layout, so it survives navigation between any of these pages.
# System prompt for the realtime voice assistant. Explicit instructions are
# critical: without them the model uses its own judgment about when to call
# functions vs. just describing the action verbally — leading to commands like
# "switch to quiz" being acknowledged out loud but never actually executed.
#
# Built per-session (see _build_realtime_instructions) so it can be personalized
# with the logged-in user's identity — the static string is just the shared
# template.
_REALTIME_INSTRUCTIONS_TEMPLATE = (
    "You are the voice interface for TECKTAL Tutor, an AI tutoring platform. "
    "Your name is \"TECKTAL Tutor\" — if asked your name, who you are, or who "
    "made you, say you are TECKTAL Tutor. Never call yourself DeepTutor.\n\n"
    "{user_identity}"
    "Your primary job is to help users control the app by voice and to answer "
    "educational questions concisely.\n\n"
    "FIRST, ALWAYS CLASSIFY WHAT YOU HEARD before deciding what to do: is this "
    "a greeting/acknowledgement/small talk with no actionable content ('hi', "
    "'thanks', 'ok', 'how are you', a laugh, silence/noise), a genuine "
    "question you can just answer out loud, or an explicit request to do "
    "something (navigate, switch mode, generate, save, download)? Only the "
    "third category ever calls a function. Never treat the mere fact that "
    "you heard something as a reason to act — most turns in a conversation "
    "are not requests, and defaulting to 'do something' on every turn is "
    "exactly the failure mode to avoid.\n\n"
    "CRITICAL RULE — tool use: whenever the user asks to navigate, switch modes, "
    "start a new chat, open/close history, change the theme, or expand/collapse "
    "the menu, you MUST call the matching function. Never describe the action "
    "verbally without calling the function — the function is what actually makes "
    "the app respond. Speak a short confirmation AFTER calling it.\n\n"
    "Available actions (call the function, do not just say you will):\n"
    "• navigate_to — go to a whole different PAGE of the app: home, settings, "
    "partners, agents, co_writer, book, learning_space, notebooks (the "
    "Notebooks library page itself), memory, knowledge_center.\n"
    "• switch_capability — change chat mode: chat, quiz, research, solve, "
    "visualize, mastery_path. Only fill its `request` argument when the user "
    "gave actual concrete content to generate (a topic, a chapter, a specific "
    "thing to visualize) — that argument triggers real generation immediately. "
    "For a bare mode switch with no specific content yet ('switch to "
    "visualize mode', 'let's do a quiz'), call switch_capability with "
    "`request` empty/omitted so it just changes the mode and waits for the "
    "user to say what they want. For visualize specifically, see the "
    "VISUALIZING section below before filling in `request`. NEVER call "
    "switch_capability for a short acknowledgement or filler utterance — "
    "'thanks', 'thank you', 'ok', 'okay', 'alright', 'cool', 'got it', "
    "'sounds good', 'nice', 'sure', a laugh, or similar — these carry no new "
    "request even if a capability (e.g. visualize) is already active; just "
    "reply naturally with speech, no function call, no repeated generation. "
    "Only call switch_capability again mid-session if the user clearly "
    "describes a genuinely new/different thing to generate.\n"
    "• start_new_chat — clear the current conversation and open a fresh one.\n"
    "• open_history / close_history — show or hide the past-conversations panel.\n"
    "• set_theme — change the visual theme: light, dark, glass, snow, brand.\n"
    "• show_more / show_less — expand or collapse the home-page action menu.\n"
    "• save_quiz_to_notebook — save the quiz CONTENT the user is currently "
    "taking into one of their notebooks. Use this — not navigate_to — whenever "
    "the user says something like 'save this', 'save this quiz', 'save this "
    "to my notebook(s)', or 'bookmark this' while a quiz is open. Only "
    "navigate_to(page='notebooks') if they explicitly ask to open/go to the "
    "notebooks page itself, not to save something into one.\n"
    "• download_quiz — download the quiz the user is currently taking as a "
    "file. Only call this while a quiz is open on screen.\n\n"
    "SOLVING / CALCULATING — exception to the 'keep it short' rule below: "
    "whenever the user asks you to solve, calculate, prove, or derive "
    "something (an exercise, a problem, an equation, anything with a right "
    "answer reached through steps), speak the full step-by-step walkthrough "
    "out loud, as if teaching someone who has never learned this before — "
    "say the result, then walk back through each step in order explaining "
    "what you did and why, defining any term a first-time learner wouldn't "
    "know. Do not just say the final answer and do not compress the steps "
    "away for brevity.\n\n"
    "VISUALIZING — you are audio-only and never generate the actual chart, "
    "diagram, or figure yourself. When the user asks to visualize something "
    "and does NOT already say what format they want, ask ONE short "
    "follow-up first — e.g. \"Would you like that as a chart, a diagram, an "
    "illustration, or an animation?\" — and wait for their answer before "
    "calling switch_capability. Skip the question only if they already told "
    "you the format, or if they explicitly say they don't care / want you to "
    "choose (then use render_mode='auto'). Once you know both the content "
    "and the format, call switch_capability(visualize) with `request` AND "
    "`render_mode` filled in — that hands the request off to the real "
    "visualization pipeline, which runs separately and takes a few seconds. "
    "Never describe, draw, or narrate what the chart supposedly looks like, "
    "you have not seen it and guessing produces a description that won't "
    "match what's actually generated. Just acknowledge briefly, e.g. "
    "\"Generating that now — check the chat.\" Keep it to one short "
    "sentence, then stop. If `request` was left empty (bare mode switch), "
    "just confirm the mode change and ask what they'd like visualized. "
    "After you've already called switch_capability(visualize) with a "
    "request, the pipeline is already running — do not call it again for "
    "whatever the user says next unless it is unmistakably a new, distinct "
    "visualization request. Replies like 'thanks', 'alright', 'ok', or "
    "general conversation are just conversation; answer them normally "
    "without touching switch_capability or restarting generation. THIS "
    "APPLIES EVEN WHEN ALREADY IN VISUALIZE MODE FROM AN EARLIER REQUEST: "
    "the format question is per-request, not per-session — a new distinct "
    "topic ('now visualize X' / 'also show me Y' / any different content) "
    "still needs its own format answered first, exactly like the very first "
    "request did. Never reuse or assume the previous request's format for a "
    "different topic, and never call switch_capability for the new topic "
    "until you've asked and the user has answered (or already stated the "
    "format themselves, or said they don't care).\n\n"
    "UNCLEAR AUDIO — if the transcribed input is empty, garbled, just "
    "background noise, or otherwise doesn't contain an actual question or "
    "request, do NOT invent a topic or continue rambling on an unrelated "
    "subject. Briefly ask the user to repeat themselves (e.g. \"Sorry, I "
    "didn't catch that — could you say it again?\") and stop; never call a "
    "function based on a guess about what noisy audio might have meant.\n\n"
    "UPLOADED FILES — you are audio-only and never receive the bytes of any "
    "file the user has attached in the app; solving it is handled elsewhere "
    "and appears in the chat. When the user asks you to solve, read, "
    "summarize, or explain something 'in the file' / 'in this document' / "
    "'in what I uploaded', never say you can't access, open, read, or see "
    "the file, and never mention being audio-only or lacking a tool for it — "
    "the user does not need that explained. Just acknowledge the request "
    "positively and point them to the chat, e.g. \"Here's the resolution — "
    "check the chat.\" or \"Working on it, you'll see the full solution in "
    "the chat.\" Keep it to one short sentence, then stop.\n\n"
    "For everything else (questions, explanations, tutoring), just answer helpfully "
    "and concisely — voice responses should be short."
)


def _build_realtime_instructions(username: str) -> str:
    """Fill the shared template with the logged-in user's identity, so the
    model can answer "who am I?" instead of deflecting or guessing."""
    identity = (
        f'The person you are talking to is logged in as "{username}". If they '
        f"ask who they are or what their username/account is, answer with that "
        f"name directly instead of saying you don't know.\n\n"
    )
    return _REALTIME_INSTRUCTIONS_TEMPLATE.format(user_identity=identity)


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
                },
                "request": {
                    "type": "string",
                    "description": (
                        "The specific thing to generate, ONLY if the user actually "
                        "described concrete content — e.g. 'the water cycle' for "
                        "'visualize the water cycle', or 'chapter 3 on photosynthesis' "
                        "for 'quiz me on chapter 3'. Leave this empty/omit it entirely "
                        "when the user only asked to switch modes with no specific "
                        "content yet, e.g. 'switch to visualize mode' or 'let's do a "
                        "quiz' — passing anything here starts real generation "
                        "immediately, which would be wrong for a bare mode switch."
                    ),
                },
                "render_mode": {
                    "type": "string",
                    "enum": ["auto", "svg", "chartjs", "mermaid", "html", "manim_video"],
                    "description": (
                        "Only used when capability='visualize' and `request` is "
                        "filled in — the visual format the user wants. Map their "
                        "words to: a bar/line/pie/data chart -> 'chartjs'; a "
                        "diagram, flowchart, or process/relationship map -> "
                        "'mermaid'; a precise vector drawing/illustration/geometry "
                        "figure -> 'svg'; an interactive page or simulation -> "
                        "'html'; a narrated video/motion animation -> "
                        "'manim_video'. Use 'auto' only if the user explicitly "
                        "says they don't care or want you to choose — otherwise "
                        "ask them first (see VISUALIZING instructions) rather "
                        "than guessing."
                    ),
                },
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
    {
        "type": "function",
        "name": "show_more",
        "description": (
            "Expand the home-page action menu to reveal all tools and nav "
            "destinations. Use when the user says 'show more', 'expand', "
            "'see all options', or similar."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "show_less",
        "description": (
            "Collapse the home-page action menu back to the headline tiles. "
            "Use when the user says 'show less', 'collapse', 'hide', or similar."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "save_quiz_to_notebook",
        "description": (
            "Save the quiz CONTENT the user is currently taking into one of "
            "their notebooks. Use this for phrases like 'save this', 'save "
            "this quiz', 'save this to my notebook(s)', or 'bookmark this' "
            "while a quiz is open — this is different from navigate_to's "
            "'notebooks' page, which just opens the notebooks list without "
            "saving anything. Only meaningful while a quiz is open on screen."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "download_quiz",
        "description": (
            "Download the quiz the user is currently taking as a file. Use "
            "when the user asks to download, export, or save a copy of the "
            "current quiz to their device. Only meaningful while a quiz is "
            "open on screen."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
]


class TTSRequest(BaseModel):
    """Text-to-speech request body."""

    text: str = Field(..., min_length=1)
    voice: str | None = None
    format: str | None = None


class ExecuteActionRequest(BaseModel):
    """A voice-triggered function call, as received from OpenAI's Realtime
    API in the browser — relayed here so it executes through a real MCP
    ``call_tool`` round-trip instead of a client-side switch-statement."""

    name: str = Field(..., min_length=1)
    arguments: dict[str, object] = Field(default_factory=dict)


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
                        "instructions": _build_realtime_instructions(current_user.username),
                        "audio": {
                            "input": {
                                # Without this, the API never emits
                                # conversation.item.input_audio_transcription.*
                                # events — the model still hears the user fine,
                                # but we'd have no text to save into chat history.
                                "transcription": {"model": _REALTIME_TRANSCRIBE_MODEL},
                                "turn_detection": _REALTIME_TURN_DETECTION,
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


@router.post("/execute-action")
async def execute_voice_action(payload: ExecuteActionRequest) -> dict[str, object]:
    """Execute a voice-triggered function call through the internal
    voice-actions MCP server (see ``deeptutor.services.voice.mcp_action_server``).

    The browser still owns the actual realtime connection and still has to
    apply the result locally (only it can navigate its own router, change
    its own React state, etc.) — this endpoint is the validation/execution
    step in between, and it's a real MCP ``call_tool`` round-trip, not a
    second copy of the validation logic.
    """
    from deeptutor.multi_user.context import get_current_user
    from deeptutor.multi_user.model_access import has_capability_access
    from deeptutor.services.voice.mcp_action_client import call_voice_action

    current_user = get_current_user()
    if not current_user.is_admin and not has_capability_access("llm"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No LLM model is assigned to your account. Please contact an administrator.",
        )

    return await call_voice_action(payload.name, payload.arguments)
