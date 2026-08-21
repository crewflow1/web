"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactElement,
} from "react";
import {
  EMPLOYEE_RANGES,
  TURNOVER_LABELS,
  TURNOVER_RANGES,
} from "@/lib/demo/schema";

type SubmitResult =
  | { ok: true; deduped?: boolean }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Book-demo modal — unified dark "Setting-Out" system.
 *
 * PRESENTATION + a11y only were reworked here; the booking logic is unchanged:
 * open via the global `crewflow:open-book-demo` event, POST the form to
 * /api/demo, inline field errors, pending → success. The dialog now has a real
 * focus trap, returns focus to the trigger on close, locks body scroll, and is
 * a bottom sheet on mobile / centred on desktop.
 */

const INPUT =
  "mt-1.5 block w-full rounded-md border border-cfborder bg-navy-950 px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-dim focus:border-gold-500 focus:ring-2 focus:ring-gold-500/25";

export function BookDemoModal() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showMore, setShowMore] = useState(false);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onOpen() {
      // Remember what to return focus to (the button that dispatched the event).
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      setDone(false);
      setError(null);
      setFieldErrors({});
      setShowMore(false);
    }
    window.addEventListener("crewflow:open-book-demo", onOpen);
    return () => window.removeEventListener("crewflow:open-book-demo", onOpen);
  }, []);

  // Scroll-lock + focus trap + Esc + restore focus on close.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const restoreTo = returnFocusRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => firstFieldRef.current?.focus(), 30);

    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const outside = !dialog?.contains(activeEl);
      if (e.shiftKey && (activeEl === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (activeEl === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreTo?.focus();
    };
  }, [open]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setError(null);
    setFieldErrors({});

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
      aria-describedby="book-demo-desc"
      className="fixed inset-0 z-[80] flex items-end justify-center bg-navy-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-cf border border-cfborder bg-navy-900 shadow-cf sm:max-w-lg sm:rounded-cf"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 rounded-md p-1.5 text-ink-dim transition-colors hover:bg-white/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {done ? (
          <div className="px-8 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-positive/15">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-positive">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="mt-5 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
              We&apos;ll be in touch.
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-ink-mut">
              Your demo request is in. Someone from CrewFlow will reach out within
              one working day to confirm a time.
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-7 inline-flex h-11 items-center rounded-lg bg-gold-500 px-6 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-6 py-7 sm:px-8 sm:py-8">
            <p className="inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-gold-500">
              <span aria-hidden="true" className="inline-block h-2 w-2 border border-gold-500/60" />
              Book a demo
            </p>
            <h2
              id="book-demo-title"
              className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] text-ink"
            >
              See CrewFlow on your own numbers.
            </h2>
            <p id="book-demo-desc" className="mt-2 text-[15px] leading-relaxed text-ink-mut">
              30 minutes on a call. We&apos;ll walk through your existing jobs and
              figures so you see exactly what would change. No slides.
            </p>

            {error ? (
              <div
                role="alert"
                className="mt-5 rounded-lg border border-danger/40 bg-danger/[0.08] px-3.5 py-2.5 text-sm text-danger"
              >
                {error}
              </div>
            ) : null}

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <Row>
                <Field name="name" label="Your name" error={fieldErrors.name}>
                  <input ref={firstFieldRef} name="name" required maxLength={120} autoComplete="name" className={INPUT} />
                </Field>
                <Field name="company" label="Company" error={fieldErrors.company}>
                  <input name="company" required maxLength={160} autoComplete="organization" className={INPUT} />
                </Field>
              </Row>

              <Row>
                <Field name="email" label="Email" error={fieldErrors.email}>
                  <input name="email" type="email" required autoComplete="email" className={INPUT} />
                </Field>
                <Field name="employees" label="Employees" error={fieldErrors.employees}>
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
              </Row>

              {/* The four optional fields collapse behind a toggle so the form
                  reads as four fields, not eight. Auto-expands if the server
                  ever returns an error against one of them. */}
              {showMore ||
              fieldErrors.phone ||
              fieldErrors.turnover_range ||
              fieldErrors.current_systems ||
              fieldErrors.preferred_demo_time ? (
                <>
                  <Row>
                    <Field name="phone" label="Phone (optional)" error={fieldErrors.phone}>
                      <input name="phone" type="tel" autoComplete="tel" className={INPUT} />
                    </Field>
                    <Field name="turnover_range" label="Turnover (optional)" error={fieldErrors.turnover_range}>
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
                  <Field name="current_systems" label="Current systems (optional)" error={fieldErrors.current_systems}>
                    <input name="current_systems" placeholder="e.g. Xero + WhatsApp + paper diary" maxLength={500} className={INPUT} />
                  </Field>
                  <Field name="preferred_demo_time" label="Preferred demo time (optional)" error={fieldErrors.preferred_demo_time}>
                    <input name="preferred_demo_time" placeholder="e.g. weekday mornings, this week" maxLength={200} className={INPUT} />
                  </Field>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowMore(true)}
                  className="rounded text-sm font-medium text-gold-500 transition-colors hover:text-gold-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
                >
                  + Add phone, turnover &amp; timing (optional)
                </button>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-11 items-center rounded-lg px-4 text-sm font-medium text-ink-mut transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  aria-busy={pending}
                  className="inline-flex h-11 items-center rounded-lg bg-gold-500 px-6 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {pending ? "Sending…" : "Request demo"}
                </button>
              </div>
              <p className="pt-1 text-center text-xs text-ink-dim">
                We&apos;ll only use this to book your demo.
              </p>
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
  name,
  label,
  error,
  children,
}: {
  name: string;
  label: string;
  error?: string;
  children: ReactElement;
}) {
  const errId = error ? `${name}-err` : undefined;
  const control =
    error && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-invalid": true,
          "aria-describedby": errId,
        })
      : children;
  return (
    <label className="block text-xs font-medium text-ink-mut">
      {label}
      {control}
      {error ? (
        <span id={errId} className="mt-1 block text-[11px] font-normal text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/**
 * A button that opens the modal. Render anywhere on the site. Callers pass the
 * full (dark) button styling via `className`; the default is a minimal fallback.
 */
export function BookDemoButton({
  children = "Book a demo",
  className = "inline-flex h-11 items-center rounded-lg bg-gold-500 px-5 text-sm font-semibold text-navy-950 shadow-cf-gold transition-colors hover:bg-gold-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-100",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("crewflow:open-book-demo"))}
      className={className}
    >
      {children}
    </button>
  );
}
