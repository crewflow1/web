"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import {
  EMPLOYEE_RANGES,
  TURNOVER_LABELS,
  TURNOVER_RANGES,
} from "@/lib/demo/schema";
import { buttonClass } from "@/components/ui/button";

type SubmitResult =
  | { ok: true; deduped?: boolean }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Premium book-demo modal. Submitted form goes to the server action,
 * which inserts demo_requests + (optionally) an internal-org lead +
 * emails hello@crewflow.uk.
 *
 * Behaviours:
 *   - Open/close via the global custom event `crewflow:open-book-demo`
 *     dispatched by buttons across the landing.
 *   - Inline field errors from the server action.
 *   - Pending state on the submit button.
 *   - Esc to close, click-outside to close.
 *   - Success screen with reassurance + close.
 */

const INPUT =
  "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm transition focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

export function BookDemoModal() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setDone(false);
      setError(null);
      setFieldErrors({});
    }
    window.addEventListener("crewflow:open-book-demo", onOpen);
    return () => window.removeEventListener("crewflow:open-book-demo", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => firstFieldRef.current?.focus(), 30);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setError(null);
    setFieldErrors({});

    // Convert FormData → plain object so the API route's Zod schema can
    // validate it directly. Empty optional fields become undefined.
    const payload: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string" && value.trim() !== "") {
        payload[key] = value;
      }
    });

    startTransition(async () => {
      try {
        const res = await fetch("/api/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        let result: SubmitResult;
        try {
          result = (await res.json()) as SubmitResult;
        } catch {
          result = {
            ok: false,
            error:
              "Something went wrong on our end and your request didn't go through. Email hello@crewflow.uk and we'll book you in directly.",
          };
        }
        if (result.ok) {
          setDone(true);
          form.reset();
        } else {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
        }
      } catch (err) {
        console.error("[demo] fetch threw — surfacing friendly error", err);
        setError(
          "We hit a network problem sending your request. Email hello@crewflow.uk and we will book you in directly.",
        );
      }
    });
  }

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-demo-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 px-4 py-6 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>

        {done ? (
          <div className="px-8 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <span aria-hidden className="text-2xl">✓</span>
            </div>
            <h2 className="mt-4 text-xl font-semibold text-slate-900">
              We&apos;ll be in touch.
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Your demo request is in. Someone from CrewFlow will reach out
              within one working day to confirm a time.
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={buttonClass("primary", "md", "mt-6")}
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-6 py-6 sm:px-8 sm:py-8">
            <h2 id="book-demo-title" className="text-xl font-semibold text-slate-900">
              Book a CrewFlow demo
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              30 minutes on a call. We&apos;ll walk through your existing
              numbers so you see exactly what CrewFlow would change.
            </p>

            {error ? (
              <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <form onSubmit={onSubmit} className="mt-5 space-y-4">
              <Row>
                <Field label="Your name" error={fieldErrors.name}>
                  <input
                    ref={firstFieldRef}
                    name="name"
                    required
                    maxLength={120}
                    autoComplete="name"
                    className={INPUT}
                  />
                </Field>
                <Field label="Company" error={fieldErrors.company}>
                  <input
                    name="company"
                    required
                    maxLength={160}
                    autoComplete="organization"
                    className={INPUT}
                  />
                </Field>
              </Row>

              <Row>
                <Field label="Email" error={fieldErrors.email}>
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    className={INPUT}
                  />
                </Field>
                <Field label="Phone (optional)" error={fieldErrors.phone}>
                  <input
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    className={INPUT}
                  />
                </Field>
              </Row>

              <Row>
                <Field label="Employees" error={fieldErrors.employees}>
                  <select name="employees" required defaultValue="" className={INPUT}>
                    <option value="" disabled>
                      Pick a range
                    </option>
                    {EMPLOYEE_RANGES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Turnover" error={fieldErrors.turnover_range}>
                  <select name="turnover_range" defaultValue="" className={INPUT}>
                    <option value="">Prefer not to say</option>
                    {TURNOVER_RANGES.filter((r) => r !== "prefer_not_say").map((r) => (
                      <option key={r} value={r}>
                        {TURNOVER_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </Field>
              </Row>

              <Field label="Current systems" error={fieldErrors.current_systems}>
                <input
                  name="current_systems"
                  placeholder="e.g. Xero + WhatsApp + paper diary"
                  maxLength={500}
                  className={INPUT}
                />
              </Field>

              <Field label="Preferred demo time" error={fieldErrors.preferred_demo_time}>
                <input
                  name="preferred_demo_time"
                  placeholder="e.g. weekday mornings, this week"
                  maxLength={200}
                  className={INPUT}
                />
              </Field>

              <div className="mt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className={buttonClass("ghost", "md")}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className={buttonClass("primary", "md")}
                >
                  {pending ? "Sending…" : "Request demo"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-medium text-slate-700">
      {label}
      {children}
      {error ? <span className="mt-1 block text-[11px] font-normal text-red-700">{error}</span> : null}
    </label>
  );
}

/**
 * A button that opens the modal. Render anywhere on the landing.
 */
export function BookDemoButton({
  size = "lg",
  variant = "primary",
  children = "Book a demo",
  className,
}: {
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("crewflow:open-book-demo"))}
      className={buttonClass(variant, size, className)}
    >
      {children}
    </button>
  );
}
