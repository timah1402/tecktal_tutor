"use client";

import {
  ReactNode,
  useState,
  useCallback,
  useEffect,
  useRef,
  useId,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  description?: string;
  children: ReactNode;
  side?: "right" | "bottom";
}

const GAP = 8;

export function Tooltip({
  label,
  description,
  children,
  side = "right",
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const computePosition = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (side === "right") {
      setPosition({ top: rect.top + rect.height / 2, left: rect.right + GAP });
    } else {
      setPosition({ top: rect.bottom + GAP, left: rect.left + rect.width / 2 });
    }
  }, [side]);

  const showTooltip = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      computePosition();
      setVisible(true);
    }, 300);
  }, [computePosition]);

  const showNow = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    computePosition();
    setVisible(true);
  }, [computePosition]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="dt-tooltip-wrapper"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showNow}
      onBlur={hideTooltip}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {children}
      {visible &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={tooltipId}
            className="dt-tooltip-content"
            data-side={side}
            role="tooltip"
            style={{ top: position.top, left: position.left }}
          >
            <div className="dt-tooltip-label">{label}</div>
            {description && <div className="dt-tooltip-desc">{description}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}
