import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P4 Job Documents — schema/source-contract suite.
 *
 * CI has no database, so — exactly like impersonation-rls.test.ts and
 * billing-schema-protections.test.ts — we pin the security-critical invariants
 * on the migration SQL itself. These lock the staff/private boundary, the
 * versioning rules, and the audit filter so a future edit can't silently drop
 * them.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const MIG_TABLES = read("supabase/migrations/20260704010000_job_documents.sql");
const MIG_BUCKETS = read("supabase/migrations/20260704010100_job_docs_buckets.sql");
const MIG_ACTIVITY = read(
  "supabase/migrations/20260704010200_job_documents_activity_filter.sql",
);

// =====================================================================
// Tables + columns
// =====================================================================

describe("job_documents — table shape", () => {
  it("creates job_documents and job_document_versions idempotently", () => {
    expect(MIG_TABLES).toMatch(/create table if not exists public\.job_documents/i);
    expect(MIG_TABLES).toMatch(
      /create table if not exists public\.job_document_versions/i,
    );
  });

  it("discriminates visibility with a CHECK in ('staff','private')", () => {
    expect(MIG_TABLES).toMatch(
      /visibility text not null check \(visibility in \('staff', ?'private'\)\)/i,
    );
  });

  it("enumerates doc_type including the EICR-era types", () => {
    expect(MIG_TABLES).toMatch(/doc_type text not null default 'custom'/i);
    for (const t of [
      "eicr",
      "test_sheet",
      "risk_assessment",
      "method_statement",
      "completion_cert",
      "checklist",
      "custom",
    ]) {
      expect(MIG_TABLES).toContain(`'${t}'`);
    }
  });

  it("locks status to draft/in_progress/completed", () => {
    expect(MIG_TABLES).toMatch(
      /status text not null default 'draft'\s*\n?\s*check \(status in \('draft', ?'in_progress', ?'completed'\)\)/i,
    );
  });

  it("carries the forward-compatibility columns (no future ALTER needed)", () => {
    expect(MIG_TABLES).toMatch(/template_id uuid/i); // reserved, no FK
    expect(MIG_TABLES).toMatch(
      /assigned_to uuid references public\.users\(id\) on delete set null/i,
    );
    expect(MIG_TABLES).toMatch(/external_reference text/i);
    expect(MIG_TABLES).toMatch(/customer_shared_at timestamptz/i);
    expect(MIG_TABLES).toMatch(
      /requires_staff_signature boolean not null default false/i,
    );
    expect(MIG_TABLES).toMatch(
      /requires_customer_signature boolean not null default false/i,
    );
  });

  it("keeps actor columns nullable with ON DELETE SET NULL (no self-contradicting NOT NULL)", () => {
    expect(MIG_TABLES).toMatch(
      /created_by uuid references public\.users\(id\) on delete set null/i,
    );
    expect(MIG_TABLES).toMatch(
      /updated_by uuid references public\.users\(id\) on delete set null/i,
    );
    // created_by must NOT be NOT NULL (that conflicts with ON DELETE SET NULL).
    expect(MIG_TABLES).not.toMatch(/created_by uuid not null/i);
  });

  it("current_version has NO foreign key (circular ref avoided, trigger-maintained)", () => {
    // The column exists but is not declared as a references … to versions.
    expect(MIG_TABLES).toMatch(/current_version uuid/i);
    expect(MIG_TABLES).not.toMatch(
      /current_version uuid references public\.job_document_versions/i,
    );
  });

  it("versions are immutable, file-per-version, with a reserved form_data for EICR", () => {
    expect(MIG_TABLES).toMatch(/form_data jsonb/i);
    expect(MIG_TABLES).toMatch(/unique \(document_id, version_no\)/i);
    expect(MIG_TABLES).toMatch(
      /storage_bucket text not null\s*\n?\s*check \(storage_bucket in \('job-docs', ?'job-docs-private'\)\)/i,
    );
  });
});

// =====================================================================
// RLS — the staff/private boundary
// =====================================================================

