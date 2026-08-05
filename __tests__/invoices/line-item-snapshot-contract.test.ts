import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #349 Phase 2 — snapshot wiring + trigger contract.
 *
 * The behavioural guarantees (atomic snapshot, immutability, cascade, cross-org
 * rejection) are the real-Postgres integration suite. This pins on source:
 *   - the trigger is the SOLE snapshot authority (no app-level snapshot insert);
 *   - every invoice line-item READER uses invoice_line_items, not quote_line_items;
 *   - the migration mirrors #351/#357 and the trigger can't swallow a failure.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const MIG = read("supabase/migrations/20260916000000_invoice_line_item_snapshot.sql");

const INVOICE_READERS = [
  "app/(app)/invoices/[id]/page.tsx",
  "app/api/invoices/[id]/pdf/route.ts",
  "app/customer-portal/[token]/invoices/[id]/pdf/route.ts",
  "lib/email/send-invoice.ts",
  "app/api/invoices/export/route.ts",
];

const INVOICE_WRITERS = [
  "app/api/invoices/route.ts",
  "app/(app)/quotes/actions.ts",
  "app/(app)/imports/actions.ts",
];

// =====================================================================
// The trigger is the SOLE creation authority
// =====================================================================

describe("snapshot creation — trigger only, no app-level insert", () => {
  it("the migration defines an AFTER INSERT trigger on invoices", () => {
    expect(MIG).toMatch(
      /create trigger invoices_snapshot_line_items\s*\n\s*after insert on public\.invoices/,
    );
    expect(MIG).toMatch(/execute function public\._tg_invoices_snapshot_line_items/);
  });

  it("the trigger copies only NEW.quote_id, same-org, in order", () => {
    expect(MIG).toMatch(/where li\.quote_id = NEW\.quote_id/);
    expect(MIG).toMatch(/and li\.org_id = NEW\.org_id/);
    expect(MIG).toMatch(/order by li\.sort_order/);
  });

  it("the trigger is null-safe on quote_id", () => {
    expect(MIG).toMatch(/if NEW\.quote_id is not null then/);
  });

  it("the trigger has NO exception handler — a failure propagates and rolls back", () => {
    // Rollback is structural: an AFTER INSERT trigger runs in the invoice
    // insert's transaction, so any error it raises rolls the insert back. A
    // BEGIN/EXCEPTION block would swallow that guarantee — there must be none.
    const fn = MIG.slice(
      MIG.indexOf("_tg_invoices_snapshot_line_items"),
      MIG.indexOf("$fn$;"),
    );
    expect(fn).not.toMatch(/\bexception\b/i);
  });

  it("NO invoice writer performs an application-level snapshot insert", () => {
    for (const p of INVOICE_WRITERS) {
      expect(read(p)).not.toMatch(/from\("invoice_line_items"\)/);
    }
  });
});

// =====================================================================
// Table + integrity (the #351/#357 composite-FK pattern)
// =====================================================================

describe("invoice_line_items — schema + integrity", () => {
  it("carries only the fields needed to reproduce the invoice", () => {
    for (const col of [
      "invoice_id",
      "org_id",
      "description",
      "qty",
      "unit",
      "unit_price",
      "vat_rate",
      "line_total",
      "sort_order",
    ]) {
      expect(MIG).toMatch(new RegExp(`\\b${col}\\b`));
    }
    // No quote_id column — a snapshot must not point back at the mutable
    // source. Check the column DEFINITIONS, not comments that mention quote_id
    // to explain its absence.
    const createBlock = MIG.slice(
      MIG.indexOf("create table if not exists public.invoice_line_items"),
      MIG.indexOf("comment on constraint"),
    );
    const codeLines = createBlock
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(codeLines).not.toMatch(/\bquote_id\b/);
  });

  it("mirrors the source numeric precision so a valid quote never overflows", () => {
    expect(MIG).toMatch(/qty\s+numeric\(12, 2\)/);
    expect(MIG).toMatch(/unit_price\s+numeric\(12, 2\)/);
    expect(MIG).toMatch(/line_total\s+numeric\(12, 2\)/);
    expect(MIG).toMatch(/vat_rate\s+numeric\(5, 2\)/);
  });

  it("uses the composite FK to invoices (id, org_id), ON DELETE CASCADE", () => {
    expect(MIG).toMatch(
      /foreign key \(invoice_id, org_id\)\s*\n?\s*references public\.invoices \(id, org_id\)\s*\n?\s*on delete cascade/,
    );
  });

  it("has RLS + a members-select policy (org-scoped reads)", () => {
    expect(MIG).toMatch(/enable row level security/);
    expect(MIG).toMatch(/for select to authenticated\s*\n\s*using \(org_id in \(select public\.current_org_ids\(\)\)\)/);
  });

  it("orders by (invoice_id, sort_order) for deterministic rendering", () => {
    expect(MIG).toMatch(/invoice_line_items_invoice_idx\s*\n?\s*on public\.invoice_line_items \(invoice_id, sort_order\)/);
  });
});

// =====================================================================
// Backfill — safe + idempotent
// =====================================================================

describe("legacy backfill", () => {
  it("copies same-org quote lines only, guarded against duplicates", () => {
    expect(MIG).toMatch(/from public\.invoices i\s*\n\s*join public\.quote_line_items li/);
    expect(MIG).toMatch(/and li\.org_id = i\.org_id/);
    expect(MIG).toMatch(/not exists \(\s*\n\s*select 1 from public\.invoice_line_items existing/);
  });
});

// =====================================================================
// Reader migration — snapshot is the sole authority
// =====================================================================

describe("readers use the snapshot, never live quote line items", () => {
  for (const p of INVOICE_READERS) {
    it(`${p} reads invoice_line_items and not quote_line_items`, () => {
      const src = read(p);
      expect(src).toMatch(/from\("invoice_line_items"\)/);
      expect(src).not.toMatch(/from\("quote_line_items"\)/);
    });
  }

  it("readers key line items by invoice_id, not quote_id", () => {
    expect(read("app/(app)/invoices/[id]/page.tsx")).toMatch(/\.eq\("invoice_id", id\)/);
    expect(read("app/api/invoices/[id]/pdf/route.ts")).toMatch(/\.eq\("invoice_id", id\)/);
    expect(read("app/customer-portal/[token]/invoices/[id]/pdf/route.ts")).toMatch(
      /\.eq\("invoice_id", invoice\.id\)/,
    );
    expect(read("lib/email/send-invoice.ts")).toMatch(/\.eq\("invoice_id", invoice\.id\)/);
    // F-1: the export now chunks the id list and pages each chunk, so the
    // key is `idsChunk` (a slice of invoiceIds) — still keyed by invoice_id.
    expect(read("app/api/invoices/export/route.ts")).toMatch(/\.in\("invoice_id", idsChunk\)/);
  });
});

// =====================================================================
// Scope — nothing financial changed
// =====================================================================

describe("scope: totals / VAT / lifecycle untouched", () => {
  it("the migration does not touch invoice totals, status, VAT or payment triggers", () => {
    expect(MIG).not.toMatch(/alter table public\.invoices/i);
    expect(MIG).not.toMatch(/invoice_payments|_tg_invoice_payments|invoice_status|vat_total\s*=/i);
  });
});
