"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

/**
 * Numeric input that behaves like a CEO would expect a Money/Qty field
 * to behave:
 *
 *   • Allows the field to be empty (no forced "0").
 *   • Allows decimals (e.g. 0.5, 1.25, 100).
 *   • Never displays a phantom leading zero — typing "5" into an
 *     empty field shows "5", not "05". The previous `<input
 *     type="number" value={li.qty}/>` pattern surfaced "0" when the
 *     state was 0 and produced "05" UX as the user typed.
 *   • Permits in-progress strings like "0." while the operator is
 *     still typing — only commits to the parent when the value is a
 *     valid number.
 *   • Clamps to [min, max] on commit.
 *   • Refuses negative input when `min >= 0`.
 *
 * Contract with parent:
 *   - value: the canonical number (parent owns state).
 *   - onChange: called with the parsed number, OR null when the field
 *     is empty. Parents typically map null→0 in submit serialisers,
 *     but the validation layer is expected to reject 0 where it
 *     matters (zod `.positive()` etc.).
 *
 * Implementation notes:
 *   - Internally stores a string `display` so partial input ("0.",
 *     ".5", "") doesn't get clobbered by the parent's number value.
 *   - When the parent value changes externally (e.g. echoed back from
 *     a server action) the display syncs only if it doesn't already
 *     parse to that number — avoids stomping over the operator's
 *     in-flight edit.
 */
export function NumericInput({
  value,
  onChange,
  min,
  max,
  allowDecimal = true,
  allowEmpty = true,
  onFocus,
  ...rest
}: {
  value: number;
  onChange: (next: number | null) => void;
  min?: number;
  max?: number;
  allowDecimal?: boolean;
  allowEmpty?: boolean;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
>) {
  const initial = stringifyValue(value, allowEmpty);
  const [display, setDisplay] = useState<string>(initial);
  const lastEmittedRef = useRef<number | null>(value);

  // Reconcile when the parent's value diverges from what we'd parse
  // out of `display`. Avoids erasing in-progress edits.
  useEffect(() => {
    const parsed = parseDisplay(display, allowDecimal);
    if (parsed === value) return;
    // If the user just emitted this exact value via onChange, don't
    // re-sync — it would cancel "0." or "" mid-edit.
    if (lastEmittedRef.current === value) return;
    setDisplay(stringifyValue(value, allowEmpty));
  }, [value, allowDecimal, allowEmpty, display]);

  return (
    <input
      {...rest}
      type="text"
      inputMode={allowDecimal ? "decimal" : "numeric"}
      autoComplete="off"
      value={display}
      onFocus={(e) => {
        // Select-on-focus: the first keystroke replaces the prefilled value
        // instead of being inserted next to it. Without this, focusing a
        // field showing "1" and typing "1" produced "11", and a money field
        // showing "21600.00" became "21600.0010000" — the H1 append defect.
        e.currentTarget.select();
        onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        // Whitelist: digits, one dot if decimals allowed, nothing else.
        const pattern = allowDecimal ? /^\d*\.?\d*$/ : /^\d*$/;
        if (raw !== "" && !pattern.test(raw)) return;

        setDisplay(raw);

        if (raw === "" || raw === ".") {
          lastEmittedRef.current = allowEmpty ? null : 0;
          onChange(allowEmpty ? null : 0);
          return;
        }

        const parsed = parseDisplay(raw, allowDecimal);
        if (parsed === null) return;
        const clamped = clamp(parsed, min, max);
        lastEmittedRef.current = clamped;
        onChange(clamped);
      }}
      onBlur={() => {
        // Normalise the display on blur — "5." → "5", "" → "" (or "0"
        // if empty isn't allowed), but preserve "0.5".
        if (display === "" || display === ".") {
          if (allowEmpty) {
            setDisplay("");
          } else {
            setDisplay("0");
            lastEmittedRef.current = 0;
            onChange(0);
          }
          return;
        }
        const parsed = parseDisplay(display, allowDecimal);
        if (parsed === null) return;
        const clamped = clamp(parsed, min, max);
        // Strip trailing decimal point / leading zeros: String(0.5) is "0.5".
        setDisplay(String(clamped));
        lastEmittedRef.current = clamped;
        onChange(clamped);
      }}
    />
  );
}

function stringifyValue(value: number, allowEmpty: boolean): string {
  if (!Number.isFinite(value)) return allowEmpty ? "" : "0";
  if (value === 0 && allowEmpty) return "";
  return String(value);
}

function parseDisplay(raw: string, allowDecimal: boolean): number | null {
  if (raw === "" || raw === ".") return null;
  const parsed = allowDecimal ? parseFloat(raw) : parseInt(raw, 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return null;
  return parsed;
}

function clamp(n: number, min?: number, max?: number): number {
  let out = n;
  if (typeof min === "number" && out < min) out = min;
  if (typeof max === "number" && out > max) out = max;
  return out;
}
