"use client";

import { type ReactNode } from "react";

/**
 * Shared HQ confirm-form wrapper.
 *
 * Wraps a server-action form and asks the operator for native
 * `confirm()` before submitting. Loud, blocking, accessible on every
 * device, zero modal-library bytes shipped. Used wherever the HQ
 * destructive op has high blast radius — refunds, voids, alert
 * resolutions, force-end impersonation, customer-visible support
 * replies.
 *
 * The previous home for this helper was
 * `app/admin/customers/[id]/_confirm.tsx` — that file re-exports
 * this one for backwards compat. New code should import from
 * `@/app/admin/_client-confirm` (or the relative path).
 *
 * Usage:
 *
 *   <ClientConfirmForm action={refundInvoice} confirm="Refund £120 to Acme?">
 *     <input type="hidden" name="invoice_id" value={inv.id} />
 *     <button type="submit">Refund</button>
 *   </ClientConfirmForm>
 */
export function ClientConfirmForm({
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
