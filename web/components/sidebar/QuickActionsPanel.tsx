"use client";

/**
 * QuickActionsPanel — Step 3/4 of the navigation redesign.
 *
 * Same prop contract as SidebarShell (a drop-in replacement, not a rewrite
 * of the data plumbing AppSidebar already owns), but a
 * completely different interaction model: a colorful icon-tile grid instead
 * of a vertical nav-link list, plus a voice-orb header and a RAG Provider
 * section — modeled on the user-provided "Tecktal Tutor" reference.
 *
 * The voice orb and RAG Provider section are static placeholders here;
 * History is a static placeholder too (its real flyout lands in Step 6)
 * while Notebooks already links out since that route exists today.
 * Capability tiles link to ``/home?capability=X`` as a plain Link for now —
 * making that switch the composer in place even while already on /home is
 * Step 5's job. There is no collapsed-rail mode (dropped per the approved
 * plan); footerSlot is always rendered in its expanded form.
 */

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  BookOpen,
  BookText,
  Bot,
  Brain,
  BrainCircuit,
  Github,
  GraduationCap,
  HeartHandshake,
  History as HistoryIcon,
  House,
  LayoutGrid,
  Library,
  Lock,
  Menu,
  Microscope,
  MessageSquare,
  NotebookText,
  PenLine,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState, type ReactNode } from "react";

import { useCapabilityAccess } from "@/components/access/CapabilityAccessContext";
import { Tooltip } from "@/components/ui/Tooltip";
import { VersionBadge } from "@/components/sidebar/VersionBadge";
import HistoryFlyout from "@/components/sidebar/HistoryFlyout";
import { VoiceOrb } from "@/components/sidebar/VoiceOrb";
import KnowledgeSelector from "@/components/chat/home/KnowledgeSelector";
import { dispatchCapabilitySelect } from "@/context/app-shell-storage";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { getAccentForIndex } from "@/lib/quick-action-colors";
import { listKnowledgeBases } from "@/lib/knowledge-api";
import type { Capability } from "@/lib/capability-routes";
import type { SessionSummary } from "@/lib/session-api";

const GITHUB_REPO_URL = "https://github.com/HKUDS/DeepTutor";
const DOCS_URL = "https://deeptutor.info/";

