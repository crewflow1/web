/**
 * The focus trap, as arithmetic.
 *
 * A modal's Tab handling is the one part of a dialog that is real logic rather
 * than markup, and it is the part every hand-rolled dialog in this repo gets
 * wrong by omission — all nine let Tab walk straight out of the dialog into the
 * page behind the backdrop. Keeping the decision here, as a pure function over
 * an index, means it can be tested exhaustively in the fast unit tier with no
 * DOM, no jsdom and no rendering: `__tests__/ui/focus-trap.test.ts` enumerates
 * every (count, activeIndex, shiftKey) triple that matters.
 *
 * ./modal.tsx owns the DOM half — collecting the focusable elements and calling
 * `.focus()` — and nothing else.
 */

/**
 * What counts as focusable inside a dialog.
 *
 * `[tabindex="-1"]` is excluded because it is programmatically focusable but not
 * tabbable, and the panel itself carries `tabIndex={-1}` precisely so it can
 * receive focus without joining the tab ring. `:not([disabled])` matters on the
 * submit button, which the shipped dialogs disable while a server action is in
 * flight — Tab must skip it and wrap at the button before it.
 */
export const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab should send focus next, or `null` to let the browser do its normal
 * thing.
 *
 * @param count       how many tabbable elements the panel currently holds
 * @param activeIndex index of the focused element within them, or -1 if focus is
 *                    outside the panel (the panel itself, or something the
 *                    browser handed focus to behind the backdrop)
 * @param shiftKey    Shift+Tab, i.e. backwards
 * @returns the index to focus, `-1` for "focus the panel itself", or `null` for
 *          "do not intervene"
 *
 * The three interventions, and why each is needed:
 *
 *   empty panel        → -1. With nothing tabbable, Tab would leave immediately.
 *                        Focus is pinned to the panel instead of escaping.
 *   at the far edge    → wrap. Forwards from the last element goes to the first;
 *                        backwards from the first goes to the last. This is the
 *                        trap.
 *   focus outside      → pull it back in, to the last element on Shift+Tab and
 *                        the first otherwise, so the ring is entered from the
 *                        correct end. Reachable in practice: the panel itself is
 *                        focused on open (index -1), so the very first Shift+Tab
 *                        of a dialog's life takes this branch, and without it
 *                        that keystroke lands in the page behind the backdrop.
 *
 * Everything else returns `null` — a trap that re-implements ordinary Tab
 * movement is a trap that gets ordinary Tab movement wrong.
 */
export function nextTrapIndex(
  count: number,
  activeIndex: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return -1;
  if (activeIndex < 0 || activeIndex >= count) return shiftKey ? count - 1 : 0;
  if (shiftKey && activeIndex === 0) return count - 1;
  if (!shiftKey && activeIndex === count - 1) return 0;
  return null;
}
