import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  EMPTY_SITE_USAGE,
  loadSiteForOrg,
  loadSiteUsageForOrg,
  type SiteRow,
  type SitesClient,
} from "@/server/services/sites";
import { formatSiteAddress, siteKindLabel } from "@/lib/sites/schema";
import { SiteForm } from "../_form";
import { deleteSite, setSiteActive, updateSite } from "../actions";

export const dynamic = "force-dynamic";

/**
 * /sites/[id] — one company location.
 *
 * ACTIVE-ORG PINNED by-id load. A site in the caller's OTHER org resolves to
 * null here and renders as not-found — never as an editable form bound to a row
 * this org has no business writing.
 */

const ERROR_MAP: Record<string, string> = {
  in_use:
    "That site is still used by vehicles or kit that's signed out, so it can't be deleted — " +
    "the database refuses it so old records keep telling the truth. Deactivate it instead.",
  delete_denied: "Only an owner or admin can delete a site.",
  forbidden: "Only an owner or admin can change a site.",
  save_failed: "Couldn't save that change. Try again.",
  bad_id: "Invalid site id.",
};

const SAVED_MAP: Record<string, string> = {
  deactivated: "Site retired. It stays on every record that already points at it.",
  reactivated: "Site is back in the pickers.",
};

type SP = Promise<{ error?: string; saved?: string }>;

export default async function SiteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const db = supabase as unknown as SitesClient;

  const site = await loadSiteForOrg<SiteRow>(db, ctx.org.id, id);
  if (!site) notFound();

  const usage = (await loadSiteUsageForOrg(db, ctx.org.id)).get(id) ?? EMPTY_SITE_USAGE;
  const referenced = usage.vehicles > 0 || usage.custody > 0;
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const err = sp.error ? ERROR_MAP[sp.error] : null;
  const saved = sp.saved ? SAVED_MAP[sp.saved] : null;
  const address = formatSiteAddress(site);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sites" className="hover:text-slate-900">
          Sites
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{site.name}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{site.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {siteKindLabel(site.kind)}
            {address ? ` · ${address}` : ""}
          </p>
        </div>
        {site.active ? null : (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
            Retired
          </span>
        )}
      </header>

      {err ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {err}
        </p>
      ) : null}
      {saved ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {saved}
        </p>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">What&rsquo;s here</h2>
        {referenced ? (
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {usage.vehicles > 0 ? (
              <li>
                <Link href="/fleet/vehicles" className="underline hover:text-slate-900">
                  {usage.vehicles} vehicle{usage.vehicles === 1 ? "" : "s"}
                </Link>{" "}
                based here
              </li>
            ) : null}
            {usage.custody > 0 ? (
              <li>
                <Link href="/assets/holdings" className="underline hover:text-slate-900">
                  {usage.custody} custody record{usage.custody === 1 ? "" : "s"}
                </Link>{" "}
                pointing here
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            Nothing points at this site yet. Set it as a vehicle&rsquo;s home site on the fleet
            record, or pick it when you store a tool.
          </p>
        )}
      </section>

      {isAdmin ? (
        <SiteForm
          action={updateSite.bind(null, id)}
          defaults={{
            name: site.name,
            kind: site.kind,
            address_line1: site.address_line1 ?? undefined,
            address_line2: site.address_line2 ?? undefined,
            city: site.city ?? undefined,
            county: site.county ?? undefined,
            postcode: site.postcode ?? undefined,
            country: site.country ?? undefined,
            notes: site.notes ?? undefined,
          }}
          submitLabel="Save changes"
          cancelHref="/sites"
        />
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            Only an owner or admin can edit a site. Renaming or retiring one re-labels every record
            that points at it, so it stays a curation job.
          </p>
          {site.notes ? (
            <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{site.notes}</p>
          ) : null}
        </section>
      )}

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            {site.active ? "Retire this site" : "Bring this site back"}
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            {site.active
              ? "Retiring drops it out of every picker. Nothing already pointing at it changes — last year's custody log still says where the kit was."
              : "Reactivating puts it back in the vehicle and custody pickers."}
          </p>
          <form action={setSiteActive} className="mt-3">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="active" value={site.active ? "false" : "true"} />
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {site.active ? "Retire site" : "Reactivate site"}
            </button>
          </form>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Delete permanently</h3>
            {referenced ? (
              <p className="mt-1 text-xs text-slate-600">
                Not available: {usage.vehicles > 0 ? `${usage.vehicles} vehicle${usage.vehicles === 1 ? "" : "s"}` : ""}
                {usage.vehicles > 0 && usage.custody > 0 ? " and " : ""}
                {usage.custody > 0
                  ? `${usage.custody} custody record${usage.custody === 1 ? "" : "s"}`
                  : ""}{" "}
                still point here, and the database refuses a delete that would blank them. Retire it
                instead — that is what retiring is for.
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-slate-600">
                  Nothing points at this site, so deleting it loses nothing. If anything ever has,
                  retire it instead.
                </p>
                <form action={deleteSite} className="mt-3">
                  <input type="hidden" name="id" value={id} />
                  <button
                    type="submit"
                    className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                  >
                    Delete site
                  </button>
                </form>
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
