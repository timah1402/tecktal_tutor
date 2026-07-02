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
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  Mic,
  Loader2,
  Volume2,
  History as HistoryIcon,
  NotebookText,
  MoreHorizontal,
} from "lucide-react";

import {
  CAPABILITY_TILES,
  NAV_TILES,
  type QuickActionEntry,
} from "@/components/sidebar/QuickActionsPanel";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCapabilityAccess } from "@/components/access/CapabilityAccessContext";
import { getAccentForIndex } from "@/lib/quick-action-colors";
import { dispatchCapabilitySelect, EXPAND_DOCK_EVENT } from "@/context/app-shell-storage";
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

// The collapsed hero's 6 "headline" actions, big and front-and-center —
// everything else (Partners, My Agents, Co-Writer, Book, Learning Space,
// Memory, Knowledge Center, Settings, Notebooks, History) only shows up
// once "See more" is clicked. Order matches how the user described it:
// the 5 capabilities, then Home.
const MAIN_TILES: QuickActionEntry[] = [...DOCK_TOOLS, NAV_TILES[0]];

// Synthetic 7th tile — not a real nav/capability entry, just the toggle
// that reveals the rest. Paired with MAIN_TILES it's exactly 7 tiles, which
// a 4-column grid auto-places as 4 on top + 3 on the row below.
const SEE_MORE_ENTRY: QuickActionEntry = { href: "", label: "See more", icon: MoreHorizontal };

const SPRING = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };

/** Icon circle + label, used for both capability tools (button) and nav
 * tiles (link). `size="lg"` is the collapsed hero's headline tiles; `"sm"`
 * (default) is the original compact size used once expanded. */
