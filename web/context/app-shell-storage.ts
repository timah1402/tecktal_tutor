"use client";

export type AppLanguage = "en" | "zh";

export const ACTIVE_SESSION_STORAGE_KEY = "deeptutor.activeSessionId.tab";
export const LANGUAGE_STORAGE_KEY = "deeptutor-language";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "deeptutor.sidebarCollapsed";
export const CHAT_RESPONSE_TIMEOUT_STORAGE_KEY =
  "deeptutor.chatResponseTimeout";

// Mirror of the per-user ``chat_response_timeout`` UI preference. Cached in
// localStorage so the chat watchdog (a separate provider from Settings) can
// read it synchronously without its own fetch. Kept in sync on settings load.
export const DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS = 180;
export const MIN_CHAT_RESPONSE_TIMEOUT_SECONDS = 30;
export const MAX_CHAT_RESPONSE_TIMEOUT_SECONDS = 1800;

export function clampChatResponseTimeout(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  return Math.min(
    MAX_CHAT_RESPONSE_TIMEOUT_SECONDS,
    Math.max(MIN_CHAT_RESPONSE_TIMEOUT_SECONDS, Math.round(seconds)),
  );
}

export function readStoredChatResponseTimeout(): number {
  if (typeof window === "undefined")
    return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  try {
    const raw = window.localStorage.getItem(CHAT_RESPONSE_TIMEOUT_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? clampChatResponseTimeout(parsed)
      : DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  }
}

export function writeStoredChatResponseTimeout(seconds: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CHAT_RESPONSE_TIMEOUT_STORAGE_KEY,
      String(clampChatResponseTimeout(seconds)),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export const ACTIVE_SESSION_EVENT = "deeptutor:active-session";
export const LANGUAGE_EVENT = "deeptutor:language";
export const SIDEBAR_COLLAPSED_EVENT = "deeptutor:sidebar-collapsed";
// Fired by QuickActionsPanel when a capability tile is clicked while already
// on /home, so the composer can switch modes in place instead of relying on
// the page's mount-only ?capability= query-param effect (which won't
// re-fire on a query-only navigation). Transient signal, not persisted.
export const CAPABILITY_SELECT_EVENT = "deeptutor:capability-select";

export function dispatchCapabilitySelect(capability: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CAPABILITY_SELECT_EVENT, { detail: { capability } }),
  );
}

// Fired by VoiceCallContext's show_more / show_less tool handlers so
// HeroQuickActions can expand/collapse without lifting its local `expanded`
// state up through the provider tree. Transient signal, not persisted.
export const EXPAND_DOCK_EVENT = "deeptutor:expand-dock";

export function dispatchExpandDock(expanded: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(EXPAND_DOCK_EVENT, { detail: { expanded } }),
  );
}

// Fired by QuickActionsPanel's voice orb (its own independent
// useVoiceRecorder instance — separate from the composer's mic button) once
// a transcript comes back, so /home can drop it into the composer the same
// way other "inject text" features already do. Transient signal, not
// persisted.
export const VOICE_TRANSCRIPT_EVENT = "deeptutor:voice-transcript";

export function dispatchVoiceTranscript(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(VOICE_TRANSCRIPT_EVENT, { detail: { text } }),
  );
}

export function normalizeLanguage(
  value: string | null | undefined,
): AppLanguage {
  return value === "zh" ? "zh" : "en";
}

export function readStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  try {
    return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "en";
  }
}

export function writeStoredLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    window.dispatchEvent(
      new CustomEvent(LANGUAGE_EVENT, {
        detail: { language },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function readStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredActiveSessionId(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionId) {
      window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(ACTIVE_SESSION_EVENT, {
        detail: { sessionId },
      }),
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

export function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_COLLAPSED_EVENT, {
        detail: { collapsed },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}
