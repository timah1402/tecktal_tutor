"use client";

/**
 * VoiceOrb — Step 7 of the navigation redesign.
 *
 * Its own independent useVoiceRecorder instance (separate from the
 * composer's existing mic button in ChatComposer.tsx — zero changes there).
 * On a transcript, dispatches VOICE_TRANSCRIPT_EVENT, which /home listens
 * for and drops into the composer via the existing prefillInputRef bridge.
 *
 * Only interactive on /home — elsewhere there's no listener for the event
 * (mirrors the RAG Provider section's /home-only scoping), so recording
 * from another page would produce a transcript that silently goes nowhere.
 * Instead it shows a quiet "open a chat to use voice" hint there.
 *
 * Graceful degradation: this doesn't pre-flight whether an STT provider is
 * configured (no clean client-side signal for that) — it just attempts to
 * record, and surfaces useVoiceRecorder's existing `error` state inline
 * (mic permission denied, unsupported browser, or the backend call failing
 * because no provider is configured) with a link to Settings, rather than
 * failing silently or claiming a continuous "always listening" mode this
 * app doesn't actually have (DeepTutor only does single-utterance dictation
 * today).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mic, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { dispatchVoiceTranscript } from "@/context/app-shell-storage";

export function VoiceOrb() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const onHome = pathname.startsWith("/home");

  const recorder = useVoiceRecorder((text) => {
    dispatchVoiceTranscript(text);
  });

  const handleClick = () => {
    if (!onHome) return;
    recorder.toggle();
  };

  const recording = recorder.state === "recording";
  const transcribing = recorder.state === "transcribing";

  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border)]/55 bg-[var(--card)] py-5">
      <button
        type="button"
        onClick={handleClick}
        disabled={!onHome || transcribing}
        aria-label={
          recording ? t("Stop recording") : t("Record voice")
        }
        className={`flex h-20 w-20 items-center justify-center rounded-full border-4 transition-all duration-150 disabled:cursor-not-allowed ${
          recording
            ? "border-red-500/50 bg-red-500/10"
            : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
        } ${!onHome ? "opacity-50" : ""}`}
      >
        {transcribing ? (
          <Loader2
            size={28}
            strokeWidth={1.6}
            className="animate-spin text-[var(--primary)]"
          />
        ) : (
          <Mic
            size={28}
            strokeWidth={1.6}
            className={recording ? "text-red-500" : "text-[var(--primary)]"}
          />
        )}
      </button>
      <div className="px-3 text-center">
        {!onHome ? (
          <div className="text-[10.5px] text-[var(--muted-foreground)]/70">
            {t("Open a chat to use voice")}
          </div>
        ) : recorder.error ? (
          <div className="text-[10.5px] leading-snug text-[var(--destructive)]">
            {recorder.error}{" "}
            <Link
              href="/settings/stt"
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
            >
              {t("Configure voice in Settings")}
            </Link>
          </div>
        ) : (
          <>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-[var(--muted-foreground)]">
              {recording ? t("Listening…") : t("Tap to start")}
            </div>
            <div className="text-[10.5px] text-[var(--muted-foreground)]/70">
              {recording
                ? t("Tap again to stop")
                : t("Single-utterance voice input")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