function WideTile({
  entry,
  index,
  active,
  locked,
  lockedTooltip,
  layoutId,
  onClick,
  href,
  size = "sm",
}: {
  entry: QuickActionEntry;
  index: number;
  active?: boolean;
  locked?: boolean;
  lockedTooltip?: string;
  layoutId?: string;
  onClick?: (event: React.MouseEvent) => void;
  href?: string;
  size?: "sm" | "lg";
}) {
  const { t } = useTranslation();
  const accent = getAccentForIndex(index);
  const label = t(entry.label);
  const isLg = size === "lg";

  const content = (
    <>
      <div
        className={`flex items-center justify-center rounded-full ${isLg ? "h-14 w-14" : "h-9 w-9"}`}
        style={{ background: locked ? "var(--muted)" : accent.tint }}
      >
        <entry.icon
          size={isLg ? 26 : 17}
          strokeWidth={1.8}
          style={{ color: locked ? "var(--muted-foreground)" : accent.icon }}
        />
      </div>
      <span
        className={`flex w-full items-center justify-center overflow-hidden text-center leading-tight ${isLg ? "h-[28px] text-[13px]" : "h-[26px] text-[11px]"} ${locked ? "text-[var(--muted-foreground)]/60" : "text-[var(--foreground)]/85"}`}
      >
        {label}
      </span>
    </>
  );

  // Explicit fixed dimensions — every tile (capability or nav, 1-word or
  // 2-line label) renders at exactly this size, never sized off its own
  // content, so the grid stays visually uniform regardless of label length.
  const className = `flex shrink-0 flex-col items-center justify-center rounded-2xl border text-center transition-colors duration-150 ${
    isLg ? "h-[130px] w-[130px] gap-2 px-3 py-4" : "h-[92px] w-[72px] gap-1.5 px-2 py-3"
  } ${
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

  // Collapsed (default): just the 6 headline actions, big, plus "See more".
  // Expanded: every tool/nav tile, shrunk back down to fit the page — flips
  // true the moment "See more" is clicked, false again on remount (a fresh
  // session always starts back in the collapsed state).
  const [expanded, setExpanded] = useState(false);

  // Allow voice commands (show_more / show_less in VoiceCallContext) to
  // control the expanded state without lifting it out of this component.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ expanded: boolean }>).detail;
      if (detail != null) setExpanded(detail.expanded);
    };
    window.addEventListener(EXPAND_DOCK_EVENT, handler);
    return () => window.removeEventListener(EXPAND_DOCK_EVENT, handler);
  }, []);

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

  // Index pinned to each entry up front (rather than re-deriving it from a
  // sliced array's own 0-based position) so accent color stays consistent
  // regardless of which row a tile lands in.
  const collapsedEntries = [...MAIN_TILES, SEE_MORE_ENTRY].map((entry, index) => ({
    entry,
    index,
  }));

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
        className={`flex h-36 w-36 shrink-0 items-center justify-center rounded-full border-[8px] transition-colors duration-150 ${
          speaking
            ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 animate-pulse"
            : callActive || connecting
              ? "border-red-500/50 bg-red-500/10"
              : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
        }`}
      >
        {connecting ? (
          <Loader2 size={52} strokeWidth={1.5} className="animate-spin text-[var(--primary)]" />
        ) : speaking ? (
          <Volume2 size={52} strokeWidth={1.5} className="text-[var(--primary)]" />
        ) : (
          <Mic
            size={52}
            strokeWidth={1.5}
            className={callActive ? "text-red-500" : "text-[var(--primary)]"}
          />
        )}
      </motion.button>

      {expanded ? (
        <>
          {/* Fixed-width grid (one 72px column per possible tool, regardless
              of how many are actually rendered right now). With a
              shrink-to-fit flex row instead, removing a tile shrinks the row
              and the parent's `items-center` just recenters the smaller
              group, so the remaining tiles barely seem to move. Pinning the
              row to a constant width means it never recenters: the inactive
              tiles auto-place into the first N grid cells, sliding fully
              left into whichever cell opened up — visible for the instant
              right after a click, mid-FLIP, before this whole component
              unmounts in favor of the sidebar strip. */}
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

          {/* Nav tiles — Home + remaining nav destinations + Notebooks.
              Plain Links, no reorder animation since these navigate away
              rather than toggling state in place. */}
          <div className="flex max-w-xl flex-wrap items-center justify-center gap-2.5">
            {NAV_GROUP.map((entry, index) => (
              <WideTile
                key={entry.label}
                entry={entry}
                index={index}
                active={pathname.startsWith(entry.href.split("?")[0])}
                locked={navLocked(entry)}
                lockedTooltip={lockedTooltip}
                href={entry.href}
                onClick={entry === NAV_TILES[0] ? handleHomeClick : undefined}
              />
            ))}
            <WideTile
              entry={{ href: "", label: "History", icon: HistoryIcon }}
              index={NAV_GROUP.length}
              onClick={call.openHistory}
            />
          </div>

          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-[12px] text-[var(--muted-foreground)]/70 underline-offset-2 hover:text-[var(--foreground)] hover:underline"
          >
            {t("Show less")}
          </button>
        </>
      ) : (
        /* Collapsed (default): the 6 headline actions + "See more", big — 4
            on top, 3 below, the bottom row centered under the top one
            (rather than left-aligned, which is what a single 4-column grid
            would do with a 3-item leftover row). Two explicit flex rows
            inside a centered flex-col achieves that: each row sizes to its
            own content (4 vs 3 tiles), and `items-center` centers the
            narrower row under the wider one. Clicking any real tile behaves
            exactly as it does once expanded (same handlers/layoutIds); only
            "See more" is local UI state. */
        <div className="flex flex-col items-center gap-4">
          {[collapsedEntries.slice(0, 4), collapsedEntries.slice(4)].map((row, rowIndex) => (
            <div key={rowIndex} className="flex gap-4">
              {row.map(({ entry, index }) => {
                if (entry === SEE_MORE_ENTRY) {
                  return (
                    <WideTile
                      key={entry.label}
                      entry={entry}
                      index={index}
                      size="lg"
                      onClick={() => setExpanded(true)}
                    />
                  );
                }
                const isHome = entry === NAV_TILES[0];
                return (
                  <WideTile
                    key={entry.label}
                    entry={entry}
                    index={index}
                    size="lg"
                    active={isHome ? pathname.startsWith(entry.href.split("?")[0]) : undefined}
                    locked={isHome ? navLocked(entry) : undefined}
                    lockedTooltip={lockedTooltip}
                    layoutId={isHome ? undefined : `dock-tool-${entry.capabilityValue}`}
                    href={isHome ? entry.href : undefined}
                    onClick={isHome ? handleHomeClick : () => handleActivate(entry)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
