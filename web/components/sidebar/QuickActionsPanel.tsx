"use client";

/**
 * QuickActionsPanel — the sidebar shell.
 *
 * Normally just the logo header and the footer (account menu/version/docs/
 * github) — the icon-tile grid and the voice button live in the home page's
 * centered dock (HeroQuickActions)
 * while no tool is picked, so they're not duplicated in two places at once.
 *
 * The exception: once a tool *is* picked (and we're still on the empty
 * /home hero, no messages yet), HeroQuickActions collapses to nothing and
 * this sidebar instead renders a compact icon strip right under the logo —
 * Voice + the remaining tools + the nav tiles, all shrunk to icon-only
 * circles. That's what "transforming the center bar into a side bar"
 * means: the wide centered dock becomes this narrow strip pinned under the
 * TECKTAL TUTOR header, clearing the whole center of the page. The picked
 * tool's own icon isn't here either — it's flown into the composer's
 * capability badge (ChatComposer.tsx) via a shared Framer Motion
 * `layoutId`, exactly like it does when leaving HeroQuickActions; this
 * strip's icons share those same `dock-tool-${value}`/`dock-voice`
 * layoutIds so the FLIP animation works no matter which of the two
 * (HeroQuickActions vs. this strip) currently owns a given tile.
 *
 * Tile *data* (NAV_TILES/CAPABILITY_TILES/QUICK_ACTION_TILES) and the tile
 * components (QuickActionTile/ButtonTile) stay exported since
 * HeroQuickActions imports them rather than duplicating.
 */

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  BrainCircuit,
  GraduationCap,
  HeartHandshake,
  History as HistoryIcon,
  House,
  LayoutGrid,
  Library,
  Loader2,
  Lock,
  Menu,
  Mic,
  Microscope,
  MessageSquare,
  NotebookText,
  PenLine,
  Settings,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState, type ReactNode } from "react";

import { useCapabilityAccess } from "@/components/access/CapabilityAccessContext";
import { Tooltip } from "@/components/ui/Tooltip";
import HistoryFlyout from "@/components/sidebar/HistoryFlyout";
import { dispatchCapabilitySelect } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { getAccentForIndex } from "@/lib/quick-action-colors";
import type { Capability } from "@/lib/capability-routes";
import type { SessionSummary } from "@/lib/session-api";

// Matches HeroQuickActions' SPRING/ChatComposer's DOCK_SPRING exactly — all
// three share the same `dock-tool-${value}`/`dock-voice` layoutIds, so a
// tile's FLIP animation looks identical regardless of which pair of
// components it's currently flying between.
const DOCK_SPRING = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };

export interface QuickActionEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  tooltipKey?: string;
  requires?: Capability;
  /**
   * Chat capability value ("" for plain Chat) for tiles that should switch
   * the composer in place when already on /home (Step 5), instead of
   * navigating. Undefined for plain nav tiles.
   */
  capabilityValue?: string;
}

// Primary + secondary destinations, copied verbatim from SidebarShell's
// PRIMARY_NAV / SECONDARY_NAV (same hrefs, gating, tooltip keys) so the two
// nav surfaces can't silently drift apart. Exported so HeroQuickActions (the
// home page's empty-state hero grid) renders the exact same tile data
// instead of a second, driftable copy.
export const NAV_TILES: QuickActionEntry[] = [
  { href: "/home", label: "Home", icon: House, tooltipKey: "Home tooltip", requires: "llm" },
  { href: "/partners", label: "Partners", icon: HeartHandshake, tooltipKey: "Partners tooltip", requires: "llm" },
  { href: "/agents", label: "My Agents", icon: Bot, tooltipKey: "Agents tooltip" },
  { href: "/co-writer", label: "Co-Writer", icon: PenLine, tooltipKey: "Co-Writer tooltip", requires: "llm" },
  { href: "/book", label: "Book", icon: Library, tooltipKey: "Book tooltip", requires: "llm" },
  { href: "/space", label: "Learning Space", icon: LayoutGrid, tooltipKey: "Space tooltip" },
  { href: "/memory", label: "Memory", icon: Brain, tooltipKey: "Memory tooltip" },
  { href: "/knowledge", label: "Knowledge Center", icon: BookOpen, tooltipKey: "Knowledge tooltip" },
  { href: "/settings", label: "Settings", icon: Settings },
];

