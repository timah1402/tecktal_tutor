"use client";

import { useSyncExternalStore } from "react";

// Matches Tailwind's `max-md` (below the 768px `md` breakpoint) — the same
// cut-off where the sidebar turns into a drawer.
const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** One-off check for effects/handlers (where the hook's hydration-time
 * `false` would be stale). */
export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

/** True on phone-width viewports. Always false during SSR/hydration, then
 * settles to the real value on the client. For layouts that can't just be
 * CSS-toggled (e.g. two trees sharing Framer Motion layoutIds). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
