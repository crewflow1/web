import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ACCOUNTING EXPORT PAGINATION (F-1, GAP 4 / GAP 5) — behavioural proof.
 *
 * THE TRAP. PostgREST clamps EVERY response to the project `max_rows`
 * (supabase/config.toml → 1000). The pre-fix service read the ledger with a
 * single `.limit(MAX_ROWS + 1)` = `.limit(50001)`, which the clamp silently
 * truncated to 1000 rows. So:
 *   GAP 4 — the CSV export / provider push dropped rows 1001+ with no notice,
 *           and the `truncated` probe (length > 50000) was DEAD (the server
 *           never returned > 1000).
 *   GAP 5 — the push-once anti-set (already-pushed ids) capped at 1000, so an
 *           entity beyond the first 1000 could be re-pushed and duplicated.
 *
 * This test models the clamp EXACTLY: any single response is capped at 1000
 * rows (a `.range(lo, hi)` returns at most 1000; a `.limit(n)` returns at most
 * 1000). Only `fetchAllRows`' sub-1000 paging escapes it. We then seed WELL past
 * 1000 rows and assert the export, the push-once exclusion, and the `truncated`
 * flag all reflect the FULL ledger — the pre-fix single-shot read would fail
 * every one of these.
 */

const CLAMP = 1000; // supabase/config.toml max_rows

type Row = Record<string, unknown>;

const dbState = {
  invoices: [] as Row[],
  payments: [] as Row[],
  ledger: [] as Row[], // accounting_pushed_entities
};

function resetDb() {
  dbState.invoices = [];
  dbState.payments = [];
  dbState.ledger = [];
}

/** A chainable builder that MODELS the PostgREST max_rows clamp on every read. */
function makeBuilder(table: string) {
  const filters: Array<[string, unknown, boolean]> = []; // [col, val, isNeq]
  const orderSpecs: Array<[string, boolean]> = []; // [col, ascending]

  const source = (): Row[] => {
    if (table === "invoices") return dbState.invoices;
    if (table === "invoice_payments") return dbState.payments;
    if (table === "accounting_pushed_entities") return dbState.ledger;
    return [];
  };

  const filtered = (): Row[] => {
    let rows = source().filter((r) =>
      filters.every(([col, val, isNeq]) =>
        isNeq ? r[col] !== val : r[col] === val,
      ),
    );
    if (orderSpecs.length) {
      rows = [...rows].sort((a, b) => {
        for (const [col, asc] of orderSpecs) {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
        }
        return 0;
      });
    }
    return rows;
  };

  /** The clamp: no response ever exceeds CLAMP rows. */
  const clamp = (rows: Row[]): Row[] => rows.slice(0, CLAMP);

  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push([col, val, false]);
      return builder;
    },
    neq(col: string, val: unknown) {
      filters.push([col, val, true]);
      return builder;
    },
    gte() {
      return builder;
    },
    lte() {
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderSpecs.push([col, opts?.ascending !== false]);
      return builder;
    },
    range(lo: number, hi: number) {
      const requested = hi - lo + 1;
      const effective = Math.min(requested, CLAMP); // clamp the page window
      const rows = filtered().slice(lo, lo + effective);
      return Promise.resolve({ data: rows, error: null });
    },
    limit(n: number) {
      // Present so a hypothetical single-shot read is modelled too: clamped.
      const rows = clamp(filtered()).slice(0, Math.min(n, CLAMP));
      return Promise.resolve({ data: rows, error: null });
    },
    then(onF: (v: { data: Row[]; error: null }) => unknown, onR?: () => unknown) {
      // A bare (unpaged) read is clamped, exactly like PostgREST.
      return Promise.resolve({ data: clamp(filtered()), error: null }).then(onF, onR);
    },
  };
  return builder;
}

const fakeClient = { from: (t: string) => makeBuilder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));

// Imported AFTER the mock so it binds to the fake.
import { buildAccountingExport, MAX_ROWS } from "@/server/services/accounting-export";

const ORG = "org-A";
const TODAY = "2026-08-01";

