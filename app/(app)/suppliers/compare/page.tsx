import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";
import {
  COMPARISON_SUPPLIER_LIMIT,
  listSupplierPerformance,
  type PerformanceClient,
} from "@/server/services/supplier-performance";
import {
  MIN_RATED_SAMPLE,
  formatRateCompact,
  isRated,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";
import { formatGbp } from "@/lib/money";
import { Badge, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { HowMeasured, NotMeasuredSection } from "../_performance-sections";
import { EmptyState } from "../../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Compare suppliers · CrewFlow" };

/**
 * /suppliers/compare — the buying decision, side by side.
 *
 * A static sibling of /suppliers/[id], the same shape /suppliers/new already
 * uses; supplier ids are uuids so no real row is shadowed by the literal
 * segment.
 *
 * ── WHY THERE IS NO "BEST SUPPLIER" ────────────────────────────────────────
 * This page will not rank suppliers for you, and the reason is the whole design
 * constraint of the feature. The columns count DIFFERENT things over DIFFERENT
 * denominators, and one of them ("settled within") measures US. A single
 * ordering would need weights — how many late deliveries equal one over-invoiced
 * order — and no such exchange rate exists in your data. What this page does
 * instead is let you SORT by one named column at a time, so the criterion is
 * always visible and always yours. Every sort states what it sorted on.
 *
 * Suppliers with no trading record are shown, marked, and always sorted LAST
 * whatever the column: an untried merchant has no record, and a blank row must
 * never read as a clean one.
 *
 * ORG-PINNED. `listSuppliersForOrg` scopes the roster and
 * `listSupplierPerformance` scopes every underlying read, because the same
 * merchant account is routinely shared between an owner's two companies — the
 * defect class #456/#459/#461/#463/#464/#468 closed on the read side.
 */

/** The columns a buyer may sort on. Each names its own criterion in the UI. */
const SORTS = {
  name: "Supplier name",
  late: "Late delivery rate",
  deliveries: "Number of deliveries",
  split: "Split delivery rate",
  overbilled: "Invoiced-over rate",
} as const;

type SortKey = keyof typeof SORTS;

function isSortKey(v: unknown): v is SortKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SORTS, v);
}

/**
 * Sort comparators.
 *
 * A ratio with no earned rate sorts as UNKNOWN, not as zero: a supplier with one
 * on-time delivery must not outrank one with fifty, and treating `pct: null` as
 * 0 would put every thin record at the top of a "least late" list. Unknown goes
 * last, and empty records go after that.
 */
function compareBy(key: SortKey) {
  const rate = (p: SupplierPerformance, pick: (x: SupplierPerformance) => number | null) => {
    const v = pick(p);
    return v === null ? Number.POSITIVE_INFINITY : v;
  };
  return (a: SupplierPerformance, b: SupplierPerformance): number => {
    // Empty records are always last, whatever the column.
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    switch (key) {
      case "late": {
        const d =
          rate(a, (x) => x.delivery.punctuality.pct) - rate(b, (x) => x.delivery.punctuality.pct);
        return d !== 0 ? d : a.supplierName.localeCompare(b.supplierName);
      }
      case "split": {
        const d =
          rate(a, (x) => x.delivery.splitDeliveries.pct) -
          rate(b, (x) => x.delivery.splitDeliveries.pct);
        return d !== 0 ? d : a.supplierName.localeCompare(b.supplierName);
      }
      case "overbilled": {
        const d = rate(a, (x) => x.price.overBilled.pct) - rate(b, (x) => x.price.overBilled.pct);
        return d !== 0 ? d : a.supplierName.localeCompare(b.supplierName);
      }
      case "deliveries": {
        const d = b.delivery.deliveries - a.delivery.deliveries;
        return d !== 0 ? d : a.supplierName.localeCompare(b.supplierName);
      }
      case "name":
      default:
        return a.supplierName.localeCompare(b.supplierName);
    }
  };
}

const SORT_EXPLANATION: Record<SortKey, string> = {
  name: "Sorted alphabetically. No judgement applied.",
  late: `Sorted by late delivery rate, lowest first. Suppliers with fewer than ${MIN_RATED_SAMPLE} comparable deliveries have no rate and appear after those that do.`,
  deliveries: "Sorted by number of posted deliveries, most first — how much evidence there is, not how good it is.",
  split: `Sorted by split delivery rate, lowest first. Suppliers with fewer than ${MIN_RATED_SAMPLE} delivered orders have no rate and appear after those that do.`,
  overbilled: `Sorted by how often invoices exceed the order, lowest first. Suppliers with fewer than ${MIN_RATED_SAMPLE} billed orders have no rate and appear after those that do.`,
};

type SP = Promise<{ sort?: string }>;

