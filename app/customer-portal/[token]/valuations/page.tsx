import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  buildPortalValuationView,
  isPortalVisibleValuation,
  type PortalValuationView,
} from "@/lib/valuations/portal";
import { sumCertifiedBase, type ValuationStatus } from "@/lib/valuations/compute";

/**
 * Customer-side interim valuations (applications for payment).
 *
 * Read-only, cost-free by construction. Runs on the RLS-BYPASSING admin client,
 * so every field the customer sees is assembled through `buildPortalValuationView`
 * (named scalars, no row spread, no cost/notes parameter). Only submitted /
 * certified / invoiced valuations are shown — drafts are internal.
 */

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });

type ValRow = {
  id: string;
  job_id: string;
  sequence: number;
  status: string;
  period_start: string | null;
  period_end: string | null;
  valuation_date: string;
  work_completed_to_date: number | string | null;
  materials_on_site: number | string | null;
  deductions: number | string | null;
  vat_rate: number | string | null;
  variations_total: number | string | null;
  previous_certified_gross: number | string | null;
  net_certified_this: number | string | null;
  retention_percent: number | string | null;
  invoice_id: string | null;
};

export default async function PortalValuationsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();
  // job_valuations / job_valuation_variations post-date the generated Supabase
  // types — reach them through a precise structural shim (jobs/invoices stay typed).
  type LB = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> & {
    select: (c: string) => LB;
    eq: (k: string, v: unknown) => LB;
    in: (k: string, v: unknown[]) => LB;
    order: (k: string, o: { ascending: boolean }) => LB;
    range: (f: number, t: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
  };
  const adminLoose = admin as unknown as { from: (t: string) => LB };

  // This customer's jobs (org + customer pinned), with the contract retention rate.
  const { data: jobsData, error: jobsError } = await fetchAllRows<{
    id: string;
    retention_percent: number | string | null;
  }>((from, to) =>
    admin
      .from("jobs")
      .select("id, retention_percent")
      .eq("org_id", customer.org_id)
      .eq("customer_id", customer.id)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { id: string; retention_percent: number | string | null }[] | null; error: unknown }>,
  );
  if (jobsError) throw readFailure("portal valuations: jobs", jobsError);
  const jobIds = (jobsData ?? []).map((j) => j.id);
  const rateByJob = new Map(jobsData.map((j) => [j.id, j.retention_percent]));

  let views: Array<PortalValuationView & { jobId: string }> = [];
  let invoiceNumberById = new Map<string, string>();

  if (jobIds.length > 0) {
    const { data: valData, error: valError } = await fetchAllRows<ValRow>((from, to) =>
      adminLoose
        .from("job_valuations")
        .select(
          "id, job_id, sequence, status, period_start, period_end, valuation_date, " +
            "work_completed_to_date, materials_on_site, deductions, vat_rate, " +
            "variations_total, previous_certified_gross, net_certified_this, retention_percent, invoice_id",
        )
        .eq("org_id", customer.org_id)
        .in("job_id", jobIds)
        .order("job_id", { ascending: true })
        .order("sequence", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: ValRow[] | null; error: unknown }>,
    );
    if (valError) throw readFailure("portal valuations: job_valuations", valError);

    // Live variation totals per DRAFT/SUBMITTED valuation (certified rows carry a
    // snapshot). Only amounts + valuation_id — never any cost column.
    const valIds = valData.map((v) => v.id);
    const linkTotals = new Map<string, number>();
    if (valIds.length > 0) {
      const { data: links, error: linksError } = await fetchAllRows<{
        valuation_id: string;
        amount: number | string | null;
      }>((from, to) =>
        adminLoose
          .from("job_valuation_variations")
          .select("valuation_id, amount")
          .eq("org_id", customer.org_id)
          .in("valuation_id", valIds)
          .order("valuation_id", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: { valuation_id: string; amount: number | string | null }[] | null; error: unknown }>,
      );
      if (linksError) throw readFailure("portal valuations: variation links", linksError);
      for (const l of links) {
        linkTotals.set(l.valuation_id, (linkTotals.get(l.valuation_id) ?? 0) + Number(l.amount ?? 0));
      }
    }

    // Generated invoice numbers, for the invoiced rows.
    const invoiceIds = valData.map((v) => v.invoice_id).filter((x): x is string => !!x);
    if (invoiceIds.length > 0) {
      const { data: invs, error: invsError } = await fetchAllRows<{ id: string; number: string }>((from, to) =>
        admin
          .from("invoices")
          .select("id, number")
          .eq("org_id", customer.org_id)
          .in("id", invoiceIds)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: { id: string; number: string }[] | null; error: unknown }>,
      );
      if (invsError) throw readFailure("portal valuations: invoice numbers", invsError);
      invoiceNumberById = new Map((invs ?? []).map((i) => [i.id, i.number]));
    }

    // Per-job cumulation set for projecting submitted rows.
    const byJob = new Map<string, ValRow[]>();
    for (const v of valData) (byJob.get(v.job_id) ?? byJob.set(v.job_id, []).get(v.job_id)!).push(v);

    views = valData
      .filter((v) => isPortalVisibleValuation(v.status))
      .map((v) => {
        const isCertified = v.status === "certified" || v.status === "invoiced";
        const cumulation = (byJob.get(v.job_id) ?? []).map((r) => ({
          id: r.id,
          status: r.status,
          net_certified_this: r.net_certified_this,
        }));
        const previousCertifiedGross = isCertified
          ? v.previous_certified_gross
          : sumCertifiedBase(cumulation, v.id);
        const variationsTotal = isCertified ? v.variations_total : linkTotals.get(v.id) ?? 0;
        const retentionPercent = isCertified ? v.retention_percent : rateByJob.get(v.job_id) ?? 0;
        return {
          jobId: v.job_id,
          ...buildPortalValuationView({
            id: v.id,
            sequence: v.sequence,
            status: v.status as ValuationStatus,
            periodStart: v.period_start,
            periodEnd: v.period_end,
            valuationDate: v.valuation_date,
            workCompletedToDate: v.work_completed_to_date,
            materialsOnSite: v.materials_on_site,
            variationsTotal,
            deductions: v.deductions,
            previousCertifiedGross,
            retentionPercent,
            vatRate: v.vat_rate,
            invoiceNumber: v.invoice_id ? invoiceNumberById.get(v.invoice_id) ?? null : null,
          }),
        };
      });
  }

  return (
    <PortalShell customer={customer} org={org} token={token} active="valuations">
      <div className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Valuations</h1>
          <p className="text-sm text-slate-500">Applications for payment on your projects.</p>
        </div>

        {views.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            No valuations to show yet.
          </p>
        ) : (
          <div className="space-y-3">
            {views.map((v) => (
              <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900">
                    Valuation {v.sequence}
                    {v.invoice_number ? ` · ${v.invoice_number}` : ""}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{v.status_label}</span>
                </div>
                <div className="space-y-0.5 text-sm">
                  <Row label="Value of works to date (ex-VAT)" value={v.gross_valuation} />
                  {v.variations_total > 0 ? <Row label="Included variations" value={v.variations_total} /> : null}
                  <Row label="Less previously certified" value={-v.previous_certified} />
                  <Row label="Certified this period (ex-VAT)" value={v.net_certified_this} strong />
                  {v.retention_this > 0 ? <Row label={`Less retention (${v.retention_percent}%)`} value={-v.retention_this} /> : null}
                  <Row label="VAT" value={v.vat} />
                  <Row label="Amount due for payment" value={v.amount_due} strong />
                </div>
                {v.period_end ? (
                  <p className="mt-2 text-xs text-slate-400">Period to {v.period_end}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </PortalShell>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? "font-semibold text-slate-900" : "text-slate-700"}>{GBP.format(value)}</span>
    </div>
  );
}
