"use client";

/**
 * VoiceOrb — lives in AppSidebar, which is now mounted once at the root
 * layout and persists across every page, so the live call survives
 * navigation instead of dropping when crossing between what used to be
 * separate (workspace)/(utility) route-group layouts.
 *
 * Two distinct interaction modes, chosen per-tap based on context:
 *
 * 1. **Realtime call** (Chat capability active, or no capability set yet —
 *    on *any* page): tapping starts a live ``useRealtimeVoiceCall`` WebRTC
 *    call directly against OpenAI — talk and be interrupted naturally, hear
 *    the AI's voice back, and navigate to other pages via the
 *    ``navigate_to`` tool without the call dropping. Tapping again ends it.
 * 2. **Single-utterance dictation** (a non-Chat capability is active, e.g.
 *    Quiz/Research — tool-using turns aren't in scope for the realtime call
 *    yet): falls back to the original ``useVoiceRecorder`` flow, which
 *    transcribes one clip and drops it into the composer via
 *    VOICE_TRANSCRIPT_EVENT. That event only has a listener on /home, so
 *    this mode (only) stays gated to /home — the orb shows a quiet
 *    "open a chat to use voice" hint elsewhere.
 *
 * Graceful degradation: neither mode pre-flights whether voice is
 * configured (no clean client-side signal for that, especially for the
 * realtime call — the active LLM's binding lives behind /settings). Both
 * just attempt the action and surface the resulting error inline with a
 * link to Settings, rather than failing silently or claiming a continuous
 * "always listening" mode beyond what's actually configured.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Mic, Loader2, Volume2 } from "lucide-react";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useRealtimeVoiceCall } from "@/hooks/useRealtimeVoiceCall";
import {
  dispatchCapabilitySelect,
  dispatchVoiceTranscript,
} from "@/context/app-shell-storage";
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

export function VoiceOrb({
  onOpenHistory,
  onCloseHistory,
}: {
  /** Opens the History flyout — that state lives in the parent QuickActionsPanel. */
  onOpenHistory?: () => void;
  /** Closes the History flyout — same state, opposite direction. */
  onCloseHistory?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const onHome = pathname.startsWith("/home");

  const chat = useUnifiedChatSafe();
  const activeCapability = chat?.state.activeCapability || "";
  // Tool-using capabilities (Quiz/Research/...) aren't in scope for the
  // realtime call yet — dictation into the composer still makes sense there.
  // Unlike dictation, the call itself isn't tied to /home: it can be
  // started/continued/controlled from any page now that AppSidebar persists.
  const realtimeEligible = !activeCapability || activeCapability === "chat";
  // Dictation drops text into the /home composer via a DOM event that only
  // has a listener there, so that fallback (only) stays gated to /home.
  const dictationDisabled = !realtimeEligible && !onHome;

  const recorder = useVoiceRecorder((text) => {
    dispatchVoiceTranscript(text);
  });

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
  // (and the call inside it) now persists across every page, so navigate_to
  // can freely cross what used to be route-group boundaries without
  // dropping the call.
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
          onOpenHistory?.();
          return { status: "ok" };
        case "close_history":
          onCloseHistory?.();
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
    [chat, onOpenHistory, onCloseHistory, router],
  );

  const call = useRealtimeVoiceCall({
    onUserUtterance: handleUserUtterance,
    onAssistantUtterance: handleAssistantUtterance,
    onFunctionCall: handleFunctionCall,
  });

  const handleClick = () => {
    if (realtimeEligible) {
      if (call.state === "idle" || call.state === "error") void call.connect();
      else call.disconnect();
      return;
    }
    if (dictationDisabled) return;
    recorder.toggle();
  };

  const recording = recorder.state === "recording";
  const transcribing = recorder.state === "transcribing";

  const callActive = call.state === "listening" || call.state === "speaking";
  const connecting = call.state === "connecting";
  const speaking = call.state === "speaking";

  const active = realtimeEligible ? callActive || connecting : recording;
  const busy = realtimeEligible ? connecting : transcribing;
  const errorMessage = realtimeEligible ? call.error : recorder.error;
  // Benign (e.g. the silence auto-disconnect) — shown without the "configure
  // in Settings" link an actual error gets, and clears on the next tap.
  const noticeMessage = realtimeEligible ? call.notice : null;

  let statusLabel: string;
  let hintLabel: string;
  if (realtimeEligible) {
    statusLabel = connecting
      ? t("Connecting…")
      : speaking
        ? t("Speaking…")
        : callActive
          ? t("Listening…")
          : t("Tap to start");
    hintLabel = callActive ? t("Tap again to end call") : t("Live voice conversation");
  } else {
    statusLabel = recording ? t("Listening…") : t("Tap to start");
    hintLabel = recording ? t("Tap again to stop") : t("Single-utterance voice input");
  }

  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border)]/55 bg-[var(--card)] py-5">
      <button
        type="button"
        onClick={handleClick}
        disabled={dictationDisabled || busy}
        aria-label={active ? t("Stop recording") : t("Record voice")}
        className={`flex h-20 w-20 items-center justify-center rounded-full border-4 transition-all duration-150 disabled:cursor-not-allowed ${
          speaking
            ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 animate-pulse"
            : active
              ? "border-red-500/50 bg-red-500/10"
              : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
        } ${dictationDisabled ? "opacity-50" : ""}`}
      >
        {busy ? (
          <Loader2
            size={28}
            strokeWidth={1.6}
            className="animate-spin text-[var(--primary)]"
          />
        ) : speaking ? (
          <Volume2 size={28} strokeWidth={1.6} className="text-[var(--primary)]" />
        ) : (
          <Mic
            size={28}
            strokeWidth={1.6}
            className={active ? "text-red-500" : "text-[var(--primary)]"}
          />
        )}
      </button>
      <div className="px-3 text-center">
        {dictationDisabled ? (
          <div className="text-[10.5px] text-[var(--muted-foreground)]/70">
            {t("Open a chat to use voice")}
          </div>
        ) : errorMessage ? (
          <div className="text-[10.5px] leading-snug text-[var(--destructive)]">
            {errorMessage}{" "}
            <Link
              href={realtimeEligible ? "/settings/llm" : "/settings/stt"}
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
            >
              {t("Configure voice in Settings")}
            </Link>
          </div>
        ) : noticeMessage ? (
          <div className="text-[10.5px] leading-snug text-[var(--muted-foreground)]">
            {noticeMessage}
          </div>
        ) : (
          <>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[var(--muted-foreground)]">
              {statusLabel}
            </div>
            <div className="text-[10.5px] text-[var(--muted-foreground)]/70">
              {hintLabel}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
