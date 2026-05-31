"use client";

import type { InputHTMLAttributes } from "react";

/**
 * A `type="number"` input that selects its contents on focus, so a
 * prefilled value (here, the AI/OCR-extracted expense amount) is replaced
 * on the first keystroke instead of being appended to — the H1 append
 * defect (e.g. "21600.00" + typing → "21600.0010000").
 *
 * Extracted into this tiny client component because the parent
 * expense-draft page is a Server Component and therefore cannot attach an
 * `onFocus` handler to its own elements. All other props (name, defaultValue,
 * disabled, className, step, min, required, …) pass straight through.
 */
export function AmountInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onFocus">,
) {
  return (
    <input
      {...props}
      type="number"
      onFocus={(e) => e.currentTarget.select()}
    />
  );
}
