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

// Fired by VoiceCallContext's save_quiz_to_notebook / download_quiz / quiz_*
// tool handlers. The most-recently-mounted QuizViewer (there's normally
// exactly one visible) is the only listener that acts on it — see
// QuizViewer's own "active instance" tracking. No-op (silently ignored) when
// no quiz is open.
export const QUIZ_SESSION_ACTION_EVENT = "deeptutor:quiz-session-action";
export type QuizSessionAction =
  | "save"
  | "download"
  | "answer"
  | "navigate"
  | "submit"
  | "reset"
  | "judge"
  | "bookmark"
  | "add_to_category"
  | "set_answer_view"
  | "toggle_review_collapse"
  | "open_followup";

export interface QuizSessionActionPayload {
  option?: string;
  text?: string;
  direction?: "previous" | "next";
  /** 1-based question number, as the user said it. */
  index?: number;
  categoryName?: string;
  /** set_answer_view only. */
  view?: "reference" | "judgment";
  /** toggle_review_collapse only — omitted means "toggle current state". */
  collapsed?: boolean;
}

export function dispatchQuizSessionAction(
  action: QuizSessionAction,
  payload?: QuizSessionActionPayload,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(QUIZ_SESSION_ACTION_EVENT, { detail: { action, payload } }),
  );
}

// Fired by VoiceCallContext's open_save_to_notebook tool handler so the home
// page can open its existing "save chat to notebook" modal. No-op if the
// page isn't mounted. Transient signal, not persisted.
export const OPEN_SAVE_TO_NOTEBOOK_EVENT = "deeptutor:open-save-to-notebook";

export function dispatchOpenSaveToNotebook(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_SAVE_TO_NOTEBOOK_EVENT));
}

// Fired by VoiceCallContext's toggle_viewer_panel tool handler. `open`
// omitted means "toggle current state". Transient signal, not persisted.
export const VIEWER_PANEL_EVENT = "deeptutor:viewer-panel";

export function dispatchViewerPanel(open?: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(VIEWER_PANEL_EVENT, { detail: { open } }),
  );
}

// Fired by VoiceCallContext's research_* tool handlers. Only the
// most-recently-mounted ResearchOutlineEditor reacts — same "active
// instance" pattern as quiz. No-op when no outline is open for review.
export const RESEARCH_OUTLINE_ACTION_EVENT = "deeptutor:research-outline-action";
export type ResearchOutlineAction =
  | "confirm"
  | "remove_item"
  | "add_item"
  | "edit_item"
  | "toggle_collapse";

export interface ResearchOutlineActionPayload {
  /** 1-based position, as the user said it. */
  index?: number;
  title?: string;
  overview?: string;
  /** toggle_collapse only — omitted means "toggle current state". */
  collapsed?: boolean;
}

export function dispatchResearchOutlineAction(
  action: ResearchOutlineAction,
  payload?: ResearchOutlineActionPayload,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(RESEARCH_OUTLINE_ACTION_EVENT, {
      detail: { action, payload },
    }),
  );
}

// Fired by VoiceCallContext's visualize_* tool handlers. Only the
// most-recently-mounted VisualizationViewer reacts — same "active instance"
// pattern as quiz. No-op when no visualization is open.
export const VISUALIZE_ACTION_EVENT = "deeptutor:visualize-action";
export type VisualizeAction = "fullscreen" | "show_code" | "copy_code";

export interface VisualizeActionPayload {
  enter?: boolean;
  show?: boolean;
}

export function dispatchVisualizeAction(
  action: VisualizeAction,
  payload?: VisualizeActionPayload,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(VISUALIZE_ACTION_EVENT, { detail: { action, payload } }),
  );
}

// Fired by VoiceCallContext's mastery_path_redo / mastery_path_delete tool
// handlers, after the API mutation already succeeded, so an already-open
// learning-space page re-fetches its list/detail. Best-effort — a no-op if
// that page isn't mounted, since the mutation itself doesn't depend on it.
export const MASTERY_PATH_REFRESH_EVENT = "deeptutor:mastery-path-refresh";

export function dispatchMasteryPathRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MASTERY_PATH_REFRESH_EVENT));
}

// Fired BY QuizViewer/ResearchOutlineEditor/VisualizationViewer (the
// reverse direction from the events above) whenever one becomes the active
// instance or its visible state changes, so VoiceCallContext can ground the
// realtime model in what's actually on screen — otherwise voice has no way
// to know a quiz/outline/visualization is currently open at all, and
// commands like "answer B" or "complete the quiz" get treated as a request
// to start something new instead of acting on what's visible. Carries a
// plain-language summary already worded for injection into the model's
// context, not structured data — keeps the wording/grounding logic in one
// place (the component itself, which knows its own state) rather than
// duplicated in VoiceCallContext.
export const UI_CONTEXT_EVENT = "deeptutor:ui-context";

export function dispatchUiContext(summary: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(UI_CONTEXT_EVENT, { detail: { summary } }),
  );
}

// Fired by VoiceCallContext's open_upload tool handler so the composer's
// existing file input (ChatComposer's `handlePickFiles`) opens the OS file
// picker exactly as if the user had clicked the attach/paperclip button
// themselves. No-op if no composer is mounted to hear it. Transient signal,
// not persisted.
export const OPEN_FILE_PICKER_EVENT = "deeptutor:open-file-picker";

export function dispatchOpenFilePicker(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_FILE_PICKER_EVENT));
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
