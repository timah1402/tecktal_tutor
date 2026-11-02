"use client";

/**
 * Shrinks its children uniformly (CSS transform) so they always fit the
 * space this wrapper is given, instead of reflowing them. Used by the /home
 * empty-state hero: on a short or narrow window the greeting, voice button
 * and tiles keep exactly the same look, just smaller, rather than sliding
 * under the composer.
 *
 * The children are laid out at their natural size (`w-max`), measured, and
 * scaled by min(1, availableW / naturalW, availableH / naturalH). A sized
 * wrapper reserves the *scaled* box so centering and scrolling see the real
 * footprint. Below `minScale` it stops shrinking and the parent's scroll
 * takes over.
 */

import { useLayoutEffect, useRef, useState } from "react";

export function ScaleToFit({
  children,
  minScale = 0.5,
  className = "",
}: {
  children: React.ReactNode;
  minScale?: number;
  className?: string;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const update = () => {
      // offsetWidth/Height ignore transforms, so this is always the natural size.
      const width = inner.offsetWidth;
      const height = inner.offsetHeight;
      if (!width || !height) return;
      const scale = Math.max(
        minScale,
        Math.min(1, outer.clientWidth / width, outer.clientHeight / height),
      );
      setFit((prev) =>
        prev && prev.scale === scale && prev.width === width && prev.height === height
          ? prev
          : { scale, width, height },
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [minScale]);

  return (
    <div ref={outerRef} className={`flex w-full min-h-0 flex-1 justify-center ${className}`}>
      <div
        className="shrink-0"
        style={fit ? { width: fit.width * fit.scale, height: fit.height * fit.scale } : undefined}
      >
        <div
          ref={innerRef}
          className="w-max"
          style={
            fit && fit.scale < 1
              ? { transform: `scale(${fit.scale})`, transformOrigin: "top left" }
              : undefined
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
