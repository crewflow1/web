import "server-only";

/**
 * Sites — the read layer behind /sites, its detail route, and every site
 * picker embedded in other domains (the fleet vehicle form, the custody
 * check-out / transfer forms).
 *
 * Every read here is PINNED to the active org as well as running under RLS.
 * `sites_select` (20261061000000) is `org_id in (select current_org_ids())`,
 * which passes for EVERY org the viewer belongs to. Without the pin, a dual-org
 * member working in company A would see company B's depots in the register, a
 * `/sites/[id]` link would open B's depot inside A's shell, and — worst — the
 * fleet and custody pickers would OFFER a site that the org-integrity trigger
 * then refuses at write time, turning a leak into an unexplainable error.
 * Same class as the supplier fix in server/services/suppliers.ts, the job
 * fixes in #456, the finance writes in #459 and the rota in #461.
 *
 * This is a correctness / data-integrity defect, not a cross-tenant breach —
 * the viewer is a legitimate member of both orgs. RLS remains the outer
 * boundary and is untouched by anything in this file.
 *
 * A row in a non-active org is deliberately INDISTINGUISHABLE from one that
 * does not exist: `loadSiteForOrg` returns null and callers `notFound()`
 * exactly as they would for a genuinely missing site.
 *
 * These functions take the Supabase client as an argument (mirrors
 * server/services/suppliers.ts and server/services/rota.ts) so the integration
 * suite can drive the EXACT same queries with a real multi-org user's JWT
 * against real Postgres — removing a pin here goes red in
 * __tests__/integration/rls/sites-isolation.test.ts, not just in review.
 *
 * `sites` is newer than the generated Supabase types, so the client is accessed
 * through the loose shape below — the same cast style the assets, snags and
 * fleet call sites already use for their own tables.
 */

type Row = Record<string, unknown>;

export type SitesClient = { from: (t: string) => SitesBuilder };

type SitesBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => SitesBuilder;
  eq: (k: string, v: unknown) => SitesBuilder;
  order: (k: string, o: { ascending: boolean }) => SitesBuilder;
  limit: (n: number) => SitesBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: unknown }>;
};

/** How many sites the register and the pickers read at most. */
export const SITE_LIST_LIMIT = 500;

/** Columns every list surface and picker needs. */
export const SITE_LIST_COLUMNS =
  "id, name, kind, address_line1, address_line2, city, county, postcode, country, active, notes, created_at";

export type SiteRow = {
  id: string;
  name: string;
  kind: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
};

/** The shape a picker needs — nothing more leaves the server than has to. */
export type SiteOption = { id: string; name: string; kind: string; active: boolean };

/**
 * Load one site by id, constrained to `orgId` (the ACTIVE org).
 *
 * Returns null when the site does not exist OR belongs to another org — the two
 * cases are deliberately indistinguishable to the caller.
 */
export async function loadSiteForOrg<T = SiteRow>(
  db: SitesClient,
  orgId: string,
  siteId: string,
  columns: string = SITE_LIST_COLUMNS,
): Promise<T | null> {
  const { data } = await db
    .from("sites")
    .select(columns)
    .eq("id", siteId)
    .eq("org_id", orgId)
    .maybeSingle();
  return (data as T | null) ?? null;
}

/**
 * List sites for `orgId` (the ACTIVE org) — the register and every picker.
 *
 * Ordered by name so the register reads like a list of places rather than a
 * changelog; `active` is returned so callers can group or filter without a
 * second round trip.
 */
export async function listSitesForOrg<T = SiteRow>(
  db: SitesClient,
  orgId: string,
  opts: { columns?: string; limit?: number } = {},
): Promise<T[]> {
  const { data } = await db
    .from("sites")
    .select(opts.columns ?? SITE_LIST_COLUMNS)
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(opts.limit ?? SITE_LIST_LIMIT);
  return (data ?? []) as unknown as T[];
}

/** What still points at a site — the reason a delete is refused. */
export type SiteUsage = { vehicles: number; custody: number };

export const EMPTY_SITE_USAGE: SiteUsage = { vehicles: 0, custody: 0 };

/** Upper bound on the usage scan. Well beyond any real tenant's estate. */
// Advisory usage counts only — the DB FK guard is the real delete gate (see the
// caller). Honest bounded sample: PostgREST clamps every read to max_rows (1000).
export const SITE_USAGE_SCAN_LIMIT = 1000;

/**
 * Count what references each site in the ACTIVE org.
 *
 * Load-bearing, not decoration: `tg_sites_delete_guard` (20261061000000)
 * refuses to delete a referenced site, so the register and the detail page must
 * be able to say WHY before the user clicks — "3 vehicles are based here" is an
 * explanation; a bare refusal after the fact is not.
 *
 * Both reads carry `.eq("org_id", orgId)` on top of RLS for the usual reason: a
 * dual-org member's counts would otherwise include the other company's estate
 * and a site could look "in use" because of vehicles this org cannot even see.
 *
 * Counted in TypeScript from two org-pinned id reads rather than by a PostgREST
 * aggregate, because these are tens-to-hundreds of rows for a 5-50-person
 * builder and an explicit read cannot be mis-resolved by the planner.
 */
export async function loadSiteUsageForOrg(
  db: SitesClient,
  orgId: string,
): Promise<Map<string, SiteUsage>> {
  const usage = new Map<string, SiteUsage>();
  const bump = (siteId: unknown, key: keyof SiteUsage) => {
    if (typeof siteId !== "string" || siteId.length === 0) return;
    const current = usage.get(siteId) ?? { vehicles: 0, custody: 0 };
    current[key] += 1;
    usage.set(siteId, current);
  };

  try {
    const [vehicles, custody] = await Promise.all([
      db
        .from("fleet_vehicles")
        .select("home_site_id")
        .eq("org_id", orgId)
        .limit(SITE_USAGE_SCAN_LIMIT),
      db
        .from("asset_assignments")
        .select("site_id")
        .eq("org_id", orgId)
        .limit(SITE_USAGE_SCAN_LIMIT),
    ]);
    for (const row of vehicles.data ?? []) bump(row.home_site_id, "vehicles");
    for (const row of custody.data ?? []) bump(row.site_id, "custody");
  } catch {
    // Counts are an explanation, never a gate — the DB guard is the gate. An
    // unavailable count must not stop the register rendering.
    return usage;
  }
  return usage;
}

/**
 * Org-pinned site options for a form dropdown.
 *
 * `activeOnly` defaults to true: a picker exists to choose where something goes
 * NEXT, and a retired depot is not a valid destination. Callers editing an
 * existing record pass the record's current site id as `keepId` so a value that
 * was chosen before the site was retired still renders as the selected option
 * instead of silently vanishing from the form — the "editing this row must not
 * quietly change it" rule.
 *
 * Best-effort by design: a failed site read must never block adding a vehicle
 * or signing a tool out, because the field is optional and the free-text
 * fallback still works. Degrades to no options, exactly like
 * loadSupplierOptions.
 */
export async function listSiteOptionsForOrg(
  db: SitesClient,
  orgId: string,
  opts: { activeOnly?: boolean; keepId?: string | null } = {},
): Promise<SiteOption[]> {
  try {
    const rows = await listSitesForOrg<SiteOption>(db, orgId, {
      columns: "id, name, kind, active",
    });
    const activeOnly = opts.activeOnly ?? true;
    if (!activeOnly) return rows;
    return rows.filter((s) => s.active || (opts.keepId != null && s.id === opts.keepId));
  } catch {
    return [];
  }
}
