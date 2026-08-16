import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStocktakeSessions, type StocktakeClient } from "@/server/services/stocktake";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { isStocktakeLive, stocktakeStatusLabel, STOCKTAKE_STATUS_CLASS, isStocktakeStatus } from "@/lib/stocktake/schema";
import { EmptyState } from "../../_components/empty-state";
import { Card, CardHeader } from "../_components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stocktakes · CrewFlow" };

/**
 * /stock/stocktake — every count, newest first.
 *
 * ORG-PINNED and LOUD via server/services/stocktake.ts. F-1: the list is paged
 * complete. THE ACCOUNTING BOUNDARY: a stocktake shows quantities counted and
 * variances, never a value — stock has none in this milestone (D1 undecided).
 */

const SAVED: Record<string, string> = {
  counting: "Counting started.",
  posted: "Variances posted to stock.",
  cancelled: "Stocktake cancelled.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function StocktakeListPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const [sessions, sites] = await Promise.all([
    listStocktakeSessions(supabase as unknown as StocktakeClient, ctx.org.id),
    listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id),
  ]);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const saved = sp.saved ? SAVED[sp.saved] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/stock" className="text-sm text-slate-500 hover:text-slate-700">
            ← Stock
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">Stocktakes</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Count a place, compare it to what CrewFlow expected, and post the difference. Every
            variance becomes an adjustment in the movement history — nothing is edited behind the
            scenes.
          </p>
        </div>
        <Link
          href="/stock/stocktake/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New stocktake
        </Link>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}

      {sessions.length === 0 ? (
        <Card>
          <EmptyState
            icon="🧮"
            title="No stocktakes yet"
            body={
              <>
                A stocktake freezes what CrewFlow thinks you hold at one place, lets you count it,
                and posts any difference for you. Start one when you next walk a yard or container.
                <span className="mt-2 block text-xs text-slate-500">
                  Set a barcode on your items first and you can scan straight to the count.
                </span>
              </>
            }
            primary={{ href: "/stock/stocktake/new", label: "Start a stocktake" }}
            secondary={{ href: "/stock/items", label: "See items" }}
          />
        </Card>
      ) : (
        <Card>
          <CardHeader title="All stocktakes" hint="Newest first." />
          <ul className="divide-y divide-slate-100">
            {sessions.map((s) => {
              const status = isStocktakeStatus(s.status) ? s.status : "open";
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/stock/stocktake/${s.id}`}
                      className="block truncate text-sm font-medium text-slate-900 hover:text-slate-700"
                    >
                      {s.reference || siteById.get(s.site_id)?.name || "Stocktake"}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {siteById.get(s.site_id)?.name ?? "Site"} · opened{" "}
                      {(s.opened_at ?? "").slice(0, 10)}
                      {s.posted_at ? ` · posted ${s.posted_at.slice(0, 10)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isStocktakeLive(s.status) ? (
                      <span className="text-xs font-medium text-sky-700">In progress</span>
                    ) : null}
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STOCKTAKE_STATUS_CLASS[status]}`}
                    >
                      {stocktakeStatusLabel(s.status)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
