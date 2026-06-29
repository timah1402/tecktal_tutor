"use client";

/**
 * The /home empty-state's centered icon area: Voice + every tool/nav icon
 * that used to live in the sidebar, now together in the middle of the page
 * while no tool is picked yet.
 *
 * As soon as a capability *is* picked, this component renders nothing at
 * all — the whole dock has moved into the sidebar instead (QuickActionsPanel
 * collapses to a compact icon strip right under the logo, see that file's
 * module doc comment) — "transforming the center bar into a side bar" so
 * the center of the page is completely clear to actually use the tool. The
 * picked tool's own icon isn't in either dock: it flies down into the
 * composer's capability badge (ChatComposer.tsx, the pencil/icon + label
 * next to the chat input) via a shared Framer Motion `layoutId`
 * (`dock-tool-${value}`) — no manual rect math, no timers, just this dock
 * unmounting the same render the composer badge's layoutId starts matching
 * it. Deselecting (or picking a different tool) reverses it: this neutral
 * layout remounts (or the sidebar strip keeps showing the new pick), and
 * the tile flies back from the badge.
 */

import { motion } from "framer-motion";
import Link from "next/link";
import { useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Mic, Loader2, Volume2, History as HistoryIcon, NotebookText } from "lucide-react";

import {
  CAPABILITY_TILES,
  NAV_TILES,
  type QuickActionEntry,
} from "@/components/sidebar/QuickActionsPanel";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCapabilityAccess } from "@/components/access/CapabilityAccessContext";
import { getAccentForIndex } from "@/lib/quick-action-colors";
import { dispatchCapabilitySelect } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { useVoiceCall } from "@/context/VoiceCallContext";

// Next's Link forwards its ref to the underlying <a>, so framer-motion's
// `motion()` wrapper can drive `layout`/`layoutId` on it directly — this
// keeps nav tiles on client-side routing instead of falling back to a
// plain <a href> (which would force a full page reload).
const MotionLink = motion(Link);

// Chat ("") is the dock's neutral/no-selection state, not a tile of its own.
const DOCK_TOOLS = CAPABILITY_TILES.filter((entry) => entry.capabilityValue !== "");

// Nav group: Home + the rest of the sidebar's old nav tiles, plus Notebooks
// (which never had its own NAV_TILES entry — it linked out directly from
// the grid). History joins this group too, even though it opens a flyout
// instead of navigating — visually it's just another icon in the row.
const NAV_GROUP: QuickActionEntry[] = [
  ...NAV_TILES,
  { href: "/space/questions", label: "Notebooks", icon: NotebookText },
];

const SPRING = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };

/** Icon circle + label, used for both capability tools (button) and nav
 * tiles (link). */
function WideTile({
  entry,
  index,
  active,
  locked,
  lockedTooltip,
  layoutId,
  onClick,
  href,
}: {
  entry: QuickActionEntry;
  index: number;
  active?: boolean;
  locked?: boolean;
  lockedTooltip?: string;
  layoutId?: string;
  onClick?: (event: React.MouseEvent) => void;
  href?: string;
}) {
  const { t } = useTranslation();
  const accent = getAccentForIndex(index);
  const label = t(entry.label);

  const content = (
    <>
      <div
        className="flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: locked ? "var(--muted)" : accent.tint }}
      >
        <entry.icon
          size={17}
          strokeWidth={1.8}
          style={{ color: locked ? "var(--muted-foreground)" : accent.icon }}
        />
      </div>
      <span
        className={`text-[11px] leading-tight ${locked ? "text-[var(--muted-foreground)]/60" : "text-[var(--foreground)]/85"}`}
      >
        {label}
      </span>
    </>
  );

  const className = `flex w-full flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-colors duration-150 ${
    locked
      ? "cursor-not-allowed border-[var(--border)]/50 bg-[var(--card)]/60"
      : active
        ? "border-[var(--primary)]/40 bg-[var(--card)] shadow-sm"
        : "border-[var(--border)]/55 bg-[var(--card)] hover:border-[var(--primary)]/30 hover:shadow-sm"
  }`;

  const tile = href ? (
    <MotionLink
      layout
      layoutId={layoutId}
      transition={SPRING}
      href={href}
      onClick={onClick}
      aria-label={label}
      className={className}
    >
      {content}
    </MotionLink>
  ) : (
    <motion.button
      type="button"
      layout
      layoutId={layoutId}
      transition={SPRING}
      onClick={onClick}
      role="option"
      aria-selected={false}
      aria-label={label}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.96 }}
      className={className}
    >
      {content}
    </motion.button>
  );

  return locked ? (
    <Tooltip label={label} description={lockedTooltip}>
      <div aria-disabled aria-label={`${label} — ${lockedTooltip}`}>{tile}</div>
    </Tooltip>
  ) : (
    <Tooltip label={label}>{tile}</Tooltip>
  );
}

