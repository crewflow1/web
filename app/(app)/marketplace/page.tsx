import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { isMarketplaceEnabled } from "@/lib/marketplace/flag";
import { CATEGORY_LABELS, type ListingCategory } from "@/lib/marketplace/registry";
import { InstallForm, UninstallButton } from "./_forms";

/**
 * /marketplace — the tenant DISCOVERY + install surface (Phase 14).
 *
 * DARK: 404 while FEATURE_MARKETPLACE is off — the surface does not exist until
 * the marketplace is activated (flag + external partner onboarding).
 *
 * Reads the APPROVED listing catalogue (RLS admits approved listings to any
 * authenticated user) and this org's own installs (admin-only, org-pinned), so
 * each card shows either an Install (consent) form or a Remove button. Both
 * reads are LOUD — a failed query must not render as "no apps".
 */

export const dynamic = "force-dynamic";

type ListingRow = {
  id: string;
  name: string;
  slug: string;
  short_description: string;
  category: string;
  logo_url: string | null;
  requested_scopes: string[] | null;
  webhook_url: string | null;
};

type InstallRow = {
  id: string;
  listing_id: string;
  status: string;
  installed_at: string;
};

type ListingsRead = {
  select: (cols: string) => {
    eq: (c: string, v: string) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => PromiseLike<{ data: ListingRow[] | null; error: { message: string; code?: string } | null }>;
    };
  };
};

type InstallsRead = {
  select: (cols: string) => {
    eq: (c: string, v: string) => {
      eq: (
        c: string,
        v: string,
      ) => PromiseLike<{ data: InstallRow[] | null; error: { message: string; code?: string } | null }>;
    };
  };
};

export default async function MarketplacePage() {
  if (!isMarketplaceEnabled()) notFound();

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();

  // Approved catalogue (global; RLS admits approved to any authenticated user).
  const { data: listingData, error: listErr } = await (
    supabase.from("marketplace_listings" as never) as unknown as ListingsRead
  )
    .select("id, name, slug, short_description, category, logo_url, requested_scopes, webhook_url")
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (listErr) throw readFailure("marketplace: listings", listErr);
  const listings = listingData ?? [];

  // This org's live installs (admin-only; org-pinned). Non-admins see none.
  let installsByListing = new Map<string, InstallRow>();
  if (isAdmin) {
    const { data: installData, error: instErr } = await (
      supabase.from("marketplace_installs" as never) as unknown as InstallsRead
    )
      .select("id, listing_id, status, installed_at")
      .eq("org_id", ctx.org.id) // active-org pin
      .eq("status", "active");
    if (instErr) throw readFailure("marketplace: installs", instErr);
    installsByListing = new Map((installData ?? []).map((i) => [i.listing_id, i]));
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Marketplace</h1>
        <p className="mt-1 text-sm text-slate-600">
          Connect approved third-party apps to CrewFlow. Installing an app grants
          it exactly the access it requests, through a dedicated API key you can
          revoke at any time by removing the app.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/settings/marketplace" className="font-medium text-slate-700 underline">
            Building an integration? Open the developer console →
          </Link>
        </p>
      </header>

      {listings.length === 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">No apps are available yet.</p>
        </section>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {listings.map((l) => {
            const install = installsByListing.get(l.id);
            return (
              <section
                key={l.id}
                className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">{l.name}</h2>
                    <span className="mt-1 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {CATEGORY_LABELS[l.category as ListingCategory] ?? l.category}
                    </span>
                  </div>
                  {install ? (
                    <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                      Installed
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 flex-1 text-sm text-slate-600">{l.short_description}</p>

                <div className="mt-4 border-t border-slate-100 pt-4">
                  {!isAdmin ? (
                    <p className="text-xs text-slate-500">
                      Ask an owner or admin to install this app.
                    </p>
                  ) : install ? (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Active</span>
                      <UninstallButton installId={install.id} listingName={l.name} />
                    </div>
                  ) : (
                    <InstallForm
                      listingId={l.id}
                      listingName={l.name}
                      scopes={l.requested_scopes ?? []}
                      hasWebhook={Boolean(l.webhook_url)}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
