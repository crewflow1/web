import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { OrgStatus } from "@/server/auth/session";
import {
  computeProgress,
  type ChecklistStepId,
  type OnboardingSnapshot,
} from "@/lib/onboarding/checklist";

/**
 * CrewFlow HQ — Onboarding & Migration aggregator (HQ-4).
 *
 * Service-role only — pulls cross-tenant import progress for every
 * org. The customer-facing /imports page is RLS-scoped so the CEO
 * can't see other orgs' imports through normal channels; this
 * service exists specifically to give the operator that view.
 */

// ---------------------------------------------------------------------------
// F-1 paging helper. Every read in this HQ aggregator is CROSS-TENANT and
// service-role, and each one is bucketed / counted in memory — so a bare
// `.select()` clamped at PostgREST max_rows (1000) silently drops rows and
// under-counts (`import_rows` in particular is a big table). These reads are
// therefore paged under the cap on a stable unique order. The org-id `.in()`
// lists stay un-chunked: the org count is the launch-horizon ceiling (hundreds),
// well under the URL request-line limit.
// ---------------------------------------------------------------------------
type HqRow = Record<string, unknown>;
type HqBuilder = PromiseLike<{ data: HqRow[] | null; error: unknown }> & {
  select: (c: string) => HqBuilder;
  eq: (k: string, v: unknown) => HqBuilder;
  neq: (k: string, v: unknown) => HqBuilder;
  in: (k: string, v: readonly unknown[]) => HqBuilder;
  order: (k: string, o: { ascending: boolean }) => HqBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<HqRow>>;
};
type HqLoose = { from: (t: string) => HqBuilder };

/** Page a cross-tenant set read on a stable `orderKey` (default unique `id`). */
function hqPaged(
  loose: HqLoose,
  table: string,
  cols: string,
  apply: (b: HqBuilder) => HqBuilder,
  orderKey = "id",
): Promise<{ data: HqRow[]; error: unknown }> {
  return fetchAllRows<HqRow>((from, to) =>
    apply(loose.from(table).select(cols))
      .order(orderKey, { ascending: true })
      .range(from, to),
  );
}

export type OnboardingRow = {
  org_id: string;
  org_name: string;
  status: OrgStatus;
  /** Operator-set; comes from organizations.onboarding_percent. */
  onboarding_percent: number;
  /** Operator-set; comes from organizations.migration_percent. */
  migration_percent: number;
  migration_stage: string | null;
  migration_eta: string | null;
  /** Most-recent imports.created_at for this org — proxy for activity. */
  last_import_at: string | null;
  /** Most-recent imports.committed_at — when their migration last landed. */
  last_committed_at: string | null;
  /** Sum across all imports — files uploaded. */
  files_count: number;
  /** Sum across all import_rows — rows successfully committed. */
  rows_imported: number;
  /** Sum across all import_rows — rows that failed mapping. */
  rows_failed: number;
  /** Count of distinct imports in flight (status != committed/rolled_back). */
  imports_in_progress: number;
  /** Count of imports rolled back — surfaces "something went wrong" signal. */
  imports_rolled_back: number;
  /** Owner identity. */
  owner_email: string | null;
  owner_name: string | null;
};

