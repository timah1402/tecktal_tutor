"use client";

/**
 * Phone-width (below `md`) bottom navigation bar: the destinations people
 * reach for most, in the one-thumb zone. Everything else stays in the
 * sidebar drawer behind the ☰ button. Uses the same tile data as the
 * sidebar (NAV_TILES), so feature-flagged routes disappear here too.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { History as HistoryIcon } from "lucide-react";

import { NAV_TILES, type QuickActionEntry } from "@/components/sidebar/QuickActionsPanel";
import { useUnifiedChatSafe } from "@/context/UnifiedChatContext";
import { useVoiceCall } from "@/context/VoiceCallContext";

const findTile = (href: string) => NAV_TILES.find((tile) => tile.href === href);
const HOME = findTile("/home");
// Shown after History, in this order.
const TRAILING = [findTile("/space"), findTile("/settings")].filter(
  (tile): tile is QuickActionEntry => Boolean(tile),
);

export default function MobileBottomNav() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const chat = useUnifiedChatSafe();
  const call = useVoiceCall();

  // Mirrors the sidebar's Home tile: always reset to a fresh session.
  const handleHomeClick = (event: React.MouseEvent) => {
    event.preventDefault();
    chat?.cancelStreamingTurn();
    chat?.newSession();
    router.push("/home");
  };

  const itemClass = (active: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors ${
      active ? "font-semibold text-[var(--primary)]" : "text-[var(--muted-foreground)]"
    }`;

  return (
    <nav
      aria-label={t("Main navigation")}
      className="fixed inset-x-0 bottom-0 z-30 flex h-14 border-t border-[var(--border)]/60 bg-[var(--background)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      {HOME && (
        <Link href={HOME.href} onClick={handleHomeClick} className={itemClass(pathname.startsWith("/home"))}>
          <HOME.icon size={20} strokeWidth={1.8} />
          {t(HOME.label)}
        </Link>
      )}
      <button type="button" onClick={call.openHistory} className={itemClass(false)}>
        <HistoryIcon size={20} strokeWidth={1.8} />
        {t("History")}
      </button>
      {TRAILING.map((tile) => (
        <Link key={tile.href} href={tile.href} className={itemClass(pathname.startsWith(tile.href))}>
          <tile.icon size={20} strokeWidth={1.8} />
          {t(tile.label)}
        </Link>
      ))}
    </nav>
  );
}
