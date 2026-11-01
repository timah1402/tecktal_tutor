"use client";

/**
 * Phone-width (below `md`) version of the /home empty state, replacing
 * HeroQuickActions there. Voice-first: a large glowing orb in the middle that
 * starts/stops the voice call, a status line under it, and the capabilities
 * as a horizontally scrolling row of pills just above the composer.
 *
 * Same actions as the desktop hero — the orb drives `useVoiceCall`, pills
 * dispatch the same capability select — only the layout differs. Colors all
 * come from the theme vars (--primary, the logo accents), so it follows
 * whichever theme is active. Unlike the desktop dock, it stays mounted after
 * a pill is picked: the picked pill is highlighted and tapping it again goes
 * back to plain Chat.
 */

import { useTranslation } from "react-i18next";
import { Loader2, Mic, Volume2 } from "lucide-react";

import { CAPABILITY_TILES } from "@/components/sidebar/QuickActionsPanel";
import { getAccentForIndex } from "@/lib/quick-action-colors";
import { dispatchCapabilitySelect } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { useVoiceCall } from "@/context/VoiceCallContext";

const MODE_PILLS = CAPABILITY_TILES.filter((entry) => entry.capabilityValue !== "");

export function MobileHomeHero({ greeting }: { greeting: string }) {
  const { t } = useTranslation();
  const chat = useUnifiedChatSafe();
  const call = useVoiceCall();
  const activeValue = chat?.state.activeCapability || "";

  const callActive = call.state === "listening" || call.state === "speaking";
  const connecting = call.state === "connecting";
  const speaking = call.state === "speaking";
  const listening = call.state === "listening";

  const title = connecting
    ? t("Connecting…")
    : listening
      ? t("I'm listening.")
      : speaking
        ? t("Speaking…")
        : t(greeting);
  const subtitle = callActive
    ? t("Tap the orb again to end the conversation.")
    : t("Tap to talk, or type your question below.");

  return (
    <div className="flex w-full flex-1 min-h-0 flex-col items-center">
      <div className="flex w-full flex-1 min-h-0 flex-col items-center justify-center gap-6 overflow-y-auto py-4">
        {/* Orb: ambient glow + a faint outer ring + a dashed inner ring,
            around the actual button. */}
        <div className="relative flex h-56 w-56 shrink-0 items-center justify-center">
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-0 rounded-full bg-[var(--primary)]/15 blur-3xl ${
              callActive ? "animate-pulse" : ""
            }`}
          />
          <div aria-hidden className="pointer-events-none absolute h-52 w-52 rounded-full border border-[var(--primary)]/10" />
          <div aria-hidden className="pointer-events-none absolute h-44 w-44 rounded-full border border-dashed border-[var(--primary)]/25" />
          <button
            type="button"
            onClick={() => {
              if (call.state === "idle" || call.state === "error") void call.connect();
              else call.disconnect();
            }}
            aria-label={t("Record voice")}
            className={`relative flex h-36 w-36 items-center justify-center rounded-full text-white shadow-[0_16px_50px_-8px_var(--primary)] outline-none transition-transform active:scale-95 focus-visible:ring-4 focus-visible:ring-[var(--primary)]/30 ${
              callActive || connecting ? "bg-red-500" : "bg-[var(--primary)]"
            }`}
          >
            {/* Soft top-light / bottom-shade for a rounded, tactile look. */}
            <span aria-hidden className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-t from-black/15 to-white/20" />
            {connecting ? (
              <Loader2 size={44} strokeWidth={1.6} className="relative animate-spin" />
            ) : speaking ? (
              <Volume2 size={44} strokeWidth={1.6} className="relative animate-pulse" />
            ) : listening ? (
              <span aria-hidden className="relative flex h-10 items-center gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="w-1 animate-pulse rounded-full bg-white"
                    style={{ height: `${[14, 26, 36, 22, 16][i]}px`, animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </span>
            ) : (
              <Mic size={44} strokeWidth={1.6} className="relative" />
            )}
          </button>
        </div>

        <div className="flex max-w-[300px] flex-col items-center gap-2 text-center">
          <h1 className="font-serif text-[26px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--foreground)]">
            {title}
          </h1>
          <p className="text-[14px] leading-relaxed text-[var(--muted-foreground)]">{subtitle}</p>
        </div>
      </div>

      {/* Mode pills — scroll sideways; -mx/px let them run to the screen
          edge while the first/last pill still lines up with the content. */}
      <div
        role="listbox"
        aria-label={t("Tools")}
        className="-mx-6 flex w-[calc(100%+3rem)] shrink-0 gap-2 overflow-x-auto px-6 pb-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {MODE_PILLS.map((entry, index) => {
          const active = entry.capabilityValue === activeValue;
          const accent = getAccentForIndex(index);
          return (
            <button
              key={entry.capabilityValue}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => dispatchCapabilitySelect(active ? "" : (entry.capabilityValue ?? ""))}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all active:scale-95 ${
                active
                  ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                  : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"
              }`}
            >
              <entry.icon
                size={16}
                strokeWidth={1.8}
                style={{ color: active ? "currentColor" : accent.icon }}
              />
              {t(entry.label)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