// Chat capabilities — mirrors the CAPABILITIES array in the /home composer
// (value, label, icon). Linking to ?capability=X covers navigating in from
// another page; capabilityValue lets the click handler switch the composer
// in place instead when already on /home (Step 5).
export const CAPABILITY_TILES: QuickActionEntry[] = [
  { href: "/home", label: "Chat", icon: MessageSquare, capabilityValue: "" },
  { href: "/home?capability=deep_solve", label: "Solve", icon: BrainCircuit, capabilityValue: "deep_solve" },
  { href: "/home?capability=visualize", label: "Visualize", icon: BarChart3, capabilityValue: "visualize" },
  { href: "/home?capability=deep_research", label: "Research", icon: Microscope, capabilityValue: "deep_research" },
  { href: "/home?capability=deep_question", label: "Quiz", icon: PenLine, capabilityValue: "deep_question" },
  { href: "/home?capability=mastery_path", label: "Mastery Path", icon: GraduationCap, capabilityValue: "mastery_path" },
];

// Grid order: chat entry points first, then the 5 other capabilities, then
// the remaining nav destinations, Notebooks, then admin/secondary. Exported
// (alongside NAV_TILES/CAPABILITY_TILES above) so HeroQuickActions renders
// the identical combined list instead of a second, driftable copy.
export const QUICK_ACTION_TILES: QuickActionEntry[] = [
  NAV_TILES[0], // Home
  ...CAPABILITY_TILES, // Chat, Quiz, Research, Solve, Visualize, Mastery Path
  NAV_TILES[3], // Co-Writer
  NAV_TILES[1], // Partners
  NAV_TILES[2], // My Agents
  NAV_TILES[4], // Book
  NAV_TILES[5], // Learning Space
  NAV_TILES[6], // Memory
  NAV_TILES[7], // Knowledge Center
  NAV_TILES[8], // Settings
];

// Chat ("") is the dock's neutral/no-selection state, not a tile of its own
// — mirrors the identical filter in HeroQuickActions.
const DOCK_TOOLS = CAPABILITY_TILES.filter((entry) => entry.capabilityValue !== "");

// Nav icons shown in the collapsed strip: Home + the rest of NAV_TILES,
// plus Notebooks (which never had its own NAV_TILES entry — it linked out
// directly from the grid).
const STRIP_NAV_TILES: QuickActionEntry[] = [
  ...NAV_TILES,
  { href: "/space/questions", label: "Notebooks", icon: NotebookText },
];

interface QuickActionsPanelProps {
  sessions?: SessionSummary[];
  activeSessionId?: string | null;
  loadingSessions?: boolean;
  showSessions?: boolean;
  onSelectSession?: (sessionId: string) => void | Promise<void>;
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  footerSlot?: ReactNode | ((collapsed: boolean) => ReactNode);
}

