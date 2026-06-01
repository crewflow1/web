"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Email quote PDF" control. Posts to /api/quotes/[id]/send which renders the
 * quote PDF and emails it with a portal link (view + approve/reject).
 */
export function SendQuote({
  quoteId,
  customerEmail,
}: {
  quoteId: string;
  customerEmail: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSend() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: overrideEmail || undefined,
          message: message || undefined,
        }),
      });
      const data = (await res.json()) as { to?: string; error?: string; detail?: string };
      if (!res.ok) {
        setError(data.detail ?? data.error ?? "Couldn't send the quote.");
      } else {
        setInfo(`Quote emailed to ${data.to}.`);
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-slate-200 pt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Send to customer
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
      {info ? <p className="mt-2 text-xs text-emerald-600">{info}</p> : null}
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setError(null);
            setInfo(null);
          }}
          disabled={busy}
          className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Email quote PDF
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
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Hi — quote for the works discussed, see attached. You can approve or reject online."
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSend}
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send quote"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
