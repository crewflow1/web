"use client";

import { useEffect, useRef, useState } from "react";
import { inputClass, labelClass } from "./_meta";

/**
 * A datetime-local field whose *submitted* value is a full, offset-qualified
 * ISO instant — what the server action validates with
 * `z.string().datetime({ offset: true })`.
 *
 * A bare <input type="datetime-local"> posts "YYYY-MM-DDTHH:mm" (no seconds, no
 * timezone), which that schema rejects. So the visible picker is unnamed and a
 * hidden sibling carries the real value: on change we run the local wall-clock
 * time through `new Date(value).toISOString()` → e.g. "2026-07-24T09:00:00.000Z".
 *
 * The stored value arrives already offset-qualified, so the hidden field is
 * seeded with it verbatim (deterministic on server and client — no hydration
 * mismatch); the picker is only *localised* for display after mount, via a ref,
 * since that conversion depends on the browser timezone.
 */

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function PermitDateTimeField({
  id,
  name,
  label,
  defaultValue = "",
  hint,
  required = false,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  hint?: string;
  required?: boolean;
}) {
  const [iso, setIso] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el && defaultValue && !el.value) {
      el.value = isoToLocalInput(defaultValue);
    }
  }, [defaultValue]);

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="datetime-local"
        required={required}
        className={inputClass}
        onChange={(e) => {
          const v = e.target.value;
          setIso(v ? new Date(v).toISOString() : "");
        }}
      />
      {/* Carries the offset-qualified ISO instant the action validates. */}
      <input type="hidden" name={name} value={iso} readOnly />
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
