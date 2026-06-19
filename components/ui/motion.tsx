"use client";

import {
  animate,
  motion,
  useInView,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Animation primitives — the "feels alive" layer of the design system.
 *
 * Built on Framer Motion, GPU-friendly (opacity + transform only), and every
 * one of them respects prefers-reduced-motion: reduced users get the final
 * state instantly with no movement. Entrances fire on scroll-into-view (once),
 * so long pages animate progressively rather than all at once.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Fade + rise into view. The default entrance for any block of content. */
export function FadeIn({
  delay = 0,
  y = 8,
  durationMs = 450,
  className,
  style,
  children,
}: {
  delay?: number;
  y?: number;
  durationMs?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: durationMs / 1000, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

const STAGGER_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

const STAGGER_ITEM: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/** Container that staggers its <StaggerItem> children in as it scrolls in. */
export function Stagger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={STAGGER_CONTAINER}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-40px" }}
    >
      {children}
    </motion.div>
  );
}

/** One staggered child. Must be a direct child of <Stagger>. */
export function StaggerItem({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={STAGGER_ITEM}>
      {children}
    </motion.div>
  );
}

/** A card/element that springs upward on hover. Use when CSS hover isn't enough. */
export function HoverLift({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
    >
      {children}
    </motion.div>
  );
}

/** Scale + fade entrance with a spring — for celebration marks, success icons, badges. */
export function Pop({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, scale: 0.6 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: "-20px" }}
      transition={{ type: "spring", stiffness: 380, damping: 18, delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * AnimatedBar — a progress fill that draws in from empty when it scrolls into
 * view. GPU-friendly: animates `transform: scaleX` (composited), never layout
 * width. Mirrors the static <Meter> a11y contract (role="progressbar" +
 * aria-valuenow) so screen readers get the true value immediately while the
 * fill animates. Reduced-motion users get the final fill with no movement.
 */
export function AnimatedBar({
  value,
  className,
  barClassName,
  durationMs = 900,
  delayMs = 0,
}: {
  /** 0–100. */
  value: number;
  /** Track classes (height, width, rounding, background). */
  className?: string;
  /** Fill classes (background colour). */
  barClassName?: string;
  durationMs?: number;
  delayMs?: number;
}) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(100, value));
  const frac = pct / 100;
  return (
    <div
      className={cn("overflow-hidden", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {reduce ? (
        <div
          className={cn("h-full w-full origin-left", barClassName)}
          style={{ transform: `scaleX(${frac})` }}
        />
      ) : (
        <motion.div
          className={cn("h-full w-full origin-left", barClassName)}
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: frac }}
          viewport={{ once: true, margin: "-20px" }}
          transition={{ duration: durationMs / 1000, ease: EASE, delay: delayMs / 1000 }}
        />
      )}
    </div>
  );
}

export type NumberFormat = "number" | "currency" | "percent" | "compact";

function formatValue(
  n: number,
  format: NumberFormat,
  decimals: number,
  currency: string,
): string {
  switch (format) {
    case "currency":
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
      }).format(n);
    case "percent":
      return `${n.toFixed(decimals)}%`;
    case "compact":
      return new Intl.NumberFormat("en-GB", {
        notation: "compact",
        maximumFractionDigits: decimals === 0 ? 1 : decimals,
      }).format(n);
    default:
      return new Intl.NumberFormat("en-GB", {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
      }).format(n);
  }
}

/**
 * A number that counts up to its value when it scrolls into view. SSR and the
 * first client render both paint the 0 baseline so hydration matches; reduced
 * users see the final value immediately.
 */
export function AnimatedNumber({
  value,
  format = "number",
  decimals = 0,
  currency = "GBP",
  durationMs = 1100,
  delayMs = 0,
  className,
}: {
  value: number;
  format?: NumberFormat;
  decimals?: number;
  currency?: string;
  durationMs?: number;
  delayMs?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20px" });
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!inView || started.current) return;
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
  }, [inView, value, reduce, durationMs, delayMs]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {formatValue(display, format, decimals, currency)}
    </span>
  );
}
