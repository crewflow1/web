"use client";

import { useState } from "react";
import { formatGbp } from "@/lib/money";
import { StateForm } from "@/components/forms/StateForm";
import { VALUATION_STATUS_LABEL, type ValuationStatus } from "@/lib/valuations/compute";
import type { JobValuationsView, JobValuationLine } from "@/server/services/job-valuations";
import {
  createValuation,
  updateValuation,
  submitValuation,
  cancelValuation,
  certifyValuation,
  generateValuationInvoice,
  linkVariation,
  unlinkVariation,
} from "../valuation-actions";

export type AvailableVariation = { id: string; label: string; subtotal: number };

const STATUS_STYLE: Record<ValuationStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  submitted: "bg-blue-100 text-blue-700",
  certified: "bg-amber-100 text-amber-700",
  invoiced: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-400 line-through",
};

function StatusPill({ status }: { status: ValuationStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {VALUATION_STATUS_LABEL[status]}
    </span>
  );
}

function Figure({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? "font-semibold text-slate-900" : "text-slate-700"}>{formatGbp(value)}</span>
    </div>
  );
}

function DetailsFields({ line }: { line?: JobValuationLine }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs text-slate-600">
        Period start
        <input type="date" name="period_start" defaultValue={line?.periodStart ?? ""} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-slate-600">
        Period end
        <input type="date" name="period_end" defaultValue={line?.periodEnd ?? ""} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-slate-600">
        Work completed to date (ex-VAT)
        <input type="number" step="0.01" min="0" name="work_completed_to_date" defaultValue={line ? undefined : 0} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-slate-600">
        Materials on site (ex-VAT)
        <input type="number" step="0.01" min="0" name="materials_on_site" defaultValue={line ? undefined : 0} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-slate-600">
        Deductions (ex-VAT)
        <input type="number" step="0.01" min="0" name="deductions" defaultValue={line ? undefined : 0} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="text-xs text-slate-600">
        VAT rate (%)
        <input type="number" step="0.01" min="0" max="100" name="vat_rate" defaultValue={20} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
      <label className="col-span-2 text-xs text-slate-600">
        Notes
        <textarea name="notes" rows={2} defaultValue={line?.notes ?? ""} className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
      </label>
    </div>
  );
}