export function HeroQuickActions() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const chat = useUnifiedChatSafe();
  const call = useVoiceCall();
  const { has } = useCapabilityAccess();
  const activeValue = chat?.state.activeCapability || "";

  // Once a tool is picked, the whole dock has moved into the sidebar
  // (QuickActionsPanel) — nothing to render here at all.
  if (activeValue !== "") return null;

  // A dock tile is only ever rendered while inactive (the active one has
  // flown to the composer badge), so activating it is always a plain select
  // — no toggle-off case to handle here.
  const handleActivate = (entry: QuickActionEntry) => {
    dispatchCapabilitySelect(entry.capabilityValue ?? "");
  };

  // Mirrors QuickActionsPanel's Home tile: always reset to a fresh session,
  // but let modifier-clicks fall through (middle-click/new-tab).
  const handleHomeClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    chat?.cancelStreamingTurn();
    chat?.newSession();
    router.push("/home");
  };

  const lockedTooltip = t("Locked — contact your administrator to get access.");
  const navLocked = (item: QuickActionEntry) => (item.requires ? !has(item.requires) : false);

  const callActive = call.state === "listening" || call.state === "speaking";
  const connecting = call.state === "connecting";
  const speaking = call.state === "speaking";

  return (
    <div className="flex flex-col items-center gap-6">
      <motion.button
        type="button"
        layout
        layoutId="dock-voice"
        transition={SPRING}
        onClick={() => {
          if (call.state === "idle" || call.state === "error") void call.connect();
          else call.disconnect();
        }}
        aria-label={t("Record voice")}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className={`flex h-28 w-28 shrink-0 items-center justify-center rounded-full border-[6px] transition-colors duration-150 ${
          speaking
            ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 animate-pulse"
            : callActive || connecting
              ? "border-red-500/50 bg-red-500/10"
              : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
        }`}
      >
        {connecting ? (
          <Loader2 size={40} strokeWidth={1.5} className="animate-spin text-[var(--primary)]" />
        ) : speaking ? (
          <Volume2 size={40} strokeWidth={1.5} className="text-[var(--primary)]" />
        ) : (
          <Mic
            size={40}
            strokeWidth={1.5}
            className={callActive ? "text-red-500" : "text-[var(--primary)]"}
          />
        )}
      </motion.button>

      {/* Fixed-width grid (one 72px column per possible tool, regardless of
          how many are actually rendered right now). With a shrink-to-fit
          flex row instead, removing a tile shrinks the row and the parent's
          `items-center` just recenters the smaller group, so the remaining
          tiles barely seem to move. Pinning the row to a constant width
          means it never recenters: the inactive tiles auto-place into the
          first N grid cells, sliding fully left into whichever cell opened
          up — visible for the instant right after a click, mid-FLIP,
          before this whole component unmounts in favor of the sidebar
          strip. */}
      <div role="listbox" aria-label={t("Tools")} className="grid grid-cols-[72px_72px_72px_72px_72px] gap-3">
        {DOCK_TOOLS.map((entry, index) => (
          <WideTile
            key={entry.capabilityValue}
            entry={entry}
            index={index}
            layoutId={`dock-tool-${entry.capabilityValue}`}
            onClick={() => handleActivate(entry)}
          />
        ))}
      </div>

      {/* Nav tiles — Home + remaining nav destinations + Notebooks. Plain
          Links, no reorder animation since these navigate away rather than
          toggling state in place. */}
      <div className="flex max-w-xl flex-wrap items-center justify-center gap-2.5">
        {NAV_GROUP.map((entry, index) => (
          <div key={entry.label} className="w-[72px]">
            <WideTile
              entry={entry}
              index={index}
              active={pathname.startsWith(entry.href.split("?")[0])}
              locked={navLocked(entry)}
              lockedTooltip={lockedTooltip}
              href={entry.href}
              onClick={entry === NAV_TILES[0] ? handleHomeClick : undefined}
            />
          </div>
        ))}
        <div className="w-[72px]">
          <WideTile
            entry={{ href: "", label: "History", icon: HistoryIcon }}
            index={NAV_GROUP.length}
            onClick={call.openHistory}
          />
        </div>
      </div>
    </div>
  );
}
