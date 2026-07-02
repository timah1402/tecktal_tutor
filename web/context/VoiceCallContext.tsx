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
import { usePathname, useRouter } from "next/navigation";

import { useRealtimeVoiceCall, type RealtimeCallState } from "@/hooks/useRealtimeVoiceCall";
import { dispatchCapabilitySelect, dispatchExpandDock } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { setTheme, type Theme } from "@/lib/theme";
import { executeVoiceAction } from "@/lib/voice-api";

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

  // Pairs a finished user utterance with the assistant's reply that follows
  // it, then persists the pair together (the backend appends both messages
  // in one call) and reconciles local state via the same loadSession() path
  // normal typed turns already use. Both refs, not state — this is plumbing
  // between event callbacks, not something that should re-render.
  const pendingUserTextRef = useRef<string | null>(null);
  const pendingAssistantTextRef = useRef<string | null>(null);

  const handleUserUtterance = useCallback((text: string) => {
    pendingUserTextRef.current = text;
  }, []);

  // Store the assistant text but DON'T record yet — we don't know until
  // response.done whether this turn also included a function call.
  // onTurnComplete (below) commits or discards the pending exchange.
  const handleAssistantUtterance = useCallback((text: string) => {
    pendingAssistantTextRef.current = text;
  }, []);

  // Called by useRealtimeVoiceCall at response.done. Voice is a separate
  // interface from chat — exchanges are never auto-recorded. A chat session
  // only starts when the user explicitly asks for one (typed message or
  // "start new chat" voice command). Just clear the pending refs.
  const handleTurnComplete = useCallback((_hadFunctionCalls: boolean) => {
    pendingUserTextRef.current = null;
    pendingAssistantTextRef.current = null;
  }, []);

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
          const path = VOICE_PAGE_ROUTES[String(result.page || "")];
          if (!path) return { status: "error", message: `Unknown page: ${result.page}` };
          if (result.page === "home") {
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
          const value = VOICE_CAPABILITY_VALUES[String(result.capability || "")];
          if (value === undefined) {
            return { status: "error", message: `Unknown capability: ${result.capability}` };
          }
          if (pathname.startsWith("/home")) {
            // Already on /home — fire in-place; the listener in home/page.tsx
            // is mounted right now, no navigation needed.
            dispatchCapabilitySelect(value);
          } else {
            // Off /home — navigate with the capability as a query param so
            // home/page.tsx's mount effect picks it up cleanly on arrival.
            router.push(value ? `/home?capability=${value}` : "/home");
          }
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
          const requested = String(result.theme || "");
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
