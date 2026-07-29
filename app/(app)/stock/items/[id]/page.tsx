import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  listStockMovements,
  loadStockItem,
  type StockClient,
} from "@/server/services/stock";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { listJobOptions } from "@/app/(app)/diary/_data";
import { balanceKey, foldSiteBalances, stockLevel } from "@/lib/stock/balance";
import { formatQuantity } from "@/lib/stock/movements";
import { round2, toPounds } from "@/lib/money";
import { siteKindLabel } from "@/lib/sites/schema";
import { setStockItemActive } from "../../actions";
import {
  AccountingNote,
  Card,
  CardHeader,
  Effect,
  LevelPill,
  MovementPill,
  Qty,
} from "../../_components/ui";
import { CorrectMovementForm, MoveStockPanel } from "./_move-forms";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock item · CrewFlow" };

/**
 * /stock/items/[id] — one item: where it is, and everything that ever happened
 * to it.
 *
 * ORG-PINNED: `loadStockItem` and `listStockMovements` both carry
 * `.eq("org_id", ctx.org.id)` on top of RLS, and an item in the caller's OTHER
 * org is deliberately indistinguishable from one that does not exist — this
 * page `notFound()`s either way.
 *
 * BALANCES ARE DERIVED HERE, from the same movement rows the history renders,
 * by the same pure fold the overview uses. One read, one fold, one number: the
 * balance beside the history can never disagree with the history.
 *
 * THE ACCOUNTING BOUNDARY: quantities only. Nothing on this page has a value,
 * and issuing to a job adds no cost — the material was costed when the
 * supplier's bill was recorded.
 */

const SAVED: Record<string, string> = {
  issued: "Stock issued.",
  transferred: "Stock moved.",
  adjusted: "Count recorded.",
  corrected: "Movement reversed.",
  retired: "Item retired — it stays on every movement that already names it.",
  reinstated: "Item back in use.",
};

const ERRORS: Record<string, string> = {
  forbidden: "You can't change that item in this organisation.",
  save_failed: "Couldn't save. Try again.",
};

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

