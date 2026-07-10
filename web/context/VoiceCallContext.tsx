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
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";

import { useRealtimeVoiceCall, type RealtimeCallState } from "@/hooks/useRealtimeVoiceCall";
import {
  dispatchCapabilitySelect,
  dispatchExpandDock,
  dispatchQuizSessionAction,
} from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { setTheme, type Theme } from "@/lib/theme";
import { executeVoiceAction } from "@/lib/voice-api";
import { recordRealtimeExchange } from "@/lib/session-api";

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
  partners: "/partners",
  agents: "/agents",
  co_writer: "/co-writer",
  book: "/book",
  learning_space: "/space",
  notebooks: "/space/notebooks",
  memory: "/memory",
  knowledge_center: "/knowledge",
};

interface VoiceCallContextValue {
  state: RealtimeCallState;
  error: string | null;
  notice: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  historyOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
}

const VoiceCallCtx = createContext<VoiceCallContextValue | null>(null);

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const chat = useUnifiedChatSafe();
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

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
  // Pure Q&A turns (no function call): always write the exchange as text,
  // whether or not a session is already active — sendMessage auto-creates a
  // draft session the same way typing a first message on the empty home
  // page does, so voice questions show up in writing exactly like typed
  // ones instead of being spoken-only.
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

    // Route through sendMessage (same path as typing) so the capability
    // pipeline generates a properly formatted markdown response — storing
    // the raw spoken assistant text produces plain prose with no markdown
    // structure, which looks poor compared to typed responses.
    if (!userText) return;

    chat?.sendMessage(userText);
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
          // Consume (and clear) the snapshot so no other handler records it.
          const exchange = pendingExchangeForFunctionRef.current;
          pendingExchangeForFunctionRef.current = null;

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

          // Write the voice exchange as text in a new session so the user can
          // read the conversation, not just hear it. Always record — the
          // backend requires min_length=1 for both fields so we supply a
          // fallback when the model called the function without speaking (or
          // the transcription event raced past response.done and the refs were
          // still empty at snapshot time). Using `null` as sessionId always
          // creates a fresh session separate from whatever the home screen
          // was showing — voice capability switches land in their own chat.
          const capabilityLabel = String(args.capability || value || "selected mode");
          const userText = exchange?.userText || `Switch to ${capabilityLabel}`;
          const assistantText = exchange?.assistantText || `Switching to ${capabilityLabel}.`;
          try {
            const { sessionId: newId } = await recordRealtimeExchange(
              null,
              userText,
              assistantText,
              value || null,
            );
            router.push(`/home/${newId}`);
          } catch {
            // Recording failed — capability animation already happened; no crash
          }
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
        default:
          return { status: "error", message: `Unknown action: ${name}` };
      }
    },
    [chat, openHistory, closeHistory, router, pathname],
  );

  const call = useRealtimeVoiceCall({
    onUserUtterance: handleUserUtterance,
    onAssistantUtterance: handleAssistantUtterance,
    onFunctionCall: handleFunctionCall,
    onTurnComplete: handleTurnComplete,
  });

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
