import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { buildJobValuationsView } from "@/server/services/job-valuations";
import { ValuationsClient, type AvailableVariation } from "./_valuations.client";

export const dynamic = "force-dynamic";

/**
 * Interim valuations / applications for payment for one job.
 *
 * Server-rendered from the loud read (`buildJobValuationsView`) — org-pinned,
 * paged, loud. The customer-safe projection lives on the portal; this staff page
 * shows the full internal breakdown (retention position included).
 */
export default async function JobValuationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: jobId } = await params;
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const supabase = await createClient();
  type LB = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> & {
    select: (c: string) => LB;
    eq: (k: string, v: unknown) => LB;
    order: (k: string, o: { ascending: boolean }) => LB;
    range: (f: number, t: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
  };
  const db = supabase as unknown as { from: (t: string) => LB };

  // Confirm the job is in the active org (pin). By-id read — bounded to one row.
  const jobRes = await db
    .from("jobs")
    .select("id, org_id, customer_id")
    .eq("org_id", ctx.org.id)
    .eq("id", jobId)
    .range(0, 0);
  if (jobRes.error) throw readFailure("job valuations: job", jobRes.error);
  const job = jobRes.data?.[0];
  if (!job) notFound();

  const view = await buildJobValuationsView(ctx.org.id, jobId);

  // Accepted variations for this job that are (a) not already linked to any
  // valuation and (b) carry no ISSUED invoice — the candidates the guard allows.
  // All three set-reads are F-1 PAGED (fetchAllRows, org-pinned, id-ordered) and
  // LOUD (a failed read errors the page rather than showing a wrong picker).
  const pageRead = (table: string, cols: string, extra?: [string, unknown]) =>
    fetchAllRows<Record<string, unknown>>((from, to) => {
      let q = db.from(table).select(cols).eq("org_id", ctx.org.id);
      if (extra) q = q.eq(extra[0], extra[1]);
      return q.order("id", { ascending: true }).range(from, to);
    });

  const [varsRes, linksRes, invRes] = await Promise.all([
    pageRead("quotes", "id, number, variation_number, subtotal, status, job_id", ["job_id", jobId]),
    pageRead("job_valuation_variations", "id, variation_quote_id"),
    pageRead("invoices", "id, quote_id, status", ["job_id", jobId]),
  ]);
  if (varsRes.error) throw readFailure("job valuations: quotes", varsRes.error);
  if (linksRes.error) throw readFailure("job valuations: variation links", linksRes.error);
  if (invRes.error) throw readFailure("job valuations: invoices", invRes.error);

  const linkedVariationIds = new Set(
    (linksRes.data ?? []).map((l) => String(l.variation_quote_id)),
  );
  const issuedInvoiceQuoteIds = new Set(
    (invRes.data ?? [])
      .filter((i) => i.status != null && i.status !== "draft" && i.quote_id != null)
      .map((i) => String(i.quote_id)),
  );

  const availableVariations: AvailableVariation[] = (varsRes.data ?? [])
    .filter(
      (q) =>
        q.variation_number != null &&
        q.status === "accepted" &&
        !linkedVariationIds.has(String(q.id)) &&
        !issuedInvoiceQuoteIds.has(String(q.id)),
    )
    .map((q) => ({
      id: String(q.id),
      label: `Variation #${String(q.variation_number).padStart(3, "0")}${q.number ? ` (${q.number})` : ""}`,
      subtotal: Number(q.subtotal ?? 0),
    }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Valuations</h1>
          <p className="text-sm text-slate-500">Applications for payment for this job.</p>
        </div>
        <Link href={`/jobs/${jobId}`} className="text-sm text-slate-600 hover:text-slate-900">
          Back to job
        </Link>
      </div>

      {view.loadError ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Some figures couldn&apos;t be loaded, so the totals below may be incomplete. Reload to try again.
        </div>
      ) : null}

      <ValuationsClient
        jobId={jobId}
        isAdmin={isAdmin}
        view={view}
        availableVariations={availableVariations}
      />
    </div>
  );
}
