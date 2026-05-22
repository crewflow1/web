"use client";

import { useState, useTransition, type ReactNode } from "react";

/**
 * Confirm-then-submit form wrapper.
 *
 * Used by the approval-panel buttons that need a Yes / Cancel modal
 * before the destructive or stage-flipping action runs. The pattern:
 *
 *   <ConfirmForm action={setOrganizationStatus} buttonLabel="Approve" …>
 *     <input type="hidden" name="org_id" value={org.id} />
 *     <input type="hidden" name="status" value="trial" />
 *   </ConfirmForm>
 *
 * The button renders inline. Clicking it opens a small confirmation
 * modal pinned to the centre of the screen. The Yes button submits
 * the underlying form (with the inputs the caller provided as
 * children) using `useTransition` so the page can re-render once the
 * server action settles.
 */
export function ConfirmForm({
  action,
  buttonLabel,
  buttonVariant = "default",
  title,
  body,
  confirmLabel,
  children,
}: {
  action: (formData: FormData) => Promise<void> | void;
  buttonLabel: string;
  buttonVariant?: "default" | "primary" | "danger" | "warning";
  title: string;
  body: string;
  confirmLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const buttonClass =
    buttonVariant === "primary"
      ? "rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800"
      : buttonVariant === "danger"
        ? "rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
        : buttonVariant === "warning"
          ? "rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50"
          : "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50";

  const confirmClass =
    buttonVariant === "danger"
      ? "rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-800"
      : buttonVariant === "warning"
        ? "rounded-md bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-800"
        : "rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass}
      >
        {buttonLabel}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 px-4 py-6 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
              <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            </div>
            <form
              action={(fd) => {
                startTransition(async () => {
                  await action(fd);
                  setOpen(false);
                });
              }}
              className="space-y-4 px-5 py-4 text-sm text-slate-700"
            >
              <p>{body}</p>
              {children}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className={`${confirmClass} disabled:opacity-60`}
                >
                  {pending ? "Working…" : confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
