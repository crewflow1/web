import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OrgStatus } from "@/server/auth/session";

/**
 * CrewFlow HQ — Onboarding & Migration aggregator (HQ-4).
 *
 * Service-role only — pulls cross-tenant import progress for every
 * org. The customer-facing /imports page is RLS-scoped so the CEO
 * can't see other orgs' imports through normal channels; this
 * service exists specifically to give the operator that view.
 */

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
  const { data: orgsRaw } = await admin
    .from("organizations")
    .select(
      [
        "id",
        "name",
        "status",
        "onboarding_percent",
        "migration_percent",
        "migration_stage",
        "migration_eta",
        "created_at",
      ].join(", ") as never,
    )
    .order("created_at", { ascending: false });

  type OrgRow = {
    id: string;
    name: string;
    status: OrgStatus;
    onboarding_percent: number;
    migration_percent: number;
    migration_stage: string | null;
    migration_eta: string | null;
    created_at: string;
  };
  const orgs = ((orgsRaw ?? []) as unknown as OrgRow[]);
  if (orgs.length === 0) return [];
  const ids = orgs.map((o) => o.id);

  // ---------- Owners ----------
  type OwnerRow = {
    org_id: string;
    user: { full_name: string | null; email: string } | null;
  };
  const { data: ownerships } = await admin
    .from("memberships")
    .select("org_id, user:users ( full_name, email )")
    .in("org_id", ids)
    .eq("role", "owner");
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
  const { data: importsRaw } = await admin
    .from("imports")
    .select("id, org_id, status, created_at, committed_at, rolled_back_at")
    .in("org_id", ids);
  const imports = ((importsRaw ?? []) as unknown as ImportRow[]);

  const importsByOrg = new Map<string, ImportRow[]>();
  for (const imp of imports) {
    const list = importsByOrg.get(imp.org_id) ?? [];
    list.push(imp);
    importsByOrg.set(imp.org_id, list);
  }

  // ---------- Files (count per org via FK) ----------
  type FileRow = { id: string; org_id: string };
  const { data: filesRaw } = await admin
    .from("import_files")
    .select("id, org_id")
    .in("org_id", ids);
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
  const { data: rowRowsRaw } = await admin
    .from("import_rows")
    .select("org_id, status")
    .in("org_id", ids);
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
    return {
      org_id: o.id,
      org_name: o.name,
      status: o.status,
      onboarding_percent: Number(o.onboarding_percent ?? 0),
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
  const { data: impsRaw } = await admin
    .from("imports")
    .select(
      "id, name, status, created_at, committed_at, rolled_back_at",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);
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
  const { data: filesRaw } = await admin
    .from("import_files")
    .select("id, import_id, filename, row_count, size_bytes, mime_type")
    .in("import_id", imports.map((i) => i.id));
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
