"use client";

import { type ReactNode } from "react";

/**
 * Tenant-side confirm-then-submit wrapper.
 *
 * Mirrors `app/admin/_client-confirm.tsx` (HQ) but lives in the
 * shared components/forms tree so customer pages can import it
 * cleanly without crossing the admin boundary.
 *
 * Uses the browser's native `confirm()` — loud, blocking, no modal
 * library bytes shipped. The form's `action` only runs if the user
 * clicks OK. Hidden inputs / submit button render as children.
 *
 * Usage:
 *
 *   <ConfirmForm
 *     action={deleteJob.bind(null, job.id)}
 *     confirm="Delete this job? Linked photos and timesheet rows stay."
 *   >
 *     <button type="submit">Delete</button>
 *   </ConfirmForm>
 */
export function ConfirmForm({
  action,
  confirm,
  className = "inline-block",
  children,
}: {
  action: (formData: FormData) => Promise<void> | void;
  confirm: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirm)) {
          e.preventDefault();
        }
      }}
      className={className}
    >
      {children}
    </form>
  );
}
