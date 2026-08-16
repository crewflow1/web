import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Quote version history — migration + app-source security contracts.
 *
 * The runtime behaviour (atomic capture, cross-org rejection, cascade) belongs
 * to a real-Postgres suite; this pins the load-bearing invariants at the source,
 * mirroring __tests__/invoices/line-item-snapshot-contract.test.ts:
 *   - quote_versions is APPEND-ONLY (RLS select-only + service-role backstop
 *     triggers that raise on UPDATE and DELETE);
 *   - reads are ORG-SCOPED (RLS + the page's active-org pin);
 *   - the capture TRIGGER is the sole creation authority (no app-level insert);
 *   - tenant integrity via the composite FK to quotes(id, org_id);
 *   - the table is registered for GDPR export.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const MIG = read("supabase/migrations/20261150000000_quote_versions.sql");
const PAGE = read("app/(app)/quotes/[id]/page.tsx");
const ORG_TABLES = JSON.parse(read("lib/gdpr/org-tables.json")) as { known: string[] };

// =====================================================================
// Append-only — RLS grants SELECT only; no insert/update/delete policy
// =====================================================================
describe("append-only — RLS is select-only", () => {
  it("enables RLS and grants members SELECT scoped to their orgs", () => {
    expect(MIG).toMatch(/alter table public\.quote_versions enable row level security/);
    expect(MIG).toMatch(
      /for select to authenticated\s*\n\s*using \(org_id in \(select public\.current_org_ids\(\)\)\)/,
    );
  });

  it("defines NO insert/update/delete RLS policy (writes are trigger-only)", () => {
    const policyLines = MIG.split("\n").filter((l) => /^\s*create policy/i.test(l));
    // exactly one policy, and it is the SELECT one
    expect(policyLines).toHaveLength(1);
    for (const p of policyLines) {
      expect(p).not.toMatch(/for (insert|update|delete|all)/i);
    }
    expect(MIG).not.toMatch(/for insert to authenticated/i);
    expect(MIG).not.toMatch(/for update to authenticated/i);
    expect(MIG).not.toMatch(/for delete to authenticated/i);
  });
});

// =====================================================================
// Append-only — service-role backstop triggers
// =====================================================================
describe("append-only — service-role backstop triggers", () => {
  it("a BEFORE UPDATE trigger raises for every role (no role/auth gate)", () => {
    expect(MIG).toMatch(/create trigger quote_versions_frozen\s*\n\s*before update on public\.quote_versions/);
    const start = MIG.indexOf("create or replace function public.tg_quote_versions_frozen()");
    const fn = MIG.slice(start, MIG.indexOf("$$;", start));
    expect(fn).toMatch(/raise exception/);
    // Unconditional — no auth.uid()/role escape hatch that would let a
    // service-role or privileged writer through.
    expect(fn).not.toMatch(/auth\.uid\(\)/);
    expect(fn).not.toMatch(/if\s/i);
  });

  it("a BEFORE DELETE trigger blocks direct deletes but yields to the parent cascade", () => {
    expect(MIG).toMatch(/create trigger quote_versions_no_delete\s*\n\s*before delete on public\.quote_versions/);
    const start = MIG.indexOf("create or replace function public.tg_quote_versions_no_delete()");
    const fn = MIG.slice(start, MIG.indexOf("$$;", start));
    // Raises only while the parent quote still exists — a cascade (quote already
    // gone) is allowed, a bare delete is refused.
    expect(fn).toMatch(/if exists \(select 1 from public\.quotes where id = old\.quote_id\)/);
    expect(fn).toMatch(/raise exception/);
    expect(fn).toMatch(/return old/);
  });
});

// =====================================================================
// Capture trigger — the sole creation authority
// =====================================================================
describe("capture — trigger only, no app-level insert", () => {
  it("defines an AFTER UPDATE trigger on quotes", () => {
    expect(MIG).toMatch(
      /create trigger quotes_capture_version\s*\n\s*after update on public\.quotes/,
    );
    expect(MIG).toMatch(/execute function public\._tg_quotes_capture_version/);
  });

  it("captures only on a real transition into 'sent' or 'approved'", () => {
    expect(MIG).toMatch(/if new\.status is not distinct from old\.status then/);
    expect(MIG).toMatch(/if new\.status not in \('sent', 'approved'\) then/);
  });

  it("is idempotent per (quote_id, version_number)", () => {
    expect(MIG).toMatch(/constraint quote_versions_quote_version_key unique \(quote_id, version_number\)/);
    expect(MIG).toMatch(/on conflict \(quote_id, version_number\) do nothing/);
  });

  it("snapshots same-org line items only, deterministically ordered", () => {
    expect(MIG).toMatch(/where li\.quote_id = new\.id/);
    expect(MIG).toMatch(/and li\.org_id = new\.org_id/);
    expect(MIG).toMatch(/order by li\.sort_order, li\.id/);
  });

  it("the capture function has NO exception handler — failure rolls the transition back", () => {
    const fn = MIG.slice(
      MIG.indexOf("create or replace function public._tg_quotes_capture_version()"),
      MIG.indexOf("$fn$;"),
    );
    expect(fn).not.toMatch(/\bexception\b/i);
  });

  it("NO app code performs an application-level quote_versions insert", () => {
    for (const p of ["app/(app)/quotes/actions.ts", "app/(app)/quotes/[id]/page.tsx"]) {
      expect(read(p)).not.toMatch(/from\("quote_versions"\)[\s\S]{0,40}\.insert/);
    }
    expect(read("app/(app)/quotes/actions.ts")).not.toMatch(/\.insert\([^)]*quote_versions/);
  });
});

// =====================================================================
// Tenant integrity + schema
// =====================================================================
describe("tenant integrity + schema", () => {
  it("org_id references organizations ON DELETE CASCADE", () => {
    expect(MIG).toMatch(/org_id\s+uuid not null references public\.organizations\(id\) on delete cascade/);
  });

  it("uses the composite FK to quotes (id, org_id), ON DELETE CASCADE", () => {
    expect(MIG).toMatch(
      /foreign key \(quote_id, org_id\)\s*\n?\s*references public\.quotes \(id, org_id\)\s*\n?\s*on delete cascade/,
    );
  });

  it("constrains captured_reason to the closed vocabulary", () => {
    expect(MIG).toMatch(/check \(captured_reason in \('sent', 'approved', 're-approved'\)\)/);
  });

  it("requires line_items to be a jsonb array", () => {
    expect(MIG).toMatch(/check \(jsonb_typeof\(line_items\) = 'array'\)/);
  });
});

// =====================================================================
// Org-scoped reads on the page + GDPR registration
// =====================================================================
describe("org-scoped reads + GDPR registration", () => {
  it("the page reads quote_versions pinned to the active org", () => {
    expect(PAGE).toMatch(/\.from\("quote_versions"\)/);
    const block = PAGE.slice(PAGE.indexOf('.from("quote_versions")'));
    expect(block).toMatch(/\.eq\("quote_id", id\)/);
    expect(block).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("registers quote_versions for GDPR export (org-tables.json known)", () => {
    expect(ORG_TABLES.known).toContain("quote_versions");
  });
});

// =====================================================================
// Backfill — safe + idempotent
// =====================================================================
describe("legacy backfill", () => {
  it("seeds version 1 only for milestone-reached quotes, guarded against duplicates", () => {
    expect(MIG).toMatch(/where \(q\.sent_at is not null or q\.approved_at is not null\)/);
    expect(MIG).toMatch(/not exists \(\s*\n\s*select 1 from public\.quote_versions existing/);
  });
});