export async function listOnboardingForHq(): Promise<OnboardingRow[]> {
  const admin = createAdminClient();

  // ---------- Orgs ----------
  // We now pull the full onboarding-snapshot input on this query so
  // `buildHqChecklistProgress` can compute the *live* customer-facing
  // pct per org without a second round trip per org. The stored
  // `onboarding_percent` column is read for back-compat but is NOT
  // surfaced any more — the customer's live progress is the source
  // of truth (matches the directive's "Sync HQ onboarding % with
  // customer-facing computeProgress()" requirement).
  const loose = admin as unknown as HqLoose;
  // F-1: the org spine itself is paged — a bare read caps the whole HQ list at
  // 1000 orgs. Newest-first, with a unique `id` tiebreak for a stable boundary.
  const { data: orgsRaw, error: orgsError } = await fetchAllRows<HqRow>((from, to) =>
    loose
      .from("organizations")
      .select(
        [
          "id",
          "name",
          "status",
          "phone",
          "email",
          "vat_number",
          "logo_path",
          "logo_url",
          "bank_details",
          "default_terms",
          "address",
          "onboarding_state",
          "onboarding_percent",
          "migration_percent",
          "migration_stage",
          "migration_eta",
          "created_at",
        ].join(", "),
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (orgsError) throw readFailure("hq-onboarding-snapshot: organizations", orgsError as SupabaseReadError);

  type OrgRow = {
    id: string;
    name: string;
    status: OrgStatus;
    phone: string | null;
    email: string | null;
    vat_number: string | null;
    logo_path: string | null;
    logo_url: string | null;
    bank_details: OnboardingSnapshot["org"]["bank_details"];
    default_terms: string | null;
    address: OnboardingSnapshot["org"]["address"];
    onboarding_state: Record<string, unknown> | null;
    onboarding_percent: number;
    migration_percent: number;
    migration_stage: string | null;
    migration_eta: string | null;
    created_at: string;
  };
  const orgs = ((orgsRaw ?? []) as unknown as OrgRow[]);
  if (orgs.length === 0) return [];
  const ids = orgs.map((o) => o.id);

  // ---------- Live progress per org (mirrors customer dashboard) ----------
  // Five batched queries — one each for memberships / customers /
  // invoices / quotes / imports — then we bucket the counts by org_id
  // and feed each org through the same `computeProgress()` the customer
  // dashboard uses. The HQ number can no longer drift from what the
  // customer sees.
  const livePctByOrg = await buildHqChecklistProgress(orgs, admin);

  // ---------- Owners ----------
  type OwnerRow = {
    org_id: string;
    user: { full_name: string | null; email: string } | null;
  };
  const { data: ownerships } = await hqPaged(
    loose,
    "memberships",
    "org_id, user:users ( full_name, email )",
    (b) => b.in("org_id", ids).eq("role", "owner"),
  );
  const ownerByOrg = new Map(
    ((ownerships ?? []) as unknown as OwnerRow[]).map((r) => [
      r.org_id,
      {
        email: r.user?.email ?? null,
        name: r.user?.full_name ?? null,
      },
    ]),
  );

  // ---------- Imports (per-org aggregation) ----------
  type ImportRow = {
    id: string;
    org_id: string;
    status: string;
    created_at: string;
    committed_at: string | null;
    rolled_back_at: string | null;
  };
  const { data: importsRaw, error: importsError } = await hqPaged(
    loose,
    "imports",
    "id, org_id, status, created_at, committed_at, rolled_back_at",
    (b) => b.in("org_id", ids),
  );
  if (importsError) throw readFailure("hq-onboarding-snapshot: imports", importsError as SupabaseReadError);
  const imports = ((importsRaw ?? []) as unknown as ImportRow[]);

  const importsByOrg = new Map<string, ImportRow[]>();
  for (const imp of imports) {
    const list = importsByOrg.get(imp.org_id) ?? [];
    list.push(imp);
    importsByOrg.set(imp.org_id, list);
  }

  // ---------- Files (count per org via FK) ----------
  type FileRow = { id: string; org_id: string };
  const { data: filesRaw, error: filesError } = await hqPaged(
    loose,
    "import_files",
    "id, org_id",
    (b) => b.in("org_id", ids),
  );
  if (filesError) throw readFailure("hq-onboarding-snapshot: import files", filesError as SupabaseReadError);
  const files = ((filesRaw ?? []) as unknown as FileRow[]);
  const filesByOrg = new Map<string, number>();
  for (const f of files) {
    filesByOrg.set(f.org_id, (filesByOrg.get(f.org_id) ?? 0) + 1);
  }

  // ---------- Rows (committed vs failed counts per org) ----------
  // import_rows can be a big table — pull only the slices we need to
  // bucket. RLS doesn't apply with service-role; we filter via the
  // org_ids we already know.
  type ImportRowRow = { org_id: string; status: string };
  const { data: rowRowsRaw, error: rowRowsError } = await hqPaged(
    loose,
    "import_rows",
    "id, org_id, status",
    (b) => b.in("org_id", ids),
  );
  if (rowRowsError) throw readFailure("hq-onboarding-snapshot: import rows", rowRowsError as SupabaseReadError);
  const rowRows = ((rowRowsRaw ?? []) as unknown as ImportRowRow[]);
  const importedByOrg = new Map<string, number>();
  const failedByOrg = new Map<string, number>();
  for (const r of rowRows) {
    // "committed" = imported successfully; "failed" / "skipped_duplicate" =
    // didn't make it. The exact enum varies but matching on substring
    // keeps this resilient to renames in future imports refactors.
    const s = (r.status ?? "").toLowerCase();
    if (s === "committed" || s === "imported") {
      importedByOrg.set(r.org_id, (importedByOrg.get(r.org_id) ?? 0) + 1);
    } else if (s.includes("fail") || s.includes("error")) {
      failedByOrg.set(r.org_id, (failedByOrg.get(r.org_id) ?? 0) + 1);
    }
  }

  // ---------- Merge ----------
  return orgs.map<OnboardingRow>((o) => {
    const orgImports = importsByOrg.get(o.id) ?? [];
    let last_import_at: string | null = null;
    let last_committed_at: string | null = null;
    let imports_in_progress = 0;
    let imports_rolled_back = 0;
    for (const imp of orgImports) {
      if (!last_import_at || imp.created_at > last_import_at) {
        last_import_at = imp.created_at;
      }
      if (imp.committed_at && (!last_committed_at || imp.committed_at > last_committed_at)) {
        last_committed_at = imp.committed_at;
      }
      if (imp.rolled_back_at) {
        imports_rolled_back++;
      } else if (imp.status !== "committed") {
        imports_in_progress++;
      }
    }
    const owner = ownerByOrg.get(o.id) ?? { email: null, name: null };
    // Prefer the live customer-facing pct (source of truth). Fall back
    // to the stored column only if the live derivation failed (e.g.
    // an unexpected schema gap on a brand-new org).
    const livePct = livePctByOrg.get(o.id);
    return {
      org_id: o.id,
      org_name: o.name,
      status: o.status,
      onboarding_percent:
        typeof livePct === "number" ? livePct : Number(o.onboarding_percent ?? 0),
      migration_percent: Number(o.migration_percent ?? 0),
      migration_stage: o.migration_stage,
      migration_eta: o.migration_eta,
      last_import_at,
      last_committed_at,
      files_count: filesByOrg.get(o.id) ?? 0,
      rows_imported: importedByOrg.get(o.id) ?? 0,
      rows_failed: failedByOrg.get(o.id) ?? 0,
      imports_in_progress,
      imports_rolled_back,
      owner_email: owner.email,
      owner_name: owner.name,
    };
  });
}

// ---------------------------------------------------------------------
// Live HQ checklist progress per org — batched.
//
// The customer dashboard renders `computeProgress(buildOnboardingSnapshot
// (orgId))` live, so its pct reflects current DB state. The HQ side used
// to read the operator-set `organizations.onboarding_percent` integer,
// which drifted as customers progressed.
//
// This helper builds the same `OnboardingSnapshot` shape per org, then
// feeds each through `computeProgress`. To stay O(1) on round-trips
// regardless of org count, we run ONE query per dependent table across
// every org and bucket by org_id locally.
//
// Returns a Map<org_id, pct_0_to_100>. Missing entries mean the helper
// couldn't compute (caller falls back to stored column).
// ---------------------------------------------------------------------

type HqOrgRow = {
  id: string;
  phone: string | null;
  email: string | null;
  vat_number: string | null;
  logo_path: string | null;
  logo_url: string | null;
  bank_details: OnboardingSnapshot["org"]["bank_details"];
  default_terms: string | null;
  address: OnboardingSnapshot["org"]["address"];
  onboarding_state: Record<string, unknown> | null;
  name: string;
};

async function buildHqChecklistProgress(
  orgs: HqOrgRow[],
  admin: ReturnType<typeof createAdminClient>,
): Promise<Map<string, number>> {
  if (orgs.length === 0) return new Map();
  const ids = orgs.map((o) => o.id);

  // Five parallel batched queries — one PAGED read per table (F-1: a bare
  // `.select()` clamped at max_rows would under-count a table with >1000 rows
  // across all orgs and drift the HQ progress figure), never N round trips per
  // org. Order on unique `id` (present on every one of these tables) so a page
  // boundary can't drop or repeat a row that would skew a bucketed count.
  const loose = admin as unknown as HqLoose;
  const [membersRes, customersRes, invoicesRes, quotesRes, importsCommittedRes] =
    await Promise.all([
      hqPaged(loose, "memberships", "org_id, role", (b) =>
        b.in("org_id", ids).neq("role", "owner"),
      ),
      hqPaged(loose, "customers", "org_id", (b) => b.in("org_id", ids)),
      hqPaged(loose, "invoices", "org_id", (b) => b.in("org_id", ids)),
      hqPaged(loose, "quotes", "org_id", (b) => b.in("org_id", ids)),
      hqPaged(loose, "imports", "org_id", (b) =>
        b.in("org_id", ids).eq("status", "committed"),
      ),
    ]);

  const countByOrg = (
    rows: ReadonlyArray<{ org_id: string }> | null | undefined,
  ): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      m.set(r.org_id, (m.get(r.org_id) ?? 0) + 1);
    }
    return m;
  };

  const membersByOrg = countByOrg(
    membersRes.data as unknown as ReadonlyArray<{ org_id: string }>,
  );
  const customersByOrg = countByOrg(
    customersRes.data as unknown as ReadonlyArray<{ org_id: string }>,
  );
  const invoicesByOrg = countByOrg(
    invoicesRes.data as unknown as ReadonlyArray<{ org_id: string }>,
  );
  const quotesByOrg = countByOrg(
    quotesRes.data as unknown as ReadonlyArray<{ org_id: string }>,
  );
  const importsByOrg = countByOrg(
    importsCommittedRes.data as unknown as ReadonlyArray<{ org_id: string }>,
  );

  const out = new Map<string, number>();
  const VALID_DISMISSED_IDS: ReadonlyArray<ChecklistStepId> = [
    "company_profile",
    "logo",
    "vat",
    "bank",
    "terms",
    "staff",
    "customers",
    "imports",
    "invoices_import",
    "first_quote",
  ];
  for (const o of orgs) {
    const dismissedArr = Array.isArray(
      (o.onboarding_state as { dismissed_steps?: unknown })?.dismissed_steps,
    )
      ? ((o.onboarding_state as { dismissed_steps: unknown[] })
          .dismissed_steps as string[])
      : [];
    const dismissed = new Set<ChecklistStepId>(
      dismissedArr.filter((s): s is ChecklistStepId =>
        VALID_DISMISSED_IDS.includes(s as ChecklistStepId),
      ),
    );
    const startedAtRaw = (o.onboarding_state as { started_at?: unknown } | null)
      ?.started_at;
    const completedAtRaw = (
      o.onboarding_state as { completed_at?: unknown } | null
    )?.completed_at;
    const snap: OnboardingSnapshot = {
      org: {
        name: o.name,
        phone: o.phone,
        email: (o as unknown as { email?: string | null }).email ?? null,
        vat_number: o.vat_number,
        logo_path: o.logo_path,
        logo_url: o.logo_url,
        bank_details: o.bank_details,
        default_terms: o.default_terms,
        address: o.address,
      },
      counts: {
        staffMembers: membersByOrg.get(o.id) ?? 0,
        customers: customersByOrg.get(o.id) ?? 0,
        invoices: invoicesByOrg.get(o.id) ?? 0,
        quotes: quotesByOrg.get(o.id) ?? 0,
        importsCommitted: importsByOrg.get(o.id) ?? 0,
      },
      dismissed,
      timestamps: {
        started_at: typeof startedAtRaw === "string" ? startedAtRaw : null,
        completed_at:
          typeof completedAtRaw === "string" ? completedAtRaw : null,
      },
    };
    out.set(o.id, computeProgress(snap).pct);
  }
  return out;
}

