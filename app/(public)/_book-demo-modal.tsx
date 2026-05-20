"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { STAFF_COUNT_OPTIONS } from "@/lib/demo/schema";
import { submitDemoRequest } from "./actions";
import { buttonClass } from "@/components/ui/button";

/**
 * Book-demo modal. Opens via the global custom event
 * `crewflow:open-book-demo` so any button on the landing page can
 * trigger it without prop-drilling.
 *
 *   - Inline field errors from the server action
 *   - Pending state on the submit button
 *   - Esc + click-outside to close
 *   - Success screen with reassurance
 *
 * Submitted form goes to the server action which writes demo_requests,
 * creates an internal lead, and notifies the owner via Resend.
 */

const INPUT =
  "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

export function BookDemoModal() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
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
    startTransition(async () => {
      const result = await submitDemoRequest(formData);
      if (result.ok) {
        setDone(true);
        form.reset();
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
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
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>

        {done ? (
          <div className="px-8 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <span aria-hidden className="text-2xl">✓</span>
            </div>
            <h2 className="mt-4 text-xl font-semibold text-slate-900">
              Request received.
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              We will be in touch within one working day to confirm a time
              that suits you.
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
              30 minutes on a call. We will run through your numbers so you
              see exactly what CrewFlow would change.
            </p>

            {error ? (
              <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
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
                <Field label="Phone" error={fieldErrors.phone}>
                  <input
                    name="phone"
                    type="tel"
                    required
                    autoComplete="tel"
                    placeholder="07700 900111"
                    className={INPUT}
                  />
                </Field>
              </Row>

              <Field label="Number of staff" error={fieldErrors.staff_count}>
                <select name="staff_count" required defaultValue="" className={INPUT}>
                  <option value="" disabled>
                    Pick a team size
                  </option>
                  {STAFF_COUNT_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Current systems" error={fieldErrors.current_systems}>
                <input
                  name="current_systems"
                  placeholder="e.g. Sage, Xero, WhatsApp, paper diary"
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
                  {pending ? "Sending…" : "Book demo"}
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
      {error ? (
        <span className="mt-1 block text-[11px] font-normal text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Button that opens the modal. Render anywhere on the landing page.
 */
export function BookDemoButton({
  size = "md",
  variant = "primary",
  children = "Book demo",
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
