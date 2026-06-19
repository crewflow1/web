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
      ? "rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm shadow-emerald-900/30 transition-colors hover:bg-emerald-500"
      : buttonVariant === "danger"
        ? "rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
        : buttonVariant === "warning"
          ? "rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
          : "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800";

  const confirmClass =
    buttonVariant === "danger"
      ? "rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-rose-900/30 hover:bg-rose-500"
      : buttonVariant === "warning"
        ? "rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-amber-900/30 hover:bg-amber-500"
        : "rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-emerald-900/30 hover:bg-emerald-500";

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
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
            <div className="border-b border-slate-800 bg-slate-900/60 px-5 py-3">
              <h2 className="text-base font-semibold text-white">{title}</h2>
            </div>
            <form
              action={(fd) => {
                startTransition(async () => {
                  await action(fd);
                  setOpen(false);
                });
              }}
              className="space-y-4 px-5 py-4 text-sm text-slate-300"
            >
              <p>{body}</p>
              {children}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  className="rounded-md border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className={`${confirmClass} transition-colors disabled:opacity-60`}
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
