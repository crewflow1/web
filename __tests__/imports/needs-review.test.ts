import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  detectEntityType,
  mapRow,
  remapRawToEntity,
} from "@/lib/imports/detect";
import type { ParsedSheet } from "@/lib/imports/parsers";

/**
 * Migration OS — "Needs review" flow.
 *
 * The guided-migration contract is explicit: when extraction is uncertain we
 * surface the row for human review, NEVER silently drop it and NEVER mark it
 * "failed". Before this change every parsed row landed as `pending`, and
 * commitImport only processed `pending AND confidence >= 50` — so
 * low-confidence and unknown-entity rows were quietly excluded with no visible
 * trace.
 *
 * This pins the fix end to end:
 *   1. remapRawToEntity (pure) re-derives mapped fields when an operator
 *      re-classifies a reviewed row.
 *   2. The uncertainty predicate upload uses (entity unknown OR confidence
 *      below the threshold) is proven against the REAL detector output.
 *   3. Source pins: the migration widens the status CHECK; uploadImportFiles
 *      routes uncertain rows to `needs_review`; resolveReviewRow confirms /
 *      re-classifies / skips; the wizard renders + acts on the queue.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

const sheet = (header: string[], rows: (string | number | null)[][]): ParsedSheet => ({
  name: "s",
  header,
  rows,
});

// The 50% bar must match REVIEW_THRESHOLD in app/(app)/imports/actions.ts.
const REVIEW_THRESHOLD = 50;

describe("remapRawToEntity re-derives mapped fields for a chosen entity", () => {
  it("maps a customer-shaped raw record", () => {
    const m = remapRawToEntity(
      { Name: "Acme Ltd", Email: "Owner@Acme.COM", Phone: "07700 900 123" },
      "customer",
    );
    expect(m.entity_type).toBe("customer");
    expect(m.mapped.name).toBe("Acme Ltd");
    expect(m.mapped.email).toBe("owner@acme.com"); // lowercased
    expect(m.mapped.phone).toBe("07700900123"); // whitespace stripped
  });

  it("maps an invoice-shaped raw record (money + number parsed)", () => {
    const m = remapRawToEntity(
      { "Invoice Number": "INV-1", Total: "£1,200.00", "Due Date": "2026-06-30" },
      "invoice",
    );
    expect(m.entity_type).toBe("invoice");
    expect(m.mapped.number).toBe("INV-1");
    expect(m.mapped.total).toBe(1200);
  });

  it("honours the chosen entity even when columns look generic (re-classify)", () => {
    // An operator overriding a mis-detected row to 'cost'.
    const m = remapRawToEntity({ Amount: "500", Category: "Materials" }, "cost");
    expect(m.entity_type).toBe("cost");
    expect(m.mapped.amount).toBe(500);
  });

  it("flags missing required fields as warnings rather than throwing", () => {
    const m = remapRawToEntity({ Foo: "bar" }, "customer");
    expect(m.mapped.name).toBeUndefined();
    expect(m.warnings.some((w) => /missing/.test(w))).toBe(true);
  });
});

describe("the upload uncertainty predicate matches the real detector", () => {
  it("a garbage sheet is uncertain → would be parked as needs_review", () => {
    const s = sheet(["foo", "bar"], [["x", "y"]]);
    const d = detectEntityType(s);
    const m = mapRow(d, s.rows[0]!);
    const uncertain = d.entity_type === "unknown" || m.confidence < REVIEW_THRESHOLD;
    expect(uncertain).toBe(true);
  });

  it("a clean contact sheet is confident → would commit as pending", () => {
    // We don't pin WHICH entity wins (customer vs staff overlap on
    // name/email) — only that detection is confident, so the row routes to
    // `pending`, not the review queue.
    const s = sheet(
      ["full name", "email", "phone"],
      [["Acme Ltd", "a@b.com", "07700900123"]],
    );
    const d = detectEntityType(s);
    const m = mapRow(d, s.rows[0]!);
    expect(d.entity_type).not.toBe("unknown");
    expect(m.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    const uncertain = d.entity_type === "unknown" || m.confidence < REVIEW_THRESHOLD;
    expect(uncertain).toBe(false);
  });
});

describe("migration widens import_rows.status to admit needs_review", () => {
  const sql = read(
    "supabase/migrations/20260702000000_add_import_rows_needs_review_status.sql",
  );

  it("drops + re-adds the named constraint (idempotent)", () => {
    expect(sql).toMatch(/drop constraint if exists import_rows_status_check/);
    expect(sql).toMatch(/add constraint\s+import_rows_status_check/);
  });

  it("admits 'needs_review' alongside every existing status", () => {
    for (const s of [
      "needs_review",
      "pending",
      "imported",
      "skipped",
      "error",
      "duplicate",
      "merged",
    ]) {
      expect(sql).toMatch(new RegExp(`'${s}'`));
    }
  });
});

describe("uploadImportFiles routes uncertain rows to needs_review", () => {
  const src = read("app/(app)/imports/actions.ts");

  it("uses one shared REVIEW_THRESHOLD for routing + the commit gate", () => {
    expect(src).toMatch(/const REVIEW_THRESHOLD = 50/);
    expect(src).toMatch(/\.gte\("confidence", REVIEW_THRESHOLD\)/);
  });

  it("parks uncertain rows as needs_review, confident ones as pending", () => {
    expect(src).toMatch(/detected\.entity_type === "unknown"/);
    expect(src).toMatch(/mapped\.confidence < REVIEW_THRESHOLD/);
    expect(src).toMatch(/status: uncertain \? "needs_review" : "pending"/);
  });
});

describe("resolveReviewRow turns a reviewed row into an explicit decision", () => {
  const src = read("app/(app)/imports/actions.ts");

  it("exists as a server action handling confirm + skip", () => {
    expect(src).toMatch(/export async function resolveReviewRow\(/);
    expect(src).toMatch(/intent === "skip"/);
    expect(src).toMatch(/intent === "confirm"/);
  });

  it("skip → status skipped, never a silent drop", () => {
    expect(src).toMatch(/status: "skipped", error_message: "skipped in review"/);
  });

  it("confirm → pending with human-verified confidence", () => {
    expect(src).toMatch(/status: "pending"/);
    expect(src).toMatch(/confidence: 100/);
  });

  it("re-classify re-derives fields via remapRawToEntity", () => {
    expect(src).toMatch(/remapRawToEntity\(raw, finalEntity\)/);
  });

  it("forces an entity choice before committing an unknown row", () => {
    expect(src).toMatch(/if \(!finalEntity\)/);
    expect(src).toMatch(/error=pick_entity_type/);
  });
});

describe("the wizard surfaces + acts on the needs-review queue", () => {
  const page = read("app/(app)/imports/[id]/page.tsx");

  it("imports and binds the resolveReviewRow action", () => {
    expect(page).toMatch(/resolveReviewRow/);
    expect(page).toMatch(/action=\{resolveReviewRow\.bind\(null, r\.id\)\}/);
  });

  it("filters the needs_review rows into their own section", () => {
    expect(page).toMatch(/r\.status === "needs_review"/);
    expect(page).toMatch(/Needs review/);
  });

  it("offers confirm / skip + an entity-type picker per row", () => {
    expect(page).toMatch(/value="confirm"/);
    expect(page).toMatch(/value="skip"/);
    expect(page).toMatch(/name="entity_type"/);
  });

  it("does not break the pinned post-commit counters", () => {
    // The flagged counter must still recognise the established statuses…
    expect(page).toMatch(/r\.status === "duplicate"/);
    expect(page).toMatch(/r\.status === "error"/);
    expect(page).toMatch(/r\.status === "skipped" && r\.error_message/);
    // …and the RowSummary field orders the v3 pins lock.
    expect(page).toMatch(/job: \["customer_name", "status", "scheduled_date"\]/);
    expect(page).toMatch(/quote: \["number", "customer_name", "total"\]/);
    expect(page).toMatch(/payment: \["invoice_number", "amount", "paid_at"\]/);
  });
});
