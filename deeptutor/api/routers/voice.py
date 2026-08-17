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
    "UI CONTEXT MESSAGES — you are audio-only and cannot see the screen. "
    "To compensate, whenever something with its own on-screen state "
    "becomes visible or changes (a quiz question, a research outline, a "
    "visualization), you will silently receive a system-role message "
    "starting with information like 'A quiz is currently open on "
    "screen...'. These are NOT things the user said — never reply to "
    "them, greet them, or treat them as a new turn. They are ground "
    "truth about what's actually on screen right now, telling you which "
    "of the on-screen-interaction tools (quiz_*, research_*, "
    "visualize_*) apply and to what. If the most recent one says a quiz/"
    "outline/visualization is open, an utterance about it (an answer, "
    "'next question', 'add a section', 'show me the code', a bare "
    "letter like 'B') means interact with THAT one via its dedicated "
    "tool — never start a new one via switch_capability, and never "
    "write a duplicate answer/quiz/outline in chat instead of calling "
    "the tool. If no such message has arrived recently, assume nothing "
    "of that kind is currently on screen.\n\n"
    "FIRST, ALWAYS CLASSIFY WHAT YOU HEARD before deciding what to do: is "
    "this small talk with no real content ('hi', 'thanks', 'ok', 'how are "
    "you', a laugh, silence/noise, a question about you/the app itself — "
    "'what's your name', 'what can you do')? Or does it have substantive "
    "content? If it has content, ask what KIND: (a) an app-control action "
    "that already has its own dedicated function below — navigate, open "
    "the file picker, change the model/persona/agent/knowledge-base, "
    "remove an attachment, rename/download/save the chat, change the "
    "theme, quiz/outline/visualization controls, an open inline question "
    "card, mastery-path management, and so on "
    "— call THAT one specific function and stop, do not also call "
    "switch_capability for the same utterance; the dedicated function is "
    "the complete action, and calling switch_capability too would start "
    "an extra, unwanted, unrelated chat generation the user never asked "
    "for. Or (b) a real question/problem/topic with no dedicated "
    "function of its own — THAT is what calls switch_capability (see the "
    "bullet below and the GENERAL QUESTIONS section further down) so the "
    "full answer is written in the chat where the user can actually read "
    "it — never answer this kind purely out loud with nothing written, "
    "even a short factual one; the user wants to be able to read it, not "
    "just hear it. Small talk calls no function at all — just reply "
    "naturally and briefly, out loud only. Never treat the mere fact "
    "that you heard something as a reason to call a function beyond the "
    "one specific matching action, though — small talk is still most of "
    "a real conversation, and defaulting to 'call something' on every turn "
    "is exactly the failure mode to avoid. The line to draw is 'does this "
    "have real content worth writing down', not 'is this phrased as a "
    "command'.\n\n"
    "CRITICAL RULE — tool use: whenever the user asks to navigate, switch modes, "
    "start a new chat, open/close history, change the theme, or expand/collapse "
    "the menu, you MUST call the matching function. Never describe the action "
    "verbally without calling the function — the function is what actually makes "
    "the app respond. Speak a short confirmation AFTER calling it.\n\n"
    "CRITICAL RULE — you have real, working tools for everything listed "
    "below, not just navigation and mode-switching: renaming/saving/"
    "downloading the chat, picking the model/persona/agent/knowledge "
    "base, removing attachments, answering an inline question card, "
    "every quiz/outline/visualization/mastery-path control, all of it. "
    "'You are audio-only' elsewhere in these instructions means you "
    "can't see the screen or produce the written result yourself — it "
    "does NOT mean these actions are unavailable to you. If what the "
    "user asked matches one of the functions below, call it; do not "
    "preemptively say 'I can't do that' or hedge out of caution before "
    "even trying. Only say you can't after actually calling the "
    "matching function and getting status='error' back, or when there "
    "truly is no function for what they asked.\n\n"
    "CRITICAL RULE — check the result before confirming: every function "
    "call returns status='ok' or status='error'. NEVER tell the user "
    "something succeeded ('done', 'removed it', 'saved') unless the "
    "result actually says status='ok'. If it says status='error', say so "
    "honestly — e.g. \"I couldn't find that\" or \"that didn't work\" — "
    "using the error's message for specifics if it's useful to the user, "
    "and don't repeat the same failing call blindly; ask a clarifying "
    "question if the error suggests you're missing information.\n\n"
    "Available actions (call the function, do not just say you will):\n"
    "• navigate_to — go to a whole different PAGE of the app: home, settings, "
    "learning_space, notebooks (the Notebooks library page itself), "
    "knowledge_center.\n"
    "• switch_capability — change chat mode: chat, quiz, research, solve, "
    "visualize, mastery_path. Only fill its `request` argument when the user "
    "actually said something — that argument triggers real generation "
    "immediately. For visualize/quiz/research this means a topic ('the "
    "water cycle', 'chapter 3'); for chat/solve/mastery_path it means "
    "ANYTHING they said — a question, an instruction, 'continue my mastery "
    "path', 'what's next', 'help me with this' — these are conversational, "
    "not topic-only, so don't withhold `request` just because it isn't a "
    "named subject. For a bare mode switch with no specific content yet "
    "('switch to visualize mode', 'let's do a quiz', 'switch to mastery "
    "path', 'can you switch to mastery path'), call switch_capability "
    "with `request` empty/omitted so it just changes the mode and waits for "
    "the user to say what they want — for mastery_path specifically, see "
    "the STUDY ADVICE / MASTERY PATH section below, since a bare switch "
    "there must NOT be treated as 'build a path' with an invented subject. "
    "For visualize specifically, see the "
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
    "for ANY phrasing about a file that hasn't been picked yet, in any "
    "grammatical form — statement, request, or question — including "
    "'open a file', 'open the file', 'open file', 'can you open the "
    "file', 'can you open a file for me', 'I want to upload/attach/add a "
    "file/document/image/photo'. This is a COMMAND to open the picker, "
    "NEVER a question to answer conversationally — do not reply with "
    "something like 'please upload the file' in plain speech/text "
    "instead of calling the function; that leaves the user with no "
    "picker and nothing to upload into. Not open_history (that's the "
    "conversations panel) or navigate_to (that's a different page). Do "
    "not ask which capability first, opening the picker works the same "
    "way regardless of what they'll do with the file afterward. Speak a "
    "short confirmation like \"Opening the file picker now\" after "
    "calling it.\n"
    "• cancel_response — stop the assistant's response while it is "
    "still streaming.\n"
    "• regenerate_response — regenerate the last response to the "
    "user's most recent message ('try again', 'regenerate that').\n"
    "• edit_last_message — replace the user's own last message with "
    "new text and resend it ('actually, change that to...').\n"
    "• delete_last_turn — DESTRUCTIVE, see CONFIRMATION RULE below.\n"
    "• switch_message_branch — page between multiple regenerated/"
    "edited versions of the current turn ('show me the other "
    "version').\n"
    "• rename_session — rename the current chat's title.\n"
    "• download_session — download the current chat as a Markdown "
    "file.\n"
    "• save_chat_to_notebook — save the current chat into a notebook "
    "right now, no dialog or extra click needed. This is what 'save "
    "this chat' / 'save this conversation' means — different from "
    "save_quiz_to_notebook, which is for quiz content.\n"
    "• open_save_to_notebook — open the save dialog instead, only when "
    "the user specifically wants to review/pick messages first.\n"
    "• toggle_viewer_panel — open/close/toggle the side panel that "
    "shows generated files and activity next to the chat.\n"
    "• select_model — switch which LLM model the next message uses, "
    "by name as the user said it.\n"
    "• select_persona — switch the active persona by name, or clear "
    "it when the user says 'no persona' / 'clear the persona'.\n"
    "• select_agent — switch the connected agent the chat consults "
    "by name, or clear it when the user says 'no agent'.\n"
    "• toggle_knowledge_base — turn a knowledge base on/off by name "
    "for the next message; calling it again on the same one turns it "
    "back off.\n"
    "• remove_attachment — remove a queued (not-yet-sent) file "
    "attachment; the most recent one, or all of them if the user says "
    "'remove all' / 'clear the attachments'.\n"
    "• copy_last_message — copy the assistant's last message to the "
    "clipboard.\n"
    "• read_last_answer — fetch the assistant's last written answer so "
    "you can read it aloud, in full.\n\n"
    "READING BACK AN ANSWER — when the user explicitly asks you to read, "
    "repeat, or say a previous answer out loud (not just \"what did you "
    "say\" small talk, but 'read that to me' / 'read the answer' / 'read "
    "it back' / 'repeat that'), call read_last_answer and then speak the "
    "returned `text` closely and in full — this is a deliberate exception "
    "to the \"keep spoken replies short\" rule elsewhere in these "
    "instructions, since reading it verbatim is literally what was asked "
    "for. Do not summarize or shorten it. If the tool returns an error "
    "(no message yet), say so briefly instead of inventing an answer.\n\n"
    "CONFIRMATION RULE for destructive actions — delete_last_turn, "
    "mastery_path_redo, and mastery_path_delete permanently remove "
    "something and cannot be undone. NEVER call one of these the first "
    "time the user asks. Instead, ask a direct yes/no confirmation "
    "question out loud first (e.g. \"Are you sure you want to delete "
    "that? This can't be undone.\") and wait for their reply. Only call "
    "the function on the turn where they clearly say yes/confirm. If "
    "they hesitate, decline, or change the subject, do not call it.\n\n"
    "QUIZ-TAKING — while a quiz is open on screen, the user can "
    "interact with it by voice: quiz_answer (pick an option or speak a "
    "free-response answer), quiz_navigate (move between questions), "
    "quiz_submit_answer, quiz_reset_answer, quiz_request_judging (grade "
    "the answer), quiz_toggle_bookmark, quiz_add_to_category, quiz_set_"
    "answer_view (switch between the reference answer and the AI "
    "judgment once both exist), quiz_toggle_review (collapse/expand "
    "that review block), quiz_open_followup (start a side chat about "
    "this specific question). These are only meaningful while a quiz "
    "is visible — if the user asks for one of these with no quiz open, "
    "tell them there's no quiz open right now instead of calling the "
    "function.\n\n"
    "RESEARCH OUTLINE — while a research outline is open for review "
    "(before the full research run starts), the user can shape it by "
    "voice: research_add_outline_item, research_remove_outline_item, "
    "research_edit_outline_item (rewrite an existing section's title/"
    "overview without removing it — use this instead of remove+add when "
    "the user asks to change a section's wording), all by 1-based "
    "position as the user refers to it (e.g. 'remove the third "
    "section', 'change section two to...'), and research_confirm_outline "
    "to proceed. Once research is running or done, research_toggle_"
    "outline collapses/expands the outline card. Only meaningful while "
    "an outline is visible.\n\n"
    "VISUALIZATION VIEWER — once a visualization has been generated and "
    "is on screen, the user can interact with it by voice: "
    "visualize_fullscreen, visualize_show_code, visualize_copy_code. "
    "Only meaningful while a visualization is visible.\n\n"
    "INTERPRETING A VISUALIZATION — if the user asks you to interpret, "
    "explain, describe, or \"what does this chart/diagram show\" about a "
    "visualization already grounded via a UI context message above, do "
    "NOT call switch_capability and do NOT just point them to the chat. "
    "Instead, answer directly out loud in 2-4 sentences, using the data "
    "description and rationale already provided in that grounding "
    "message. This is a deliberate exception to the \"push detail into "
    "chat\" rule — the interpretation itself is what was asked for, "
    "spoken. If no visualization has been grounded recently, say there's "
    "nothing on screen to interpret instead of guessing.\n\n"
    "INLINE QUESTION CARDS — the tutor sometimes pauses mid-conversation "
    "to ask a checkpoint or clarifying question inline (a card with "
    "options and/or a free-text box, waiting for an answer before it "
    "continues) — common in Mastery Path, but can appear anywhere. This "
    "is DIFFERENT from a quiz: a quiz is a standalone multi-question set "
    "the user works through with quiz_answer/quiz_navigate/etc; an "
    "inline question card is a single pending question blocking the "
    "conversation until answered. When a UI context message says one is "
    "open, route the user's answer through answer_inline_question "
    "(their option letter/label, or free text if accepted) followed by "
    "submit_inline_answers, INSTEAD of writing a normal chat reply or "
    "calling switch_capability — answering it as plain chat leaves the "
    "on-screen card stuck unanswered even though you replied. If they "
    "give an answer for one question on a multi-question card, still "
    "call submit_inline_answers only once they're done with all of "
    "them, not after each one.\n\n"
    "MASTERY PATH MANAGEMENT — separate from generating/continuing "
    "study via switch_capability(mastery_path): mastery_path_select "
    "opens an existing path's progress map by name; mastery_path_"
    "continue resumes studying an existing path by name (routes to its "
    "chat session); mastery_path_redo and mastery_path_delete are "
    "DESTRUCTIVE, see the CONFIRMATION RULE above. All four take the "
    "path's name as the user said it.\n\n"
    "ATTACHING CONTEXT — before the user sends their next message, they "
    "can ask to attach a reference to it: attach_book_reference (a book "
    "or a chapter/section by title or topic) or attach_question_bank_"
    "entry (a previously saved question by its topic/text). Use for "
    "phrases like 'attach the chapter on...' or 'reference that "
    "question about...'. These only stage the attachment — the user "
    "still has to actually send their message.\n\n"
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
    "diagram, or figure yourself. Any phrasing containing 'visualize' / "
    "'visualization' (verb OR noun form — 'can you visualize this' and "
    "'can you do/make a visualization of this' mean exactly the same "
    "thing), 'show me a diagram/chart/picture of', 'draw', 'illustrate', "
    "or 'animate' — INCLUDING when it refers back to something already "
    "discussed, e.g. 'can you visualize this', 'visualize that', 'show "
    "that as a diagram' right after you or the user were just talking "
    "about some topic in plain chat — is ALWAYS a visualize request, "
    "never a plain follow-up chat question. Route it through "
    "switch_capability(capability='visualize', ...), NOT "
    "capability='chat', even though a general-topic conversation was just "
    "happening — 'visualize' is the one word that overrides 'just keep "
    "answering in chat'. The specific thing to visualize is whatever 'this'"
    "/'that' refers to (the topic of the immediately preceding exchange), "
    "filled into `request` as concrete content, e.g. hearing 'can you "
    "visualize this Pythagorean theorem' after discussing it means "
    "request='the Pythagorean theorem', not a bare mode switch. When the "
    "user asks to visualize something "
    "and does NOT already say what format they want, ask ONE short "
    "follow-up first — e.g. \"Would you like that as a chart, a diagram, an "
    "illustration, or an animation?\" — and wait for their answer before "
    "calling switch_capability. Skip the question only if they already told "
    "you the format, or if they explicitly say they don't care / want you to "
    "choose (then use render_mode='auto'). Map their answer to render_mode: "
    "'chart' -> render_mode='chartjs'; 'diagram' or 'illustration' -> "
    "render_mode='auto' (still tell the pipeline the intent via `request`, "
    "e.g. 'as a diagram' — the specialized routing picks svg vs mermaid "
    "better than you can guess); 'animation', 'interactive', or anything "
    "that should move, react to clicks, or have moving parts -> "
    "render_mode='auto' UNLESS it's specifically a math/science CONCEPT "
    "explainer (a derivation, proof, or geometric transformation evolving "
    "step by step, meant as a narrated video) — that specific case, and "
    "only that case, is render_mode='manim_video'. Do NOT route general "
    "motion/animation on a non-math/science topic to manim_video just "
    "because the user said 'animation' — e.g. 'animate a sorting "
    "algorithm' or 'make this diagram pulse' is 'auto' (built as an "
    "interactive React page), not 'manim_video'; only an explicit math/"
    "science derivation-style request is 'manim_video'. When unsure "
    "between the two, prefer 'auto'. For 'auto' (interactive/animated) "
    "cases specifically, the pipeline routes these to a proper interactive "
    "build (React-based) on its own, which renders far better than "
    "guessing a literal format yourself. Only ever pass an explicit "
    "render_mode OTHER than 'auto' when the user names a specific standard "
    "chart/diagram type unambiguously (bar chart, pie chart -> 'chartjs'; "
    "leave flowchart/sequence diagram etc. to 'auto'), or it's the math/"
    "science concept-video case above (-> 'manim_video'). 'html' is no "
    "longer offered at all — even if the user explicitly asks for HTML/a "
    "plain webpage, use render_mode='react' instead (react is a strict "
    "upgrade over html: same sandboxed page, real component structure "
    "instead of freehand DOM). When genuinely unsure, prefer "
    "'auto' — it is not a fallback of last resort here, it is the normal, "
    "well-supported choice for anything interactive or animated. Once you "
    "know both the content "
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
    "After calling switch_capability(quiz) with a request, just "
    "acknowledge briefly, e.g. \"Generating your quiz now — check the "
    "chat.\" Keep it to one short sentence; never read the questions "
    "aloud, they're written in the chat. Exactly like visualize, this is "
    "per-request, not per-session: a new, distinct quiz request (a "
    "different topic, or switching between topic and mimic) needs its "
    "own kind and parameters asked again — never reuse a previous quiz's "
    "settings for a different request. After calling switch_capability"
    "(quiz) with a request, don't call it again for filler/"
    "acknowledgements or general conversation, same as visualize.\n\n"
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
    "calling, mention briefly — one short sentence — that research can "
    "take a while and that they'll see an outline to review in the chat "
    "before the full result; never narrate the outline or findings "
    "yourself, you won't be the one presenting that outline. Exactly like visualize "
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
    "memory page's own stats. This section covers two different things — "
    "tell them apart before calling anything:\n"
    "  - A QUESTION about existing learning/progress — 'what should I "
    "study next', 'what am I weak in', 'what did I get wrong', 'give me "
    "advice based on my quiz mistakes/failures', 'how am I doing' — IS "
    "real content on its own: call switch_capability(capability="
    "'mastery_path', request=<their question, verbatim or lightly "
    "cleaned up>) immediately, no clarifying question needed. Mastery "
    "Path is the only capability with tools that read the user's actual "
    "mastery/quiz history, so routing there gets them a grounded, "
    "personalized answer instead of you guessing. Do this regardless of "
    "which page they're on — being on the Memory page doesn't mean the "
    "question is about memory internals.\n"
    "  - A BARE MODE SWITCH ('switch to mastery path', 'can you switch "
    "to mastery path', 'let's do mastery path mode') or a request to "
    "BUILD/START a path with NO subject named ('build me a mastery "
    "path', 'make me a study plan', 'help me master something') has NO "
    "real content yet — follow the same rule as any other bare mode "
    "switch: call switch_capability with `request` empty/omitted, and "
    "if they were asking to build/start one, ask what subject or topic "
    "they want it on before calling switch_capability again with "
    "`request` filled. NEVER let a mastery path get built on a subject "
    "you invented or guessed at — if the user hasn't named one, ask; "
    "don't proceed until they have. Once they name a subject (or ask an "
    "existing-progress question per the first bullet), call "
    "switch_capability(mastery_path, request=<the subject or question>) "
    "— this is a plain capability switch with content, not visualize/"
    "quiz/research, so no extra parameters apply.\n"
    "After calling with a request, speak only a brief pointer, e.g. "
    "\"I've put some suggestions together — check the chat.\" Never read "
    "the full advice or path details aloud; the detailed, personalized "
    "answer belongs in what gets written. If the request is clearly NOT "
    "about study/mastery/memory-stats (e.g. 'what is this app', 'how "
    "does spaced repetition work in general'), it's a general question "
    "instead — follow the GENERAL QUESTIONS section below rather than "
    "answering it purely out loud.\n\n"
    "GENERAL QUESTIONS — for any substantive question that isn't a solve/"
    "visualize/quiz/research/mastery-path request covered by the sections "
    "above (a fact, a definition, a concept explanation, 'what is X', "
    "'how does Y work', general tutoring) — call switch_capability"
    "(capability='chat', request=<their question, verbatim or lightly "
    "cleaned up>) so the full explanation is written in the chat where "
    "the user can read it, exactly as if they'd typed it in themselves. "
    "Do NOT answer these purely out loud with nothing written — a "
    "spoken-only answer disappears the moment you stop talking, and the "
    "user wants to be able to read it back. After calling, speak only "
    "ONE short sentence — the headline fact or a pointer, never the "
    "explanation itself. E.g. for 'what's the capital of France' say "
    "\"Paris — I've written more detail in the chat\" rather than reading "
    "a paragraph aloud. This is per-request, not per-session, same as "
    "the other capabilities above: don't call switch_capability again "
    "for filler/acknowledgements or a reply that's just conversation "
    "about what you already wrote.\n\n"
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
    "In every case, keep spoken replies short — a sentence or two at "
    "most, even when small talk. The chat is where detail belongs; your "
    "voice is a pointer to it, not a second copy of it."
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
            "user asks to open Settings, go to the learning space, "
            "notebooks, the knowledge center, or go back home."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": [
                        "home",
                        "settings",
                        "learning_space",
                        "notebooks",
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
                    "enum": ["auto", "svg", "chartjs", "mermaid", "react", "manim_video"],
                    "description": (
                        "Only used when capability='visualize' and `request` is "
                        "filled in — the visual format the user wants. Map their "
                        "words to: a bar/line/pie/data chart -> 'chartjs'; a "
                        "diagram, flowchart, or process/relationship map, or a "
                        "precise vector drawing/illustration/geometry figure -> "
                        "'auto' (the pipeline picks mermaid vs svg better than a "
                        "guess here); ANY interactive page, simulation, or "
                        "motion/animation -> 'auto' as well (the pipeline builds "
                        "these as React, which renders far better than 'html' — "
                        "do NOT pass 'html' unless the user names that literal "
                        "technology, e.g. 'as a plain HTML page'). Reserve "
                        "'manim_video' ONLY for a math/science CONCEPT explainer "
                        "— a derivation, proof, or geometric transformation "
                        "evolving step by step as a narrated video — never for "
                        "general motion/animation on a non-math/science topic "
                        "(e.g. 'animate a sorting algorithm' is 'auto', not "
                        "'manim_video': it's a mechanism to interact with, not a "
                        "concept video). When unsure between 'auto' and a "
                        "specific value, prefer 'auto' — it is the normal, "
                        "well-supported choice, not a fallback of last resort. "
                        "See VISUALIZING instructions for the full mapping."
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
            "yourself. Use for ANY phrasing of wanting to add or open a "
            "file from their device, in statement OR question form: 'I "
            "want to upload a file', 'let me attach a document', 'add a "
            "picture', 'open a file', 'open the file', 'open file', "
            "'choose a file', 'can you open the file', 'can you open a "
            "file for me'. This is a command to run, not a question to "
            "answer conversationally — never reply in plain speech/text "
            "asking the user to upload a file instead of calling this; "
            "that leaves them stuck with no picker open. Not open_history "
            "or navigate_to — those are for different panels/pages, this "
            "is specifically about picking a file to attach. Just call "
            "this — never say you can't access files or that you're "
            "audio-only; opening the picker for them is the correct "
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
    # --- Chat message / conversation actions -----------------------------
    {
        "type": "function",
        "name": "cancel_response",
        "description": (
            "Stop the assistant's response while it is still streaming. Use "
            "when the user says 'stop', 'cancel', 'never mind', or similar "
            "while a response is being generated."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "regenerate_response",
        "description": (
            "Regenerate the assistant's last response to the user's most "
            "recent message. Use for 'try again', 'regenerate that', "
            "'give me another answer'. Only meaningful right after an "
            "assistant reply, not while one is still streaming."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "edit_last_message",
        "description": (
            "Edit the user's own last sent message and resend it as a new "
            "reply, replacing what they said. Use for 'actually, change "
            "that to...', 'edit my last message', 'I meant to say...'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "new_content": {
                    "type": "string",
                    "description": "The full replacement text for the user's last message.",
                }
            },
            "required": ["new_content"],
        },
    },
    {
        "type": "function",
        "name": "delete_last_turn",
        "description": (
            "Permanently delete the most recent user/assistant turn from "
            "the conversation. DESTRUCTIVE — only call this after the user "
            "has explicitly said yes to a direct confirmation question you "
            "asked them in this same conversation (e.g. you ask 'are you "
            "sure you want to delete that?' and they confirm). Never call "
            "this on the first ask."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "switch_message_branch",
        "description": (
            "Switch to a sibling version of the current turn, when the user "
            "has regenerated or edited a message more than once and there "
            "are multiple versions to page through. Use for 'show me the "
            "other version', 'go back to the previous answer', 'next "
            "version'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["previous", "next"]}
            },
            "required": ["direction"],
        },
    },
    {
        "type": "function",
        "name": "rename_session",
        "description": "Rename the current chat session's title.",
        "parameters": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    },
    {
        "type": "function",
        "name": "download_session",
        "description": (
            "Download the current chat conversation as a Markdown file. Use "
            "for 'download this chat', 'export this conversation', 'save "
            "this session to my device'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "save_chat_to_notebook",
        "description": (
            "Save the current chat conversation into a notebook immediately "
            "— no dialog, no extra click. Use this for 'save this chat to "
            "my notebook', 'save this conversation', 'bookmark this chat' "
            "— not navigate_to, and not open_save_to_notebook unless the "
            "user specifically asks to review or pick which messages first. "
            "Different from save_quiz_to_notebook, which is for quiz "
            "content."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "open_save_to_notebook",
        "description": (
            "Open the save-to-notebook dialog so the user can pick which "
            "messages to include and which notebook to use, instead of "
            "saving everything immediately. Only use this when the user "
            "specifically asks to review, choose, or open that dialog — "
            "for a plain 'save this chat', use save_chat_to_notebook "
            "instead, which needs no further click."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "toggle_viewer_panel",
        "description": (
            "Open, close, or toggle the side viewer panel next to the chat "
            "(shows generated files/activity). Omit `open` to just toggle "
            "its current state."
        ),
        "parameters": {
            "type": "object",
            "properties": {"open": {"type": "boolean"}},
        },
    },
    # --- Quiz-taking actions ----------------------------------------------
    {
        "type": "function",
        "name": "quiz_answer",
        "description": (
            "Select or type an answer for the current quiz question. Only "
            "meaningful while a quiz is open on screen. Use `option` for a "
            "multiple-choice letter ('A','B','C','D') or true/false "
            "('true'/'false'); use `text` for a free-response/fill-in-the-"
            "blank/short-answer/essay question."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "option": {"type": "string"},
                "text": {"type": "string"},
            },
        },
    },
    {
        "type": "function",
        "name": "quiz_navigate",
        "description": (
            "Move to a different question within the current quiz. Only "
            "meaningful while a quiz is open on screen."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["previous", "next"]},
                "index": {
                    "type": "integer",
                    "description": "Jump directly to this question number (1-based, as spoken by the user).",
                },
            },
        },
    },
    {
        "type": "function",
        "name": "quiz_submit_answer",
        "description": "Submit the currently selected/typed answer for the current quiz question.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "quiz_reset_answer",
        "description": "Clear/reset the answer on the current quiz question so the user can retry it.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "quiz_request_judging",
        "description": (
            "Ask the AI to judge/grade the user's submitted answer on the "
            "current quiz question. Use for 'grade this', 'was I right', "
            "'check my answer'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "quiz_toggle_bookmark",
        "description": "Toggle a bookmark on the current quiz question.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "quiz_add_to_category",
        "description": (
            "File the current quiz question into a named category, creating "
            "the category if it doesn't already exist."
        ),
        "parameters": {
            "type": "object",
            "properties": {"category_name": {"type": "string"}},
            "required": ["category_name"],
        },
    },
    # --- Research outline actions ------------------------------------------
    {
        "type": "function",
        "name": "quiz_set_answer_view",
        "description": (
            "Switch the current quiz question's review block between the "
            "reference answer and the AI judgment, when both are available. "
            "Only meaningful once the question has been answered and, for "
            "the judgment tab, judged."
        ),
        "parameters": {
            "type": "object",
            "properties": {"view": {"type": "string", "enum": ["reference", "judgment"]}},
            "required": ["view"],
        },
    },
    {
        "type": "function",
        "name": "quiz_toggle_review",
        "description": (
            "Collapse or expand the current quiz question's reference/AI-"
            "judgment review block. Omit `collapsed` to just toggle."
        ),
        "parameters": {
            "type": "object",
            "properties": {"collapsed": {"type": "boolean"}},
        },
    },
    {
        "type": "function",
        "name": "quiz_open_followup",
        "description": (
            "Open a follow-up chat about the current quiz question, pinning "
            "the question/answer/judgment as context. Use for 'let's talk "
            "about this question', 'I want to ask about this one'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "research_confirm_outline",
        "description": (
            "Confirm the current research outline and proceed to the full "
            "run. Only meaningful while an outline is open for review."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "research_remove_outline_item",
        "description": "Remove a section from the research outline currently open for review.",
        "parameters": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "integer",
                    "description": "1-based position of the section to remove, as spoken by the user.",
                }
            },
            "required": ["index"],
        },
    },
    {
        "type": "function",
        "name": "research_add_outline_item",
        "description": "Add a new section to the research outline currently open for review.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "overview": {"type": "string"},
            },
            "required": ["title"],
        },
    },
    {
        "type": "function",
        "name": "research_edit_outline_item",
        "description": (
            "Rewrite an existing section's title and/or overview in the "
            "research outline currently open for review, without removing "
            "and re-adding it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "integer",
                    "description": "1-based position of the section to edit, as spoken by the user.",
                },
                "title": {"type": "string"},
                "overview": {"type": "string"},
            },
            "required": ["index"],
        },
    },
    {
        "type": "function",
        "name": "research_toggle_outline",
        "description": (
            "Collapse or expand the research outline card. Only meaningful "
            "once the outline has been confirmed and research is running "
            "or done — before that, it's always expanded."
        ),
        "parameters": {
            "type": "object",
            "properties": {"collapsed": {"type": "boolean"}},
        },
    },
    # --- Visualize viewer actions -------------------------------------------
    {
        "type": "function",
        "name": "visualize_fullscreen",
        "description": (
            "Enter or exit fullscreen view of the visualization currently "
            "on screen. Not available for interactive HTML visualizations."
        ),
        "parameters": {
            "type": "object",
            "properties": {"enter": {"type": "boolean"}},
            "required": ["enter"],
        },
    },
    {
        "type": "function",
        "name": "visualize_show_code",
        "description": "Show or hide the underlying code of the visualization currently on screen.",
        "parameters": {
            "type": "object",
            "properties": {"show": {"type": "boolean"}},
            "required": ["show"],
        },
    },
    {
        "type": "function",
        "name": "visualize_copy_code",
        "description": "Copy the underlying code of the visualization currently on screen to the clipboard.",
        "parameters": {"type": "object", "properties": {}},
    },
    # --- Mastery path management --------------------------------------------
    {
        "type": "function",
        "name": "mastery_path_select",
        "description": (
            "Open a specific existing mastery path by name in the learning "
            "space, to view its progress map."
        ),
        "parameters": {
            "type": "object",
            "properties": {"path_name": {"type": "string"}},
            "required": ["path_name"],
        },
    },
    {
        "type": "function",
        "name": "mastery_path_continue",
        "description": (
            "Resume an existing mastery path by name, opening its chat "
            "session to continue studying where the user left off."
        ),
        "parameters": {
            "type": "object",
            "properties": {"path_name": {"type": "string"}},
            "required": ["path_name"],
        },
    },
    {
        "type": "function",
        "name": "mastery_path_redo",
        "description": (
            "Reset an existing mastery path's progress so the user can "
            "start it over. DESTRUCTIVE — only call this after the user has "
            "explicitly said yes to a direct confirmation question you "
            "asked them in this same conversation. Never call this on the "
            "first ask."
        ),
        "parameters": {
            "type": "object",
            "properties": {"path_name": {"type": "string"}},
            "required": ["path_name"],
        },
    },
    {
        "type": "function",
        "name": "mastery_path_delete",
        "description": (
            "Permanently delete an existing mastery path. DESTRUCTIVE — "
            "only call this after the user has explicitly said yes to a "
            "direct confirmation question you asked them in this same "
            "conversation. Never call this on the first ask."
        ),
        "parameters": {
            "type": "object",
            "properties": {"path_name": {"type": "string"}},
            "required": ["path_name"],
        },
    },
    # --- Context-attach -------------------------------------------------------
    {
        "type": "function",
        "name": "select_model",
        "description": (
            "Switch which LLM model the next message will use. Use for "
            "'switch to GPT-5', 'use Claude', 'change the model to...'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The model name as the user said it.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "select_persona",
        "description": (
            "Switch which persona the chat uses, or clear it back to none. "
            "Use for 'switch to the tutor persona', 'use my study-buddy "
            "persona', 'clear the persona' / 'no persona'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The persona name as the user said it, or empty/"
                        "'none' to clear the current persona."
                    ),
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "select_agent",
        "description": (
            "Switch which connected agent the chat consults, or clear it. "
            "Use for 'use my research agent', 'consult the writing agent', "
            "'stop using an agent' / 'no agent'. Different from a saved "
            "personal AI companion — this is a connected external agent "
            "tool."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "The agent name as the user said it, or empty/"
                        "'none' to clear the current agent."
                    ),
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "toggle_knowledge_base",
        "description": (
            "Turn a knowledge base on or off for the next message — calling "
            "this again on the same one turns it back off. Use for 'use my "
            "physics knowledge base', 'search my textbook notes', 'stop "
            "using that knowledge base'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The knowledge base name as the user said it.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "remove_attachment",
        "description": (
            "Remove a file the user has queued to attach to their next "
            "message but not yet sent. Removes the most recently added one "
            "unless `all` is true, which clears every queued attachment."
        ),
        "parameters": {
            "type": "object",
            "properties": {"all": {"type": "boolean"}},
        },
    },
    {
        "type": "function",
        "name": "copy_last_message",
        "description": (
            "Copy the assistant's last message to the clipboard. Use for "
            "'copy that', 'copy the last response'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "read_last_answer",
        "description": (
            "Fetch the assistant's last written answer so you can read it "
            "aloud, in full. Use for 'read that to me', 'read the answer', "
            "'read it back', 'say that out loud', 'repeat the last answer'."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "attach_book_reference",
        "description": (
            "Attach a book or a specific book page/section as context to "
            "the user's next message, before they send it. Use for 'attach "
            "the chapter on...', 'reference my book about...'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The book title, chapter, or topic the user described.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "attach_question_bank_entry",
        "description": (
            "Attach a saved question-bank entry as context to the user's "
            "next message, before they send it. Use for 'attach that "
            "question about...', 'reference the saved question on...'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The topic or text of the saved question the user described.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "type": "function",
        "name": "answer_inline_question",
        "description": (
            "Answer the inline question card currently waiting on screen "
            "(a checkpoint/clarifying question the tutor asked mid-"
            "conversation — common in Mastery Path, but can appear in any "
            "capability). Only meaningful while a UI context message says "
            "one is open. Pass either the option's letter/label exactly as "
            "shown (e.g. 'A' or the option text) or, if free text is "
            "accepted, the user's own words. Does not submit by itself — "
            "call submit_inline_answers after, unless the user is still "
            "mid-thought."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The option letter/label, or free-text answer.",
                }
            },
            "required": ["text"],
        },
    },
    {
        "type": "function",
        "name": "submit_inline_answers",
        "description": (
            "Submit the inline question card currently waiting on screen. "
            "Only meaningful while a UI context message says one is open. "
            "Unanswered questions on a multi-question card are submitted "
            "as skipped, matching what clicking Submit does."
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
