"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { nextTrapIndex, FOCUSABLE } from "./focus-trap";

/**
 * Modal — the product's dialog, with the keyboard contract built in.
 *
 * Nine files hand-roll a dialog (app/(app)/staff/_invite-modal, the three
 * jobs/[id]/blueprints viewers, app/admin/{_confirm-form,_nav-mobile},
 * app/admin/customers/[id]/_impersonate, app/admin/pulse/_detail-drawer,
 * app/(public)/_book-demo-modal). None of them traps focus. None restores focus
 * to the trigger. None locks body scroll. Most put `role="dialog"` on the
 * full-viewport backdrop, so the element that dismisses the dialog on click is
 * *inside* the dialog. That is the duplication worth removing: not the box, the
 * behaviour.
 *
 * NO ANIMATION LIBRARY — the entrance is CSS. See the decision note below.
 *
 * GEOMETRY IS THE DOMINANT SHIPPED IDIOM, VERBATIM, so adoption is a
 * pixel-for-pixel swap rather than a restyle:
 *   overlay `fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50
 *            px-4 py-6 sm:items-center`      3 of the 9, and 5 of 9 for the panel
 *   panel   `rounded-2xl border border-slate-200 bg-white shadow-2xl`
 *   close   `absolute right-3 top-3 rounded-md p-1.5 text-slate-500
 *            hover:bg-slate-100 hover:text-slate-700`   both dialogs that have one
 * The stranded branch's version painted a separate `bg-slate-950/70
 * backdrop-blur-sm` layer and a slate-50 header band — a different dialog. Its
 * `dark:` halves are dropped: `.dark` is applied nowhere in app/.
 *
 * PORTALLED, unlike all nine. This is not tidiness. Rendered in place, the
 * overlay is a DOM child of the page container, so `space-y-6` on that container
 * lands `margin-top: 24px` on a `position: fixed` element: measured on
 * origin/main, /staff's dialog backdrop starts at y=24 and the top 24px of the
 * viewport is left undimmed. A portal to `document.body` is the only fix that
 * cannot be reintroduced by an unrelated edit to a parent's spacing.
 *
 * SCROLLABLE PANEL. `max-h-full overflow-y-auto` is a no-op whenever the content
 * fits: at 1280px /staff's panel is 628px in an 852px window, and its measured
 * box is unchanged at 512x628 (the max-height is never reached, so `auto` shows no
 * scrollbar; corner clipping survives because any non-visible overflow clips). It
 * is load-bearing at 375px, where the same panel is 911px tall in a 764px window:
 * on origin/main its top sat at y=-123, putting the heading and the close button
 * off-screen inside a `position: fixed` overlay that cannot scroll. It is now
 * clamped to 764px at y=24 and scrolls internally, so both ends are reachable.
 *
 * The ONE position change either width, and it is the portal's doing rather than
 * this: with the overlay's stray 24px top margin gone, `sm:items-center` centres
 * the panel in the real viewport instead of in a container pushed 24px down and
 * cropped 24px short. Every element inside the panel keeps its exact x, width and
 * height; the whole panel moves up 12px at 1280px and down 147px at 375px.
 *
 * ACCESSIBLE NAME IS REQUIRED, not optional: `labelledBy` must be the id of a
 * visible heading inside the dialog. A dialog with no name is an axe violation
 * and a screen-reader dead end, and making the prop optional is how that
 * happens. `role="dialog"` + `aria-modal` sit on the PANEL, never the backdrop.
 *
 * WHY NOT NATIVE `<dialog>`. It was assessed and rejected on a specific,
 * checkable conflict, not on taste. `showModal()` promotes the element to the
 * TOP LAYER, which sits above the whole z-index stack — and this app has two
 * surfaces that deliberately sit above z-50 at `z-[60]`:
 * app/(app)/_components/sw-register.tsx (the "a new version of CrewFlow is
 * available" banner, `role="status" aria-live="polite"`, product tier) and
 * app/_components/cookie-consent.tsx. A native modal would paint over both, and
 * z-index cannot correct it because the top layer is outside the z-index model.
 * The migration is not incremental either: the first of the nine dialogs to move
 * would start covering that banner, so the layering has to be settled for all of
 * them at once. Two smaller costs: `::backdrop` has no Tailwind v3 variant, so
 * the dim would move into app/globals.css as raw CSS — taking colour out of the
 * class string, which is the one thing ./tokens.ts exists to prevent; and
 * backdrop-click-to-close still needs a handler, because `closedby` is too new to
 * rely on. What it WOULD buy is real (focus trap, Escape and inert-behind for
 * free), and nothing here forecloses it: this component's props — open, onClose,
 * labelledBy, size, showClose, initialFocus — describe a dialog, never a portal
 * or a `<div>`, so switching is a change to this one file.
 *
 * Server-safe barrel note: this is the one client module in components/ui.
 * `components/ui/index.ts` deliberately does NOT re-export it — see the comment
 * there.
 *
 *   const [open, setOpen] = useState(false);
 *   const firstField = useRef<HTMLInputElement>(null);
 *   <Modal open={open} onClose={() => setOpen(false)}
 *          labelledBy="thing-title" size="lg" initialFocus={firstField}>
 *     <div className="px-6 py-6 sm:px-8 sm:py-8">
 *       <h2 id="thing-title">…</h2>
 *       <input ref={firstField} />
 *     </div>
 *   </Modal>
 */

