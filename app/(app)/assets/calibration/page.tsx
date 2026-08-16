import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { EmptyState } from "../../_components/empty-state";
import {
  CALIBRATION_RESULT_LABELS,
  CALIBRATION_EXPIRY_LABELS,
  classifyCalibrationExpiry,
  type CalibrationExpiryState,
  type CalibrationResult,
} from "@/lib/assets/calibration";

export const metadata = { title: "Calibration register · CrewFlow" };

type Row = {
  id: string;
  asset_id: string;
  certificate_number: string;
  calibrated_by: string;
  calibration_date: string;
  next_due_date: string | null;
  result: CalibrationResult;
  standard: string | null;
  asset: { name: string | null } | null;
};

const EXPIRY_STYLES: Record<CalibrationExpiryState, string> = {
  no_expiry: "bg-slate-100 text-slate-600",
  valid: "bg-emerald-100 text-emerald-800",
  due_soon: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
};

const EXPIRY_RANK: Record<CalibrationExpiryState, number> = {
  expired: 0,
  due_soon: 1,
  valid: 2,
  no_expiry: 3,
};

/**
 * /assets/calibration — the org-wide calibration certificate register.
 *
 * F-1: paged via `fetchAllRows` with a stable (calibration_date desc, id)
 * ordering so no certificate is dropped at a 1000-row boundary. ACTIVE-org
 * pinned — current_org_ids() is permissive. Loud reads — a failed read throws
 * (never renders an empty "no certificates" state on failure). Expiry state is
 * classified deterministically by the pure module and sorted worst-first.
 */
export default async function CalibrationRegisterPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await fetchAllRows<Row>((from, to) =>
    (
      supabase.from("asset_calibration_certificates" as never) as unknown as {
        select: (c: string) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => {
              order: (
                c: string,
                o: { ascending: boolean },
              ) => {
                range: (
                  f: number,
                  t: number,
                ) => Promise<{ data: Row[] | null; error: SupabaseReadError | null }>;
              };
            };
          };
        };
      }
    )
      .select(
        "id, asset_id, certificate_number, calibrated_by, calibration_date, next_due_date, result, standard, asset:assets(name)",
      )
      .eq("org_id", ctx.org.id)
      .order("calibration_date", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("calibration register: list", error as SupabaseReadError);

  const rows = (data ?? [])
    .map((r) => ({ ...r, expiry: classifyCalibrationExpiry(r.next_due_date, today) }))
    .sort(
      (a, b) =>
        EXPIRY_RANK[a.expiry.state] - EXPIRY_RANK[b.expiry.state] ||
        (a.expiry.daysUntilDue ?? Number.POSITIVE_INFINITY) - (b.expiry.daysUntilDue ?? Number.POSITIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    );

  const expiredCount = rows.filter((r) => r.expiry.state === "expired").length;
  const dueSoonCount = rows.filter((r) => r.expiry.state === "due_soon").length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Assets
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Calibration register</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every calibration certificate recorded across your assets — issued by external labs, tracked for expiry.
          {expiredCount > 0 ? ` ${expiredCount} expired.` : ""}
          {dueSoonCount > 0 ? ` ${dueSoonCount} due soon.` : ""}
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📏"
            title="No calibration certificates yet"
            body="Record a calibration certificate from an asset's page — the certificate number, who calibrated it, and the next-due date. Expiries then surface in your alerts."
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Certificate</th>
                  <th className="px-4 py-3">Calibrated by</th>
                  <th className="px-4 py-3">Cal date</th>
                  <th className="px-4 py-3">Next due</th>
                  <th className="px-4 py-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/assets/${r.asset_id}`} className="font-medium text-slate-900 hover:underline">
                        {r.asset?.name ?? "Asset"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {r.certificate_number}
                      {r.standard ? <span className="ml-2 text-xs text-slate-400">{r.standard}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.calibrated_by}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.calibration_date}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${EXPIRY_STYLES[r.expiry.state]}`}>
                        {r.next_due_date ? `${r.next_due_date} · ${CALIBRATION_EXPIRY_LABELS[r.expiry.state]}` : CALIBRATION_EXPIRY_LABELS[r.expiry.state]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{CALIBRATION_RESULT_LABELS[r.result]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
