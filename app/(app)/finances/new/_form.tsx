"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  FINANCE_CATEGORIES,
  FINANCE_VAT_RATES,
  RECEIPT_MAX_BYTES,
} from "@/lib/finances/schema";

/**
 * Client-side new-finance form.
 *
 * Posts multipart/form-data to /api/finances. Live VAT preview is computed
 * from the current amount + vat_rate inputs so the user sees what they're
 * about to save.
 *
 * Receipt is optional and validated client-side for size before upload.
 * Server-side validation in the route is the authoritative check.
 */
export function NewFinanceForm({ jobId, jobLabel }: { jobId?: string; jobLabel?: string } = {}) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [vatRate, setVatRate] = useState("20");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const amountNum = Number(amount);
  const vatNum = Number(vatRate);
  const vatPreview = Number.isFinite(amountNum) && Number.isFinite(vatNum)
    ? Number(((amountNum * vatNum) / 100).toFixed(2))
    : 0;
  const totalPreview = Number.isFinite(amountNum) ? amountNum + vatPreview : 0;

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const f = e.target.files?.[0];
    if (!f) {
      setFileName(null);
      return;
    }
    if (f.size > RECEIPT_MAX_BYTES) {
      setFileError("Receipt exceeds 10 MB.");
      e.target.value = "";
      setFileName(null);
      return;
    }
    setFileName(f.name);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/finances", { method: "POST", body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      // When the cost was filed against a specific job, send the user
      // back to that job's detail page so they can verify the rollup —
      // otherwise the generic finance list.
      router.push(jobId ? `/jobs/${jobId}` : "/finances");
      router.refresh();
    } catch (err) {
      console.error(err);
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      {jobId ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Linking this cost to <strong>{jobLabel ?? `job ${jobId.slice(0, 8)}`}</strong>.
          Margin will update once saved.
          <input type="hidden" name="job_id" value={jobId} />
        </div>
      ) : null}

      <div>
        <label htmlFor="amount" className="block text-sm font-medium text-slate-800">
          Amount (net, £) <span className="text-red-500">*</span>
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="vat_rate" className="block text-sm font-medium text-slate-800">
            VAT %
          </label>
          <select
            id="vat_rate"
            name="vat_rate"
            value={vatRate}
            onChange={(e) => setVatRate(e.target.value)}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {FINANCE_VAT_RATES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="category" className="block text-sm font-medium text-slate-800">
            Category
          </label>
          <select
            id="category"
            name="category"
            defaultValue=""
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">—</option>
            {FINANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <div className="flex justify-between">
          <span>Net</span>
          <span>£{(amountNum || 0).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span>VAT ({vatRate}%)</span>
          <span>£{vatPreview.toFixed(2)}</span>
        </div>
        <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-medium text-slate-900">
          <span>Total</span>
          <span>£{totalPreview.toFixed(2)}</span>
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
          Notes <span className="text-xs text-slate-500">Optional</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label htmlFor="receipt" className="block text-sm font-medium text-slate-800">
          Receipt <span className="text-xs text-slate-500">Optional</span>
        </label>
        <input
          id="receipt"
          name="receipt"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
          onChange={onFileChange}
          className="mt-1.5 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
        />
        <p className="mt-1 text-xs text-slate-500">
          {fileName ?? "JPG, PNG, WEBP, HEIC, or PDF. Max 10 MB."}
        </p>
        {fileError ? (
          <p className="mt-1 text-xs text-red-600">{fileError}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save entry"}
        </button>
        <a
          href="/finances"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