export default async function CompareSuppliersPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;
  const sort: SortKey = isSortKey(sp.sort) ? sp.sort : "name";

  const suppliers = await listSuppliersForOrg<{ id: string; name: string }>(
    supabase as unknown as SuppliersClient,
    ctx.org.id,
    { columns: "id, name", limit: COMPARISON_SUPPLIER_LIMIT },
  );

  const rows = await listSupplierPerformance(
    supabase as unknown as PerformanceClient,
    ctx.org.id,
    suppliers,
  );
  const sorted = [...rows].sort(compareBy(sort));
  const withRecord = sorted.filter((r) => !r.empty).length;
  const atCap = suppliers.length >= COMPARISON_SUPPLIER_LIMIT;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Compare suppliers</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          What each supplier has actually done, counted from your own orders, deliveries and bills.
          There is no overall score and no recommendation &mdash; pick the column that matters for
          the job you are buying for and sort by it.
        </p>
      </header>

      {suppliers.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📋"
            title="No suppliers yet"
            body="Add the merchants and subcontractors you buy from, then raise orders against them. Their delivery and invoicing record builds itself from the paperwork you already file."
            primary={{ href: "/suppliers/new", label: "Add a supplier" }}
          />
        </div>
      ) : (
        <>
          <nav aria-label="Sort suppliers" className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Sort by
            </span>
            {(Object.keys(SORTS) as SortKey[]).map((key) => {
              const active = key === sort;
              return (
                <Link
                  key={key}
                  href={`/suppliers/compare?sort=${key}`}
                  aria-current={active ? "true" : undefined}
                  className={
                    // min-h-[44px] because these are the only controls on the
                    // page and they are thumb targets at 375px — the same floor
                    // the rest of the supplier domain uses for its action links.
                    active
                      ? "inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                      : "inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  }
                >
                  {SORTS[key]}
                </Link>
              );
            })}
          </nav>

          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {SORT_EXPLANATION[sort]}
          </p>

          <HowMeasured />

          {/* overflow-hidden so the card's rounded corners clip the table's own
              horizontal scroll container at 375px, matching /suppliers. */}
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <Table>
              <THead>
                <TR hover={false}>
                  <TH>Supplier</TH>
                  <TH numeric>Deliveries</TH>
                  <TH numeric>Late</TH>
                  <TH numeric hideBelow="sm">
                    Split
                  </TH>
                  <TH numeric hideBelow="md">
                    Invoiced over
                  </TH>
                  <TH numeric hideBelow="lg">
                    Over-invoiced
                  </TH>
                  <TH numeric hideBelow="lg">
                    Settled bills
                  </TH>
                </TR>
              </THead>
              <TBody>
                {sorted.map((r) => (
                  <TR key={r.supplierId}>
                    <TD>
                      <Link
                        href={`/suppliers/${r.supplierId}/performance`}
                        className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                      >
                        {r.supplierName}
                      </Link>
                      {r.empty ? (
                        <span className="ml-2 align-middle">
                          <Badge tone="slate">No record</Badge>
                        </span>
                      ) : null}
                    </TD>
                    <TD numeric muted>
                      {r.delivery.deliveries || "—"}
                    </TD>
                    <TD numeric>
                      <RateCell
                        text={formatRateCompact(r.delivery.punctuality)}
                        rated={isRated(r.delivery.punctuality)}
                      />
                    </TD>
                    <TD numeric hideBelow="sm">
                      <RateCell
                        text={formatRateCompact(r.delivery.splitDeliveries)}
                        rated={isRated(r.delivery.splitDeliveries)}
                      />
                    </TD>
                    <TD numeric hideBelow="md">
                      <RateCell
                        text={formatRateCompact(r.price.overBilled)}
                        rated={isRated(r.price.overBilled)}
                      />
                    </TD>
                    <TD numeric muted hideBelow="lg">
                      {r.price.overBilledExcess > 0 ? formatGbp(r.price.overBilledExcess) : "—"}
                    </TD>
                    <TD numeric muted hideBelow="lg">
                      {r.settlement.n || "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </section>

          <p className="text-xs text-slate-500">
            {withRecord} of {suppliers.length} suppliers have a trading record in this company.
            A cell reading <span className="font-medium">3/4</span> is a count with no rate: fewer
            than {MIN_RATED_SAMPLE} comparable records, so a percentage would overstate what is
            known. A dash means nothing comparable has been recorded at all.
            {atCap
              ? ` Showing the first ${COMPARISON_SUPPLIER_LIMIT} suppliers by name — you have at least that many.`
              : ""}
          </p>

          <NotMeasuredSection />
        </>
      )}
    </div>
  );
}

/**
 * A rate cell. An unrated figure is rendered in the muted colour so a bare
 * count is visually distinct from an earned percentage at a glance — without a
 * tone, which on an aggregate would be a grade (see _performance-sections.tsx).
 */
function RateCell({ text, rated }: { text: string; rated: boolean }) {
  return <span className={rated ? "font-medium text-slate-900" : "text-slate-500"}>{text}</span>;
}
