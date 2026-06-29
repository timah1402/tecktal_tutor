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
import { useRouter } from "next/navigation";

import { useRealtimeVoiceCall, type RealtimeCallState } from "@/hooks/useRealtimeVoiceCall";
import { dispatchCapabilitySelect } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { recordRealtimeExchange } from "@/lib/session-api";
import { setTheme, type Theme } from "@/lib/theme";

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
  const chat = useUnifiedChatSafe();
  const [historyOpen, setHistoryOpen] = useState(false);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  // Pairs a finished user utterance with the assistant's reply that follows
  // it, then persists the pair together (the backend appends both messages
  // in one call) and reconciles local state via the same loadSession() path
  // normal typed turns already use. A ref, not state — this is plumbing
  // between two event callbacks, not something that should re-render.
  const pendingUserTextRef = useRef<string | null>(null);

  const handleUserUtterance = useCallback((text: string) => {
    pendingUserTextRef.current = text;
  }, []);

  const handleAssistantUtterance = useCallback(
    (text: string) => {
      const userText = pendingUserTextRef.current;
      pendingUserTextRef.current = null;
      if (!userText) return;
      // Persists the capability active *right now* (which a switch_capability
      // call earlier in this same exchange may have just changed) alongside
      // the message pair — otherwise the loadSession() reconciliation below
      // would reload the session's stale, last-typed-turn capability and
      // silently undo the voice-triggered switch.
      void recordRealtimeExchange(
        chat?.state.sessionId ?? null,
        userText,
        text,
        chat?.state.activeCapability || "",
      )
        .then(({ sessionId }) => chat?.loadSession(sessionId))
        .catch(() => {
          // Best-effort: the exchange was already heard/spoken live, so a
          // network blip here just means it won't show up in history — not
          // worth surfacing as a call-ending error.
        });
    },
    [chat],
  );

  // The voice-navigable actions declared server-side (voice.py). AppSidebar
  // (and the call inside it) persists across every page, so navigate_to can
  // freely cross what used to be route-group boundaries without dropping
  // the call.
  const handleFunctionCall = useCallback(
    (name: string, args: Record<string, unknown>): { status: string; message?: string } => {
      switch (name) {
        case "navigate_to": {
          const requested = String(args.page || "");
          const path = VOICE_PAGE_ROUTES[requested];
          if (!path) {
            return { status: "error", message: `Unknown page: ${requested}` };
          }
          router.push(path);
          return { status: "ok" };
        }
        case "switch_capability": {
          const requested = String(args.capability || "");
          const value = VOICE_CAPABILITY_VALUES[requested];
          if (value === undefined) {
            return { status: "error", message: `Unknown capability: ${requested}` };
          }
          dispatchCapabilitySelect(value);
          return { status: "ok" };
        }
        case "start_new_chat":
          chat?.cancelStreamingTurn();
          chat?.newSession();
          router.push("/home");
          return { status: "ok" };
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
        default:
          return { status: "error", message: `Unknown action: ${name}` };
      }
    },
    [chat, openHistory, closeHistory, router],
  );

  const call = useRealtimeVoiceCall({
    onUserUtterance: handleUserUtterance,
    onAssistantUtterance: handleAssistantUtterance,
    onFunctionCall: handleFunctionCall,
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
