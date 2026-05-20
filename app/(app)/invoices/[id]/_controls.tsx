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
  customerEmail,
  linkedJobId,
  jobsForPicker,
}: {
  id: string;
  status: InvoiceStatus;
  customerEmail: string | null;
  linkedJobId: string | null;
  jobsForPicker: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showSendForm, setShowSendForm] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState("");
  const [emailMessage, setEmailMessage] = useState("");

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

  async function onSend() {
    const recipient = overrideEmail.trim() || customerEmail;
    if (!recipient) {
      setError("No recipient. Add a customer email or override above.");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/invoices/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: overrideEmail.trim() || undefined,
          message: emailMessage.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.sent) {
        setError(j.detail ?? j.error ?? `Failed (${res.status})`);
      } else {
        setInfo(`Sent to ${j.to}.`);
        setShowSendForm(false);
        setOverrideEmail("");
        setEmailMessage("");
        router.refresh();
      }
    } catch (err) {
      console.error("[invoice-send] failed", err);
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function onLinkJob(nextJobId: string) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: nextJobId || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Failed (${res.status})`);
      } else {
        setInfo(nextJobId ? "Linked to job — profitability updated." : "Unlinked from job.");
        router.refresh();
      }
    } catch (err) {
      console.error("[invoice-link-job] failed", err);
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemind() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/invoices/${id}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.sent) {
        setError(j.detail ?? j.error ?? `Failed (${res.status})`);
      } else {
        setInfo(`Reminder sent to ${j.to}.`);
        router.refresh();
      }
    } catch (err) {
      console.error("[invoice-remind] failed", err);
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

      <div className="border-t border-slate-200 pt-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Link to job
        </div>
        <div className="mt-2">
          <select
            value={linkedJobId ?? ""}
            onChange={(e) => onLinkJob(e.target.value)}
            disabled={busy}
            className="block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 disabled:opacity-50"
          >
            <option value="">— Not linked —</option>
            {jobsForPicker.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">
            Attribute this invoice&apos;s revenue to a job for profitability tracking.
          </p>
        </div>
      </div>

      <div className="border-t border-slate-200 pt-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Send to customer
        </div>
        {!showSendForm ? (
          <button
            type="button"
            onClick={() => {
              setShowSendForm(true);
              setError(null);
              setInfo(null);
            }}
            disabled={busy}
            className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Email invoice PDF
            {customerEmail ? (
              <span className="ml-1 text-slate-500">→ {customerEmail}</span>
            ) : (
              <span className="ml-1 text-amber-700">(no customer email)</span>
            )}
          </button>
        ) : (
          <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
            <label className="block text-xs text-slate-600">
              Recipient (override)
              <input
                type="email"
                value={overrideEmail}
                onChange={(e) => setOverrideEmail(e.target.value)}
                placeholder={customerEmail ?? "name@example.com"}
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-xs text-slate-600">
              Optional note
              <textarea
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                rows={3}
                placeholder="Hi — invoice for last week's work, see attached. Thanks."
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onSend}
                disabled={busy}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send now"}
              </button>
              <button
                type="button"
                onClick={() => setShowSendForm(false)}
                disabled={busy}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 pt-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Send reminder
        </div>
        <button
          type="button"
          onClick={onRemind}
          disabled={busy || status === "paid"}
          className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title={status === "paid" ? "Already paid — no reminder needed" : "Send a one-off reminder now (in addition to the auto-schedule)"}
        >
          Send reminder now
          {customerEmail ? (
            <span className="ml-1 text-slate-500">→ {customerEmail}</span>
          ) : (
            <span className="ml-1 text-amber-700">(no customer email)</span>
          )}
        </button>
      </div>

      {info ? (
        <p role="status" className="text-xs text-green-700">
          {info}
        </p>
      ) : null}
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
