"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * Gate + lazy mount for the hero product demo.
 *
 * The static dashboard screenshot (rendered by the server in page.tsx) is the
 * LCP and the universal fallback. This client island decides — after hydration,
 * once — whether to progressively enhance it with the self-running scene:
 *   - viewport >= 768px (the full multi-panel loop isn't worth it on a phone),
 *   - the user has not asked to reduce motion,
 *   - IntersectionObserver is available.
 * When any gate fails we render nothing and the screenshot stands.
 *
 * The scene chunk is `ssr:false` + dynamic, so it is a separate async chunk
 * that never loads on mobile / reduced-motion and never touches the server-
 * rendered LCP markup.
 */

const HeroScene = dynamic(() => import("./hero-scene").then((m) => m.HeroScene), {
  ssr: false,
});

export function HeroShowcase() {
  const [enhance, setEnhance] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const desktop = window.matchMedia("(min-width: 768px)").matches;
    const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (desktop && motionOk && "IntersectionObserver" in window) setEnhance(true);
  }, []);

  if (!enhance) return null;
  return <HeroScene />;
}

export default HeroShowcase;
