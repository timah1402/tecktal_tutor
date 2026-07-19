"use client";

/**
 * Owns the single live realtime voice call (the actual ``RTCPeerConnection``,
 * via ``useRealtimeVoiceCall``) plus every voice-triggered in-app action
 * (switch_capability, navigate_to, open/close history, etc. — see voice.py's
 * ``_REALTIME_TOOLS``). Mounted once at the root layout so multiple visual
 * surfaces — the sidebar's compact ``VoiceOrb`` and the home page's big hero
 * voice button — can drive and reflect the *same* call instead of each
 * opening its own independent WebRTC connection.
 *
 * History-flyout open/closed state lives here too (not in QuickActionsPanel,
 * where it used to be a local ``useState``) because the voice-triggered
 * open_history/close_history tools need to reach it, and this context is the
 * only thing mounted above both QuickActionsPanel and any future consumer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";

import { useRealtimeVoiceCall, type RealtimeCallState } from "@/hooks/useRealtimeVoiceCall";
import {
  dispatchCapabilitySelect,
  dispatchExpandDock,
  dispatchOpenFilePicker,
  dispatchQuizSessionAction,
  dispatchOpenSaveToNotebook,
  dispatchViewerPanel,
  dispatchResearchOutlineAction,
  dispatchVisualizeAction,
  dispatchMasteryPathRefresh,
  UI_CONTEXT_EVENT,
} from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { setTheme, type Theme } from "@/lib/theme";
import { executeVoiceAction } from "@/lib/voice-api";
import { recordRealtimeExchange } from "@/lib/session-api";
import {
  QUIZ_QUESTION_TYPES,
  type NormalizedQuizQuestionType,
} from "@/lib/quiz-question-type";
import { buildVisiblePath, type SiblingInfo } from "@/lib/message-branches";
import { downloadChatMarkdown, buildChatMarkdown } from "@/lib/chat-export";
import {
  fetchAllProgress,
  redoProgress,
  deleteProgress,
  type ProgressSummary,
} from "@/lib/learning-api";
import { bookApi } from "@/lib/book-api";
import type { SelectedBookReference } from "@/lib/book-references";
import {
  listNotebookEntries,
  listNotebooks,
  createNotebook,
  saveNotebookRecord,
} from "@/lib/notebook-api";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import { listLLMOptions } from "@/lib/llm-options";
import { listPersonas } from "@/lib/personas-api";
import { listKnowledgeBases } from "@/lib/knowledge-api";

/** Case-insensitive "best guess" match for resolving a spoken name (path,
 *  book title, saved question text) against a list of candidates — exact
 *  match wins, otherwise the longest substring containment either
 *  direction. Returns null rather than a low-confidence guess so callers
 *  can surface a clear "not found" error back to the model. */
function bestFuzzyMatch<T>(
  items: T[],
  query: string,
  label: (item: T) => string,
): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const name = label(item).trim().toLowerCase();
    if (!name) continue;
    if (name === q) return item;
    let score = 0;
    if (name.includes(q)) score = q.length / name.length;
    else if (q.includes(name)) score = name.length / q.length;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore > 0 ? best : null;
}

async function resolveMasteryPath(name: string): Promise<ProgressSummary | null> {
  try {
    const result = await fetchAllProgress();
    return bestFuzzyMatch(result.summaries, name, (s) => s.name);
  } catch {
    return null;
  }
}

// Maps the voice-facing capability names declared in voice.py's session
// config to this app's internal capability values (see QuickActionsPanel's
// CAPABILITY_TILES) — "chat" is represented internally as "".
const VOICE_CAPABILITY_VALUES: Record<string, string> = {
  chat: "",
  quiz: "deep_question",
  research: "deep_research",
  solve: "deep_solve",
  visualize: "visualize",
  mastery_path: "mastery_path",
};

