import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { remapRawWithColumnMap } from "@/lib/imports/detect";

/**
 * Migration OS — in-app per-column remap (gap G11).
 *
 * The detector binds each canonical field to a source header automatically.
 * When it binds the WRONG column (and confidence stays above the review bar)
 * the only fix today is edit-the-file-and-re-upload. G11 adds an operator-
 * chosen column-map OVERRIDE that re-materialises the staged `mapped` jsonb
 * through the SAME normalisation path, with no schema change and no new
 * customer-facing surface.
 *
 * This suite pins:
 *   (1) the pure engine (remapRawWithColumnMap) — the override wins over
 *       auto-detect, untouched columns are preserved, and a bad/unknown field
 *       or header is ignored rather than trusted; and
 *   (2) the server-action contract (overrideColumnMapping) — it mirrors
 *       overrideSheetEntity's admin gate + active-org pins on every read and
 *       write, is pre-commit-only, re-derives confidence (does NOT force 100),
 *       and is NOT wired into the customer-visible wizard (exposure unchanged).
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("remapRawWithColumnMap — operator column override on top of auto-detect", () => {
  // Auto-detect binds `total` to the exact-match "Total" column (999). The real
  // gross lives in "Acct Gross" (500), which the detector leaves unbound.
  const raw = {
    "Invoice No": "INV-1",
    "Acct Gross": "500",
    Total: "999",
  };

  it("without an override, reproduces the automatic binding", () => {
    const auto = remapRawWithColumnMap(raw, "invoice", {});
    expect(auto.entity_type).toBe("invoice");
    expect(auto.mapped.number).toBe("INV-1");
    expect(auto.mapped.total).toBe(999);
  });

  it("an override WINS over the automatic binding", () => {
    const remapped = remapRawWithColumnMap(raw, "invoice", {
      total: "Acct Gross",
    });
    expect(remapped.mapped.total).toBe(500);
  });

  it("columns not named in the override are preserved (auto binding kept)", () => {
    const remapped = remapRawWithColumnMap(raw, "invoice", {
      total: "Acct Gross",
    });
    // `number` was never overridden — its automatic binding survives.
    expect(remapped.mapped.number).toBe("INV-1");
  });

  it("an unknown canonical field in the override is ignored (not trusted blind)", () => {
    const remapped = remapRawWithColumnMap(raw, "invoice", {
      // `not_a_field` is not a real invoice field — must be dropped, leaving the
      // automatic `total` binding untouched.
      not_a_field: "Acct Gross",
    } as Record<string, string>);
    expect(remapped.mapped.total).toBe(999);
    expect(remapped.mapped).not.toHaveProperty("not_a_field");
  });

  it("an override to a source header that is not a real column is ignored", () => {
    const remapped = remapRawWithColumnMap(raw, "invoice", {
      total: "Nonexistent Column",
    });
    // The bogus header can't be honoured, so the automatic binding stands.
    expect(remapped.mapped.total).toBe(999);
  });

  it("re-mapping a column whose VALUE won't normalise surfaces a warning, not a silent empty", () => {
    const withText = {
      "Invoice No": "INV-9",
      Notes: "not a number",
      Total: "750",
    };
    const remapped = remapRawWithColumnMap(withText, "invoice", {
      total: "Notes",
    });
    expect(remapped.mapped.total).toBeUndefined();
    expect(remapped.warnings.some((w) => /bad number in total/.test(w))).toBe(true);
  });

  it("confidence is re-derived (a bounded 0–100 score), never forced to 100", () => {
    const remapped = remapRawWithColumnMap(raw, "invoice", {
      total: "Acct Gross",
    });
    expect(typeof remapped.confidence).toBe("number");
    expect(remapped.confidence).toBeGreaterThanOrEqual(0);
    expect(remapped.confidence).toBeLessThanOrEqual(100);
  });
});

describe("overrideColumnMapping — server action contract (mirrors overrideSheetEntity)", () => {
  const actions = read("app/(app)/imports/actions.ts");
  const start = actions.indexOf("export async function overrideColumnMapping(");
  const after = actions.indexOf("export async function ", start + 1);
  const block = actions.slice(start, after === -1 ? undefined : after);

  it("is exported as a server action", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(actions).toMatch(/export async function overrideColumnMapping\(/);
  });

  it("re-derives mapped fields via remapRawWithColumnMap (no bespoke mapping logic)", () => {
    expect(block).toMatch(/remapRawWithColumnMap\(/);
  });

  it("is admin-gated like every other import action", () => {
    expect(block).toMatch(/isAdmin\(ctx\.membership\.role\)/);
  });

  it("ACTIVE-org pins the imports guard read", () => {
    expect(block).toMatch(
      /from\("imports"\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("ACTIVE-org pins the import_rows read AND the write (never another org's rows)", () => {
    // Both the read of the rows and the update are pinned to the active org.
    const orgPins = block.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    // imports guard + rows read + per-row update = at least three pins.
    expect(orgPins.length).toBeGreaterThanOrEqual(3);
    expect(block).toMatch(
      /from\("import_rows"\)[\s\S]*?\.update\([\s\S]*?\.eq\("id", r\.id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("parses overrides against the server-side field allow-list (entityFieldNames)", () => {
    expect(block).toMatch(/entityFieldNames\(entity\)/);
  });

  it("is pre-commit only (guards `status !== \"detected\"`)", () => {
    expect(block).toMatch(/status !== "detected"/);
  });

  it("re-derives per-row confidence and does NOT force confidence 100", () => {
    expect(block).toMatch(/confidence: remapped\.confidence/);
    expect(block).not.toMatch(/confidence:\s*100/);
  });

  it("keeps sub-threshold rows in needs_review (uncertain is not silently imported)", () => {
    expect(block).toMatch(
      /confidence < REVIEW_THRESHOLD \? "needs_review" : "pending"/,
    );
  });
});

describe("exposure — the remap control is NOT surfaced in the customer-visible wizard", () => {
  it("the detection screen does not reference overrideColumnMapping (engine+action held for the exposure decision)", () => {
    const page = read("app/(app)/imports/[id]/page.tsx");
    expect(page).not.toMatch(/overrideColumnMapping/);
  });
});
