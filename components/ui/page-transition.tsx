"use client";

import { motion, useReducedMotion } from "framer-motion";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";

/**
 * PageTransition — a gentle fade-and-rise applied to route content.
 *
 * Keyed on the pathname so it replays on every navigation: the new
 * page's content fades up into place rather than snapping in. Enter-only
 * by design — the App Router swaps server components before an exit
 * animation could play, so a keyed entrance is the reliable, jank-free
 * choice. Reduced-motion users get the content with no movement.
 *
 * Wrap a layout's children once:
 *
 *   <PageTransition>{children}</PageTransition>
 */
const EASE = [0.22, 1, 0.36, 1] as const;

export function PageTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const pathname = usePathname();

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      key={pathname}
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
