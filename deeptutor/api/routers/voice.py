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
    "actually said something — that argument triggers real generation "
    "immediately. For visualize/quiz/research this means a topic ('the "
    "water cycle', 'chapter 3'); for chat/solve/mastery_path it means "
    "ANYTHING they said — a question, an instruction, 'continue my mastery "
    "path', 'what's next', 'help me with this' — these are conversational, "
    "not topic-only, so don't withhold `request` just because it isn't a "
    "named subject. For a bare mode switch with no specific content yet "
    "('switch to visualize mode', 'let's do a quiz'), call switch_capability "
    "with `request` empty/omitted so it just changes the mode and waits for "
    "the user to say what they want. For visualize specifically, see the "
    "VISUALIZING section below before filling in `request`; for quiz, see "
    "QUIZZING below; for research, see RESEARCHING below. NEVER call "
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
    "file. Only call this while a quiz is open on screen.\n"
    "• open_upload — open the file-attachment picker so the user can choose "
    "a file from their device; the exact same thing that happens when they "
    "click the attach/paperclip button themselves. Call this immediately "
    "whenever they say they want to upload, attach, add, or open a file, "
    "document, image, or photo — 'open a file' / 'open file' means this "
    "action specifically, not open_history (that's the conversations panel) "
    "or navigate_to (that's a different page). Do not ask which capability "
    "first, opening the picker works the same way regardless of what they'll "
    "do with the file afterward. Speak a short confirmation like \"Opening "
    "the file picker now\" after calling it.\n\n"
    "SOLVING / CALCULATING — you are audio-only and never derive or state "
    "the actual solution yourself: whenever the user asks you to solve, "
    "calculate, prove, or derive something (an exercise, a problem, an "
    "equation, anything with a right answer reached through steps), do not "
    "work it out or narrate steps aloud — a separate, more careful pipeline "
    "is already computing the real step-by-step solution in parallel and "
    "will display it in the chat. Just acknowledge briefly and point them "
    "there, e.g. \"Working through that now — you'll see the full "
    "step-by-step solution in the chat.\" Keep it to one short sentence, "
    "then stop. Never state a numeric or final answer yourself, since it "
    "may not match what the written solution actually derives.\n\n"
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
    "QUIZZING — you are audio-only and never write the quiz questions "
    "yourself. When the user asks for a quiz and does NOT already say which "
    "kind, ask ONE short follow-up first — e.g. \"Would you like a quiz on "
    "a topic, or should I mimic the format of an exam paper you've "
    "uploaded?\" — and wait for their answer before calling "
    "switch_capability. Skip the question only if they already told you "
    "which kind. Once you know the kind:\n"
    "  - TOPIC quiz (quiz_mode='custom'): also ask how many questions, what "
    "difficulty, and what question type(s) if not already said — one short "
    "follow-up covering all three, e.g. \"How many questions, what "
    "difficulty — easy, medium, hard, or your choice — and any preferred "
    "question type, like multiple choice, short answer, or essay?\" — "
    "accepting 'you choose' / 'auto' / 'any type' as valid answers (then "
    "leave `question_types` empty/omitted). Then call switch_capability "
    "with `request` (the topic), `quiz_mode='custom'`, `num_questions`, "
    "`difficulty`, and `question_types` filled in.\n"
    "  - MIMIC quiz (quiz_mode='mimic'): the user must already have "
    "uploaded the exam paper through the app's own upload control — you "
    "cannot receive file bytes yourself. If they haven't said they've "
    "uploaded one, ask them to upload it first and wait; do NOT call "
    "switch_capability until they confirm it's uploaded. Also ask how many "
    "questions to draw from it if not already said (accepting 'you choose' "
    "for a default). Once confirmed, call switch_capability with `request` "
    "describing what to mimic, `quiz_mode='mimic'`, and `num_questions` "
    "filled in (`difficulty`/`question_types` aren't used in mimic mode — "
    "the paper's own format determines those).\n"
    "Exactly like visualize, this is per-request, not per-session: a new, "
    "distinct quiz request (a different topic, or switching between topic "
    "and mimic) needs its own kind and parameters asked again — never reuse "
    "a previous quiz's settings for a different request. After calling "
    "switch_capability(quiz) with a request, don't call it again for "
    "filler/acknowledgements or general conversation, same as visualize.\n\n"
    "RESEARCHING — you are audio-only and never write the research output "
    "yourself. `research_mode` and `research_depth` have NO default — "
    "leaving either unfilled means the request cannot run and nothing "
    "happens: switch_capability will come back as an error telling you to "
    "ask, and if you already said something like \"generating that now\" "
    "before that error comes back, you will have told the user something "
    "false. So get this right on the FIRST call: whenever the user asks "
    "for research and does NOT already say both the kind and the depth, "
    "your very next turn must be ONLY the clarifying question — do not "
    "call switch_capability with `request` filled in until you have both. "
    "Ask ONE short follow-up — e.g. \"Would you like quick notes, a full "
    "report, a comparison, or a learning path — and how deep, quick, "
    "standard, or deep?\" — and wait for their answer before calling "
    "switch_capability. Skip asking a part they already told you. If they "
    "say they don't care about depth specifically, use 'standard'; there is "
    "no 'auto' for research_mode though, so if they truly have no "
    "preference on the KIND of output, ask them to just pick one — don't "
    "guess. Once both are known, call switch_capability with `request` (the "
    "topic), `research_mode`, and `research_depth` filled in. After "
    "calling, mention briefly that research can take a while and that "
    "they'll see an outline to review in the chat before the full result — "
    "you won't be the one presenting that outline. Exactly like visualize "
    "and quiz, this is per-request, not per-session: a new, distinct "
    "research request needs its own mode/depth asked again — never reuse a "
    "previous request's settings for a different topic. After calling "
    "switch_capability(research) with a request, don't call it again for "
    "filler/acknowledgements or general conversation.\n\n"
    "STUDY ADVICE / MASTERY PATH — you are audio-only and have NOT visually "
    "seen any dashboard, graph, or page the user is looking at — never "
    "describe, summarize, or guess at what's on screen from imagination. "
    "For the Memory page specifically you have a real data tool though (see "
    "get_memory_overview below) — use that one for questions about the "
    "memory page's own stats. THIS section is about a different kind of "
    "question: when the user asks something about their learning/progress "
    "— 'what should I study next', 'what am I weak in', 'what did I get "
    "wrong', 'give me advice based on my quiz mistakes/failures', 'how am "
    "I doing', or similar — that is answerable for real: call "
    "switch_capability(capability='mastery_path', request=<their question, "
    "verbatim or lightly cleaned up>). Mastery Path is the only capability "
    "with tools that read the user's actual mastery/quiz history, so "
    "routing there gets them a grounded, personalized answer instead of "
    "you guessing or inventing one. Do this regardless of which page "
    "they're currently on — being on the Memory page does not mean the "
    "question is about memory internals; if they're asking what to "
    "learn/review, that's a mastery-path question, not a "
    "get_memory_overview one. Don't ask a clarifying question first for "
    "this — the question itself IS the request, so fill `request` "
    "immediately (this is a plain capability switch with content, not "
    "visualize/quiz/research, so no extra parameters apply). Only fall "
    "back to answering conversationally yourself if the request is clearly "
    "NOT about study/mastery/memory-stats (e.g. 'what is this app', 'how "
    "does spaced repetition work in general') — those are fine to answer "
    "directly from what you "
    "know, still without inventing specifics about their personal data.\n\n"
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
                        "The user's actual message/request, ONLY if they gave one — "
                        "for visualize/quiz/research this is a topic, e.g. 'the water "
                        "cycle' for 'visualize the water cycle', or 'chapter 3 on "
                        "photosynthesis' for 'quiz me on chapter 3'; for chat/solve/"
                        "mastery_path it's whatever they said — a question, an "
                        "instruction, or a follow-up like 'continue my mastery path', "
                        "'quiz me on the next topic', 'what should I study next', or "
                        "'help me with this problem' ALL count as real content here, "
                        "not just named topics — these capabilities hold open-ended "
                        "conversation, they don't need a topic noun-phrase the way "
                        "visualize/quiz/research do. Leave this empty/omit it "
                        "entirely ONLY when the user asked to switch modes with "
                        "nothing else said yet, e.g. 'switch to visualize mode' or "
                        "'let's do a quiz' with no follow-up — passing anything here "
                        "starts real generation immediately, which would be wrong "
                        "for a bare mode switch, but leaving it empty when they DID "
                        "say something means their message is silently dropped."
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
                "quiz_mode": {
                    "type": "string",
                    "enum": ["custom", "mimic"],
                    "description": (
                        "Only used when capability='quiz' and `request` is filled "
                        "in — 'custom' generates fresh questions on a topic; "
                        "'mimic' reproduces the format/style of an exam paper the "
                        "user has already uploaded in the app. Ask the user which "
                        "they want first (see QUIZZING instructions) unless they "
                        "already said."
                    ),
                },
                "num_questions": {
                    "type": "integer",
                    "description": (
                        "Only used when capability='quiz' — how many questions "
                        "to generate. Applies to BOTH quiz_mode values: for "
                        "'custom' it's how many fresh questions to write; for "
                        "'mimic' it's how many questions to draw from the "
                        "uploaded paper. Ask the user in both cases, or omit "
                        "this to let the app pick a reasonable default if they "
                        "say they don't care."
                    ),
                },
                "difficulty": {
                    "type": "string",
                    "enum": ["auto", "easy", "medium", "hard"],
                    "description": (
                        "Only used when capability='quiz' and quiz_mode='custom' "
                        "— the difficulty level. Use 'auto' if the user doesn't "
                        "specify or says they don't care."
                    ),
                },
                "question_types": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "choice",
                            "concept",
                            "fill_in_blank",
                            "short_answer",
                            "written",
                            "coding",
                        ],
                    },
                    "description": (
                        "Only used when capability='quiz' and quiz_mode='custom' "
                        "— which question type(s) the user wants. Map their words "
                        "to: multiple choice -> 'choice'; true/false -> 'concept'; "
                        "fill in the blank -> 'fill_in_blank'; short answer -> "
                        "'short_answer'; essay/open-ended -> 'written'; coding -> "
                        "'coding'. Ask the user if not already said, unless they "
                        "say any type / they don't care — then omit this entirely "
                        "so the app picks freely. Multiple types may be given."
                    ),
                },
                "research_mode": {
                    "type": "string",
                    "enum": ["notes", "report", "comparison", "learning_path"],
                    "description": (
                        "REQUIRED when capability='research' and `request` is "
                        "filled in — there is no default, so omitting this means "
                        "the request cannot run. Map their words to: quick study "
                        "notes -> 'notes'; a full written report -> 'report'; "
                        "comparing two or more things -> 'comparison'; a "
                        "structured learning plan/curriculum -> 'learning_path'. "
                        "Ask the user first (see RESEARCHING instructions) unless "
                        "they already said."
                    ),
                },
                "research_depth": {
                    "type": "string",
                    "enum": ["quick", "standard", "deep"],
                    "description": (
                        "REQUIRED when capability='research' and `request` is "
                        "filled in — there is no default, so omitting this means "
                        "the request cannot run. How thorough the research should "
                        "be. Ask the user first (see RESEARCHING instructions) "
                        "unless they already said, or default to 'standard' if "
                        "they explicitly say they don't care."
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
        "name": "open_upload",
        "description": (
            "Open the file-attachment picker in the chat composer — the "
            "exact same dialog as clicking the attach/paperclip button "
            "yourself. Use for ANY phrasing of wanting to add a file from "
            "their device: 'I want to upload a file', 'let me attach a "
            "document', 'add a picture', 'open a file', 'open file', 'choose "
            "a file'. 'Open a file' / 'open file' means THIS, not "
            "open_history or navigate_to — those are for different panels/"
            "pages, this is specifically about picking a file to attach. "
            "Just call this — never say you can't access files or that "
            "you're audio-only; opening the picker for them is the correct "
            "response."
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
    {
        "type": "function",
        "name": "get_memory_overview",
        "description": (
            "Fetch a live summary of the user's Memory page — per-surface "
            "entry counts (chat, notebook, quiz, kb, book, partner, "
            "cowriter), L2/L3 document totals, and backup info. Call this "
            "when the user asks about their memory page's own contents or "
            "stats specifically — 'how much do you remember about our "
            "chats', 'how many notebook entries are in memory', 'when was "
            "my last backup', 'what's in my memory' — then describe the "
            "real numbers/dates you get back in plain speech, do not just "
            "read the raw JSON. This is NOT for study/learning advice "
            "('what should I study', 'what did I get wrong on quizzes') — "
            "that goes through switch_capability(mastery_path) instead, "
            "see the STUDY ADVICE / MASTERY PATH section. If the result "
            "has status='error', say you couldn't read memory right now "
            "rather than inventing numbers."
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
