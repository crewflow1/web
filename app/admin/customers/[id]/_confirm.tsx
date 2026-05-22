"use client";

import { type ReactNode } from "react";

/**
 * Tiny client wrapper that asks for confirmation before submitting.
 *
 * Used by lifecycle actions (suspend / cancel / reactivate) where the
 * blast radius is high enough that an accidental click would be a
 * problem. Uses native `confirm()` — loud, blocking, accessible on
 * every device, zero modal-library bytes shipped.
 */
export function ClientConfirmForm({
  action,
  confirm,
  children,
}: {
  action: (formData: FormData) => Promise<void> | void;
  confirm: string;
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
      className="inline-block"
    >
      {children}
    </form>
  );
}