// Purely conversational filler that carries no new request. Forwarding it
// through the active capability's bridge (handleTurnComplete below) would
// otherwise be read as fresh input — harmless for plain chat, but for a
// generative capability like visualize it silently kicks off a nonsense
// regeneration from words like "Thank you." after a chart was just produced.
const FILLER_UTTERANCE_RE =
  /^(?:thanks?(?: you)?|thank you(?: so)?(?: much)?|ok(?:ay)?|alright|cool|got it|sounds good|nice|sure|great|awesome|perfect|good|yep|yeah|no problem|you'?re welcome|welcome)[.!,\s]*$/i;

// Capabilities that have no conversational fallback — any text handed to
// their pipeline is treated as "generate a new artifact from this", not
// "reply to this" (research/quiz additionally require config fields with
// no default, so an un-configured mechanical forward doesn't just misfire,
// it fails validation and gets silently dropped). For these, mechanically
// forwarding every spoken turn (handleTurnComplete's default behavior for
// in-session capabilities like solve) means even a greeting or an
// off-topic remark either fires a bogus generation or vanishes with no
// written trace. Real triggering for these is left entirely to the
// model's own switch_capability tool call, which reasons about intent (and
// asks for the required parameters) instead of relaying transcribed text
// verbatim.
const GENERATION_ONLY_CAPABILITIES: ReadonlySet<string> = new Set([
  "visualize",
  "deep_question",
  "deep_research",
]);

function isFillerUtterance(text: string): boolean {
  return FILLER_UTTERANCE_RE.test(text.trim());
}

const VOICE_THEME_VALUES: ReadonlySet<string> = new Set([
  "light",
  "dark",
  "glass",
  "snow",
  "brand",
]);

// Maps the voice-facing page names declared in voice.py's session config to
// this app's real routes (see SidebarShell's nav list for the canonical set).
const VOICE_PAGE_ROUTES: Record<string, string> = {
  home: "/home",
  settings: "/settings",
  learning_space: "/space",
  notebooks: "/space/notebooks",
  knowledge_center: "/knowledge",
};

// Registered by whichever page currently owns the one active chat surface —
// the home composer (file-upload state included) or a partner's dedicated
// chat (see PartnerChat.tsx) — so voice can route a spoken question through
// the same send path as typing, instead of a plain chat.sendMessage(text)
// call that drops attachments and has no notion of a partner at all.
export interface VoiceComposerBridge {
  hasPendingAttachments: () => boolean;
  send: (text: string, configOverride?: Record<string, unknown>) => void;
  /**
   * When true, forward every non-filler utterance to this bridge
   * unconditionally, even with no session/capability/attachments yet. Set
   * by contexts that are ALREADY an explicit, unambiguous target the
   * moment they're mounted — e.g. a specific partner's chat page — unlike
   * the home composer's bare default-chat state, where a stray "hello"
   * should just get a spoken reply instead of silently opening a session.
   */
  alwaysForward?: boolean;
  /** attach_book_reference voice tool — stages a resolved book reference
   *  into the composer's attached-context state, same as applying the
   *  BookReferencePicker by hand. Optional: only the home composer (which
   *  owns that state) registers it. */
  attachBookReference?: (reference: SelectedBookReference) => void;
  /** attach_question_bank_entry voice tool — same idea for a resolved
   *  saved question. */
  attachQuestionEntry?: (entry: SelectedQuestionEntry) => void;
  /** remove_attachment voice tool (all=false) — removes the most recently
   *  queued attachment. */
  removeLastAttachment?: () => void;
  /** remove_attachment voice tool (all=true) — clears every queued
   *  attachment. */
  clearAttachments?: () => void;
}

interface VoiceCallContextValue {
  state: RealtimeCallState;
  error: string | null;
  notice: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  historyOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  registerComposerBridge: (bridge: VoiceComposerBridge | null) => void;
}

const VoiceCallCtx = createContext<VoiceCallContextValue | null>(null);

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const chat = useUnifiedChatSafe();
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const composerBridgeRef = useRef<VoiceComposerBridge | null>(null);
  // Set by switch_capability when it navigates to /home for a spoken
  // visualize (etc.) request but the composer bridge isn't mounted yet —
  // flushed the moment the bridge registers, so the request still reaches
  // the real send pipeline instead of being dropped.
  const pendingBridgeSendRef = useRef<{ text: string; config?: Record<string, unknown> } | null>(null);
  const registerComposerBridge = useCallback((bridge: VoiceComposerBridge | null) => {
    composerBridgeRef.current = bridge;
    if (bridge && pendingBridgeSendRef.current) {
      const pending = pendingBridgeSendRef.current;
      pendingBridgeSendRef.current = null;
      bridge.send(pending.text, pending.config);
    }
  }, []);

  // switch_capability fires a capability switch (flushSync'd, see below)
  // immediately followed by a send for the same request. handleSend's
  // isVisualizeMode/isQuizMode/isResearchMode flags are recomputed from the
  // capability, so its useCallback identity changes on that switch, and the
  // effect that re-registers the composer bridge with the *new* handleSend
  // only runs once React's normal (non-flushSync) effect scheduling gets to
  // it — reading composerBridgeRef.current synchronously in the same tick
  // risks grabbing a bridge still bound to the *previous* capability's
  // handleSend. setTimeout(0) defers past that scheduling point (a plain
  // microtask isn't reliably late enough — React's passive-effect flush is
  // itself scheduled as a task, not a microtask) so every branch below
  // consistently sees the freshly re-registered bridge.
  const sendViaBridge = useCallback(
    (text: string, config?: Record<string, unknown>) => {
      setTimeout(() => {
        if (composerBridgeRef.current) {
          composerBridgeRef.current.send(text, config);
        } else {
          pendingBridgeSendRef.current = { text, config };
        }
      }, 0);
    },
    [],
  );

  // Pair a finished user utterance with the assistant's reply, accumulated
  // across the turn's events. Both refs (not state) — plumbing between
  // event callbacks, never triggers a re-render.
  const pendingUserTextRef = useRef<string | null>(null);
  const pendingAssistantTextRef = useRef<string | null>(null);
  // When response.done carries function calls, we snapshot the exchange here
  // before clearing the primary refs, so switch_capability can write it to
  // the new session as a written record of the voice command.
  const pendingExchangeForFunctionRef = useRef<{ userText: string; assistantText: string } | null>(null);

  const handleUserUtterance = useCallback((text: string) => {
    pendingUserTextRef.current = text;
  }, []);

  // Store the assistant text but don't record yet — response.done may still
  // carry function calls. onTurnComplete decides what to do with it.
  const handleAssistantUtterance = useCallback((text: string) => {
    pendingAssistantTextRef.current = text;
  }, []);

  // Called by useRealtimeVoiceCall at response.done, before function calls
  // are dispatched.
  //
  // Function-call turns → snapshot texts for switch_capability to consume.
  //
  // Pure Q&A turns (no function call):
  //   • If the user is already inside a session (solve, plain chat, …), has
  //     a file staged in the composer's upload tray (e.g. "solve what's
  //     inside the file" right after uploading it), or has a real
  //     (non-default) capability selected — even on a brand-new draft with
  //     no session yet, e.g. they navigated to ?capability=mastery_path and
  //     just started talking with no mode-switching function call in
  //     between — send it, so it lands in writing and — when a file is
  //     attached — actually reaches the model as an attachment instead of
  //     being silently dropped.
  //   • Otherwise (truly blank home, plain chat, nothing attached) →
  //     voice-only; never create a session the user didn't explicitly ask
  //     for. A stray "hello" on the bare home page should just get a
  //     spoken reply, not pop open a chat.
  //   • Pure acknowledgements ("thanks", "ok", "alright", ...) are never
  //     forwarded, in-session or not — they're not a new request and would
  //     otherwise re-trigger the active capability (see FILLER_UTTERANCE_RE).
  //   • Capabilities with no "just reply conversationally" mode (visualize,
  //     quiz, research: any text sent to them attempts to generate a new
  //     artifact, full stop) are excluded from this mechanical forward
  //     entirely — see GENERATION_ONLY_CAPABILITIES. Their real trigger is
  //     the model's own switch_capability tool call, which actually reasons
  //     about whether the user gave a genuine new request AND asks for the
  //     required parameters first (see voice.py's VISUALIZING / QUIZZING /
  //     RESEARCHING instructions) instead of relaying whatever was said
  //     verbatim.
  const handleTurnComplete = useCallback((hadFunctionCalls: boolean) => {
    const userText = pendingUserTextRef.current ?? "";
    const assistantText = pendingAssistantTextRef.current ?? "";
    pendingUserTextRef.current = null;
    pendingAssistantTextRef.current = null;

    if (hadFunctionCalls) {
      pendingExchangeForFunctionRef.current = { userText, assistantText };
      return;
    }
    pendingExchangeForFunctionRef.current = null;
    if (!userText || isFillerUtterance(userText)) return;
    if (GENERATION_ONLY_CAPABILITIES.has(chat?.state.activeCapability ?? "")) {
      return;
    }

    const bridge = composerBridgeRef.current;
    const hasPendingAttachments = bridge?.hasPendingAttachments() ?? false;
    const currentSessionId = chat?.state.sessionId ?? null;
    // A real (non-default-chat) capability being active is itself an
    // explicit ask, even on a brand-new draft with no session yet — e.g.
    // the user navigates to ?capability=mastery_path and then just starts
    // talking, with no function call in between since the mode never
    // changes. Gating purely on session/attachment presence silently
    // dropped that: typing on the exact same blank composer works fine
    // (handleSend has no such guard), so voice alone was going mute here.
    // A bridge with alwaysForward=true (a partner's chat — see PartnerChat)
    // is the same story one level further: that page has no notion of
    // "session" or "capability" at all (its own dedicated WS, entirely
    // outside UnifiedChatContext), so without this check every one of
    // those signals reads as absent and the guard would always bail.
    const currentCapability = chat?.state.activeCapability ?? "";
    if (
      !bridge?.alwaysForward &&
      !currentSessionId &&
      !hasPendingAttachments &&
      !currentCapability
    ) {
      return;
    }

    // Route through the same send path as typing (the composer bridge when
    // available, so staged attachments ride along; otherwise plain
    // sendMessage) so the capability pipeline generates a properly
    // formatted markdown response — storing the raw spoken assistant text
    // produces plain prose with no markdown structure, which looks poor
    // compared to typed responses.
    if (bridge) {
      bridge.send(userText);
    } else {
      chat?.sendMessage(userText);
    }
  }, [chat]);

  // The voice-navigable actions declared server-side (voice.py). AppSidebar
  // (and the call inside it) persists across every page, so navigate_to can
  // freely cross what used to be route-group boundaries without dropping
  // the call.
  //
  // Validation now happens server-side, through a real MCP `call_tool`
  // round-trip (executeVoiceAction → deeptutor/services/voice — see that
  // module's docstring) rather than being re-implemented here. This
  // function's job is just to apply the *result* locally — only the
  // browser can navigate its own router or mutate its own React state, so
  // that part can't move server-side no matter how the validation is done.
  const handleFunctionCall = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<{ status: string; message?: string }> => {
      const result = await executeVoiceAction(name, args);
      if (result.status !== "ok") {
        return { status: "error", message: result.message };
      }
      switch (name) {
        case "navigate_to": {
          // Use args (OpenAI's authoritative function call values) not result.*
          // — the MCP server only signals ok/error, the args carry the data.
          const page = String(args.page || "");
          const path = VOICE_PAGE_ROUTES[page];
          if (!path) return { status: "error", message: `Unknown page: ${page}` };
          if (page === "home") {
            // Match what clicking the home icon does: cancel any in-flight
            // stream, reset to a fresh draft session, navigate to bare /home.
            // This is now safe because voice exchanges are never recorded —
            // going home won't spawn a stray chat session from the command.
            chat?.cancelStreamingTurn();
            chat?.newSession();
          }
          router.push(path);
          return { status: "ok" };
        }
        case "switch_capability": {
          const value = VOICE_CAPABILITY_VALUES[String(args.capability || "")];
          if (value === undefined) {
            pendingExchangeForFunctionRef.current = null;
            return { status: "error", message: `Unknown capability: ${args.capability}` };
          }
          // Clear the snapshot so no other handler records it — no branch
          // below needs the pre-function-call exchange text anymore, now
          // that every capability routes a real request through the send
          // pipeline instead of writing a fabricated transcript record.
          pendingExchangeForFunctionRef.current = null;
          // Model-supplied, not derived from the raw transcript: the model
          // only fills this in when the user actually described concrete
          // content (see the tool's `request` param description in
          // voice.py). Any spoken utterance reaches switch_capability — even
          // a bare "switch to visualize mode" — so gating on transcript
          // presence would fire generation on every mode switch.
          const explicitRequest = String(args.request || "").trim();

          if (pathname.startsWith("/home")) {
            // Already on /home — fire in-place. flushSync forces React to
            // commit the setCapability state update synchronously so Framer
            // Motion can measure both the departing hero tiles and the arriving
            // badge/strip in the same layout phase, giving us the FLIP
            // animation — without it, React 18's automatic batching defers the
            // commit past the layout snapshot and the animation never fires.
            flushSync(() => dispatchCapabilitySelect(value));
          } else {
            router.push(value ? `/home?capability=${value}` : "/home");
          }

          // A bare mode switch ("switch to visualize mode", nothing else
          // specific said) has nothing to generate and nothing worth
          // recording — just switch and stop. Writing a fabricated exchange
          // to a new session for this case used to make the app look like
          // it was resolving a request the user never actually made.
          if (!explicitRequest) {
            return { status: "ok" };
          }

          // Visualize is generative: when the model tells us the user gave
          // a concrete request (e.g. "visualize the water cycle"), route it
          // through the same send path as typing so the real visualize
          // pipeline runs and produces an actual chart — instead of just
          // logging the spoken words as plain text, which never touches the
          // pipeline (see record_realtime_exchange's docstring: "no
          // turn/agent execution"). render_mode carries the format the
          // model asked the user to choose (see VISUALIZING instructions in
          // voice.py) — passed as a config override so it's honored even
          // though the composer's own config panel was never opened.
          if (value === "visualize") {
            const renderMode = String(args.render_mode || "auto");
            const config = { render_mode: renderMode, quality: "medium", style_hint: "" };
            sendViaBridge(explicitRequest, config);
            return { status: "ok" };
          }

          // Quiz is generative too: `quiz_mode` carries whichever kind the
          // model asked the user to choose (see QUIZZING instructions in
          // voice.py) — 'custom' generates fresh questions on `request` (the
          // topic), 'mimic' reuses a paper the user already uploaded through
          // the panel's own upload control (voice never sees file bytes, so
          // it can only ask the user to confirm they've uploaded one — see
          // handleSend's isQuizMode branch for how the actual attachment
          // rides along once mode='mimic' is set here). `num_questions`
          // applies to both modes (see mergeQuizConfigOverride in page.tsx,
          // which routes it to num_questions for custom / max_questions for
          // mimic); difficulty/question_types are custom-only.
          if (value === "deep_question") {
            const quizMode = String(args.quiz_mode || "custom") === "mimic" ? "mimic" : "custom";
            const config: Record<string, unknown> = { mode: quizMode };
            const numQuestions = Number(args.num_questions);
            const hasNumQuestions = Number.isFinite(numQuestions) && numQuestions > 0;
            if (quizMode === "custom") {
              if (hasNumQuestions) config.num_questions = Math.round(numQuestions);
              if (args.difficulty) config.difficulty = String(args.difficulty);
              if (Array.isArray(args.question_types) && args.question_types.length > 0) {
                config.question_types = args.question_types
                  .filter((t): t is string => typeof t === "string")
                  .filter((t) => QUIZ_QUESTION_TYPES.includes(t as NormalizedQuizQuestionType));
              }
            } else if (hasNumQuestions) {
              config.max_questions = Math.round(numQuestions);
            }
            sendViaBridge(explicitRequest, config);
            return { status: "ok" };
          }

          // Research is generative too, and unlike quiz/visualize its two
          // required fields (mode, depth) have NO default — the panel's
          // local state starts blank. Without supplying both here,
          // handleSend's validation gate silently drops the request (see
          // mergeResearchConfigOverride in page.tsx): nothing gets written,
          // which is the "no writing assistant like in chat mode" symptom
          // in research mode. research_mode/research_depth carry whatever
          // the model asked the user to choose (see RESEARCHING
          // instructions in voice.py).
          if (value === "deep_research") {
            const researchMode = String(args.research_mode || "").trim();
            const researchDepth = String(args.research_depth || "").trim();
            if (!researchMode || !researchDepth) {
              // The model called switch_capability without asking first (or
              // asked but didn't wait for/fill in the answer) — nothing was
              // sent, so silently returning "ok" here used to make the
              // model think the request went through and say something like
              // "Generating that now" over dead air. Returning an explicit
              // error instead is fed back to the model as this turn's
              // function result, which reliably drives it to actually ask
              // the missing question out loud instead of falsely
              // confirming — see RESEARCHING instructions in voice.py.
              return {
                status: "error",
                message:
                  "research_mode and research_depth are both required and " +
                  "were not provided — nothing was generated. Ask the user " +
                  "which kind of research they want (quick notes, a full " +
                  "report, a comparison, or a learning path) and how deep " +
                  "(quick, standard, or deep), then call switch_capability " +
                  "again with request, research_mode, and research_depth " +
                  "all filled in.",
              };
            }
            const config = { mode: researchMode, depth: researchDepth };
            sendViaBridge(explicitRequest, config);
            return { status: "ok" };
          }

          // Every remaining capability (chat, solve, mastery_path) has no
          // dedicated config panel, so a spoken request for these is just a
          // normal message — route it through the same real send pipeline
          // as visualize/quiz/research above instead of the old fallback,
          // which wrote a fabricated transcript into a brand-new session
          // instead of the one the user was actually looking at. That made
          // the written record land out of sync with (or invisible next
          // to) the voice conversation — the exact "voice and writing not
          // showing at the same time" symptom in mastery path.
          sendViaBridge(explicitRequest);
          return { status: "ok" };
        }
        case "start_new_chat": {
          chat?.cancelStreamingTurn();
          // If a capability was active, animate its icon back to center before
          // we leave; flushSync lets Framer Motion measure the transition.
          flushSync(() => chat?.newSession());

          // Consume the exchange snapshot so we can write it to the new session.
          const startExchange = pendingExchangeForFunctionRef.current;
          pendingExchangeForFunctionRef.current = null;

          // Create a real session and navigate to it. On the empty home page
          // "start new chat" used to be a no-op (already on /home, already
          // a draft) — navigating to /home/${newId} makes the dock disappear
          // and the chat view open, which is the visible "new session started"
          // the user expects.
          const startUserText = startExchange?.userText || "Start a new chat";
          const startAssistantText = startExchange?.assistantText || "Starting a new chat!";
          try {
            const { sessionId: newId } = await recordRealtimeExchange(
              null,
              startUserText,
              startAssistantText,
              null,
            );
            router.push(`/home/${newId}`);
          } catch {
            router.push("/home");
          }
          return { status: "ok" };
        }
        case "open_history":
          openHistory();
          return { status: "ok" };
        case "close_history":
          closeHistory();
          return { status: "ok" };
        case "open_upload":
          dispatchOpenFilePicker();
          return { status: "ok" };
        case "set_theme": {
          const requested = String(args.theme || "");
          if (!VOICE_THEME_VALUES.has(requested)) {
            return { status: "error", message: `Unknown theme: ${requested}` };
          }
          setTheme(requested as Theme);
          return { status: "ok" };
        }
        case "show_more":
          dispatchExpandDock(true);
          return { status: "ok" };
        case "show_less":
          dispatchExpandDock(false);
          return { status: "ok" };
        case "save_quiz_to_notebook":
          dispatchQuizSessionAction("save");
          return { status: "ok" };
        case "download_quiz":
          dispatchQuizSessionAction("download");
          return { status: "ok" };
        case "cancel_response":
          chat?.cancelStreamingTurn();
          return { status: "ok" };
        case "regenerate_response": {
          if (!chat) return { status: "error", message: "No active chat." };
          if (chat.state.isStreaming) {
            return {
              status: "error",
              message: "A response is still streaming — nothing to regenerate yet.",
            };
          }
          chat.regenerateLastMessage();
          return { status: "ok" };
        }
        case "edit_last_message": {
          const newContent = String(args.new_content || "").trim();
          if (!newContent) {
            return { status: "error", message: "new_content was empty." };
          }
          if (!chat) return { status: "error", message: "No active chat." };
          const { messages } = buildVisiblePath(
            chat.state.messages,
            chat.state.selectedBranches,
          );
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === "user" && m.id !== undefined);
          if (!lastUser || lastUser.id === undefined) {
            return { status: "error", message: "There's no message to edit yet." };
          }
          await chat.editMessage(lastUser.id, newContent);
          return { status: "ok" };
        }
        case "delete_last_turn": {
          if (!chat) return { status: "error", message: "No active chat." };
          const { messages } = buildVisiblePath(
            chat.state.messages,
            chat.state.selectedBranches,
          );
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === "user" && m.id !== undefined);
          if (!lastUser || lastUser.id === undefined) {
            return { status: "error", message: "There's no turn to delete yet." };
          }
          await chat.deleteTurn(lastUser.id);
          return { status: "ok" };
        }
        case "switch_message_branch": {
          const direction = String(args.direction || "");
          if (direction !== "previous" && direction !== "next") {
            return { status: "error", message: `Unknown direction: ${direction}` };
          }
          if (!chat) return { status: "error", message: "No active chat." };
          const { messages, siblingsByMessageId } = buildVisiblePath(
            chat.state.messages,
            chat.state.selectedBranches,
          );
          let info: SiblingInfo | undefined;
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const id = messages[i].id;
            if (id !== undefined && siblingsByMessageId.has(id)) {
              info = siblingsByMessageId.get(id);
              break;
            }
          }
          if (!info) {
            return { status: "error", message: "There's only one version of this turn." };
          }
          const prevIdx = info.index - 2;
          const nextIdx = info.index;
          const targetId =
            direction === "previous"
              ? prevIdx >= 0
                ? info.siblingIds[prevIdx]
                : null
              : nextIdx < info.siblingIds.length
                ? info.siblingIds[nextIdx]
                : null;
          if (targetId === null || targetId === undefined) {
            return { status: "error", message: `No ${direction} version available.` };
          }
          chat.switchBranch(info.parentId, targetId);
          return { status: "ok" };
        }
        case "rename_session": {
          const title = String(args.title || "").trim();
          if (!title) return { status: "error", message: "title was empty." };
          await chat?.renameSessionTitle(title);
          return { status: "ok" };
        }
        case "download_session": {
          if (!chat || chat.state.messages.length === 0) {
            return { status: "error", message: "No chat messages to download yet." };
          }
          const firstUser = chat.state.messages.find((m) => m.role === "user");
          const title =
            chat.state.sessionTitle.trim() ||
            firstUser?.content.trim().slice(0, 80) ||
            "Chat Session";
          downloadChatMarkdown(chat.state.messages, { title });
          return { status: "ok" };
        }
        case "save_chat_to_notebook": {
          if (!chat || chat.state.messages.length === 0) {
            return { status: "error", message: "No chat messages to save yet." };
          }
          try {
            const notebooks = await listNotebooks();
            const target =
              notebooks.length > 0
                ? notebooks.reduce((latest, nb) =>
                    (nb.updated_at ?? 0) > (latest.updated_at ?? 0) ? nb : latest,
                  )
                : await createNotebook({ name: "Chat Sessions" });
            const firstUser = chat.state.messages.find((m) => m.role === "user");
            // Prefer the session's actual (possibly renamed via
            // rename_session) title over deriving one from the first
            // message — a rename should be reflected in what gets saved.
            const title =
              chat.state.sessionTitle.trim() ||
              firstUser?.content.trim().slice(0, 80) ||
              "Chat Session";
            const transcript = buildChatMarkdown(chat.state.messages, { title });
            await saveNotebookRecord({
              notebookIds: [target.id],
              recordType: "chat",
              title,
              userQuery: firstUser?.content.trim() || title,
              output: transcript,
              metadata: {
                source: "chat",
                session_id: chat.state.sessionId,
                total_message_count: chat.state.messages.length,
              },
            });
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to save chat to notebook.",
            };
          }
        }
        case "open_save_to_notebook":
          dispatchOpenSaveToNotebook();
          return { status: "ok" };
        case "toggle_viewer_panel": {
          const open = typeof args.open === "boolean" ? args.open : undefined;
          dispatchViewerPanel(open);
          return { status: "ok" };
        }
        case "quiz_answer": {
          const option = args.option ? String(args.option) : undefined;
          const text = args.text ? String(args.text) : undefined;
          if (!option && !text) {
            return { status: "error", message: "Either option or text must be given." };
          }
          dispatchQuizSessionAction("answer", { option, text });
          return { status: "ok" };
        }
        case "quiz_navigate": {
          const direction =
            args.direction === "previous" || args.direction === "next"
              ? args.direction
              : undefined;
          const index = Number(args.index);
          const hasIndex = Number.isFinite(index) && index > 0;
          if (!direction && !hasIndex) {
            return {
              status: "error",
              message: "Either direction or a positive index must be given.",
            };
          }
          dispatchQuizSessionAction("navigate", {
            direction,
            index: hasIndex ? Math.round(index) : undefined,
          });
          return { status: "ok" };
        }
        case "quiz_submit_answer":
          dispatchQuizSessionAction("submit");
          return { status: "ok" };
        case "quiz_reset_answer":
          dispatchQuizSessionAction("reset");
          return { status: "ok" };
        case "quiz_request_judging":
          dispatchQuizSessionAction("judge");
          return { status: "ok" };
        case "quiz_toggle_bookmark":
          dispatchQuizSessionAction("bookmark");
          return { status: "ok" };
        case "quiz_add_to_category": {
          const categoryName = String(args.category_name || "").trim();
          if (!categoryName) {
            return { status: "error", message: "category_name was empty." };
          }
          dispatchQuizSessionAction("add_to_category", { categoryName });
          return { status: "ok" };
        }
        case "quiz_set_answer_view": {
          const view = args.view === "reference" || args.view === "judgment" ? args.view : undefined;
          if (!view) return { status: "error", message: `Unknown view: ${args.view}` };
          dispatchQuizSessionAction("set_answer_view", { view });
          return { status: "ok" };
        }
        case "quiz_toggle_review": {
          const collapsed = typeof args.collapsed === "boolean" ? args.collapsed : undefined;
          dispatchQuizSessionAction("toggle_review_collapse", { collapsed });
          return { status: "ok" };
        }
        case "quiz_open_followup":
          dispatchQuizSessionAction("open_followup");
          return { status: "ok" };
        case "research_confirm_outline":
          dispatchResearchOutlineAction("confirm");
          return { status: "ok" };
        case "research_remove_outline_item": {
          const index = Number(args.index);
          if (!Number.isFinite(index) || index <= 0) {
            return {
              status: "error",
              message: "index must be a positive 1-based position.",
            };
          }
          dispatchResearchOutlineAction("remove_item", { index: Math.round(index) });
          return { status: "ok" };
        }
        case "research_add_outline_item": {
          const title = String(args.title || "").trim();
          if (!title) return { status: "error", message: "title was empty." };
          dispatchResearchOutlineAction("add_item", {
            title,
            overview: args.overview ? String(args.overview) : undefined,
          });
          return { status: "ok" };
        }
        case "research_edit_outline_item": {
          const index = Number(args.index);
          if (!Number.isFinite(index) || index <= 0) {
            return {
              status: "error",
              message: "index must be a positive 1-based position.",
            };
          }
          const title = args.title !== undefined ? String(args.title) : undefined;
          const overview =
            args.overview !== undefined ? String(args.overview) : undefined;
          if (title === undefined && overview === undefined) {
            return { status: "error", message: "Either title or overview must be given." };
          }
          dispatchResearchOutlineAction("edit_item", { index: Math.round(index), title, overview });
          return { status: "ok" };
        }
        case "research_toggle_outline": {
          const collapsed = typeof args.collapsed === "boolean" ? args.collapsed : undefined;
          dispatchResearchOutlineAction("toggle_collapse", { collapsed });
          return { status: "ok" };
        }
        case "visualize_fullscreen":
          dispatchVisualizeAction("fullscreen", { enter: Boolean(args.enter) });
          return { status: "ok" };
        case "visualize_show_code":
          dispatchVisualizeAction("show_code", { show: Boolean(args.show) });
          return { status: "ok" };
        case "visualize_copy_code":
          dispatchVisualizeAction("copy_code");
          return { status: "ok" };
        case "mastery_path_select": {
          const pathName = String(args.path_name || "").trim();
          if (!pathName) return { status: "error", message: "path_name was empty." };
          const match = await resolveMasteryPath(pathName);
          if (!match) {
            return { status: "error", message: `No mastery path found matching "${pathName}".` };
          }
          router.push(`/space/learning?path=${encodeURIComponent(match.book_id)}`);
          return { status: "ok" };
        }
        case "mastery_path_continue": {
          const pathName = String(args.path_name || "").trim();
          if (!pathName) return { status: "error", message: "path_name was empty." };
          const match = await resolveMasteryPath(pathName);
          if (!match) {
            return { status: "error", message: `No mastery path found matching "${pathName}".` };
          }
          router.push(`/home/${encodeURIComponent(match.book_id)}`);
          return { status: "ok" };
        }
        case "mastery_path_redo": {
          const pathName = String(args.path_name || "").trim();
          if (!pathName) return { status: "error", message: "path_name was empty." };
          const match = await resolveMasteryPath(pathName);
          if (!match) {
            return { status: "error", message: `No mastery path found matching "${pathName}".` };
          }
          await redoProgress(match.book_id);
          dispatchMasteryPathRefresh();
          return { status: "ok" };
        }
        case "mastery_path_delete": {
          const pathName = String(args.path_name || "").trim();
          if (!pathName) return { status: "error", message: "path_name was empty." };
          const match = await resolveMasteryPath(pathName);
          if (!match) {
            return { status: "error", message: `No mastery path found matching "${pathName}".` };
          }
          await deleteProgress(match.book_id);
          dispatchMasteryPathRefresh();
          return { status: "ok" };
        }
        case "select_model": {
          const query = String(args.query || "").trim();
          if (!query) return { status: "error", message: "query was empty." };
          if (!chat) return { status: "error", message: "No active chat." };
          try {
            const { options } = await listLLMOptions();
            const match = bestFuzzyMatch(
              options,
              query,
              (o) => o.model_name || o.model,
            );
            if (!match) {
              return { status: "error", message: `No model found matching "${query}".` };
            }
            chat.setLLMSelection({ profile_id: match.profile_id, model_id: match.model_id });
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to switch model.",
            };
          }
        }
        case "select_persona": {
          const query = String(args.query || "").trim();
          if (!chat) return { status: "error", message: "No active chat." };
          if (!query || /^(none|no persona|default)$/i.test(query)) {
            chat.setPersonaSelection("");
            return { status: "ok" };
          }
          try {
            const personas = await listPersonas();
            const match = bestFuzzyMatch(personas, query, (p) => p.name);
            if (!match) {
              return { status: "error", message: `No persona found matching "${query}".` };
            }
            chat.setPersonaSelection(match.name);
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to switch persona.",
            };
          }
        }
        case "select_agent": {
          const query = String(args.query || "").trim();
          if (!chat) return { status: "error", message: "No active chat." };
          try {
            const allKbs = await listKnowledgeBases();
            const agentNames = new Set(
              allKbs
                .filter((kb) => kb.metadata?.type === "subagent")
                .map((kb) => kb.name),
            );
            const withoutAgents = chat.state.knowledgeBases.filter(
              (n) => !agentNames.has(n),
            );
            if (!query || /^(none|no agent)$/i.test(query)) {
              chat.setKBs(withoutAgents);
              return { status: "ok" };
            }
            const agentOptions = allKbs.filter((kb) => agentNames.has(kb.name));
            const match = bestFuzzyMatch(agentOptions, query, (a) => a.name);
            if (!match) {
              return { status: "error", message: `No connected agent found matching "${query}".` };
            }
            chat.setKBs([...withoutAgents, match.name]);
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to switch agent.",
            };
          }
        }
        case "toggle_knowledge_base": {
          const query = String(args.query || "").trim();
          if (!query) return { status: "error", message: "query was empty." };
          if (!chat) return { status: "error", message: "No active chat." };
          try {
            const allKbs = await listKnowledgeBases();
            const kbOptions = allKbs.filter((kb) => kb.metadata?.type !== "subagent");
            const match = bestFuzzyMatch(kbOptions, query, (kb) => kb.name);
            if (!match) {
              return { status: "error", message: `No knowledge base found matching "${query}".` };
            }
            const current = chat.state.knowledgeBases;
            chat.setKBs(
              current.includes(match.name)
                ? current.filter((n) => n !== match.name)
                : [...current, match.name],
            );
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to toggle knowledge base.",
            };
          }
        }
        case "remove_attachment": {
          const bridge = composerBridgeRef.current;
          // Verify there's actually something queued before confirming —
          // otherwise a stale/unregistered bridge would still report "ok"
          // even though nothing was removed.
          if (!bridge || !bridge.hasPendingAttachments()) {
            return { status: "error", message: "There are no attachments queued to remove." };
          }
          const all = Boolean(args.all);
          if (all) {
            if (!bridge.clearAttachments) {
              return { status: "error", message: "Can't clear attachments right now." };
            }
            bridge.clearAttachments();
            return { status: "ok" };
          }
          if (!bridge.removeLastAttachment) {
            return { status: "error", message: "Can't remove an attachment right now." };
          }
          bridge.removeLastAttachment();
          return { status: "ok" };
        }
        case "copy_last_message": {
          if (!chat) return { status: "error", message: "No active chat." };
          const { messages } = buildVisiblePath(
            chat.state.messages,
            chat.state.selectedBranches,
          );
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === "assistant" && m.content?.trim());
          if (!lastAssistant) {
            return { status: "error", message: "There's no assistant message to copy yet." };
          }
          try {
            await navigator.clipboard.writeText(lastAssistant.content);
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to copy to clipboard.",
            };
          }
        }
        case "attach_book_reference": {
          const query = String(args.query || "").trim();
          if (!query) return { status: "error", message: "query was empty." };
          const bridge = composerBridgeRef.current;
          if (!bridge?.attachBookReference) {
            return {
              status: "error",
              message: "No chat composer is open to attach a reference to.",
            };
          }
          try {
            const { books } = await bookApi.list();
            const book = bestFuzzyMatch(books, query, (b) => b.title);
            if (!book) {
              return { status: "error", message: `No book found matching "${query}".` };
            }
            const detail = await bookApi.get(book.id);
            const pages = detail.pages.map((p) => ({
              bookId: book.id,
              bookTitle: book.title,
              pageId: p.id,
              pageTitle: p.title,
              chapterId: p.chapter_id,
            }));
            bridge.attachBookReference({ bookId: book.id, bookTitle: book.title, pages });
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to attach book reference.",
            };
          }
        }
        case "attach_question_bank_entry": {
          const query = String(args.query || "").trim();
          if (!query) return { status: "error", message: "query was empty." };
          const bridge = composerBridgeRef.current;
          if (!bridge?.attachQuestionEntry) {
            return {
              status: "error",
              message: "No chat composer is open to attach a reference to.",
            };
          }
          try {
            const { items } = await listNotebookEntries({ limit: 200 });
            const entry = bestFuzzyMatch(items, query, (e) => e.question);
            if (!entry) {
              return { status: "error", message: `No saved question found matching "${query}".` };
            }
            bridge.attachQuestionEntry({
              id: entry.id,
              question: entry.question,
              session_title: entry.session_title,
              is_correct: entry.is_correct,
              difficulty: entry.difficulty,
            });
            return { status: "ok" };
          } catch (err) {
            return {
              status: "error",
              message: err instanceof Error ? err.message : "Failed to attach question.",
            };
          }
        }
        case "get_memory_overview":
          // Pure data fetch, no browser-side effect — the MCP round-trip
          // (executeVoiceAction above) already did the real work and
          // `result` already IS the summary (l1_total, l2_docs, backups,
          // …); just relay it back as this turn's function output so the
          // model can describe the real numbers instead of guessing.
          return result;
        default:
          return { status: "error", message: `Unknown action: ${name}` };
      }
    },
    [chat, openHistory, closeHistory, router, pathname, sendViaBridge],
  );

  const call = useRealtimeVoiceCall({
    onUserUtterance: handleUserUtterance,
    onAssistantUtterance: handleAssistantUtterance,
    onFunctionCall: handleFunctionCall,
    onTurnComplete: handleTurnComplete,
  });

  // Ground the model in whatever's actually on screen (see UI_CONTEXT_EVENT's
  // doc comment in app-shell-storage.ts) — a quiz/outline/visualization
  // announces itself here whenever it becomes active or its visible state
  // changes, so "answer B" or "complete the quiz" acts on the real thing
  // instead of starting a new one. No-op while no call is connected.
  useEffect(() => {
    function onUiContext(event: Event) {
      const summary = (event as CustomEvent<{ summary: string }>).detail?.summary;
      if (summary) call.injectContext(summary);
    }
    window.addEventListener(UI_CONTEXT_EVENT, onUiContext);
    return () => window.removeEventListener(UI_CONTEXT_EVENT, onUiContext);
  }, [call]);

  return (
    <VoiceCallCtx.Provider
      value={{
        state: call.state,
        error: call.error,
        notice: call.notice,
        connect: call.connect,
        disconnect: call.disconnect,
        historyOpen,
        openHistory,
        closeHistory,
        registerComposerBridge,
      }}
    >
      {children}
    </VoiceCallCtx.Provider>
  );
}

export function useVoiceCall(): VoiceCallContextValue {
  const ctx = useContext(VoiceCallCtx);
  if (!ctx) throw new Error("useVoiceCall must be inside VoiceCallProvider");
  return ctx;
}
