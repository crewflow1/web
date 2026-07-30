import { describe, it, expect } from "vitest";
import { nextTrapIndex, FOCUSABLE } from "@/components/ui/focus-trap";

/**
 * The focus trap is the one part of components/ui/modal.tsx that is real logic
 * rather than markup, and it is the part every one of the nine hand-rolled
 * dialogs gets wrong by omission: Tab walks straight out of the dialog into the
 * page behind the backdrop. `nextTrapIndex` is that decision as arithmetic over
 * an index, so it can be enumerated exhaustively here with no DOM, no jsdom and
 * no rendering — the browser half (collecting elements, calling `.focus()`) is
 * proved in e2e/staff-invite-dialog-a11y.spec.ts, which drives real keystrokes.
 *
 * The contract, restated so this file can be read on its own:
 *   return  n  → focus the element at index n
 *   return -1  → focus the panel itself (nothing tabbable inside)
 *   return null → do not intervene; the browser's own Tab is correct
 */

describe("nextTrapIndex — the wrap", () => {
  it("sends Tab from the last element back to the first", () => {
    expect(nextTrapIndex(5, 4, false)).toBe(0);
    expect(nextTrapIndex(2, 1, false)).toBe(0);
  });

  it("sends Shift+Tab from the first element to the last", () => {
    expect(nextTrapIndex(5, 0, true)).toBe(4);
    expect(nextTrapIndex(2, 0, true)).toBe(1);
  });

  it("does not intervene in the middle of the ring", () => {
    // Re-implementing ordinary Tab movement is how a trap gets ordinary Tab
    // movement wrong (skipped elements, reversed order inside a fieldset).
    for (let i = 1; i < 4; i++) {
      expect(nextTrapIndex(5, i, false), `forwards from ${i}`).toBeNull();
      expect(nextTrapIndex(5, i, true), `backwards from ${i}`).toBeNull();
    }
  });
});

describe("nextTrapIndex — the edges that actually happen", () => {
  it("pins focus to the panel when nothing inside is tabbable", () => {
    // A dialog rendered with `showClose={false}` and a body of plain text. Left
    // alone, the very first Tab would leave the dialog.
    expect(nextTrapIndex(0, -1, false)).toBe(-1);
    expect(nextTrapIndex(0, -1, true)).toBe(-1);
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
  });

  it("pulls focus back in from outside, entering from the correct end", () => {
    // Reached on a real keystroke: the panel itself is focused when a dialog with
    // no `initialFocus` opens, so activeIndex is -1 and the first Shift+Tab of
    // the dialog's life takes this branch. Without it that keystroke lands in the
    // page behind the backdrop.
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });

  it("treats an out-of-range index as outside rather than trusting it", () => {
    // The element list is recomputed on every keystroke because the dialog's
    // contents change (a field error appears, the submit button disables). A
    // stale index must not resolve to `focusable[7]` of a 3-element list.
    expect(nextTrapIndex(3, 3, false)).toBe(0);
    expect(nextTrapIndex(3, 99, true)).toBe(2);
  });

  it("is a no-op ring for a single tabbable element", () => {
    // One element is simultaneously first and last, so BOTH directions wrap to
    // it. If the first-edge branch ran before the last-edge branch this would
    // return null in one direction and focus would escape.
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
  });

  it("never returns an index outside the ring", () => {
    for (let count = 0; count <= 6; count++) {
      for (let active = -2; active <= count + 1; active++) {
        for (const shift of [false, true]) {
          const out = nextTrapIndex(count, active, shift);
          if (out === null) continue;
          expect(out, `count=${count} active=${active} shift=${shift}`)
            .toBeGreaterThanOrEqual(-1);
          expect(out, `count=${count} active=${active} shift=${shift}`)
            .toBeLessThan(Math.max(count, 1));
        }
      }
    }
  });

  it("only returns -1 when there is genuinely nothing to focus", () => {
    for (let count = 1; count <= 6; count++) {
      for (let active = -2; active <= count + 1; active++) {
        for (const shift of [false, true]) {
          expect(
            nextTrapIndex(count, active, shift),
            `count=${count} active=${active} shift=${shift}`,
          ).not.toBe(-1);
        }
      }
    }
  });
});

describe("FOCUSABLE", () => {
  it("excludes tabindex=-1, which the panel itself uses", () => {
    // The panel carries tabIndex={-1} so it can receive focus without joining
    // the tab ring. If the selector matched it, the panel would be index 0 and
    // every wrap would land on the panel instead of the first field.
    expect(FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE).not.toMatch(/\[tabindex\](?!:not)/);
  });

  it("excludes disabled controls", () => {
    // The shipped dialogs disable their submit button while a server action is in
    // flight. Tab must skip it, and the wrap must land on the button before it.
    for (const tag of ["button", "input", "select", "textarea"]) {
      expect(FOCUSABLE, tag).toContain(`${tag}:not([disabled])`);
    }
  });

  it("is a single valid selector list, not an array left unjoined", () => {
    expect(typeof FOCUSABLE).toBe("string");
    expect(FOCUSABLE.split(",").length).toBeGreaterThan(4);
    expect(FOCUSABLE).not.toContain(",,");
    expect(FOCUSABLE.trim()).toBe(FOCUSABLE);
  });
});
