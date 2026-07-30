import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  EMPTY_SITE_USAGE,
  listSitesForOrg,
  loadSiteUsageForOrg,
  type SiteRow,
  type SitesClient,
} from "@/server/services/sites";
import { compareSites, formatSiteAddress, siteKindLabel } from "@/lib/sites/schema";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { EmptyState } from "../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sites · CrewFlow" };

/**
 * /sites — the register of the company's OWN locations.
 *
 * Depots, yards, warehouses, offices, containers and lock-ups. NOT customer job
 * sites: a job's address lives on the job (and is inherited from the customer),
 * and the 20261061000000 header sets out why unifying the two is a product
 * decision rather than a schema convenience.
 *
 * ORG-PINNED: the read goes through listSitesForOrg because RLS alone does not
 * scope it — `current_org_ids()` admits every org the viewer belongs to, so a
 * dual-org member's register would otherwise show both companies' depots side
 * by side with nothing to tell them apart.
 */

const SAVED_MESSAGES: Record<string, string> = {
  deleted: "Site deleted.",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function SitesPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const db = supabase as unknown as SitesClient;
  const sp = await searchParams;

  const [rows, usage] = await Promise.all([
    listSitesForOrg<SiteRow>(db, ctx.org.id),
    loadSiteUsageForOrg(db, ctx.org.id),
  ]);

  const sorted = [...rows].sort(compareSites);
  const active = sorted.filter((s) => s.active);
  const retired = sorted.filter((s) => !s.active);
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const saved = sp.saved ? SAVED_MESSAGES[sp.saved] : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Sites</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Your own places — depots, yards, warehouses, offices, containers and lock-ups. Name each
            one once and every van and every tool can point at it instead of at somebody&rsquo;s
            spelling of it.
          </p>
        </div>
        {isAdmin ? (
          <Link
            href="/sites/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add site
          </Link>
        ) : null}
      </header>

      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <>
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              icon="🏚️"
              title="No sites yet"
              body={
                <>
                  A site is somewhere <span className="font-medium text-slate-800">you</span> keep
                  things — the yard the tippers come back to, the lock-up with the SDS drills in it,
                  the office. Not a customer&rsquo;s job address: those already live on the job.
                  <span className="mt-2 block text-xs text-slate-500">
                    Right now a depot is just text typed into a van record and text typed into a
                    custody record, so &ldquo;Wakefield Yard&rdquo; and &ldquo;wakefield yard&rdquo;
                    are two different places to CrewFlow. Naming them here fixes that once.
                  </span>
                </>
              }
              primary={isAdmin ? { href: "/sites/new", label: "Add your first site" } : undefined}
              secondary={{ href: "/fleet/vehicles", label: "See the fleet" }}
            />
          </div>

          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
              What naming a site unlocks
            </h2>
            <ul className="divide-y divide-slate-100 text-sm">
              <Unlock
                title="Vans that know where they live"
                body="Set a home site on a vehicle and “where is the Transit based” has one answer, spelled one way, that you can rename in one place."
              />
              <Unlock
                title="Kit you can actually find"
                body="Sign a tool out to a site instead of typing a location, and “what’s in the lock-up” becomes a question with an answer."
              />
              <Unlock
                title="A list that survives people leaving"
                body="Free text walks out of the door with whoever typed it. A named site stays, with its address, postcode, gate code and hours."
              />
              <Unlock
                title="Retire, never delete"
                body="Close a depot and it drops out of every picker while staying on every historic record — so last year’s custody log still tells the truth."
              />
            </ul>
          </section>
        </>
      ) : (
        <>
          <SiteTable
            caption="In use"
            rows={active}
            usage={usage}
            empty="Every site you have is retired. Reactivate one, or add a new one."
          />
          {retired.length > 0 ? (
            <SiteTable
              caption="Retired"
              rows={retired}
              usage={usage}
              muted
              empty=""
              hint="Retired sites stay on every record that already points at them — they just stop appearing in pickers."
            />
          ) : null}
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

function SiteTable({
  caption,
  rows,
  usage,
  muted,
  empty,
  hint,
}: {
  caption: string;
  rows: SiteRow[];
  usage: Map<string, { vehicles: number; custody: number }>;
  muted?: boolean;
  empty: string;
  hint?: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">
          {caption}
          <span className="ml-2 text-xs font-normal text-slate-500">{rows.length}</span>
        </h2>
        {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">{empty}</p>
      ) : (
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Name</TH>
              <TH>Kind</TH>
              <TH hideBelow="md">Where</TH>
              <TH numeric>In use by</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => {
              const u = usage.get(row.id) ?? EMPTY_SITE_USAGE;
              const address = formatSiteAddress(row);
              return (
                <TR key={row.id}>
                  <TD>
                    <Link
                      href={`/sites/${row.id}`}
                      className={`font-medium hover:text-slate-700 ${
                        muted ? "text-slate-500" : "text-slate-900"
                      }`}
                    >
                      {row.name}
                    </Link>
                  </TD>
                  <TD muted>{siteKindLabel(row.kind)}</TD>
                  <TD muted hideBelow="md">
                    {address || "—"}
                  </TD>
                  {/* text-xs: the usage summary is a sentence of counts, not a
                      headline figure, and reads a size down. */}
                  <TD numeric muted className="text-xs">
                    {u.vehicles === 0 && u.custody === 0
                      ? "—"
                      : [
                          u.vehicles > 0
                            ? `${u.vehicles} vehicle${u.vehicles === 1 ? "" : "s"}`
                            : null,
                          u.custody > 0
                            ? `${u.custody} custody record${u.custody === 1 ? "" : "s"}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </section>
  );
}
