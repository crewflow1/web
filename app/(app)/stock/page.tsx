import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadStockPositions, type StockClient } from "@/server/services/stock";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { summariseStock } from "@/lib/stock/balance";
import { formatQuantity } from "@/lib/stock/movements";
import { siteKindLabel } from "@/lib/sites/schema";
import { EmptyState } from "../_components/empty-state";
import { AccountingNote, Card, CardHeader, Effect, LevelPill, MovementPill, Qty, Tile } from "./_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock · CrewFlow" };

/**
 * /stock — the operational stock command centre.
 *
 * ORG-PINNED: every read goes through server/services/stock.ts, which carries
 * `.eq("org_id", ctx.org.id)` on top of RLS — `current_org_ids()` admits every
 * org the viewer belongs to, so a dual-org member's stock would otherwise blend
 * two companies' yards into one balance.
 *
 * EVERY TILE IS A REAL NUMBER. There are no placeholder metrics, no "coming
 * soon" cards and no derived-looking figures that are actually constants: each
 * one is a count of rows this page has in hand, computed by the same pure
 * module the item pages use, so two surfaces can never print different totals.
 *
 * THE ACCOUNTING BOUNDARY: nothing here shows a value, because stock has none
 * in this milestone. Materials are expensed once, when the supplier's bill is
 * recorded; a movement is a quantity changing place.
 */

const SAVED: Record<string, string> = {
  issued: "Stock issued.",
  transferred: "Stock transferred.",
  adjusted: "Stock adjusted.",
  corrected: "Movement reversed.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function StockPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const [{ items, movements, balances, positions }, sites] = await Promise.all([
    loadStockPositions(supabase as unknown as StockClient, ctx.org.id),
    listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id),
  ]);

  const summary = summariseStock(positions, balances);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const attention = positions.filter((p) => p.active && (p.level === "out" || p.level === "low"));
  const recent = movements.slice(0, 12);

  // Per-location holdings, from the SAME fold the tiles use.
  const perSite = new Map<string, { lines: number; quantity: number }>();
  for (const b of balances.values()) {
    if (b.quantity === 0) continue;
    const current = perSite.get(b.siteId) ?? { lines: 0, quantity: 0 };
    current.lines += 1;
    current.quantity += b.quantity;
    perSite.set(b.siteId, current);
  }
  const locations = [...perSite.entries()]
    .map(([siteId, v]) => ({ siteId, ...v, name: siteById.get(siteId)?.name ?? "Unknown site" }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) || a.siteId.localeCompare(b.siteId));

  const saved = sp.saved ? SAVED[sp.saved] : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Stock</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            What you hold, where you hold it, and what has moved. Every number is worked out from
            the movement history — nothing is typed in twice.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/stock/stocktake"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Stocktake
          </Link>
          <Link
            href="/stock/replenishment"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Replenishment
          </Link>
          <Link
            href="/stock/vans"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Van stock
          </Link>
          <Link
            href="/stock/items"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            All items
          </Link>
          <Link
            href="/stock/items/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add item
          </Link>
        </div>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}

      <AccountingNote />

      {items.length === 0 ? (
        <>
          <Card>
            <EmptyState
              icon="📦"
              title="Nothing tracked yet"
              body={
                <>
                  Stock is the stuff you buy in bulk and use across jobs — cement, fixings, cable,
                  membrane. Name it once, and CrewFlow keeps the running count for every yard,
                  container and lock-up you have.
                  <span className="mt-2 block text-xs text-slate-500">
                    Deliveries you have already booked in can be taken straight into stock from the
                    purchase order — nothing is retyped.
                  </span>
                </>
              }
              primary={{ href: "/stock/items/new", label: "Add your first item" }}
              secondary={{ href: "/purchase-orders", label: "See purchase orders" }}
            />
          </Card>

          <Card>
            <CardHeader title="What tracking stock gives you" />
            <ul className="divide-y divide-slate-100 text-sm">
              <Unlock
                title="An answer to “have we got any?”"
                body="Before someone drives to the merchant. Per yard, per container, counted from what actually moved."
              />
              <Unlock
                title="A low-stock nudge, on your terms"
                body="Set a reorder level on the things that matter and CrewFlow tells you when you hit it. Leave it blank on everything else and it stays quiet."
              />
              <Unlock
                title="Where it went"
                body="Issue to a job and the history says which job, who did it and when. No new cost is added — the bill already did that."
              />
              <Unlock
                title="A count you can trust"
                body="Movements can never be edited or deleted. A mistake is reversed with a reason, and both entries stay visible."
              />
            </ul>
          </Card>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Items tracked" value={summary.activeItems} href="/stock/items" />
            <Tile
              label="Out of stock"
              value={summary.outOfStock}
              tone={summary.outOfStock > 0 ? "bad" : "plain"}
            />
            <Tile
              label="Low"
              value={summary.lowStock}
              tone={summary.lowStock > 0 ? "warn" : "plain"}
              hint="At or below reorder level"
            />
            <Tile label="Places holding stock" value={summary.sitesHolding} />
          </div>

          {attention.length > 0 ? (
            <Card>
              <CardHeader
                title="Needs ordering"
                hint="Out of stock first, then anything at or below its reorder level."
                action={
                  <Link
                    href="/stock/replenishment"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Review &amp; re-order
                  </Link>
                }
              />
              <ul className="divide-y divide-slate-100">
                {attention.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div className="min-w-0">
                      <Link
                        href={`/stock/items/${p.id}`}
                        className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                      >
                        {p.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-slate-500">
                        <Qty value={p.available} unit={p.unit} /> on hand
                        {p.reorderLevel !== null ? ` · reorder at ${formatQuantity(p.reorderLevel)}` : ""}
                        {p.shortfall !== null && p.shortfall > 0
                          ? ` · ${formatQuantity(p.shortfall)} to reach target`
                          : ""}
                      </p>
                    </div>
                    <LevelPill level={p.level} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <Card>
              <CardHeader title="Needs ordering" />
              <p className="px-4 py-6 text-sm text-slate-500">
                Nothing is out or below its reorder level.
                {positions.some((p) => p.reorderLevel === null)
                  ? " Some items have no reorder level set, so they are never flagged."
                  : ""}
              </p>
            </Card>
          )}

          <Card>
            <CardHeader title="Where it is" hint="Only places currently holding something." />
            {locations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                Nothing is in stock anywhere yet. Take a delivery into stock from a purchase order,
                or record an opening count on an item.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {locations.map((loc) => {
                  const site = siteById.get(loc.siteId);
                  return (
                    <li key={loc.siteId} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/stock/locations/${loc.siteId}`}
                          className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                        >
                          {loc.name}
                        </Link>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {site ? siteKindLabel(site.kind) : "Site"} · {loc.lines}{" "}
                          {loc.lines === 1 ? "item" : "items"}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-slate-600">
                        {formatQuantity(loc.quantity)} units
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent movements" hint="Newest first. Nothing here can be edited." />
            {recent.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">Nothing has moved yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recent.map((m) => {
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
                          {siteById.get(m.site_id)?.name ?? "Site"} ·{" "}
                          {(m.occurred_at ?? "").slice(0, 10)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <MovementPill type={m.movement_type} />
                        <Effect row={m} unit={item?.unit ?? undefined} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Unlock({ title, body }: { title: string; body: string }) {
  return (
    <li className="px-4 py-3">
      <p className="font-medium text-slate-900">{title}</p>
      <p className="mt-0.5 text-xs text-slate-500">{body}</p>
    </li>
  );
}
