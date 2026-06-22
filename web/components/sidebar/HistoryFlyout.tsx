"use client";

/**
 * HistoryFlyout — Step 6 of the navigation redesign.
 *
 * Opens the existing SessionList (same component SidebarShell used to embed
 * inline) inside a PickerShell modal, triggered by the QuickActionsPanel's
 * History tile. Reuses PickerShell/PickerHeader for the open/close/Escape/
 * focus-trap contract instead of hand-rolling another overlay, and passes
 * through the exact same session props/handlers the panel already receives
 * — no new data-fetching.
 */

import { History as HistoryIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import PickerShell from "@/components/common/PickerShell";
import PickerHeader from "@/components/common/PickerHeader";
import SessionList from "@/components/SessionList";
import type { SessionSummary } from "@/lib/session-api";

interface HistoryFlyoutProps {
  open: boolean;
  onClose: () => void;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  loadingSessions: boolean;
  onSelectSession: (sessionId: string) => void | Promise<void>;
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
}

export default function HistoryFlyout({
  open,
  onClose,
  sessions,
  activeSessionId,
  loadingSessions,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: HistoryFlyoutProps) {
  const { t } = useTranslation();

  const handleSelect = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  return (
    <PickerShell
      open={open}
      onClose={onClose}
      labelledBy="history-flyout-title"
      className="p-4 backdrop-blur-md"
      backdropClass="bg-[var(--background)]/65"
    >
      <div className="surface-card flex h-[70vh] max-h-[560px] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] text-[var(--card-foreground)] shadow-[0_22px_70px_rgba(0,0,0,0.18)]">
        <PickerHeader
          icon={HistoryIcon}
          titleId="history-flyout-title"
          title={t("History")}
          subtitle={t("Your recent conversations.")}
          onClose={onClose}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loadingSessions}
            onSelect={handleSelect}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
          />
        </div>
      </div>
    </PickerShell>
  );
}
