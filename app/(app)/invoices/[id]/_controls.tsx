"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/invoices/schema";

/**
 * Status-update + delete controls for a single invoice.
 *
 * Status mutations go via PATCH /api/invoices/[id]; delete via DELETE.
 * The server stamps sent_at / paid_at when status is set to sent / paid.
 */

export function InvoiceControls({
  id,
  status,
}: {
  id: string;
  status: InvoiceStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: InvoiceStatus) {
    if (next === status) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!confirm("Delete this invoice? Only admins/owners can do this.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Failed (${res.status})`);
        setBusy(false);
      } else {
        router.push("/invoices");
        router.refresh();
      }
    } catch {
      setError("Network error.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Set status
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {INVOICE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              disabled={busy || s === status}
              className={
                s === status
                  ? "rounded-md border border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700"
                  : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}

      <div className="border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Delete invoice
        </button>
      </div>
    </div>
  );
}