export default async function StockItemPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const db = supabase as unknown as StockClient;

  const item = await loadStockItem(db, ctx.org.id, id);
  if (!item) notFound();

  const [movements, sites, jobs] = await Promise.all([
    listStockMovements(db, ctx.org.id, { itemId: id }),
    listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id),
    listJobOptions(ctx.org.id),
  ]);

  const balances = foldSiteBalances(movements);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const total = round2(
    [...balances.values()].reduce((acc, b) => acc + b.quantity, 0),
  );
  const level = stockLevel(total, item.reorder_level);
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const unit = item.unit?.trim() || "ea";

  // The picker shows every ACTIVE site with its current balance, so "issue 40
  // from the lock-up" is checkable before submitting. Sites holding nothing are
  // still offered — that is where a transfer sends stock TO.
  const siteOptions = sites
    .filter((s) => s.active)
    .map((s) => ({
      id: s.id,
      name: s.name,
      balance: balances.get(balanceKey(item.id, s.id))?.quantity ?? 0,
    }))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id));

  const held = [...balances.values()]
    .filter((b) => b.quantity !== 0)
    .map((b) => ({ ...b, name: siteById.get(b.siteId)?.name ?? "Unknown site" }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "en-GB") || a.siteId.localeCompare(b.siteId));

  const jobLabel = new Map(jobs.map((j) => [j.id, j.label]));
  const correctedIds = new Set(
    movements.map((m) => m.corrects_movement_id).filter((v): v is string => Boolean(v)),
  );

  const saved = sp.saved ? SAVED[sp.saved] : null;
  const error = sp.error ? ERRORS[sp.error] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link href="/stock/items" className="text-sm text-slate-500 hover:text-slate-700">
          ← Stock items
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{item.name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Counted in {unit}
              {item.sku ? ` · code ${item.sku}` : ""}
              {item.active ? "" : " · retired"}
            </p>
            {item.description ? (
              <p className="mt-1 text-sm text-slate-500">{item.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LevelPill level={level} />
            <Link
              href={`/stock/items/${item.id}/edit`}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Edit
            </Link>
          </div>
        </div>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">On hand</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {formatQuantity(total)} <span className="text-base font-normal text-slate-500">{unit}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Across {held.length} {held.length === 1 ? "place" : "places"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Reorder at</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {item.reorder_level === null ? "—" : formatQuantity(item.reorder_level)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {item.reorder_level === null ? "Never flagged" : "Flagged at or below this"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Target</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {item.target_level === null ? "—" : formatQuantity(item.target_level)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {item.target_level === null
              ? "No target set"
              : total >= round2(toPounds(item.target_level))
                ? "Fully stocked"
                : `${formatQuantity(round2(toPounds(item.target_level)) - total)} ${unit} to reach it`}
          </p>
        </Card>
      </div>

      <AccountingNote />

      {item.active ? (
        <MoveStockPanel
          itemId={item.id}
          unit={unit}
          sites={siteOptions}
          jobs={jobs}
          canAdjust={isAdmin}
        />
      ) : (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          This item is retired, so it can&rsquo;t be moved. Put it back in use below if you have
          started buying it again.
        </p>
      )}

      <Card>
        <CardHeader title="Where it is" hint="Only places currently holding some." />
        {held.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            None of this anywhere right now.
            {movements.length > 0 ? " Everything that came in has gone out again." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {held.map((h) => {
              const site = siteById.get(h.siteId);
              return (
                <li key={h.siteId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/stock/locations/${h.siteId}`}
                      className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                    >
                      {h.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {site ? siteKindLabel(site.kind) : "Site"}
                      {site && !site.active ? " · retired" : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 text-sm font-medium ${h.quantity < 0 ? "text-red-700" : "text-slate-900"}`}>
                    <Qty value={h.quantity} unit={unit} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="History"
          hint="Newest first. Nothing here can be edited or deleted — a mistake is reversed, and both entries stay."
        />
        {movements.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nothing has moved yet. Take a delivery into stock from a purchase order, or record what
            is on the shelf with a count.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {movements.map((m) => {
              const reversed = correctedIds.has(m.id);
              return (
                <li key={m.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <MovementPill type={m.movement_type} />
                        {reversed ? (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            reversed
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm text-slate-700">
                        {siteById.get(m.site_id)?.name ?? "Unknown site"}
                        <span className="text-slate-400"> · </span>
                        <span className="text-xs text-slate-500">
                          {(m.occurred_at ?? "").slice(0, 16).replace("T", " ")}
                        </span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                        {m.job_id ? (
                          <Link href={`/jobs/${m.job_id}`} className="underline hover:text-slate-800">
                            {jobLabel.get(m.job_id) ?? "Job"}
                          </Link>
                        ) : null}
                        {m.grn_line_id ? <span>From a booked-in delivery</span> : null}
                        {m.transfer_group_id ? <span>Part of a transfer</span> : null}
                        {m.material_request_line_id ? <span>Against a material request</span> : null}
                      </p>
                      {m.notes ? (
                        <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{m.notes}</p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <Effect row={m} unit={unit} />
                      {!reversed && m.movement_type !== "correction" ? (
                        <div className="mt-1">
                          <CorrectMovementForm
                            itemId={item.id}
                            movementId={m.id}
                            summary={`${formatQuantity(m.qty)} ${unit}`}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={item.active ? "Retire this item" : "Put it back in use"}
          hint={
            item.active
              ? "It leaves every picker and stops being flagged, but stays on every movement that already names it. There is no delete — the history is permanent."
              : "It reappears in the pickers and can be moved again."
          }
        />
        <form action={setStockItemActive} className="px-4 py-4">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="active" value={item.active ? "false" : "true"} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {item.active ? "Retire item" : "Put back in use"}
          </button>
        </form>
      </Card>
    </div>
  );
}
