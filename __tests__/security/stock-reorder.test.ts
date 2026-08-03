import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261107000000_stock_reorder.sql";
const LIB_REORDER = "lib/stock/reorder.ts";
const SVC_REORDER = "server/services/stock-reorder.ts";
const ACTION = "app/(app)/stock/reorder-actions.ts";
const PAGE = "app/(app)/stock/replenishment/page.tsx";
const FORM = "app/(app)/stock/replenishment/_replenishment-form.tsx";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. THE ACCOUNTING BOUNDARY — replenishment must never move money
// ---------------------------------------------------------------------------

describe("stock replenishment never touches `finances`", () => {
  const surfaces: Array<[string, string]> = [
    [MIG, sqlOnly(read(MIG))],
    [LIB_REORDER, codeOf(read(LIB_REORDER))],
    [SVC_REORDER, codeOf(read(SVC_REORDER))],
    [ACTION, codeOf(read(ACTION))],
    [PAGE, codeOf(read(PAGE))],
    [FORM, codeOf(read(FORM))],
  ];

  for (const [name, src] of surfaces) {
    it(`${name} contains no executable reference to finances`, () => {
      expect(src).not.toMatch(/\bfinances\b/);
    });
  }

  it("the migration adds NO money column and no money value at all", () => {
    const sql = sqlOnly(read(MIG));
    for (const money of ["unit_cost", "unit_price", "cost", "value", "vat_rate", "currency", "price", "amount"]) {
      expect(sql, `${money} appears in the reorder migration`).not.toMatch(
        new RegExp(`\\b${money}\\s+(numeric|integer|text|money|decimal)`, "i"),
      );
    }
    // The one column it does add is a QUANTITY, strictly positive.
    expect(sql).toMatch(/add column if not exists reorder_quantity numeric\(12, 2\)/i);
    expect(sql).toMatch(/reorder_quantity is null or reorder_quantity > 0/i);
  });

  it("the boundary is DOCUMENTED where a contributor will read it", () => {
    for (const [name, raw] of [
      [MIG, read(MIG)],
      [LIB_REORDER, read(LIB_REORDER)],
      [SVC_REORDER, read(SVC_REORDER)],
      [ACTION, read(ACTION)],
    ] as const) {
      expect(raw, `${name} must state the accounting boundary`).toMatch(/ACCOUNTING BOUNDARY/);
      expect(raw, `${name} must name D1 as undecided`).toMatch(/D1/);
    }
    // The double-count risk is named where the temptation is greatest.
    for (const raw of [read(MIG), read(ACTION)]) {
      expect(raw).toMatch(/double-count|double count/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The reader is DETERMINISTIC, PURE and never fabricates
// ---------------------------------------------------------------------------

describe("the reorder reader is pure and honest", () => {
  const lib = read(LIB_REORDER);
  const code = codeOf(lib);

  it("is a PURE module — no server-only, no I/O, no client", () => {
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/from ["']@\/lib\/supabase/);
    expect(code).not.toMatch(/createClient/);
  });

  it("uses no AI — the mandate's hard no", () => {
    for (const raw of [read(LIB_REORDER), read(SVC_REORDER), read(ACTION)]) {
      expect(raw).not.toMatch(/@\/lib\/ai\//);
    }
  });

  it("REUSES reorder_level as the point — it does not invent a second threshold column", () => {
    // The design decision, pinned: no `reorder_point` column exists; reorder_level
    // is the reorder point. A second threshold column would be a second truth.
    expect(sqlOnly(read(MIG))).not.toMatch(/add column[^;]*reorder_point/i);
    expect(lib).toMatch(/reorder_level/); // documented as the source of reorderPoint
  });
});

// ---------------------------------------------------------------------------
// 3. ORG-PINNED reads — by delegation to the pinned, loud stock service
// ---------------------------------------------------------------------------

describe("replenishment reads are active-org pinned and loud", () => {
  const svc = codeOf(read(SVC_REORDER));

  it("does NO raw table reads of its own — it delegates to loadStockPositions", () => {
    // loadStockPositions is where the `.eq("org_id", orgId)` pin (#456/#468) and
    // the readFailure loud-read (#480) already live. Reusing it inherits both;
    // a bare `.from(...).select(...)` here would be an unpinned, silent read.
    expect(svc).not.toMatch(/\.from\(/);
    expect(svc).not.toMatch(/\.select\(/);
    expect(svc).toMatch(/loadStockPositions/);
  });

  it("both service entry points take an orgId and pass it down", () => {
    expect(svc).toMatch(/loadReplenishmentSuggestions\([\s\S]*?orgId: string/);
    expect(svc).toMatch(/replenishmentSuggestionsForItems\([\s\S]*?orgId: string/);
    expect(svc).toMatch(/loadStockPositions\(db, orgId\)/);
  });

  it("the page pins ctx.org.id on the read", () => {
    expect(codeOf(read(PAGE))).toMatch(/loadReplenishmentSuggestions\(\s*[\s\S]*?ctx\.org\.id/);
  });
});

// ---------------------------------------------------------------------------
// 4. The handoff REUSES the material-request authority — not a bare insert
// ---------------------------------------------------------------------------

describe("the handoff routes through the existing material-request authority", () => {
  const action = codeOf(read(ACTION));

  it("creates the request via the shared write core, not a hand-rolled insert", () => {
    expect(action).toMatch(/createMaterialRequestDraftRecord/);
    // NO bare insert into any ordering table on this path — the whole point is
    // to reuse the core's number allocator, born-draft rule and org guards.
    expect(action).not.toMatch(/\.from\(\s*["']material_requests["']/);
    expect(action).not.toMatch(/\.from\(\s*["']material_request_lines["']/);
    expect(action).not.toMatch(/\.from\(\s*["']purchase_orders["']/);
    expect(action).not.toMatch(/\.insert\(/);
  });

  it("re-derives quantities server-side — the client posts ids, never numbers to buy", () => {
    expect(action).toMatch(/replenishmentSuggestionsForItems/);
    // the payload qty comes from the server suggestion, not from formData
    expect(action).toMatch(/qty:\s*s\.suggestedQuantity/);
  });

  it("is ROLE-GATED to owner/admin, and pins the active org", () => {
    expect(action).toMatch(/role === "owner" \|\| ctx\.membership\.role === "admin"/);
    expect(action).toMatch(/Only an owner or admin can raise a replenishment request/);
    expect(action).toMatch(/ctx\.org\.id/);
  });

  it("performs NO cache revalidation — it stalls the action's state commit", () => {
    // The Next 15.5 deep-swap commit race, the same ban the stock and materials
    // lanes carry. Success hard-navigates instead.
    expect(action).not.toMatch(/revalidatePath\(/);
    expect(action).not.toMatch(/revalidateTag\(/);
    expect(action).toMatch(/redirectTo:/);
  });

  it("never reaches for the service-role admin client", () => {
    for (const raw of [read(ACTION), read(SVC_REORDER)]) {
      expect(codeOf(raw)).not.toMatch(/createAdminClient/);
      expect(codeOf(raw)).not.toMatch(/SERVICE_ROLE/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The UI hard-navigates (the deep-swap race), like every stock write
// ---------------------------------------------------------------------------

describe("the replenishment form navigates safely", () => {
  it("uses a full document navigation, never router.push, on success", () => {
    const form = codeOf(read(FORM));
    expect(form).toMatch(/window\.location\.assign\(state\.redirectTo\)/);
    expect(form).not.toMatch(/router\.push\(/);
  });
});
