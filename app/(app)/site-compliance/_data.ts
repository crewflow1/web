import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { SiteInductionRow, SiteVisitorRow } from "@/lib/site-compliance/schema";
import { computeMuster, type MusterRoll, type WorkerDisplay } from "@/lib/site-compliance/muster";
import { listStaffForOrg } from "@/app/(app)/jobs/_form-helpers";

/**
 * Site-compliance read layer. Tenant (user-JWT) client only — the service-role
 * client is never used here. These tables post-date the generated Supabase
 * types, so queries cast through the precise row shapes in lib/site-compliance.
 *
 * RLS is the OUTER boundary, not the scope: `current_org_ids()` admits EVERY org
 * the viewer belongs to, so every read carries an ACTIVE-org predicate
 * (`.eq("org_id", orgId)`) supplied by the caller (ctx.org.id). A dual-org
 * member active in company A must never see company B's inductions/visitors.
 *
 * LOUD READS: a rejected query throws via readFailure — `[]`/null are reserved
 * for a genuinely empty register / missing row, never a failed one.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };
const t = (c: unknown) => (c as FromChain).from.bind(c);

const INDUCTION_COLS =
  "id, org_id, site_id, user_id, person_name, person_company, induction_version, inducted_at, valid_until, statement, statement_version, signed_name, signature_image_bucket, signature_image_path, created_by, created_at";

const VISITOR_COLS =
  "id, org_id, site_id, visitor_name, company, purpose, host_user_id, vehicle_registration, signed_in_at, signed_out_at, signed_in_by, signed_out_by, created_at, updated_at";

/** Every induction for a site, newest first. F-1 paged + org-pinned + stable order. */
export async function listInductionsForSite(
  orgId: string,
  siteId: string,
): Promise<SiteInductionRow[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<SiteInductionRow>((from, to) =>
    t(supabase)("site_inductions")
      .select(INDUCTION_COLS)
      .eq("org_id", orgId)
      .eq("site_id", siteId)
      .order("inducted_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("site-compliance: inductions", error as SupabaseReadError);
  return data ?? [];
}

/** Visitors for a site. `onSiteOnly` restricts to signed-in-not-out (the muster). */
export async function listVisitorsForSite(
  orgId: string,
  siteId: string,
  opts: { onSiteOnly?: boolean } = {},
): Promise<SiteVisitorRow[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<SiteVisitorRow>((from, to) => {
    let q = t(supabase)("site_visitors")
      .select(VISITOR_COLS)
      .eq("org_id", orgId)
      .eq("site_id", siteId);
    if (opts.onSiteOnly) q = q.is("signed_out_at", null);
    return q
      .order("signed_in_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);
  });
  if (error) throw readFailure("site-compliance: visitors", error as SupabaseReadError);
  return data ?? [];
}

/** Currently-open time entries (org-wide) — the "on the clock" presence signal. */
export async function listOpenTimeEntries(
  orgId: string,
): Promise<Array<{ user_id: string; started_at: string }>> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<{ user_id: string; started_at: string }>((from, to) =>
    t(supabase)("time_entries")
      .select("user_id, started_at")
      .eq("org_id", orgId)
      .is("ended_at", null)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("site-compliance: open time entries", error as SupabaseReadError);
  return data ?? [];
}

/**
 * Build the live fire-muster roll for a site. Reads the three sources
 * (inductions here, org-wide open time entries, on-site visitors), resolves
 * worker display names from the membership set, and hands them to the pure
 * computeMuster. `now` is injectable for deterministic tests/exports.
 */
export async function buildMusterRoll(
  orgId: string,
  siteId: string,
  now: Date = new Date(),
): Promise<MusterRoll> {
  const [inductions, openEntries, visitors, staff] = await Promise.all([
    listInductionsForSite(orgId, siteId),
    listOpenTimeEntries(orgId),
    listVisitorsForSite(orgId, siteId, { onSiteOnly: true }),
    // Best-effort display resolution; the muster still renders from signed_name
    // if a name can't be resolved.
    listStaffForOrg(orgId).catch(() => []),
  ]);

  const workerDisplay: Record<string, WorkerDisplay> = {};
  for (const s of staff) {
    if (s?.id) workerDisplay[s.id] = { name: s.full_name ?? s.email, company: null };
  }

  // Resolve host display names for on-site visitors.
  const hostIds = new Set(visitors.map((v) => v.host_user_id).filter((x): x is string => !!x));
  const hostName = (id: string | null): string | null =>
    id && workerDisplay[id] ? workerDisplay[id]!.name : null;
  void hostIds;

  return computeMuster({
    siteId,
    inductions,
    openEntries,
    visitors: visitors.map((v) => ({
      id: v.id,
      visitor_name: v.visitor_name,
      company: v.company,
      purpose: v.purpose,
      host_name: hostName(v.host_user_id),
      signed_in_at: v.signed_in_at,
    })),
    workerDisplay,
    now,
  });
}

/** Lightweight per-site counts for the hub (current on-site heads, not history). */
export async function loadComplianceCounts(
  orgId: string,
): Promise<Map<string, { inductions: number; visitorsOnSite: number }>> {
  const supabase = await createClient();
  const counts = new Map<string, { inductions: number; visitorsOnSite: number }>();
  const bump = (siteId: unknown, key: "inductions" | "visitorsOnSite") => {
    if (typeof siteId !== "string" || siteId.length === 0) return;
    const cur = counts.get(siteId) ?? { inductions: 0, visitorsOnSite: 0 };
    cur[key] += 1;
    counts.set(siteId, cur);
  };
  const [inds, vis] = await Promise.all([
    fetchAllRows<{ site_id: string }>((from, to) =>
      t(supabase)("site_inductions")
        .select("site_id")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<{ site_id: string }>((from, to) =>
      t(supabase)("site_visitors")
        .select("site_id")
        .eq("org_id", orgId)
        .is("signed_out_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  // LOUD: a rejected count read must not render as a silently-empty hub — throw
  // so the error boundary shows a failure rather than "no inductions anywhere".
  if (inds.error) throw readFailure("site-compliance: induction counts", inds.error as SupabaseReadError);
  if (vis.error) throw readFailure("site-compliance: visitor counts", vis.error as SupabaseReadError);
  for (const r of inds.data ?? []) bump(r.site_id, "inductions");
  for (const r of vis.data ?? []) bump(r.site_id, "visitorsOnSite");
  return counts;
}
