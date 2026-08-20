import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { isMarketplaceEnabled } from "@/lib/marketplace/flag";
import { CATEGORY_LABELS, type ListingCategory } from "@/lib/marketplace/registry";
import { CreatePartnerForm, CreateListingForm, SubmitListingButton } from "./_forms";

/**
 * /settings/marketplace — the DEVELOPER console (Phase 14).
 *
 * DARK: 404 while FEATURE_MARKETPLACE is off. Admin-gated (a partner identity +
 * listing are publishing credentials; RLS is the real authority). Reads the
 * org's partner + listings LOUD and org-pinned via the partner's ownership.
 */

export const dynamic = "force-dynamic";

type PartnerRow = { id: string; name: string; slug: string; status: string };
type ListingRow = {
  id: string;
  partner_id: string;
  name: string;
  slug: string;
  category: string;
  status: string;
  requested_scopes: string[] | null;
  review_notes: string | null;
};

type PartnersRead = {
  select: (cols: string) => {
    eq: (c: string, v: string) => {
      order: (
        c: string,
        o: { ascending: boolean },
      ) => PromiseLike<{ data: PartnerRow[] | null; error: { message: string; code?: string } | null }>;
    };
  };
};

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-200 text-slate-700",
  pending_review: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-700",
  suspended: "bg-red-100 text-red-700",
};

export default async function DeveloperConsolePage() {
  if (!isMarketplaceEnabled()) notFound();

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Header />
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-600">
            Only owners and admins can manage marketplace listings.
          </p>
        </section>
      </div>
    );
  }

  const supabase = await createClient();

  // The org's partner identity (admin-only, org-pinned by RLS).
  const { data: partnerData, error: pErr } = await (
    supabase.from("marketplace_partners" as never) as unknown as PartnersRead
  )
    .select("id, name, slug, status")
    .eq("org_id", ctx.org.id) // active-org pin
    .order("created_at", { ascending: false });
  if (pErr) throw readFailure("marketplace: partners", pErr);
  const partners = partnerData ?? [];
  const partner = partners[0] ?? null;

  // The partner's listings (RLS: owner-org admins read their own in any status).
  let listings: ListingRow[] = [];
  if (partner) {
    const { data: listingData, error: lErr } = await (
      supabase.from("marketplace_listings" as never) as unknown as {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => PromiseLike<{ data: ListingRow[] | null; error: { message: string; code?: string } | null }>;
          };
        };
      }
    )
      .select("id, partner_id, name, slug, category, status, requested_scopes, review_notes")
      .eq("partner_id", partner.id)
      .order("created_at", { ascending: false });
    if (lErr) throw readFailure("marketplace: dev-listings", lErr);
    listings = listingData ?? [];
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Header />

      {!partner ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Create a developer profile</h2>
          <p className="mt-1 text-sm text-slate-600">
            A one-time step to publish apps. Your profile owns the listings you
            create.
          </p>
          <div className="mt-4">
            <CreatePartnerForm />
          </div>
        </section>
      ) : (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">{partner.name}</h2>
                <code className="text-xs text-slate-500">{partner.slug}</code>
              </div>
              <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                {partner.status}
              </span>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Your listings</h2>
            {listings.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No listings yet. Create one below.</p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {listings.map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{l.name}</p>
                      <p className="text-xs text-slate-500">
                        {CATEGORY_LABELS[l.category as ListingCategory] ?? l.category} ·{" "}
                        {(l.requested_scopes ?? []).length} scope
                        {(l.requested_scopes ?? []).length === 1 ? "" : "s"}
                      </p>
                      {l.review_notes && (l.status === "rejected" || l.status === "suspended") ? (
                        <p className="mt-1 text-xs text-red-600">Review note: {l.review_notes}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          STATUS_STYLES[l.status] ?? "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {l.status.replace("_", " ")}
                      </span>
                      {l.status === "draft" ? <SubmitListingButton listingId={l.id} /> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Create a listing</h2>
            <p className="mt-1 text-sm text-slate-600">
              Listings start as drafts. Submit for review to make them
              discoverable and installable.
            </p>
            <div className="mt-4">
              <CreateListingForm partnerId={partner.id} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <header>
      <div className="text-sm">
        <Link href="/settings" className="text-slate-500 hover:text-slate-700">
          ← Settings
        </Link>
      </div>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Developer console</h1>
      <p className="mt-1 text-sm text-slate-600">
        Publish an app to the CrewFlow marketplace. Apps request public-API
        scopes; when a tenant installs, they consent to exactly those scopes and
        your app authenticates with a dedicated, install-bound API key.
      </p>
    </header>
  );
}
