"use client";

import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Modal — the design system's general-purpose dialog.
 *
 * A controlled, portalled dialog that scales into the centre of the
 * viewport over a blurred slate backdrop. It generalises the bespoke
 * modal that lived inside `_confirm-form.tsx` so no surface ever
 * hand-builds dialog chrome again.
 *
 * Premium behaviours, all built in:
 *   - framer-motion scale + fade entrance/exit (AnimatePresence), GPU only
 *   - prefers-reduced-motion → instant, no movement
 *   - Escape closes; backdrop click closes; the panel never does
 *   - body scroll-lock while open
 *   - focus moves into the panel on open and is restored to the trigger
 *     on close, with a lightweight Tab / Shift+Tab focus trap
 *   - role="dialog" + aria-modal + aria-labelledby/-describedby wired up
 *
 * Controlled usage:
 *
 *   const [open, setOpen] = useState(false);
 *   <Button onClick={() => setOpen(true)}>Open</Button>
 *   <Modal open={open} onClose={() => setOpen(false)} title="Title">
 *     …body…
 *     <ModalFooter>
 *       <Button variant="glass" onClick={() => setOpen(false)}>Cancel</Button>
 *       <Button variant="accent">Confirm</Button>
 *     </ModalFooter>
 *   </Modal>
 */

const EASE = [0.22, 1, 0.36, 1] as const;

const SIZE: Record<"sm" | "md" | "lg" | "xl", string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  showClose = true,
  closeOnBackdrop = true,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  showClose?: boolean;
  closeOnBackdrop?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  const labelId = useId();
  const descId = useId();

  useEffect(() => setMounted(true), []);

  // Remember the trigger so focus can be restored when the dialog closes.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
    } else if (restoreRef.current) {
      restoreRef.current.focus?.();
      restoreRef.current = null;
    }
  }, [open]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Move focus into the panel once it mounts.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center px-4 py-6 sm:items-center"
          onKeyDown={onKeyDown}
        >
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "linear" }}
            onClick={closeOnBackdrop ? onClose : undefined}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? labelId : undefined}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={cn(
              "relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl outline-none",
              SIZE[size],
            )}
            initial={
              reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }
            }
            animate={
              reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
            }
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            {title || showClose ? (
              <div className="flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-900/60 px-5 py-3.5">
                <div className="min-w-0">
                  {title ? (
                    <h2
                      id={labelId}
                      className="truncate text-base font-semibold text-white"
                    >
                      {title}
                    </h2>
                  ) : null}
                  {description ? (
                    <p id={descId} className="mt-0.5 text-xs text-slate-400">
                      {description}
                    </p>
                  ) : null}
                </div>
                {showClose ? (
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close dialog"
                    className="-mr-1.5 -mt-1 shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="px-5 py-4 text-sm text-slate-300">{children}</div>

            {footer ? (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 bg-slate-900/40 px-5 py-3.5">
                {footer}
              </div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** Convenience row for right-aligned modal actions; spreads into the `footer` slot. */
export function ModalFooter({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
