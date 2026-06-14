"use client";

/**
 * Motion primitives for the marketing homepage.
 *
 * - Code-split: framer-motion's `domAnimation` feature bundle is loaded
 *   lazily via <LazyMotion>, keeping it out of the app/dashboard bundle.
 * - Reduced-motion safe: respects prefers-reduced-motion everywhere.
 * - Zero layout shift: only opacity/transform are animated.
 * - No-JS safe: reveal wrappers carry `.mkt-reveal`; a <noscript> rule in
 *   the page forces them visible if scripts never run.
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
 * Fades + lifts its children into view once. Renders a plain wrapper when
 * the user prefers reduced motion.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 24,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, margin: "0px 0px -80px 0px" });
  const cls = ["mkt-reveal", className].filter(Boolean).join(" ");

  if (reduce) {
    return (
      <div ref={ref} className={cls}>
        {children}
      </div>
    );
  }

  // useInView (standalone IntersectionObserver hook) + the core `animate`
  // prop — does not depend on the whileInView feature being in the bundle,
  // so reveals can never get stuck invisible.
  return (
    <m.div
      ref={ref}
      className={cls}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </m.div>
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
 * SSR renders 0 (decorative dashboard figure); animates on the client.
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
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce || value === 0) {
      setDisplay(value);
      return;
    }
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