interface QuickActionEntry {
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
// nav surfaces can't silently drift apart.
const NAV_TILES: QuickActionEntry[] = [
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
const CAPABILITY_TILES: QuickActionEntry[] = [
  { href: "/home", label: "Chat", icon: MessageSquare, capabilityValue: "" },
  { href: "/home?capability=deep_question", label: "Quiz", icon: PenLine, capabilityValue: "deep_question" },
  { href: "/home?capability=deep_research", label: "Research", icon: Microscope, capabilityValue: "deep_research" },
  { href: "/home?capability=deep_solve", label: "Solve", icon: BrainCircuit, capabilityValue: "deep_solve" },
  { href: "/home?capability=visualize", label: "Visualize", icon: BarChart3, capabilityValue: "visualize" },
  { href: "/home?capability=mastery_path", label: "Mastery Path", icon: GraduationCap, capabilityValue: "mastery_path" },
];

interface QuickActionsPanelProps {
  sessions?: SessionSummary[];
  activeSessionId?: string | null;
  loadingSessions?: boolean;
  showSessions?: boolean;
  onNewChat?: () => void;
  onSelectSession?: (sessionId: string) => void | Promise<void>;
  onRenameSession?: (sessionId: string, title: string) => void | Promise<void>;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  footerSlot?: ReactNode | ((collapsed: boolean) => ReactNode);
}

function QuickActionTile({
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
function ButtonTile({
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

/**
 * Live KB selector, but only on /home: that's the only place the selected
 * scope (state.knowledgeBases / setKBs, owned by UnifiedChatContext) is
 * meaningful, and it's the single source of truth the composer's own KB
 * chip already reads/writes — duplicating it elsewhere would risk drift.
 * The KB *catalog* (what's available, not what's selected) isn't in that
 * context though, so this fetches it independently via the same shared
 * listKnowledgeBases() client-cache helper page.tsx uses — same precedent
 * as AppSidebar independently calling listSessions(). Elsewhere (any
 * non-/home route) this renders a static fallback instead.
 */
function RagProviderSection() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const onHome = pathname.startsWith("/home");
  const chat = useUnifiedChatSafe();
  const [catalog, setCatalog] = useState<{ name: string }[]>([]);

  useEffect(() => {
    if (!onHome) return;
    let cancelled = false;
    listKnowledgeBases()
      .then((list) => {
        if (cancelled) return;
        setCatalog(
          list
            .filter((kb) => kb.metadata?.type !== "subagent")
            .map((kb) => ({ name: kb.name })),
        );
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onHome]);

  return (
    <>
      <div className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]/70">
        {t("RAG Provider")}
      </div>
      {onHome && chat ? (
        <div className="rounded-xl border border-[var(--border)]/55 bg-[var(--card)] px-2 py-1.5">
          <KnowledgeSelector
            knowledgeBases={catalog}
            selected={chat.state.knowledgeBases}
            onToggle={(name) => {
              const current = chat.state.knowledgeBases;
              chat.setKBs(
                current.includes(name)
                  ? current.filter((kb) => kb !== name)
                  : [...current, name],
              );
            }}
            placement="bottom"
          />
        </div>
      ) : (
        <Link
          href="/home"
          className="block rounded-xl border border-[var(--border)]/55 bg-[var(--card)] px-3 py-2 text-[12px] text-[var(--muted-foreground)]/70 transition-colors hover:border-[var(--primary)]/30 hover:text-[var(--foreground)]"
        >
          {t("Open a chat to set a Knowledge Base")}
        </Link>
      )}
    </>
  );
}

export function QuickActionsPanel({
  sessions = [],
  activeSessionId = null,
  loadingSessions = false,
  onNewChat,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  footerSlot,
}: QuickActionsPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useTranslation();
  const { has } = useCapabilityAccess();
  const [historyOpen, setHistoryOpen] = useState(false);
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

  const handleHomeClick = (event: React.MouseEvent) => {
    // Mirrors SidebarShell's Home behavior: always reset to a fresh session,
    // but let modifier-clicks fall through so middle-click/new-tab still works.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1)
      return;
    event.preventDefault();
    onNewChat?.();
    router.push("/home");
  };

  // Capability tiles (Chat/Quiz/Research/Solve/Visualize/Mastery Path):
  // already on /home → dispatch the in-place switch event (Step 5) instead
  // of navigating, since a query-only Link navigation wouldn't remount the
  // page. From anywhere else, let the Link's ?capability= href navigate
  // normally — the page's existing mount effect picks it up.
  const handleCapabilityClick =
    (capabilityValue: string) => (event: React.MouseEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button === 1
      )
        return;
      if (pathname.startsWith("/home")) {
        event.preventDefault();
        dispatchCapabilitySelect(capabilityValue);
      }
    };
  const lockedTooltip = t("Locked — contact your administrator to get access.");

  const navLocked = (item: QuickActionEntry) =>
    item.requires ? !has(item.requires) : false;

  // Grid order: chat entry points first, then the 5 other capabilities,
  // then the remaining nav destinations, Notebooks, then admin/secondary.
  const tiles: QuickActionEntry[] = [
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

        {/* Header */}
      <Link href="/" className="group flex items-center gap-2 px-1">
        <Image
          src="/logo.png"
          alt="TECKTAL TUTOR"
          width={26}
          height={26}
          className="h-[26px] w-[26px] transition-transform duration-200 group-hover:scale-105"
        />
        <span className="font-serif text-base font-semibold tracking-tight text-[var(--foreground)]">
          TECKTAL TUTOR
        </span>
      </Link>

      {/* Voice orb */}
      <VoiceOrb
        onOpenHistory={() => setHistoryOpen(true)}
        onCloseHistory={() => setHistoryOpen(false)}
      />

      {/* Quick Actions grid */}
      <div>
        <div className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-foreground)]/70">
          {t("Quick Actions")}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {tiles.map((entry, index) => (
            <QuickActionTile
              key={entry.label}
              entry={entry}
              index={index}
              active={pathname.startsWith(entry.href.split("?")[0])}
              locked={navLocked(entry)}
              lockedTooltip={lockedTooltip}
              onClick={
                entry === NAV_TILES[0]
                  ? handleHomeClick
                  : entry.capabilityValue !== undefined
                    ? handleCapabilityClick(entry.capabilityValue)
                    : undefined
              }
            />
          ))}
          <ButtonTile
            index={tiles.length}
            icon={HistoryIcon}
            label="History"
            onClick={() => setHistoryOpen(true)}
          />
          <Link href="/space/questions" className="block">
            <div className="flex flex-col items-center gap-1.5 rounded-xl border border-[var(--border)]/55 bg-[var(--card)] px-2 py-3 text-center transition-all duration-150 hover:border-[var(--primary)]/30 hover:shadow-sm">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full"
                style={{ background: getAccentForIndex(tiles.length + 1).tint }}
              >
                <NotebookText
                  size={17}
                  strokeWidth={1.8}
                  style={{ color: getAccentForIndex(tiles.length + 1).icon }}
                />
              </div>
              <span className="text-[11px] leading-tight text-[var(--foreground)]/85">
                {t("Notebooks")}
              </span>
            </div>
          </Link>
        </div>
      </div>

      {/* RAG Provider */}
      <div className="mt-auto">
        <RagProviderSection />
      </div>

      {/* Footer — Profile / Admin / Logout (carried over from SidebarShell) */}
      <div className="border-t border-[var(--border)]/40 pt-2">
        {renderedFooter}
        <div className="mt-0.5 flex items-center gap-0.5">
          <VersionBadge />
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            title={t("Docs") as string}
            aria-label={t("Docs") as string}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]/55 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--muted-foreground)]"
          >
            <BookText size={13} strokeWidth={1.7} />
          </a>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            title="GitHub"
            aria-label="GitHub"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]/55 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--muted-foreground)]"
          >
            <Github size={13} strokeWidth={1.7} />
          </a>
        </div>
      </div>

    </aside>

      {/* Rendered as a sibling of <aside>, not inside it: the aside now has
          a CSS transform (for the slide-over), which would otherwise turn
          it into a containing block for HistoryFlyout's fixed-position
          PickerShell overlay and break its full-viewport centering. */}
      <HistoryFlyout
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
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
