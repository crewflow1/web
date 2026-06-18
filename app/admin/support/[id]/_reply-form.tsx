"use client";

import { useState } from "react";
import { Button, Textarea } from "@/components/ui";

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
      className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4"
    >
      <input type="hidden" name="ticket_id" value={ticketId} />
      <p className="text-sm font-semibold text-white">Reply</p>
      <Textarea
        name="body"
        required
        minLength={1}
        maxLength={10_000}
        rows={5}
        placeholder="Customer-visible reply, OR check 'Internal note' to leave a private HQ-only message…"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
          <input
            type="checkbox"
            name="internal"
            value="true"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-indigo-500 focus:ring-indigo-500/30"
          />
          Internal note (HQ-only, not visible to customer)
        </label>
        <Button type="submit" variant="accent" size="md">
          {internal ? "Save internal note" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
