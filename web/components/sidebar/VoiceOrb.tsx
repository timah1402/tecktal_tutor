"use client";

/**
 * VoiceOrb — Step 7 of the navigation redesign, evolved in the realtime-voice
 * feature to drive a full-duplex speech-to-speech call instead of
 * single-utterance dictation, whenever that's eligible.
 *
 * Two distinct interaction modes, chosen per-tap based on context:
 *
 * 1. **Realtime call** (on /home, with the Chat capability active or no
 *    capability set yet): tapping starts a live ``useRealtimeVoiceCall``
 *    WebRTC call directly against OpenAI — talk and be interrupted
 *    naturally, hear the AI's voice back. Tapping again ends the call.
 * 2. **Single-utterance dictation** (a non-Chat capability is active, e.g.
 *    Quiz/Research — tool-using turns aren't in scope for the realtime call
 *    yet): falls back to the original ``useVoiceRecorder`` flow, which
 *    transcribes one clip and drops it into the composer via
 *    VOICE_TRANSCRIPT_EVENT. Unchanged from before.
 *
 * Off /home there's no listener for the dictation transcript event and no
 * active session for a call to attach to, so the orb shows a quiet
 * "open a chat to use voice" hint instead, same as before.
 *
 * Graceful degradation: neither mode pre-flights whether voice is
 * configured (no clean client-side signal for that, especially for the
 * realtime call — the active LLM's binding lives behind /settings, not in
 * any context already mounted on /home). Both just attempt the action and
 * surface the resulting error inline with a link to Settings, rather than
 * failing silently or claiming a continuous "always listening" mode beyond
 * what's actually configured.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mic, Loader2, Volume2 } from "lucide-react";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useRealtimeVoiceCall } from "@/hooks/useRealtimeVoiceCall";
import { dispatchVoiceTranscript } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { recordRealtimeExchange } from "@/lib/session-api";

export function VoiceOrb() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const onHome = pathname.startsWith("/home");

  const chat = useUnifiedChatSafe();
  const activeCapability = chat?.state.activeCapability || "";
  // Tool-using capabilities (Quiz/Research/...) aren't in scope for the
  // realtime call yet — dictation into the composer still makes sense there.
  const realtimeEligible = onHome && (!activeCapability || activeCapability === "chat");

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
      void recordRealtimeExchange(chat?.state.sessionId ?? null, userText, text)
        .then(({ sessionId }) => chat?.loadSession(sessionId))
        .catch(() => {
          // Best-effort: the exchange was already heard/spoken live, so a
          // network blip here just means it won't show up in history — not
          // worth surfacing as a call-ending error.
        });
    },
    [chat],
  );

  const call = useRealtimeVoiceCall({
    onUserUtterance: handleUserUtterance,
    onAssistantUtterance: handleAssistantUtterance,
  });

  const handleClick = () => {
    if (!onHome) return;
    if (realtimeEligible) {
      if (call.state === "idle" || call.state === "error") void call.connect();
      else call.disconnect();
      return;
    }
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
        disabled={!onHome || busy}
        aria-label={active ? t("Stop recording") : t("Record voice")}
        className={`flex h-20 w-20 items-center justify-center rounded-full border-4 transition-all duration-150 disabled:cursor-not-allowed ${
          speaking
            ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 animate-pulse"
            : active
              ? "border-red-500/50 bg-red-500/10"
              : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
        } ${!onHome ? "opacity-50" : ""}`}
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
        {!onHome ? (
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
