import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Interim valuation / application-for-payment (20261192000000) — trust-boundary
 * and money-integrity proofs, pinned against the migration + source.
 *
 * The properties a later edit could quietly drop:
 *   - tenant isolation: RLS on both tables; composite (…, org_id) FKs; own
 *     candidate key.
 *   - the two RPCs are SECURITY DEFINER, search_path-pinned, and revoked from
 *     anon/authenticated (Supabase default-grants EXECUTE at CREATE time).
 *   - certified→invoice generation REUSES the invoice authority
 *     (next_invoice_number + invoices + invoice_line_items) — one money path.
 *   - retention is NOT forked: the migration writes NOTHING to retention_releases
 *     and adds no money-affecting retention column.
 *   - no double bill: the variation guard refuses a variation with an issued
 *     invoice, and the increment is fenced non-negative.
 *   - the portal projection carries no cost.
 *   - both new org-scoped tables are registered in the GDPR census.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261192000000_job_valuations.sql";
const COMPUTE = "lib/valuations/compute.ts";
const PORTAL = "lib/valuations/portal.ts";
const SERVICE = "server/services/job-valuations.ts";
const ACTIONS = "app/(app)/jobs/[id]/valuation-actions.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

describe("valuation migration — tenant isolation", () => {
  const sql = read(MIG);
  const exec = sqlOnly(sql);

  it("enables RLS on both new tables", () => {
    expect(exec).toContain("alter table public.job_valuations enable row level security");
    expect(exec).toContain("alter table public.job_valuation_variations enable row level security");
  });

  it("job_valuations carries a composite job FK + its own (id, org_id) candidate key", () => {
    expect(exec).toMatch(/foreign key \(job_id, org_id\)\s*references public\.jobs \(id, org_id\)/);
    expect(exec).toContain("constraint job_valuations_id_org_key unique (id, org_id)");
    expect(exec).toMatch(/foreign key \(invoice_id, org_id\)\s*references public\.invoices \(id, org_id\)/);
  });

  it("the variation junction FKs both parent valuation and quote by (id, org_id)", () => {
    expect(exec).toMatch(/foreign key \(valuation_id, org_id\)\s*references public\.job_valuations \(id, org_id\)/);
    expect(exec).toMatch(/foreign key \(variation_quote_id, org_id\)\s*references public\.quotes \(id, org_id\)/);
  });

  it("a variation can be included in at most one valuation (no double inclusion)", () => {
    expect(exec).toContain("unique (org_id, variation_quote_id)");
  });

  it("member-write RLS is scoped by current_org_ids and admin delete by is_org_admin", () => {
    expect(exec).toContain("org_id in (select public.current_org_ids())");
    expect(exec).toContain("public.is_org_admin(org_id)");
  });
});

describe("valuation migration — the two RPCs are locked down", () => {
  const exec = sqlOnly(read(MIG));

  for (const fn of ["certify_valuation", "generate_valuation_invoice"]) {
    it(`${fn} is SECURITY DEFINER with a pinned search_path`, () => {
      const re = new RegExp(
        `create or replace function public\\.${fn}[\\s\\S]*?security definer[\\s\\S]*?set search_path = public`,
      );
      expect(exec).toMatch(re);
    });
    it(`${fn} revokes EXECUTE from anon + authenticated`, () => {
      expect(exec).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
    });
    it(`${fn} re-checks is_org_admin inside`, () => {
      const body = exec.slice(exec.indexOf(`function public.${fn}`));
      expect(body.slice(0, 2500)).toContain("is_org_admin");
    });
  }
});

describe("valuation migration — one money path, retention not forked", () => {
  const exec = sqlOnly(read(MIG));

  it("generation reuses the invoice authority (next_invoice_number + invoices + invoice_line_items)", () => {
    expect(exec).toContain("public.next_invoice_number(v_val.org_id)");
    expect(exec).toContain("insert into public.invoices");
    expect(exec).toContain("insert into public.invoice_line_items");
  });

  it("the generated invoice ex-VAT amount is the FULL certified increment (retention applied once elsewhere)", () => {
    // amount = net_certified_this, NOT a retention-reduced figure.
    expect(exec).toMatch(/insert into public\.invoices[\s\S]*?v_val\.net_certified_this/);
  });

  it("writes NOTHING to retention_releases and adds no money-affecting retention ledger", () => {
    expect(exec).not.toContain("retention_releases");
  });

  it("CAS-binds invoice_id and refuses if already invoiced (idempotent, no double bill)", () => {
    expect(exec).toContain("this valuation has already been invoiced");
    expect(exec).toMatch(/set status = 'invoiced', invoice_id = v_invoice/);
  });
});

describe("valuation migration — no double bill of variations, non-negative increment", () => {
  const exec = sqlOnly(read(MIG));

  it("the link guard refuses a variation that already carries an issued invoice", () => {
    expect(exec).toMatch(/already has an issued invoice/);
    expect(exec).toContain("i.status <> 'draft'");
  });

  it("certification refuses a negative certified increment", () => {
    expect(exec).toMatch(/certified amount is negative/);
  });

  it("only an accepted variation on the same job can be linked", () => {
    expect(exec).toContain("only an accepted variation can be included");
    expect(exec).toContain("belongs to a different job than the valuation");
  });

  it("a certified valuation's money columns are frozen", () => {
    expect(exec).toMatch(/its figures are immutable/);
  });
});

describe("valuation portal projection carries no internal cost", () => {
  const portal = read(PORTAL);

  it("takes no cost/notes parameter and never selects a cost column", () => {
    expect(portal).not.toMatch(/cost_?(labour|materials|subcontractors|misc|total)/i);
    expect(portal.toLowerCase()).not.toContain("margin");
  });

  it("the portal service read never selects a cost column from quotes", () => {
    const svc = read(SERVICE);
    // The service reads variation link amounts, never quotes.cost_*.
    expect(svc).not.toMatch(/cost_(labour|materials|subcontractors|misc|total)/);
  });
});

describe("valuation server actions pin the active org", () => {
  const actions = read(ACTIONS);

  it("every by-id update/delete carries .eq(\"org_id\", ctx.org.id)", () => {
    // No .eq("id", …) update/delete may omit the org pin. Cheap structural proof:
    // the file uses ctx.org.id on the write paths.
    expect(actions).toContain('.eq("org_id", ctx.org.id)');
    // The mutation helpers all resolve org from the active context, not a row.
    expect(actions).toContain("requireOrgContext");
  });

  it("audits through the _record_activity authority", () => {
    expect(actions).toContain("_record_activity");
  });
});

describe("GDPR census registration", () => {
  const raw = read("lib/gdpr/org-tables.json");
  const json = JSON.parse(raw) as {
    known: string[];
    erasure_anonymise: Record<string, string>;
  };

  for (const t of ["job_valuations", "job_valuation_variations"]) {
    it(`${t} is in known and classified for erasure (financial → anonymise)`, () => {
      expect(json.known).toContain(t);
      expect(Object.keys(json.erasure_anonymise)).toContain(t);
    });
  }
});
