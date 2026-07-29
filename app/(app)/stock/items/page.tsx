import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadStockPositions, type StockClient } from "@/server/services/stock";
import { formatQuantity } from "@/lib/stock/movements";
import { EmptyState } from "../../_components/empty-state";
import { AccountingNote, Card, CardHeader, LevelPill, Qty } from "../_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stock items · CrewFlow" };

/**
 * /stock/items — the catalogue register.
 *
 * ORG-PINNED via server/services/stock.ts (see that file's header).
 *
 * TOTAL ORDER. `buildItemPositions` sorts by level, then name, then `id` — the
 * id tiebreaker is what makes the page render identically for any permutation
 * the read returns, so paging can never show the same row twice or skip one.
 * The ordering discipline is the one lib/operations/compose.ts sets out.
 *
 * Paged in TypeScript rather than by `.range()` because the balances are folded
 * from the movement ledger in this process — a database-side page would have to
 * order by a column that does not exist. STOCK_ITEM_LIMIT (1000) is the real
 * bound, and the note in server/services/stock.ts records what to do if a
 * tenant ever outgrows it.
 */

const PAGE_SIZE = 25;

type SP = Promise<{ page?: string; show?: string }>;

export default async function StockItemsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const { items, positions } = await loadStockPositions(
    supabase as unknown as StockClient,
    ctx.org.id,
  );

  const showRetired = sp.show === "retired";
  const filtered = positions.filter((p) => (showRetired ? !p.active : p.active));
  const retiredCount = positions.filter((p) => !p.active).length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(sp.page ?? "1") || 1), totalPages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const qs = (next: Record<string, string>) => {
    const params = new URLSearchParams();
    if (showRetired) params.set("show", "retired");
    for (const [k, v] of Object.entries(next)) params.set(k, v);
    const s = params.toString();
    return s ? `/stock/items?${s}` : "/stock/items";
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Stock items</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            The catalogue. Each item carries its own unit and its own reorder level; the quantity
            comes from the movement history and is never typed in.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/stock"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Overview
          </Link>
          <Link
            href="/stock/items/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add item
          </Link>
        </div>
      </header>

      <AccountingNote />

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon="📦"
            title="No items yet"
            body="Name the things you keep a running count of — cement, fixings, cable, membrane. Everything else stays on the purchase order where it belongs."
            primary={{ href: "/stock/items/new", label: "Add your first item" }}
            secondary={{ href: "/stock", label: "Back to stock" }}
          />
        </Card>
      ) : (
        <>
          {retiredCount > 0 ? (
            <nav className="flex gap-2 text-sm">
              <Link
                href="/stock/items"
                aria-current={!showRetired ? "page" : undefined}
                className={
                  showRetired
                    ? "rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                    : "rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white"
                }
              >
                In use
              </Link>
              <Link
                href="/stock/items?show=retired"
                aria-current={showRetired ? "page" : undefined}
                className={
                  showRetired
                    ? "rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white"
                    : "rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                }
              >
                Retired ({retiredCount})
              </Link>
            </nav>
          ) : null}

          {rows.length === 0 ? (
            <Card>
              <p className="px-4 py-6 text-sm text-slate-500">
                {showRetired ? "Nothing is retired." : "Every item you have is retired."}
              </p>
            </Card>
          ) : (
            <>
              {/* Mobile: cards. A five-column table at 375px is unusable. */}
              <ul className="space-y-3 sm:hidden">
                {rows.map((p) => (
                  <li key={p.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/stock/items/${p.id}`}
                        className="min-w-0 flex-1 text-base font-semibold text-slate-900"
                      >
                        {p.name}
                      </Link>
                      <LevelPill level={p.level} />
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-500">On hand</dt>
                        <dd className="font-medium text-slate-900">
                          <Qty value={p.available} unit={p.unit} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-500">Reorder at</dt>
                        <dd className="text-slate-700">
                          {p.reorderLevel === null ? "—" : formatQuantity(p.reorderLevel)}
                        </dd>
                      </div>
                    </dl>
                    {p.sku ? <p className="mt-2 text-xs text-slate-500">Code {p.sku}</p> : null}
                  </li>
                ))}
              </ul>

              <Card className="hidden sm:block">
                <CardHeader
                  title={showRetired ? "Retired items" : "In use"}
                  hint={
                    showRetired
                      ? "Retired items stay on every movement that already names them — they just leave the pickers."
                      : undefined
                  }
                />
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Item</th>
                        <th className="px-4 py-3">Code</th>
                        <th className="px-4 py-3 text-right">On hand</th>
                        <th className="px-4 py-3 text-right">Reorder at</th>
                        <th className="px-4 py-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white text-sm">
                      {rows.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3">
                            <Link
                              href={`/stock/items/${p.id}`}
                              className="font-medium text-slate-900 hover:text-slate-700"
                            >
                              {p.name}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{p.sku ?? "—"}</td>
                          <td className="px-4 py-3 text-right text-slate-900">
                            <Qty value={p.available} unit={p.unit} />
                          </td>
                          <td className="px-4 py-3 text-right text-slate-600">
                            {p.reorderLevel === null ? "—" : formatQuantity(p.reorderLevel)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <LevelPill level={p.level} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {totalPages > 1 ? (
                <div className="flex items-center justify-between text-sm">
                  <p className="text-slate-500">
                    Showing {(page - 1) * PAGE_SIZE + 1}–
                    {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
                  </p>
                  <div className="flex gap-2">
                    {page > 1 ? (
                      <Link
                        href={qs({ page: String(page - 1) })}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Previous
                      </Link>
                    ) : null}
                    {page < totalPages ? (
                      <Link
                        href={qs({ page: String(page + 1) })}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Next
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