/**
 * Per-org drill-down — used by the inline expand-row on
 * /admin/onboarding to show every uploaded file + import status.
 */
export type OnboardingImportRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
  files: ReadonlyArray<{
    id: string;
    filename: string;
    row_count: number | null;
    size_bytes: number | null;
    mime_type: string | null;
  }>;
};

export async function listImportsForOrg(
  orgId: string,
): Promise<OnboardingImportRow[]> {
  const admin = createAdminClient();
  type Imp = {
    id: string;
    name: string;
    status: string;
    created_at: string;
    committed_at: string | null;
    rolled_back_at: string | null;
  };
  const { data: impsRaw, error: impsError } = await admin
    .from("imports")
    .select(
      "id, name, status, created_at, committed_at, rolled_back_at",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (impsError) throw readFailure("hq-onboarding-snapshot: org imports", impsError);
  const imports = ((impsRaw ?? []) as unknown as Imp[]);
  if (imports.length === 0) return [];

  type FileRow = {
    id: string;
    import_id: string;
    filename: string;
    row_count: number | null;
    size_bytes: number | null;
    mime_type: string | null;
  };
  const { data: filesRaw, error: filesError } = await admin
    .from("import_files")
    .select("id, import_id, filename, row_count, size_bytes, mime_type")
    .in("import_id", imports.map((i) => i.id));
  if (filesError) throw readFailure("hq-onboarding-snapshot: org import files", filesError);
  const files = ((filesRaw ?? []) as unknown as FileRow[]);
  const filesByImport = new Map<string, FileRow[]>();
  for (const f of files) {
    const list = filesByImport.get(f.import_id) ?? [];
    list.push(f);
    filesByImport.set(f.import_id, list);
  }

  return imports.map<OnboardingImportRow>((i) => ({
    id: i.id,
    name: i.name,
    status: i.status,
    created_at: i.created_at,
    committed_at: i.committed_at,
    rolled_back_at: i.rolled_back_at,
    files: (filesByImport.get(i.id) ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      row_count: f.row_count,
      size_bytes: f.size_bytes,
      mime_type: f.mime_type,
    })),
  }));
}