export function QuickActionTile({
  entry,
  index,
  active,
  locked,
  lockedTooltip,
  onClick,
}: {
  entry: QuickActionEntry;
  index: number;
  active: boolean;
  locked: boolean;
  lockedTooltip: string;
  onClick?: (event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const accent = getAccentForIndex(index);
  const description = entry.tooltipKey ? t(entry.tooltipKey) : undefined;

  const card = (
    <div
      className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-all duration-150 ${
        locked
          ? "cursor-not-allowed border-[var(--border)]/50 bg-[var(--card)]/60"
          : active
            ? "border-[var(--primary)]/40 bg-[var(--card)] shadow-sm"
            : "border-[var(--border)]/55 bg-[var(--card)] hover:border-[var(--primary)]/30 hover:shadow-sm"
      }`}
    >
      <div
        className="relative flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: locked ? "var(--muted)" : accent.tint }}
      >
        <entry.icon
          size={17}
          strokeWidth={1.8}
          style={{ color: locked ? "var(--muted-foreground)" : accent.icon }}
        />
        {locked && (
          <Lock
            size={10}
            strokeWidth={2.2}
            className="absolute bottom-0 right-0 text-[var(--muted-foreground)]"
          />
        )}
      </div>
      <span
        className={`text-[11px] leading-tight ${
          locked ? "text-[var(--muted-foreground)]/60" : "text-[var(--foreground)]/85"
        }`}
      >
        {t(entry.label)}
      </span>
    </div>
  );

  if (locked) {
    return (
      <Tooltip label={t(entry.label)} description={lockedTooltip}>
        <div aria-disabled aria-label={`${t(entry.label)} — ${lockedTooltip}`}>
          {card}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={t(entry.label)} description={description}>
      <Link
        href={entry.href}
        onClick={onClick}
        aria-label={t(entry.label)}
        className="block"
      >
        {card}
      </Link>
    </Tooltip>
  );
}

/** Clickable tile that triggers an action (e.g. opening a flyout) instead of navigating. */
export function ButtonTile({
  index,
  icon: Icon,
  label,
  onClick,
}: {
  index: number;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const accent = getAccentForIndex(index);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t(label)}
      className="flex flex-col items-center gap-1.5 rounded-xl border border-[var(--border)]/55 bg-[var(--card)] px-2 py-3 text-center transition-all duration-150 hover:border-[var(--primary)]/30 hover:shadow-sm"
    >
      <div
        className="flex h-9 w-9 items-center justify-center rounded-full"
        style={{ background: accent.tint }}
      >
        <Icon size={17} strokeWidth={1.8} style={{ color: accent.icon }} />
      </div>
      <span className="text-[11px] leading-tight text-[var(--foreground)]/85">
        {t(label)}
      </span>
    </button>
  );
}

/** Compact icon-only circle used in the collapsed strip (see module doc
 * comment above) — shares a `layoutId` with its full-size counterpart in
 * HeroQuickActions (or the composer badge, for whichever tool is active
 * right now), so Framer Motion morphs one into the other on FLIP instead
 * of just cross-fading two unrelated elements. */
function StripIcon({
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

  const className = `flex h-16 w-16 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
    active
      ? "border-[var(--primary)]/45 bg-[var(--card)] shadow-sm ring-1 ring-[var(--primary)]/20"
      : "border-[var(--border)]/55 bg-[var(--card)] hover:border-[var(--primary)]/30 hover:shadow-sm"
  }`;

  const icon = (
    <entry.icon
      size={26}
      strokeWidth={1.8}
      style={{ color: locked ? "var(--muted-foreground)" : accent.icon }}
    />
  );

  const tile = href ? (
    <motion.div layout layoutId={layoutId} transition={DOCK_SPRING}>
      <Link href={href} onClick={onClick} aria-label={label} className={className}>
        {icon}
      </Link>
    </motion.div>
  ) : (
    <motion.button
      type="button"
      layout
      layoutId={layoutId}
      transition={DOCK_SPRING}
      onClick={onClick}
      aria-label={label}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.94 }}
      className={className}
    >
      {icon}
    </motion.button>
  );

  return (
    <Tooltip label={label} description={locked ? lockedTooltip : undefined}>
      {tile}
    </Tooltip>
  );
}

export function QuickActionsPanel({
  sessions = [],
  activeSessionId = null,
  loadingSessions = false,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  footerSlot,
}: QuickActionsPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const chat = useUnifiedChatSafe();
  const call = useVoiceCall();
  const { historyOpen, closeHistory, openHistory } = call;
  const { has } = useCapabilityAccess();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const renderedFooter =
    typeof footerSlot === "function" ? footerSlot(false) : footerSlot;

  // Close the mobile drawer on every route change — adjusted during render
  // (React's recommended "reset state on prop change" pattern) rather than
  // in an effect, to avoid the extra cascading render an effect would cause.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMobileDrawerOpen(false);
  }

  // HeroQuickActions' big centered dock only exists for one specific
  // screen: the empty /home hero (no messages yet) with nothing picked.
  // Everywhere else — mid-chat, or on any other page entirely — there is
  // no other way to navigate or switch tools, so this sidebar must show
  // its own (compact) strip instead. Without this, leaving /home (or just
  // sending a first message) strands the user with literally no icons
  // anywhere: that was the bug — clicking a nav tile "completely changed
  // the page" and the icons never came back.
  const activeValue = chat?.state.activeCapability || "";
  const isNeutralHomeHero =
    pathname.startsWith("/home") && (chat?.state.messages.length ?? 0) === 0 && activeValue === "";
  const showStrip = !isNeutralHomeHero;
  const inactiveTools = DOCK_TOOLS.filter((entry) => entry.capabilityValue !== activeValue);

  const lockedTooltip = t("Locked — contact your administrator to get access.");
  const navLocked = (item: QuickActionEntry) => (item.requires ? !has(item.requires) : false);

  // Mirrors HeroQuickActions' Home tile: always reset to a fresh session,
  // but let modifier-clicks fall through (middle-click/new-tab).
  const handleHomeClick = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    chat?.cancelStreamingTurn();
    chat?.newSession();
    router.push("/home");
  };

  // Capability tiles: already on /home → dispatch the in-place switch event
  // (the only thing listening for it is that page) instead of navigating,
  // since a query-only Link navigation wouldn't remount the page. From
  // anywhere else, that listener isn't mounted at all, so let the Link's
  // `?capability=` href navigate there normally instead.
  const handleToolClick = (entry: QuickActionEntry) => (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    if (pathname.startsWith("/home")) {
      event.preventDefault();
      dispatchCapabilitySelect(entry.capabilityValue ?? "");
    }
  };

  const callActive = call.state === "listening" || call.state === "speaking";
  const connecting = call.state === "connecting";
  const speaking = call.state === "speaking";

  return (
    <>
      {/* Mobile-only trigger — floating so it never overlaps a page's own
          header content. Hidden at md and up, where the panel is always
          visible inline. */}
      <button
        type="button"
        onClick={() => setMobileDrawerOpen(true)}
        aria-label={t("Open menu")}
        className="fixed left-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)]/55 bg-[var(--card)] text-[var(--foreground)] shadow-md md:hidden"
      >
        <Menu size={18} strokeWidth={1.8} />
      </button>

      {/* Scrim — mobile only, behind the drawer, closes it on click. */}
      {mobileDrawerOpen && (
        <div
          onClick={() => setMobileDrawerOpen(false)}
          aria-hidden
          className="fixed inset-0 z-40 bg-[var(--overlay)] md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-[240px] shrink-0 flex-col gap-3 overflow-y-auto bg-[var(--background)] px-3 py-3 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          mobileDrawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Mobile-only close button inside the open drawer. */}
        <button
          type="button"
          onClick={() => setMobileDrawerOpen(false)}
          aria-label={t("Close menu")}
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)] md:hidden"
        >
          <X size={16} strokeWidth={1.8} />
        </button>

        {/* Header — large (95px) and centered on the neutral hero, shrinks
            to 45px and left-aligned once the strip is showing so it
            settles down to a compact mark. */}
      <Link
        href="/"
        aria-label="TECKTAL TUTOR"
        className={`group flex items-center px-1 transition-all duration-200 ${
          showStrip ? "" : "justify-center mt-6"
        }`}
      >
        <Image
          src="/logo.png"
          alt="TECKTAL TUTOR"
          width={showStrip ? 45 : 95}
          height={showStrip ? 45 : 95}
          className={`transition-all duration-200 group-hover:scale-105 ${
            showStrip ? "h-[45px] w-[45px]" : "h-[95px] w-[95px]"
          }`}
        />
      </Link>

      {/* Collapsed strip — only while a tool is picked on the empty /home
          hero (see module doc comment). Voice stays on top, bigger than the
          rest since it's the primary way to drive the app; everything else
          is a 2-column grid of icon-only circles below it (two per row
          keeps the strip roughly half as tall as a single column would
          be, at this larger icon size). */}
      {showStrip && (
        <div className="flex flex-col items-center gap-3 overflow-y-auto">
          <motion.button
            type="button"
            layout
            layoutId="dock-voice"
            transition={DOCK_SPRING}
            onClick={() => {
              if (call.state === "idle" || call.state === "error") void call.connect();
              else call.disconnect();
            }}
            aria-label={t("Record voice")}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.96 }}
            className={`flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-[5px] transition-colors duration-150 ${
              speaking
                ? "border-[var(--primary)]/60 bg-[var(--primary)]/10 animate-pulse"
                : callActive || connecting
                  ? "border-red-500/50 bg-red-500/10"
                  : "border-[var(--accent)] bg-[var(--accent)] hover:border-[var(--primary)]/40"
            }`}
          >
            {connecting ? (
              <Loader2 size={34} strokeWidth={1.5} className="animate-spin text-[var(--primary)]" />
            ) : speaking ? (
              <Volume2 size={34} strokeWidth={1.5} className="text-[var(--primary)]" />
            ) : (
              <Mic size={34} strokeWidth={1.5} className={callActive ? "text-red-500" : "text-[var(--primary)]"} />
            )}
          </motion.button>

          <div className="grid grid-cols-2 gap-2.5">
            {inactiveTools.map((entry, index) => (
              <StripIcon
                key={entry.capabilityValue}
                entry={entry}
                index={index}
                layoutId={`dock-tool-${entry.capabilityValue}`}
                href={entry.href}
                onClick={handleToolClick(entry)}
              />
            ))}

            <div className="col-span-2 my-0.5 h-px w-full bg-[var(--border)]/50" />

            {STRIP_NAV_TILES.map((entry, index) => (
              <StripIcon
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
            <StripIcon
              entry={{ href: "", label: "History", icon: HistoryIcon }}
              index={STRIP_NAV_TILES.length}
              onClick={openHistory}
            />
          </div>
        </div>
      )}

      {/* Footer — account menu / version / docs / github */}
      <div className="mt-auto border-t border-[var(--border)]/40 pt-2">
        {renderedFooter}
      </div>

    </aside>

      {/* Rendered as a sibling of <aside>, not inside it: the aside now has
          a CSS transform (for the slide-over), which would otherwise turn
          it into a containing block for HistoryFlyout's fixed-position
          PickerShell overlay and break its full-viewport centering. */}
      <HistoryFlyout
        open={historyOpen}
        onClose={closeHistory}
        sessions={sessions}
        activeSessionId={activeSessionId}
        loadingSessions={loadingSessions}
        onSelectSession={onSelectSession ?? (() => {})}
        onRenameSession={onRenameSession ?? (() => {})}
        onDeleteSession={onDeleteSession ?? (() => {})}
      />
    </>
  );
}
