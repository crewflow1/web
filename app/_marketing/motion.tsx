"use client";

/**
 * Motion primitives for the marketing homepage.
 *
 * - Code-split: framer-motion's `domAnimation` feature bundle is loaded
 *   lazily via <LazyMotion>, keeping it out of the app/dashboard bundle.
 * - Reduced-motion safe: respects prefers-reduced-motion everywhere.
 * - Zero layout shift: only opacity / transform / filter are animated.
 * - No-JS safe: reveal wrappers carry `.mkt-reveal`; a <noscript> rule in
 *   the page forces them visible if scripts never run.
 *
 * These are scroll-triggered "rise + settle" reveals (once), not page-load
 * fades — the effect is intentional and used sparingly, not a blanket
 * opacity fade on everything.
 */

import {
  LazyMotion,
  domAnimation,
  m,
  useInView,
  useReducedMotion,
  animate,
} from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";

const EASE = [0.16, 1, 0.3, 1] as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}

/**
 * Lifts + settles its children into view once. Optional focus-blur for a
 * premium "snaps into focus" feel on headers. Renders a plain, fully
 * visible wrapper when the user prefers reduced motion.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 22,
  blur = 0,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  blur?: number;
  as?: "div" | "span" | "li" | "section";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -80px 0px" });
  const cls = ["mkt-reveal", className].filter(Boolean).join(" ");
  const MComp = m[as] as typeof m.div;

  if (reduce) {
    const Plain = as as "div";
    return (
      <Plain ref={ref as never} className={cls}>
        {children}
      </Plain>
    );
  }

  const hidden = {
    opacity: 0,
    y,
    ...(blur ? { filter: `blur(${blur}px)` } : {}),
  };
  const shown = {
    opacity: 1,
    y: 0,
    ...(blur ? { filter: "blur(0px)" } : {}),
  };

  // useInView (standalone IntersectionObserver hook) + the core `animate`
  // prop — does not depend on the whileInView feature being in the bundle,
  // so reveals can never get stuck invisible.
  return (
    <MComp
      ref={ref}
      className={cls}
      initial={hidden}
      animate={inView ? shown : hidden}
      transition={{ duration: 0.62, delay, ease: EASE }}
    >
      {children}
    </MComp>
  );
}

function formatNumber(n: number, decimals: number): string {
  return n.toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Counts a number up from 0 to `value` when it scrolls into view.
 * SSR renders the final value (so no-JS / crawlers see the real figure);
 * the client resets to 0 and animates up.
 */
export function CountUp({
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  duration = 1.4,
  className,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -60px 0px" });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const started = useRef(false);

  useEffect(() => {
    // On the client, reset to 0 once mounted so the count-up has somewhere
    // to travel from (SSR painted the final value for no-JS safety).
    if (!started.current && !reduce && value !== 0) {
      setDisplay(0);
    }
  }, [reduce, value]);

  useEffect(() => {
    if (!inView || started.current) return;
    if (reduce || value === 0) {
      setDisplay(value);
      return;
    }
    started.current = true;
    const controls = animate(0, value, {
      duration,
      ease: EASE,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [inView, value, reduce, duration]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {formatNumber(display, decimals)}
      {suffix}
    </span>
  );
}
