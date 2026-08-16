import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  composeStocktakeDetail,
  listStocktakeLines,
  loadStocktakeSession,
  type StocktakeClient,
} from "@/server/services/stocktake";
import { listStockItems, type StockClient } from "@/server/services/stock";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import {
  isStocktakeStatus,
  STOCKTAKE_STATUS_CLASS,
  stocktakeStatusLabel,
  type StocktakeItemRefInput,
} from "@/lib/stocktake/schema";
import { formatQuantity } from "@/lib/stock/movements";
import { Card, CardHeader, Tile } from "../../_components/ui";
import {
  cancelStocktakeSession,
  postStocktakeSession,
  startStocktakeCounting,
} from "../../stocktake-actions";
import { CountPanel } from "./_count-panel";
import { VarianceLines } from "./_variance-lines";

export const dynamic = "force-dynamic";

export const metadata = { title: "Stocktake · CrewFlow" };

const SAVED: Record<string, string> = {
  counting: "Counting started — enter what you count.",
  posted: "Variances posted to stock.",
  saved: "Count saved.",
};
const ERRORS: Record<string, string> = {
  forbidden: "Only an owner or admin can post a stocktake.",
  post: "Couldn't post the stocktake. Some stock may have moved since the count — refresh and try again.",
  start: "Couldn't start counting.",
  cancel: "Couldn't cancel the stocktake.",
};

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

export default async function StocktakeDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const session = await loadStocktakeSession(supabase as unknown as StocktakeClient, ctx.org.id, id);
  if (!session) notFound();

  const [lines, items, sites] = await Promise.all([
    listStocktakeLines(supabase as unknown as StocktakeClient, ctx.org.id, id),
    listStockItems(supabase as unknown as StockClient, ctx.org.id),
    listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id),
  ]);

  const itemRefs = new Map<string, StocktakeItemRefInput>(
    items.map((i) => [i.id, { id: i.id, name: i.name, unit: i.unit, sku: i.sku, barcode: i.barcode }]),
  );
  const { positions, summary } = composeStocktakeDetail(lines, itemRefs);
  const siteName = sites.find((s) => s.id === session.site_id)?.name ?? "Site";
  const status = isStocktakeStatus(session.status) ? session.status : "open";
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const saved = sp.saved ? SAVED[sp.saved] : null;
  const error = sp.error ? ERRORS[sp.error] ?? "Something went wrong." : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/stock/stocktake" className="text-sm text-slate-500 hover:text-slate-700">
            ← Stocktakes
          </Link>
          <h1 className="mt-2 flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-900">
            {session.reference || siteName}
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STOCKTAKE_STATUS_CLASS[status]}`}
            >
              {stocktakeStatusLabel(session.status)}
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {siteName} · opened {(session.opened_at ?? "").slice(0, 10)}
            {session.posted_at ? ` · posted ${session.posted_at.slice(0, 10)}` : ""}
          </p>
        </div>
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Items" value={summary.totalLines} />
        <Tile label="Counted" value={summary.counted} />
        <Tile
          label="Not counted"
          value={summary.uncounted}
          tone={summary.uncounted > 0 && status === "counting" ? "warn" : "plain"}
        />
        <Tile
          label="Variances"
          value={summary.variances}
          tone={summary.variances > 0 ? "warn" : "plain"}
          hint={summary.variances > 0 ? `net ${formatQuantity(summary.netVariance)}` : undefined}
        />
      </div>

      {/* ── Lifecycle controls ─────────────────────────────────────────────── */}
      {status === "open" ? (
        <Card>
          <CardHeader title="Ready to count" hint="Expected quantities are frozen. Start counting to enter what you find." />
          <div className="flex flex-wrap items-center gap-3 px-4 py-4">
            <form action={startStocktakeCounting}>
              <input type="hidden" name="session_id" value={session.id} />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Start counting
              </button>
            </form>
            <CancelForm sessionId={session.id} />
          </div>
        </Card>
      ) : null}

      {status === "counting" ? (
        <>
          <CountPanel
            sessionId={session.id}
            lines={positions.map((p) => ({
              stockItemId: p.stockItemId,
              name: p.name,
              unit: p.unit,
              sku: p.sku,
              barcode: p.barcode,
              expected: p.expected,
              counted: p.counted,
            }))}
          />
          <Card>
            <CardHeader
              title="Post the variances"
              hint="Posts each difference to stock as an adjustment. Admin only, and it can't be undone in bulk."
            />
            <div className="flex flex-wrap items-center gap-3 px-4 py-4">
              {isAdmin ? (
                <form action={postStocktakeSession}>
                  <input type="hidden" name="session_id" value={session.id} />
                  <button
                    type="submit"
                    disabled={summary.counted === 0}
                    className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    Post {summary.variances} variance{summary.variances === 1 ? "" : "s"} to stock
                  </button>
                </form>
              ) : (
                <p className="text-sm text-slate-500">
                  Counting is done — ask an owner or admin to post the variances.
                </p>
              )}
              <CancelForm sessionId={session.id} />
            </div>
          </Card>
        </>
      ) : null}

      {/* ── The count sheet ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={status === "posted" ? "What was counted" : "Count sheet"}
          hint={
            status === "posted"
              ? "Frozen. Variances shown were posted to the movement history."
              : "Expected is frozen from when this count started."
          }
        />
        <VarianceLines positions={positions} posted={status === "posted"} />
      </Card>
    </div>
  );
}

function CancelForm({ sessionId }: { sessionId: string }) {
  return (
    <form action={cancelStocktakeSession}>
      <input type="hidden" name="session_id" value={sessionId} />
      <button
        type="submit"
        className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Cancel stocktake
      </button>
    </form>
  );
}
