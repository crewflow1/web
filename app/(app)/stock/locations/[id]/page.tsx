import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  listStockItems,
  listStockMovements,
  type StockClient,
} from "@/server/services/stock";
import { loadSiteForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { foldSiteBalances, stockLevel } from "@/lib/stock/balance";
import { formatQuantity } from "@/lib/stock/movements";
import { formatSiteAddress, siteKindLabel } from "@/lib/sites/schema";
import { AccountingNote, Card, CardHeader, Effect, LevelPill, MovementPill, Qty } from "../../_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock at a location · CrewFlow" };

/**
 * /stock/locations/[id] — what is at one place, and what has moved through it.
 *
 * A SITE-SHAPED VIEW OF THE SAME LEDGER. There is no per-location table and no
 * per-location balance stored anywhere: this folds the movements for this site
 * with the same pure function the item pages use, so the two surfaces can never
 * print different numbers for the same yard.
 *
 * ORG-PINNED on both reads. A site in the caller's other org is deliberately
 * indistinguishable from one that does not exist.
 *
 * A JOB IS NOT A LOCATION and never appears here (20261061000000 excludes job
 * sites from `sites`, and an issue to a job is consumption with job provenance
 * rather than a transfer into a job-shaped place). "What went to that job" is
 * answered on the job, from the same movements.
 */
type Params = Promise<{ id: string }>;

export default async function StockLocationPage({ params }: { params: Params }) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const db = supabase as unknown as StockClient;

  const site = await loadSiteForOrg<SiteRow>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    id,
  );
  if (!site) notFound();

  const [movements, items] = await Promise.all([
    listStockMovements(db, ctx.org.id, { siteId: id }),
    listStockItems(db, ctx.org.id),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const balances = foldSiteBalances(movements);

  const held = [...balances.values()]
    .map((b) => {
      const item = itemById.get(b.stockItemId);
      return {
        ...b,
        name: item?.name ?? "Unknown item",
        unit: item?.unit?.trim() || "ea",
        level: stockLevel(b.quantity, item?.reorder_level ?? null),
      };
    })
    .sort(
      (a, b) =>
        Number(b.quantity !== 0) - Number(a.quantity !== 0) ||
        a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
        a.stockItemId.localeCompare(b.stockItemId),
    );

  const holding = held.filter((h) => h.quantity !== 0);
  const emptied = held.filter((h) => h.quantity === 0);
  const address = formatSiteAddress(site);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link href="/stock" className="text-sm text-slate-500 hover:text-slate-700">
          ← Stock
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{site.name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {siteKindLabel(site.kind)}
              {address ? ` · ${address}` : ""}
              {site.active ? "" : " · retired"}
            </p>
          </div>
          <Link
            href={`/sites/${site.id}`}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Site details
          </Link>
        </div>
      </header>

      <AccountingNote />

      <Card>
        <CardHeader
          title="What is here"
          hint={`${holding.length} ${holding.length === 1 ? "item" : "items"} with something on hand.`}
        />
        {holding.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {movements.length === 0
              ? "No stock has ever moved through this place."
              : "Everything that came here has since gone out again."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {holding.map((h) => (
              <li key={h.stockItemId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/stock/items/${h.stockItemId}`}
                    className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                  >
                    {h.name}
                  </Link>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <LevelPill level={h.level} />
                  <span className={`text-sm font-medium ${h.quantity < 0 ? "text-red-700" : "text-slate-900"}`}>
                    <Qty value={h.quantity} unit={h.unit} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {emptied.length > 0 ? (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            {emptied.length} other {emptied.length === 1 ? "item has" : "items have"} been here
            before and {emptied.length === 1 ? "is" : "are"} now at zero:{" "}
            {emptied
              .slice(0, 6)
              .map((h) => h.name)
              .join(", ")}
            {emptied.length > 6 ? "…" : ""}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="What has moved through" hint="Newest first." />
        {movements.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {movements.slice(0, 60).map((m) => {
              const item = itemById.get(m.stock_item_id);
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/stock/items/${m.stock_item_id}`}
                      className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                    >
                      {item?.name ?? "Item"}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {(m.occurred_at ?? "").slice(0, 16).replace("T", " ")}
                      {m.notes ? ` · ${m.notes}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <MovementPill type={m.movement_type} />
                    <Effect row={m} unit={item?.unit?.trim() || "ea"} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {movements.length > 60 ? (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Showing the most recent 60 of {formatQuantity(movements.length)} movements.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