describe("job_documents — RLS staff/private boundary", () => {
  it("enables RLS on both tables", () => {
    expect(MIG_TABLES).toMatch(
      /alter table public\.job_documents enable row level security/i,
    );
    expect(MIG_TABLES).toMatch(
      /alter table public\.job_document_versions enable row level security/i,
    );
  });

  it("SELECT gate: members see staff docs, only admins see private (both tables)", () => {
    const gate =
      /org_id in \(select public\.current_org_ids\(\)\)\s*\n?\s*and \(visibility = 'staff' or public\.is_org_admin\(org_id\)\)/i;
    // appears in job_documents SELECT and job_document_versions SELECT.
    const matches = MIG_TABLES.match(new RegExp(gate, "gi")) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("job_documents INSERT only bounds the org (private RETURNING handled in service layer)", () => {
    expect(MIG_TABLES).toMatch(
      /for insert\s*\n?\s*with check \(org_id in \(select public\.current_org_ids\(\)\)\)/i,
    );
  });

  it("version INSERT requires staff-visibility OR admin (blocks staff JWT writing private versions)", () => {
    const versionInsert = MIG_TABLES.slice(
      MIG_TABLES.indexOf('"job_document_versions: insert staff or admin"'),
    );
    expect(versionInsert).toMatch(/for insert/i);
    expect(versionInsert).toMatch(
      /visibility = 'staff' or public\.is_org_admin\(org_id\)/i,
    );
  });

  it("UPDATE re-checks the gate in WITH CHECK so visibility can't be flipped to escape", () => {
    const upd = MIG_TABLES.slice(
      MIG_TABLES.indexOf('"job_documents: update staff or admin"'),
    );
    // both a USING and a WITH CHECK clause carrying the gate
    expect(upd).toMatch(/using \([\s\S]*?is_org_admin\(org_id\)[\s\S]*?\)/i);
    expect(upd).toMatch(/with check \([\s\S]*?is_org_admin\(org_id\)[\s\S]*?\)/i);
  });

  it("DELETE is owner/admin only on both tables", () => {
    expect(MIG_TABLES).toMatch(
      /"job_documents: delete admin"[\s\S]*?for delete\s*\n?\s*using \(public\.is_org_admin\(org_id\)\)/i,
    );
    expect(MIG_TABLES).toMatch(
      /"job_document_versions: delete admin"[\s\S]*?for delete\s*\n?\s*using \(public\.is_org_admin\(org_id\)\)/i,
    );
  });

  it("versions are immutable — there is NO UPDATE policy on job_document_versions", () => {
    expect(MIG_TABLES).not.toMatch(/on public\.job_document_versions for update/i);
  });
});

// =====================================================================
// Versioning triggers
// =====================================================================

describe("job_documents — versioning triggers", () => {
  it("before-insert is SECURITY DEFINER and locks the parent row", () => {
    expect(MIG_TABLES).toMatch(
      /create or replace function public\.tg_job_document_version_before_insert\(\)/i,
    );
    const fn = MIG_TABLES.slice(
      MIG_TABLES.indexOf("tg_job_document_version_before_insert()"),
    );
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/select \* into v_doc[\s\S]*?for update/i);
  });

  it("derives authoritative org_id/visibility from the parent (ignores client input)", () => {
    expect(MIG_TABLES).toMatch(/new\.org_id := v_doc\.org_id/i);
    expect(MIG_TABLES).toMatch(/new\.visibility := v_doc\.visibility/i);
  });

  it("blocks new versions on a completed document (the completion lock)", () => {
    expect(MIG_TABLES).toMatch(/v_doc\.status = 'completed'/i);
    expect(MIG_TABLES).toMatch(/is completed and locked/i);
  });

  it("auto-increments version_no = max+1 under the parent lock", () => {
    expect(MIG_TABLES).toMatch(/coalesce\(max\(version_no\), 0\) \+ 1/i);
  });

  it("enforces the bucket↔visibility invariant", () => {
    expect(MIG_TABLES).toMatch(/private documents must use the job-docs-private bucket/i);
    expect(MIG_TABLES).toMatch(/staff documents must use the job-docs bucket/i);
  });

  it("after-insert maintains current_version and updated_by; updated_at via tg_set_updated_at", () => {
    expect(MIG_TABLES).toMatch(
      /create or replace function public\.tg_job_document_version_after_insert\(\)/i,
    );
    expect(MIG_TABLES).toMatch(/current_version = new\.id/i);
    expect(MIG_TABLES).toMatch(
      /job_documents_set_updated_at[\s\S]*?execute function public\.tg_set_updated_at\(\)/i,
    );
  });
});

// =====================================================================
// Storage buckets + RLS (the physical private boundary)
// =====================================================================

describe("job-docs buckets — physical isolation of private bytes", () => {
  it("creates two private (non-public) buckets with a 25MB limit and a MIME whitelist", () => {
    expect(MIG_BUCKETS).toMatch(/insert into storage\.buckets/i);
    expect(MIG_BUCKETS).toMatch(/'job-docs',\s*'job-docs',\s*false,\s*26214400/i);
    expect(MIG_BUCKETS).toMatch(
      /'job-docs-private',\s*'job-docs-private',\s*false,\s*26214400/i,
    );
    expect(MIG_BUCKETS).toMatch(/allowed_mime_types/i);
    expect(MIG_BUCKETS).toMatch(/'application\/pdf'/i);
    expect(MIG_BUCKETS).toMatch(/on conflict \(id\) do update/i);
  });

  it("HARD boundary: job-docs-private READ is admin-only", () => {
    const readPolicy = MIG_BUCKETS.slice(
      MIG_BUCKETS.indexOf('"job-docs-private: admins can read"'),
    );
    expect(readPolicy).toMatch(/for select to authenticated/i);
    expect(readPolicy).toMatch(
      /bucket_id = 'job-docs-private'\s*\n?\s*and public\.is_org_admin\(\(split_part\(name, ?'\/', ?1\)\)::uuid\)/i,
    );
  });

  it("there is NO members-can-read policy on the private bucket", () => {
    expect(MIG_BUCKETS).not.toMatch(/"job-docs-private: members can read"/i);
  });

  it("drop box: any member can INSERT into job-docs-private (write-only)", () => {
    const ins = MIG_BUCKETS.slice(
      MIG_BUCKETS.indexOf('"job-docs-private: members can insert"'),
    );
    expect(ins).toMatch(/for insert to authenticated/i);
    expect(ins).toMatch(
      /bucket_id = 'job-docs-private'[\s\S]*?current_org_ids\(\)/i,
    );
  });

  it("private deletes are admin-only", () => {
    expect(MIG_BUCKETS).toMatch(
      /"job-docs-private: admins can delete"[\s\S]*?public\.is_org_admin/i,
    );
  });

  it("staff area (job-docs): members read+insert, admins delete", () => {
    expect(MIG_BUCKETS).toMatch(/"job-docs: members can read"[\s\S]*?current_org_ids\(\)/i);
    expect(MIG_BUCKETS).toMatch(/"job-docs: members can insert"[\s\S]*?current_org_ids\(\)/i);
    expect(MIG_BUCKETS).toMatch(/"job-docs: admins can delete"[\s\S]*?is_org_admin/i);
  });
});

// =====================================================================
// Activity-log private filter (no metadata leak to staff)
// =====================================================================

describe("activity_log — private-document audit rows hidden from staff", () => {
  it("recreates the existing member SELECT policy (authenticated, org-scoped)", () => {
    expect(MIG_ACTIVITY).toMatch(
      /drop policy if exists "activity_log: members can select" on public\.activity_log/i,
    );
    expect(MIG_ACTIVITY).toMatch(
      /create policy "activity_log: members can select"\s*\n?\s*on public\.activity_log for select to authenticated/i,
    );
    expect(MIG_ACTIVITY).toMatch(/org_id in \(select public\.current_org_ids\(\)\)/i);
  });

  it("filters out job_document.private.* rows unless the caller is an admin", () => {
    expect(MIG_ACTIVITY).toMatch(/action not like 'job_document\.private\.%'/i);
    expect(MIG_ACTIVITY).toMatch(/or public\.is_org_admin\(org_id\)/i);
  });
});
