"use client";

import { useEffect } from "react";

// How much the visual viewport has to shrink before we treat it as the
// on-screen keyboard rather than a collapsing browser toolbar.
const KEYBOARD_THRESHOLD = 150;

/**
 * Keeps the app shell sized to the part of the screen that is actually
 * visible. On mobile Safari the keyboard shrinks only the *visual* viewport:
 * the page keeps its full height and Safari scrolls the whole document to
 * reveal the focused input, flashing a page scrollbar and pushing the header
 * off-screen. Here we publish the visible height as `--app-height` (the shell
 * uses it instead of 100dvh), pin the document scroll at the top, and flag
 * `data-keyboard="open"` on <html> so the bottom nav can step aside.
 *
 * Pinch-zoom also shrinks the visual viewport, so it is ignored while zoomed.
 */
export function useKeyboardAwareViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    const update = () => {
      if (vv.scale > 1.01) return;
      const keyboardOpen = window.innerHeight - vv.height > KEYBOARD_THRESHOLD;
      if (keyboardOpen) {
        root.style.setProperty("--app-height", `${vv.height}px`);
        root.dataset.keyboard = "open";
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--app-height");
        delete root.dataset.keyboard;
      }
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--app-height");
      delete root.dataset.keyboard;
    };
  }, []);
}
