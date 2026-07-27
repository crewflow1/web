"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";

/**
 * The Pulse — small client primitives (Module 1, PR5 / CEO Directive #005).
 *
 * LiveDot (the pinging "live" indicator), CountUp (numbers that animate when
 * facet counts change — "numbers count"), and Skeleton (loading shimmer). All
 * honour prefers-reduced-motion. Kept tiny + local so the feed's heavier files
 * stay focused.
 */

/** A pinging status dot — emerald by default. */
export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span className={`relative flex h-2 w-2 ${className}`}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
    </span>
  );
}

/**
 * A number that count-animates to `value` whenever it changes. SSR-safe (renders
 * the final value first paint), and instant under reduced-motion.
 */
export function CountUp({
  value,
  className = "",
  duration = 0.5,
}: {
  value: number;
  className?: string;
  duration?: number;
}) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (reduce || from === value) {
      setDisplay(value);
      return;
    }
    const controls = animate(from, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, duration, reduce]);

  return <span className={`tabular-nums ${className}`}>{display.toLocaleString("en-GB")}</span>;
}

/** A shimmering loading block. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-slate-800/60 ${className}`}
      aria-hidden="true"
    />
  );
}
