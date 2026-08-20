"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * One-shot scroll reveal.
 *
 * Default state is VISIBLE ("in"), so content is NEVER stuck hidden — no-JS,
 * reduced-motion, and IntersectionObserver-unsupported all leave it fully shown.
 * After mount, a block still below the fold is switched to "out" (hidden while
 * off-screen, so there's no visible flash) and transitioned "in" exactly ONCE
 * as it enters the viewport. Unlike a raw `animation-timeline: view()` scrub, it
 * does not fade back out when you scroll up past it.
 *
 * The opacity/transform live in globals.css (`[data-reveal]`), keeping this a
 * behaviour-only wrapper.
 */
export function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"in" | "out">("in");

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already in view on load → leave visible, don't animate.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.88) return;

    setState("out");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setState("in");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.06 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} data-reveal={state} className={className}>
      {children}
    </div>
  );
}