function invoiceRow(i: number): Row {
  const n = String(i).padStart(6, "0");
  return {
    id: `inv-${n}`,
    org_id: ORG,
    number: `INV-${n}`,
    status: "sent",
    amount: 100,
    vat_total: 20,
    total: 120,
    due_date: null,
    // Distinct, monotonically increasing tax point so the id tiebreak matters.
    sent_at: `2026-01-01T00:00:00Z`,
    created_at: `2026-01-01T00:00:00Z`,
    customer: { name: "Acme Ltd" },
    quote: null,
  };
}

function paymentRow(i: number): Row {
  const n = String(i).padStart(6, "0");
  return {
    id: `pay-${n}`,
    org_id: ORG,
    amount: 50,
    paid_at: `2026-02-01`,
    invoice: { number: `INV-${n}`, customer: { name: "Acme Ltd" }, quote: null },
  };
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("GAP 4 — the export pages the FULL ledger past the 1000-row clamp", () => {
  it("exports ALL 1500 invoices + 1500 payments (a single clamped read would give 1000)", async () => {
    dbState.invoices = Array.from({ length: 1500 }, (_, i) => invoiceRow(i));
    dbState.payments = Array.from({ length: 1500 }, (_, i) => paymentRow(i));

    const { rows, invoiceCount, paymentCount, truncated } = await buildAccountingExport({
      orgId: ORG,
      todayIso: TODAY,
    });

    expect(invoiceCount).toBe(1500);
    expect(paymentCount).toBe(1500);
    expect(rows.filter((r) => r.type === "invoice")).toHaveLength(1500);
    expect(rows.filter((r) => r.type === "payment")).toHaveLength(1500);
    // The tail (row 1001+) is present — the exact rows the clamp used to drop.
    expect(rows.some((r) => r.invoice_number === "INV-001499")).toBe(true);
    // 3000 rows is far below MAX_ROWS, so this is NOT a truncated export.
    expect(truncated).toBe(false);
  });

  it("`truncated` reflects reality: it flips true ONLY past the MAX_ROWS ceiling", async () => {
    // Seed one PAST the honest ceiling. The pre-fix probe never saw > 1000 rows,
    // so `truncated` could never be true; now it is derived from the true count.
    dbState.invoices = Array.from({ length: MAX_ROWS + 1 }, (_, i) => invoiceRow(i));

    const { rows, invoiceCount, truncated } = await buildAccountingExport({
      orgId: ORG,
      todayIso: TODAY,
    });

    expect(truncated).toBe(true);
    // The ceiling is applied AFTER full paging: exactly MAX_ROWS rows survive.
    expect(invoiceCount).toBe(MAX_ROWS);
    expect(rows.filter((r) => r.type === "invoice")).toHaveLength(MAX_ROWS);
  });
});

describe("GAP 5 — the push-once anti-set is read in FULL, past the clamp", () => {
  it("excludes ALL 1200 already-pushed ids (a clamped anti-set would re-push 1001-1199)", async () => {
    // 1500 invoices; the first 1200 are already in the push-once ledger.
    dbState.invoices = Array.from({ length: 1500 }, (_, i) => invoiceRow(i));
    dbState.ledger = Array.from({ length: 1200 }, (_, i) => ({
      org_id: ORG,
      entity_type: "invoice",
      entity_id: `inv-${String(i).padStart(6, "0")}`,
      provider: "xero",
    }));

    const { rows } = await buildAccountingExport({
      orgId: ORG,
      todayIso: TODAY,
      excludePushedFor: "xero",
    });
    const exported = rows.filter((r) => r.type === "invoice").map((r) => r.sourceId);

    // Exactly the not-yet-pushed tail: inv-001200 .. inv-001499 = 300 rows.
    expect(exported).toHaveLength(300);
    expect(exported).toContain("inv-001200");
    expect(exported).toContain("inv-001499");
    // The crux: rows 1001-1199 were EXCLUDED. If the anti-set had clamped to
    // 1000, inv-001000..inv-001199 would wrongly reappear (a duplicate push).
    expect(exported).not.toContain("inv-001000");
    expect(exported).not.toContain("inv-001199");
  });
});
