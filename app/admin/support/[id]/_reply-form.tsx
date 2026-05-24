"use client";

import { useState } from "react";

/**
 * HQ Support reply form — wraps the server action with a confirm
 * gate that ONLY fires when the operator is sending a customer-
 * visible reply. Internal notes don't trigger the confirm (they're
 * not customer-visible and the audit log captures them).
 */
export function SupportReplyForm({
  action,
  ticketId,
  customerEmail,
}: {
  action: (formData: FormData) => Promise<void> | void;
  ticketId: string;
  customerEmail: string | null;
}) {
  const [internal, setInternal] = useState(false);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (internal) return;
        const audience = customerEmail ?? "the customer";
        const ok = window.confirm(
          `Send this reply to ${audience}? It will appear in their support inbox.`,
        );
        if (!ok) e.preventDefault();
      }}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <input type="hidden" name="ticket_id" value={ticketId} />
      <p className="text-sm font-semibold text-slate-900">Reply</p>
      <textarea
        name="body"
        required
        minLength={1}
        maxLength={10_000}
        rows={5}
        placeholder="Customer-visible reply, OR check 'Internal note' to leave a private HQ-only message…"
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
          <input
            type="checkbox"
            name="internal"
            value="true"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Internal note (HQ-only, not visible to customer)
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          {internal ? "Save internal note" : "Send reply"}
        </button>
      </div>
    </form>
  );
}
