import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
} from "@/lib/gdpr/export-tables";

/**
 * Org config (org_settings, 20261146) — trust-boundary proofs.
 *
 * Pins the properties a later edit could quietly drop:
 *   1. member-READ / admin-WRITE RLS at the DB (not just in the action);
 *   2. org isolation — org_id sourced from the session, never client input;
 *   3. loud reads — a failed config read throws, never renders defaults;
 *   4. the table is registered for DSAR export and is NOT excluded (it is
 *      non-PII org config, and org isolation is via org_id + RLS).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261146000000_org_settings.sql";
const SERVICE = "lib/org-config/service.ts";
const ACTIONS = "app/(app)/settings/org-config-actions.ts";

/** Strip SQL line comments so assertions test the EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const sql = sqlOnly(read(MIG));

describe("org_settings RLS — member read, admin write", () => {
  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.org_settings enable row level security/);
  });

  it("SELECT is org-member scoped (current_org_ids)", () => {
    expect(sql).toMatch(/for select\s+using \(org_id in \(select public\.current_org_ids\(\)\)\)/);
  });

  it("INSERT and UPDATE are admin-only (is_org_admin), including WITH CHECK", () => {
    // Admin gate on both write verbs — a plain member cannot change org config
    // even by calling the API directly.
    expect(sql).toMatch(/for insert\s+with check \(public\.is_org_admin\(org_id\)\)/);
    expect(sql).toMatch(/for update\s+using \(public\.is_org_admin\(org_id\)\)/);
    const updateWithCheck = /for update[\s\S]*?with check \(public\.is_org_admin\(org_id\)\)/;
    expect(sql).toMatch(updateWithCheck);
  });

  it("has NO delete policy (config removed only via org cascade)", () => {
    expect(sql).not.toMatch(/for delete/);
  });

  it("is one-row-per-org (unique org_id) and cascades on org teardown", () => {
    expect(sql).toMatch(/org_id\s+uuid not null unique references public\.organizations\(id\) on delete cascade/);
  });

  it("bounds the tax fields with CHECK constraints (defence in depth vs the app)", () => {
    expect(sql).toMatch(/default_vat_rate\s+smallint[\s\S]*?check \(default_vat_rate in \(0, 5, 20\)\)/);
    expect(sql).toMatch(/cis_default_rate\s+smallint[\s\S]*?check \(cis_default_rate in \(0, 20, 30\)\)/);
    expect(sql).toMatch(/financial_year_start_month[\s\S]*?between 1 and 12/);
    expect(sql).toMatch(/default_payment_terms_days[\s\S]*?between 0 and 365/);
  });
});

describe("org isolation — org_id from the session, never the client", () => {
  const actions = read(ACTIONS);

  it("resolves org from requireOrgContext, not from form input", () => {
    expect(actions).toMatch(/requireOrgContext/);
    // The write binds org_id to ctx.org.id — the session's org — on both upserts.
    const orgIdFromCtx = actions.match(/org_id: ctx\.org\.id/g) ?? [];
    expect(orgIdFromCtx.length).toBeGreaterThanOrEqual(2);
    // No org id is ever read out of the submitted formData.
    expect(actions).not.toMatch(/formData\.get\(["'`]org_id/);
  });

  it("enforces admin in the action as well as at the DB", () => {
    expect(actions).toMatch(/role === "owner"/);
    expect(actions).toMatch(/role === "admin"/);
    expect(actions).toMatch(/Only admins\/owners can change/);
  });
});

describe("loud reads — a failed config read throws", () => {
  it("the read service throws readFailure on a query error", () => {
    const service = read(SERVICE);
    expect(service).toMatch(/if \(error\) throw readFailure\(/);
    // A missing row is the designed empty state — defaults, not a throw.
    expect(service).toMatch(/if \(!data\) return defaultOrgSettings\(\)/);
  });
});

describe("GDPR registration — org config is DSAR-exportable, org-scoped", () => {
  it("org_settings is a KNOWN org-scoped table", () => {
    expect(KNOWN_ORG_SCOPED_TABLES).toContain("org_settings");
  });

  it("org_settings is NOT on the credential/secret deny-list", () => {
    expect(EXCLUDED_FROM_EXPORT).not.toHaveProperty("org_settings");
  });

  it("org_settings therefore flows into the export set", () => {
    expect(ORG_EXPORT_TABLES).toContain("org_settings");
  });
});
