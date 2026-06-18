"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { formatExec, type ExecFormat } from "@/lib/hq/executive";

/**
 * Command Centre animated counter (CEO Directive 004, Phase 2).
 *
 * The ONLY client JS on the dashboard — the card chrome, layout, and
 * entrance animation are all server-rendered / pure CSS. SSR and the first
 * client render both paint a "£0"/"0" baseline (so hydration matches), then
 * the value counts up on mount. Respects prefers-reduced-motion: reduced
 * users jump straight to the final value with no animation.
 *
 * `formatExec` is shared with the server so a mid-animation fractional value
 * and the final figure format identically — one source of truth.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

export function ExecCounter({
  value,
  format,
  durationMs = 1100,
  delayMs = 0,
}: {
  value: number;
  format: ExecFormat;
  durationMs?: number;
  delayMs?: number;
}) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (reduce || value === 0) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration: durationMs / 1000,
      delay: delayMs / 1000,
      ease: EASE,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduce, durationMs, delayMs]);

  return <span className="tabular-nums">{formatExec(display, format)}</span>;
}

/** A small pulsing "live" dot for the header. */
export function LiveDot() {
  return (
    <span className="relative flex h-2 w-2" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
    </span>
  );
}
