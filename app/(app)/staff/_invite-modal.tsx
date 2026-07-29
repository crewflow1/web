"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { inviteStaff } from "./actions";
import { EMPLOYMENT_TYPES } from "@/lib/staff/schema";

/**
 * Add-staff modal. Owner/admin clicks the "+ Add staff" button which
 * dispatches `crewflow:open-add-staff`. The modal validates inline,
 * shows the action's success message, and refreshes the directory list
 * via router.refresh() on success.
 */

const INPUT =
  "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10";

export function InviteStaffModal() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setDone(null);
      setError(null);
      setFieldErrors({});
    }
    window.addEventListener("crewflow:open-add-staff", onOpen);
    return () => window.removeEventListener("crewflow:open-add-staff", onOpen);
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
      const result = await inviteStaff(formData);
      if (result.ok) {
        setDone(result.message);
        form.reset();
        router.refresh();
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
      aria-labelledby="invite-staff-title"
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
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          ✕
        </button>

        {done ? (
          <div className="px-8 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <span aria-hidden className="text-2xl">✓</span>
            </div>
            <h2 className="mt-4 text-xl font-semibold text-slate-900">Done.</h2>
            <p className="mt-2 text-sm text-slate-600">{done}</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={buttonClass("primary", "md", "mt-6")}
            >
              Close
            </button>
          </div>
        ) : (
          <div className="px-6 py-6 sm:px-8 sm:py-8">
            <h2 id="invite-staff-title" className="text-xl font-semibold text-slate-900">
              Add a staff member
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Already a CrewFlow user? They join your org instantly. New
              to CrewFlow? We email a magic link they click to set their
              name and join. Profile fields below are pre-fill only and
              never overwrite their existing data.
            </p>

            {error ? (
              <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
              <Row>
                <Field label="Full name" error={fieldErrors.full_name}>
                  <input
                    ref={firstFieldRef}
                    name="full_name"
                    maxLength={200}
                    autoComplete="name"
                    placeholder="e.g. Jane Smith"
                    className={INPUT}
                  />
                </Field>
                <Field label="Email" error={fieldErrors.email} required>
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="jane@example.com"
                    className={INPUT}
                  />
                </Field>
              </Row>

              <Row>
                <Field label="Role" error={fieldErrors.role} required>
                  <select name="role" defaultValue="staff" required className={INPUT}>
                    <option value="staff">Staff</option>
                    <option value="admin">Admin</option>
                    <option value="owner" disabled>
                      Owner (onboarding only)
                    </option>
                  </select>
                </Field>
                <Field label="Employment type" error={fieldErrors.employment_type}>
                  <select name="employment_type" defaultValue="" className={INPUT}>
                    <option value="">—</option>
                    {EMPLOYMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </Field>
              </Row>

              <Row>
                <Field label="Phone" error={fieldErrors.phone}>
                  <input
                    name="phone"
                    type="tel"
                    maxLength={40}
                    autoComplete="tel"
                    placeholder="07700 900 123"
                    className={INPUT}
                  />
                </Field>
                <Field label="Hourly pay (£)" error={fieldErrors.hourly_pay}>
                  <input
                    name="hourly_pay"
                    type="number"
                    min={0}
                    max={1000}
                    step={0.01}
                    placeholder="e.g. 18.50"
                    className={INPUT}
                  />
                </Field>
              </Row>

              <fieldset className="rounded-lg border border-slate-200 p-3">
                <legend className="px-1 text-xs font-medium text-slate-700">
                  Emergency contact (optional)
                </legend>
                <Row>
                  <Field label="Name" error={fieldErrors.emergency_contact_name}>
                    <input
                      name="emergency_contact_name"
                      maxLength={200}
                      placeholder="Partner / parent / friend"
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Phone" error={fieldErrors.emergency_contact_phone}>
                    <input
                      name="emergency_contact_phone"
                      type="tel"
                      maxLength={40}
                      placeholder="07700 900 222"
                      className={INPUT}
                    />
                  </Field>
                </Row>
                <Field label="Relationship" error={fieldErrors.emergency_contact_relationship}>
                  <input
                    name="emergency_contact_relationship"
                    maxLength={80}
                    placeholder="e.g. spouse"
                    className={INPUT}
                  />
                </Field>
              </fieldset>

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
                  {pending ? "Sending…" : "Send invite"}
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
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-medium text-slate-700">
      {label}
      {required ? <span className="ml-0.5 text-red-500">*</span> : null}
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
 * Button that opens the modal. Render anywhere admins can act.
 *
 * NOTE: the parent page is responsible for the admin/staff role gate
 * (`{isAdmin ? <AddStaffButton/> : null}`). Staff users must never see
 * this button — the action layer rejects non-admin invites regardless,
 * but the UX rule is enforced at the parent.
 */
export function AddStaffButton({
  size = "md",
  variant = "primary",
  children = "+ Add staff",
  className,
  testId,
}: {
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => window.dispatchEvent(new Event("crewflow:open-add-staff"))}
      className={buttonClass(variant, size, className)}
    >
      {children}
    </button>
  );
}
