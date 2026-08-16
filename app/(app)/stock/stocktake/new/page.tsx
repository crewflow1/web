import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { siteKindLabel } from "@/lib/sites/schema";
import { OpenStocktakeForm } from "./_open-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "New stocktake · CrewFlow" };

/**
 * /stock/stocktake/new — pick a site and open a session. Opening freezes the
 * expected quantity of every item at that site into the count sheet.
 */
export default async function NewStocktakePage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const sites = await listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/stock/stocktake" className="text-sm text-slate-500 hover:text-slate-700">
          ← Stocktakes
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">New stocktake</h1>
        <p className="mt-1 text-sm text-slate-600">
          Choose where you are counting. CrewFlow freezes what it currently thinks you hold at that
          place, so the difference you post later is measured against a fixed starting point.
        </p>
      </header>

      {sites.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          You have no sites yet, so there is nowhere to count.{" "}
          <Link href="/sites/new" className="font-medium text-slate-900 underline">
            Add a depot, yard or lock-up
          </Link>{" "}
          first.
        </div>
      ) : (
        <OpenStocktakeForm
          sites={sites.map((s) => ({ id: s.id, name: s.name, kind: siteKindLabel(s.kind) }))}
        />
      )}
    </div>
  );
}
