import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { QUOTE_STATUSES, type QuoteStatus } from "@/lib/quotes/schema";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { Stagger, StaggerItem } from "@/components/ui";

/**
 * Customer-side quotes list.
 *
 * Each card deep-links to the existing per-quote public page at
 * /q/<public_token>, which is where accept/decline + PDF live. No
 * duplication of that flow here — the portal is the hub, /q/[token]
 * is the single source of truth for the per-quote action.
 *
 * Filter via search params: ?status=<one of QUOTE_STATUSES>.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<QuoteStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-700",
  sent: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-slate-200 text-slate-600",
};

type SP = Promise<{ status?: string }>;

export default async function PortalQuotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();
  // Wave 2 — customer portal only ever shows quotes that have cleared
  // the approval gate. Draft / pending_approval / rejected stay private.
  let q = admin
    .from("quotes")
    .select(
      "id, number, status, total, subtotal, vat_total, valid_until, sent_at, accepted_at, declined_at, public_token, created_at",
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .in("status", ["approved", "sent", "viewed", "accepted", "declined", "expired"])
    .order("created_at", { ascending: false })
    .limit(200);

  if (sp.status && (QUOTE_STATUSES as readonly string[]).includes(sp.status)) {
    q = q.eq("status", sp.status);
  }

  const { data: quotes } = await q;
  const rows = quotes ?? [];

  // Render-friendly visible statuses — same list as the internal app.
  const filterOptions = ["", ...QUOTE_STATUSES];

  return (
    <PortalShell customer={customer} org={org} token={token} active="quotes">
      {/* Filter */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
      >
        <div>
          <label className="block text-xs font-medium text-slate-700">Status</label>
          <select
            name="status"
            defaultValue={sp.status ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {filterOptions.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All"}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href={`/customer-portal/${token}/quotes`}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {rows.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No quotes yet</p>
          <p className="mt-1 text-xs text-slate-500">
            When {org.name} sends you a quote, it&apos;ll appear here.
          </p>
        </section>
      ) : (
        <Stagger className="space-y-3">
          {rows.map((q) => {
            const status = (q.status as QuoteStatus) ?? "draft";
            const canAct = status === "draft" || status === "sent" || status === "viewed";
            return (
              <StaggerItem
                key={q.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/q/${q.public_token}`}
                      className="block text-base font-semibold text-slate-900 hover:text-slate-700"
                    >
                      {q.number}
                    </Link>
                    <p className="mt-1 text-xs text-slate-500">
                      Sent {q.sent_at?.slice(0, 10) ?? "—"}
                      {q.valid_until ? ` · Valid until ${q.valid_until}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {status}
                    </span>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      {GBP.format(Number(q.total ?? 0))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {canAct ? (
                    <Link
                      href={`/q/${q.public_token}`}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                    >
                      View &amp; respond
                    </Link>
                  ) : (
                    <Link
                      href={`/q/${q.public_token}`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      View
                    </Link>
                  )}
                  <a
                    href={`/q/${q.public_token}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    PDF
                  </a>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}
    </PortalShell>
  );
}
