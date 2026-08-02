import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadStockPositions, type StockClient } from "@/server/services/stock";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import {
  listVanLocations,
  listVehicleOptions,
  type VanStockClient,
} from "@/server/services/van-stock";
import { summariseVanStock, vehiclesWithoutStock } from "@/lib/stock/van";
import { formatQuantity } from "@/lib/stock/movements";
import { AccountingNote, Card, CardHeader } from "../_components/ui";
import { EmptyState } from "../../_components/empty-state";
import { EnableVanForm, MoveVanStockPanel } from "./_van-forms";

export const dynamic = "force-dynamic";

export const metadata = { title: "Van stock · CrewFlow" };

/**
 * /stock/vans — stock held on vehicles.
 *
 * A van is a stock LOCATION (a `sites` row, kind = 'vehicle', 20261102000000),
 * so everything here is folded from the SAME movement ledger as every other
 * place: the per-van totals come through loadStockPositions, and a van's detail
 * page is the existing /stock/locations/[id] — no per-van table, no second
 * balance. ORG-PINNED on every read (server/services/*).
 *
 * THE ACCOUNTING BOUNDARY: a van holds a quantity, never a value. Loading a van
 * is a transfer and posts no cost — the material was expensed when the
 * supplier's bill was recorded.
 */

const SAVED: Record<string, string> = {
  enabled: "Van set up for stock.",
  loaded: "Stock loaded onto the van.",
  returned: "Stock returned to the depot.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function VanStockPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const canEnable = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const [{ items, balances }, vans, vehicles, sites] = await Promise.all([
    loadStockPositions(supabase as unknown as StockClient, ctx.org.id),
    listVanLocations(supabase as unknown as VanStockClient, ctx.org.id),
    listVehicleOptions(supabase as unknown as VanStockClient, ctx.org.id),
    listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id),
  ]);

  const holdings = summariseVanStock(vans, balances);
  const enableable = vehiclesWithoutStock(vehicles, vans);

  // Destinations for load/return: the company's real locations (depots, yards,
  // lock-ups), never another van and never a retired site.
  const depots = sites
    .filter((s) => s.kind !== "vehicle" && s.active)
    .map((s) => ({ id: s.id, name: s.name }));
  const liveVans = vans.filter((v) => v.active).map((v) => ({ id: v.id, name: v.name }));
  const itemOptions = items
    .filter((i) => i.active)
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit?.trim() || "ea" }));

  const saved = sp.saved ? SAVED[sp.saved] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Van stock</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Treat a van like any other place you hold stock. Load it from a depot, use it on jobs,
            and return what comes back — every number worked out from the same movement history.
          </p>
        </div>
        <Link
          href="/stock"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← Stock
        </Link>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}

      <AccountingNote />

      {vans.length === 0 ? (
        <Card>
          <EmptyState
            icon="🚐"
            title="No vans set up for stock yet"
            body={
              <>
                Set a vehicle up as a stock location and CrewFlow keeps its running count the same
                way it does for a yard — loaded from a depot, used on jobs, topped up and returned.
                {canEnable ? null : (
                  <span className="mt-2 block text-xs text-slate-500">
                    Ask an owner or admin to set a van up for stock.
                  </span>
                )}
              </>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader title="Vans holding stock" hint="Counted from the movement history." />
          <ul className="divide-y divide-slate-100">
            {holdings.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/stock/locations/${v.id}`}
                    className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                  >
                    {v.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {v.active ? "Vehicle" : "Vehicle · retired"} · {v.lines}{" "}
                    {v.lines === 1 ? "item" : "items"}
                  </p>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-slate-600">
                  {formatQuantity(v.quantity)} units
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {liveVans.length > 0 ? (
        <Card>
          <CardHeader title="Move stock" hint="Load a van from a depot, or return what comes back." />
          <div className="p-4">
            <MoveVanStockPanel vans={liveVans} depots={depots} items={itemOptions} />
          </div>
        </Card>
      ) : null}

      {canEnable ? (
        <Card>
          <CardHeader
            title="Set a van up for stock"
            hint="Makes a fleet vehicle a place you can hold stock at."
          />
          <div className="p-4">
            <EnableVanForm vehicles={enableable} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