function ValuationCard({
  jobId,
  line,
  isAdmin,
  availableVariations,
}: {
  jobId: string;
  line: JobValuationLine;
  isAdmin: boolean;
  availableVariations: AvailableVariation[];
}) {
  const [editing, setEditing] = useState(false);
  const f = line.figures;
  const isDraft = line.status === "draft";
  const isSubmitted = line.status === "submitted";
  const isCertified = line.status === "certified";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-900">Valuation {line.sequence}</span>
          <StatusPill status={line.status} />
        </div>
        <span className="text-xs text-slate-400">
          {line.periodEnd ? `to ${line.periodEnd}` : line.valuationDate}
        </span>
      </div>

      <div className="border-t border-slate-100 pt-2">
        <Figure label="Work + materials + variations (gross, cumulative)" value={f.gross} />
        <Figure label="Less previously certified" value={-f.previousCertifiedGross} />
        <Figure label="Certified this period (ex-VAT)" value={f.netCertifiedThis} strong />
        <Figure label={`Less retention held`} value={-f.retentionThis} />
        <Figure label="VAT" value={f.vat} />
        <Figure label="Amount due for payment" value={f.netPayableThis + f.vat} strong />
      </div>

      {line.variationCount > 0 ? (
        <p className="mt-1 text-xs text-slate-500">
          Includes {line.variationCount} variation{line.variationCount === 1 ? "" : "s"} · {formatGbp(line.variationsTotal)}
        </p>
      ) : null}
      {f.wouldGoNegative ? (
        <p className="mt-1 text-xs text-red-600">
          This would certify a negative amount — it can&apos;t be certified until the gross exceeds what&apos;s already certified.
        </p>
      ) : null}

      {/* Draft: edit + link variations + submit + cancel */}
      {isDraft ? (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          {editing ? (
            <StateForm action={updateValuation.bind(null, line.id)} className="space-y-2">
              <DetailsFields line={line} />
              <div className="flex gap-2">
                <button type="submit" className="rounded bg-slate-900 px-3 py-1 text-sm text-white">Save</button>
                <button type="button" onClick={() => setEditing(false)} className="rounded border border-slate-300 px-3 py-1 text-sm">Cancel</button>
              </div>
            </StateForm>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setEditing(true)} className="rounded border border-slate-300 px-3 py-1 text-sm">Edit</button>
              <StateForm action={submitValuation.bind(null, line.id)}>
                <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-sm text-white">Submit for certification</button>
              </StateForm>
              <StateForm action={cancelValuation.bind(null, line.id)} confirm="Cancel this valuation?">
                <button type="submit" className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-500">Cancel</button>
              </StateForm>
            </div>
          )}

          {availableVariations.length > 0 ? (
            <StateForm action={linkVariation.bind(null, line.id, jobId)} className="flex items-end gap-2">
              <label className="flex-1 text-xs text-slate-600">
                Include an agreed variation
                <select name="variation_quote_id" className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm">
                  {availableVariations.map((v) => (
                    <option key={v.id} value={v.id}>{v.label} — {formatGbp(v.subtotal)}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="rounded border border-slate-300 px-3 py-1 text-sm">Add</button>
            </StateForm>
          ) : null}
        </div>
      ) : null}

      {/* Submitted: admin certifies, or cancel */}
      {isSubmitted && isAdmin ? (
        <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
          <StateForm action={certifyValuation.bind(null, line.id, jobId)} confirm="Certify this valuation? Its figures will be frozen.">
            <button type="submit" className="rounded bg-amber-600 px-3 py-1 text-sm text-white">Certify</button>
          </StateForm>
          <StateForm action={cancelValuation.bind(null, line.id)} confirm="Cancel this valuation?">
            <button type="submit" className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-500">Cancel</button>
          </StateForm>
        </div>
      ) : null}

      {/* Certified: admin generates the stage invoice */}
      {isCertified && isAdmin ? (
        <StateForm action={generateValuationInvoice.bind(null, line.id, jobId)} className="mt-3 flex items-end gap-2 border-t border-slate-100 pt-3">
          <label className="text-xs text-slate-600">
            Invoice due date (optional)
            <input type="date" name="due_date" className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm" />
          </label>
          <button type="submit" className="rounded bg-emerald-600 px-3 py-1 text-sm text-white">Generate invoice</button>
        </StateForm>
      ) : null}

      {line.status === "invoiced" && line.invoiceId ? (
        <a href={`/invoices/${line.invoiceId}`} className="mt-3 inline-block border-t border-slate-100 pt-3 text-sm text-emerald-700 hover:underline">
          View generated invoice →
        </a>
      ) : null}
    </div>
  );
}

export function ValuationsClient({
  jobId,
  isAdmin,
  view,
  availableVariations,
}: {
  jobId: string;
  isAdmin: boolean;
  view: JobValuationsView;
  availableVariations: AvailableVariation[];
}) {
  const [creating, setCreating] = useState(false);
  const r = view.retention;

  return (
    <div className="space-y-4">
      {r.isActive ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <span className="font-medium text-slate-700">Retention</span>{" "}
          <span className="text-slate-500">
            {r.ratePercent}% · accrued {formatGbp(r.accrued)} · released {formatGbp(r.released)} · held {formatGbp(r.held)}
          </span>
        </div>
      ) : null}

      <div className="flex justify-end">
        {creating ? null : (
          <button type="button" onClick={() => setCreating(true)} className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white">
            New valuation
          </button>
        )}
      </div>

      {creating ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">New valuation</h2>
          <StateForm action={createValuation.bind(null, jobId)} className="space-y-3">
            <DetailsFields />
            <div className="flex gap-2">
              <button type="submit" className="rounded bg-slate-900 px-3 py-1 text-sm text-white">Create draft</button>
              <button type="button" onClick={() => setCreating(false)} className="rounded border border-slate-300 px-3 py-1 text-sm">Cancel</button>
            </div>
          </StateForm>
        </div>
      ) : null}

      {view.lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No valuations yet. Create the first application for payment.
        </p>
      ) : (
        <div className="space-y-3">
          {view.lines.map((line) => (
            <ValuationCard
              key={line.id}
              jobId={jobId}
              line={line}
              isAdmin={isAdmin}
              availableVariations={line.status === "draft" ? availableVariations : []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