/**
 * THE ENTRANCE IS CSS, NOT framer-motion. framer-motion is a dependency
 * (^12.40.0) and the stranded branch's modal was built on it, but:
 *
 *   1. It has ZERO consumers in app/(app) — its six call sites are
 *      app/_marketing/motion.tsx and five files under app/admin. The product
 *      tier has never taken on a client animation library.
 *   2. EIGHT of the nine hand-rolled dialogs ship no entrance at all: no
 *      framer-motion, no keyframes, no transition on the panel. The ninth,
 *      app/admin/pulse/_detail-drawer.tsx, is an admin drawer inside the one
 *      directory that already owned framer-motion.
 *   3. `tailwindcss-animate` is already installed and already registered in
 *      tailwind.config.ts, so `animate-in fade-in-0 zoom-in-95` delivers the
 *      same 150ms scale-and-fade for zero additional client JS and zero new
 *      dependencies.
 *   4. `motion-reduce:animate-none` honours prefers-reduced-motion in CSS.
 *      framer-motion's equivalent, `useReducedMotion()`, is a hook — i.e. more
 *      client JS to express the same intent declaratively.
 *   5. THE NUMBER. Both were built. First Load JS for /staff, the adoption
 *      surface:
 *
 *        origin/main, hand-rolled dialog          188 kB
 *        this modal, CSS entrance                 189 kB   (+1 kB)
 *        the same modal, framer-motion entrance   236 kB   (+48 kB)
 *
 *      47 kB of client JavaScript for a visually equivalent 150ms fade —
 *      a quarter again on the route's first load, to add an entrance that eight
 *      of the nine dialogs it replaces do not have.
 *
 * The animation must also stay FINITE and UNFILLED. `e2e/_settle.ts` gates every
 * axe scan on `document.getAnimations().length === 0`; `animate-in` sets only
 * `animation-name`, so the animation stops being in-effect when it ends and
 * drains from that list. Adding `fill-mode-both` here would hang the a11y gate
 * on every scanned route, forever.
 */
const OVERLAY =
  "fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 px-4 py-6 " +
  "animate-in fade-in-0 duration-150 motion-reduce:animate-none sm:items-center";

const PANEL =
  "relative max-h-full w-full overflow-y-auto rounded-2xl border border-slate-200 " +
  "bg-white shadow-2xl outline-none animate-in zoom-in-95 duration-150 " +
  "motion-reduce:animate-none";

/**
 * Only the two widths the nine dialogs actually use: `max-w-md` (4 of them) and
 * `max-w-lg` (2). The rest are full-screen viewers, which are not this
 * primitive. A size scale nobody asks for is a scale nobody keeps correct.
 *
 * Composed by plain concatenation, deliberately NOT through `cn`. `cn` is
 * tailwind-merge, which is free in a server primitive (Badge, StatTile, Table all
 * use it — it runs at render time on the server) and costs 8 kB of first-load JS
 * in a client one. Measured: importing it here put /staff at 196 kB against
 * 188 kB on origin/main, and the whole 8 kB was tailwind-merge's conflict tables.
 * There is nothing to merge — `PANEL` sets `w-full`, never `max-w-*` — so 8 kB
 * bought a string concatenation. This is also why Modal has no `className` prop:
 * an override slot is what would make conflict resolution necessary.
 */
const SIZE = { md: "max-w-md", lg: "max-w-lg" } as const;

export type ModalSize = keyof typeof SIZE;

export function Modal({
  open,
  onClose,
  labelledBy,
  size = "md",
  showClose = true,
  initialFocus,
  children,
}: {
  open: boolean;
  /** Called for Escape, the backdrop, and the close button. */
  onClose: () => void;
  /** Id of the visible heading inside the dialog. Required — see above. */
  labelledBy: string;
  size?: ModalSize;
  /** The corner ✕. Off for dialogs whose only exits are their own buttons. */
  showClose?: boolean;
  /**
   * Where focus lands on open — normally the first field, so a form dialog does
   * not open with focus parked on its close button. Without it focus goes to the
   * first focusable element, and to the panel itself if there is none.
   */
  initialFocus?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  // A portal needs document.body, which does not exist during SSR.
  useEffect(() => setMounted(true), []);

  /**
   * Focus restore. The trigger is captured on the render that opens the dialog
   * and re-focused when it closes — without this, closing a dialog drops the
   * caret at the top of the document and a keyboard user has to Tab back to
   * where they were.
   */
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    const trigger = restoreRef.current;
    restoreRef.current = null;
    // Only restore if the trigger is still in the document; a dialog that
    // removes its own trigger (a row action on a deleted row) must not throw.
    if (trigger?.isConnected) trigger.focus();
  }, [open]);

  /** Body scroll lock. The page behind a modal must not scroll under it. */
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  /**
   * Focus in. One frame after the panel commits, so the portal's children exist
   * and `initialFocus` has been attached.
   */
  useEffect(() => {
    if (!open || !mounted) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        initialFocus?.current ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, mounted, initialFocus]);

  /**
   * Escape and the Tab trap. Bound to the overlay rather than `window`: focus
   * starts inside and is kept inside, so every keystroke bubbles here, and a
   * nested dialog's Escape can no longer close its parent as well (which is what
   * the shipped `window.addEventListener("keydown")` versions do). It also
   * leaves a native `<select>` popup's own Escape alone.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const target = nextTrapIndex(
        focusable.length,
        focusable.indexOf(document.activeElement as HTMLElement),
        event.shiftKey,
      );
      if (target === null) return;
      event.preventDefault();
      (focusable[target] ?? panel).focus();
    },
    [onClose],
  );

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={OVERLAY}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`${PANEL} ${SIZE[size]}`}
      >
        {showClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
