import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import { compareSites, siteKindLabel } from "@/lib/sites/schema";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { loadComplianceCounts } from "./_data";
import { EmptyState } from "../_components/empty-state";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site compliance · CrewFlow" };

/**
 * /site-compliance — pick a site to run its inductions, visitor log and live
 * fire-muster roll.
 *
 * ORG-PINNED: sites and both count reads go through active-org-scoped helpers —
 * `current_org_ids()` admits every org the viewer belongs to, so a dual-org
 * member's list would otherwise blend both companies' sites and counts.
 */
export default async function SiteCompliancePage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const db = supabase as unknown as SitesClient;

  const [rows, counts] = await Promise.all([
    listSitesForOrg<SiteRow>(db, ctx.org.id),
    loadComplianceCounts(ctx.org.id),
  ]);

  const active = [...rows].filter((s) => s.active).sort(compareSites);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Site compliance</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Induct workers onto a site, sign visitors in and out, and pull a live fire-muster roll of
          everyone on site right now. Choose a site to begin.
        </p>
      </header>

      {active.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🦺"
            title="No active sites"
            body={
              <>
                Site compliance runs against your own locations. Add a depot, yard or site first, then
                you can induct workers onto it, log visitors and run a muster.
              </>
            }
            primary={{ href: "/sites/new", label: "Add a site" }}
            secondary={{ href: "/sites", label: "Manage sites" }}
          />
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Site</TH>
                <TH>Kind</TH>
                <TH numeric>Inductions</TH>
                <TH numeric>Visitors on site</TH>
              </TR>
            </THead>
            <TBody>
              {active.map((row) => {
                const c = counts.get(row.id) ?? { inductions: 0, visitorsOnSite: 0 };
                return (
                  <TR key={row.id}>
                    <TD>
                      <Link
                        href={`/site-compliance/${row.id}`}
                        className="font-medium text-slate-900 hover:text-slate-700"
                      >
                        {row.name}
                      </Link>
                    </TD>
                    <TD muted>{siteKindLabel(row.kind)}</TD>
                    <TD numeric muted>
                      {c.inductions || "—"}
                    </TD>
                    <TD numeric muted>
                      {c.visitorsOnSite || "—"}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </section>
      )}
    </div>
  );
}
