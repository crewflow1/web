"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Tooltip — a small dark label that fades in on hover or keyboard focus.
 *
 * Wraps its trigger in an inline anchor and positions the bubble with
 * pure CSS relative to that anchor (no measuring, no portal), so it is
 * cheap and never causes layout shift. Shows after a short delay,
 * hides instantly; respects prefers-reduced-motion; and is wired to the
 * trigger via aria-describedby so screen-reader users get the same hint.
 *
 *   <Tooltip content="Recompute now" side="top">
 *     <Button size="sm" variant="glass">↻</Button>
 *   </Tooltip>
 */

type Side = "top" | "bottom" | "left" | "right";

const POSITION: Record<Side, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  left: "right-full top-1/2 mr-2 -translate-y-1/2",
  right: "left-full top-1/2 ml-2 -translate-y-1/2",
};

const MOTION_OFFSET: Record<Side, { x?: number; y?: number }> = {
  top: { y: 4 },
  bottom: { y: -4 },
  left: { x: 4 },
  right: { x: -4 },
};

export function Tooltip({
  content,
  side = "top",
  delayMs = 300,
  className,
  children,
}: {
  content: ReactNode;
  side?: Side;
  delayMs?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  const offset = MOTION_OFFSET[side];

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      <AnimatePresence>
        {open ? (
          <motion.span
            role="tooltip"
            id={id}
            className={cn(
              "pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-slate-100 shadow-lg ring-1 ring-inset ring-slate-700",
              POSITION[side],
              className,
            )}
            initial={
              reduce
                ? { opacity: 0 }
                : { opacity: 0, x: offset.x ?? 0, y: offset.y ?? 0 }
            }
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            {content}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
