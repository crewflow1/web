import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AGED LEDGERS — active-org scoping, the payables role gate, and read-only.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * RLS is not scoping. `current_org_ids()` returns EVERY org the viewer belongs
 * to, so an unpinned read on a dual-org account returns both companies' rows and
 * the aged listing merges them: a customer (or supplier) trading with BOTH of
 * the operator's companies becomes ONE row with the two companies' debts added
 * together, and the operator chases — or pays — a figure that belongs to no set
 * of books.
 *
 * ── HOW SCOPING IS ENFORCED NOW (R7) ─────────────────────────────────────────
 * The listings are sourced from two org-guarded SECURITY DEFINER RPCs
 * (report_aged_receivables / report_aged_payables, migration 20261238000000).
 * Each takes the ACTIVE org id, FIRST raises 42501 for a non-member, and filters
 * strictly by that org — so only the active org's data is ever returned. The
 * dual-org / tenant-isolation PROOF therefore lives against REAL Postgres in
 * __tests__/integration/reports/aged-ledgers-rpc.test.ts (and the systemic guard
 * in __tests__/integration/rls/secdef-org-rpc-guard.test.ts). THIS tier proves
 * the service layer: it passes the active org + as-at to the RPCs, composes their
 * rows faithfully, keeps the payables ADMIN gate, fails loud, and never writes.
 */

const h = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  /** fn → org_id → rows the RPC returns (as supabase-js would, numeric as string). */
  const data: Record<string, Record<string, Array<Record<string, unknown>>>> = {};
  const failing = new Set<string>();
  let throwOnRpc = false;

  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      if (throwOnRpc) throw new Error("connection reset");
      calls.push({ fn, args });
      if (failing.has(fn)) {
        return Promise.resolve({ data: null, error: { message: `${fn} exploded` } });
      }
      const org = String(args.p_org_id);
      return Promise.resolve({ data: data[fn]?.[org] ?? [], error: null });
    },
  };

  return {
    calls,
    data,
    failing,
    client,
    setThrow(v: boolean) {
      throwOnRpc = v;
    },
    reset() {
      calls.length = 0;
      for (const k of Object.keys(data)) delete data[k];
      failing.clear();
      throwOnRpc = false;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

const { buildAgedLedgers, canReadPayables } = await import("@/server/services/aged-ledgers");

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";
const NOW = new Date("2026-07-30T09:00:00Z");

/**
 * Two companies whose books deliberately OVERLAP: the SAME customer id and the
 * SAME supplier id trade with both. Because the RPC scopes server-side, each org
 * gets back ONLY its own rows — the service must pass the right org id and never
 * blend the two seeded sets.
 */
function seedTwoOrgs() {
  h.data.report_aged_receivables = {
    [ORG_A]: [
      {
        invoice_id: "inv-a1",
        reference: "A-1",
        status: "sent",
        due_date: "2026-01-11",
        party_id: "cust-shared",
        party_name: "Shared Developments (A)",
        remaining: "750.00",
        age_days: 200,
        bucket: "d91_plus",
      },
    ],
    [ORG_B]: [
      {
        invoice_id: "inv-b1",
        reference: "B-1",
        status: "sent",
        due_date: "2026-01-11",
        party_id: "cust-shared",
        party_name: "Shared Developments (B)",
        remaining: "5000.00",
        age_days: 200,
        bucket: "d91_plus",
      },
    ],
  };
  h.data.report_aged_payables = {
    [ORG_A]: [
      {
        bill_id: "bill-a1",
        reference: "A-BILL",
        party_id: "sup-shared",
        party_name: "Shared Merchants (A)",
        outstanding: "500.00",
        age_days: 29,
        bucket: "d1_30",
        date_iso: "2026-07-01",
      },
    ],
    [ORG_B]: [
      {
        bill_id: "bill-b1",
        reference: "B-BILL",
        party_id: "sup-shared",
        party_name: "Shared Merchants (B)",
        outstanding: "5000.00",
        age_days: 29,
        bucket: "d1_30",
        date_iso: "2026-07-01",
      },
    ],
  };
}

beforeEach(() => {
  h.reset();
  seedTwoOrgs();
});

// ---------------------------------------------------------------------------
// 1. the active org is the ONE the RPC is asked for
// ---------------------------------------------------------------------------

describe("active-org scoping: the service asks the RPC for exactly one org", () => {
  it("aged debtors show ONLY the active org's rows, composed faithfully", async () => {
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(false);
    expect(view.debtors.totals.total).toBe(750);
    expect(view.debtors.rows).toHaveLength(1);
    expect(view.debtors.rows[0]!.partyName).toBe("Shared Developments (A)");
    expect(view.debtors.rows[0]!.items.map((i) => i.id)).toEqual(["inv-a1"]);
    // 200 days late → past-due bucket, so pastDue carries the whole balance.
    expect(view.debtors.totals.pastDue).toBe(750);
  });

  it("the other org sees its own figure, from the same seeded data", async () => {
    const view = await buildAgedLedgers(ORG_B, "owner", NOW);
    expect(view.debtors.totals.total).toBe(5000);
    expect(view.debtors.rows[0]!.partyName).toBe("Shared Developments (B)");
  });

  it("aged creditors show ONLY the active org's bills", async () => {
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.creditors.totals.total).toBe(500);
    expect(view.creditors.rows).toHaveLength(1);
    expect(view.creditors.rows[0]!.partyName).toBe("Shared Merchants (A)");
  });

  it("passes the ACTIVE org id and the as-at business day to every RPC", async () => {
    await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(h.calls.length).toBe(2);
    for (const c of h.calls) {
      expect(c.args.p_org_id, `${c.fn} not pinned to the active org`).toBe(ORG_A);
      expect(c.args.p_as_at, `${c.fn} not given the as-at day`).toBe("2026-07-30");
    }
  });

  it("calls exactly the two ageing RPCs, and no others", async () => {
    await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(h.calls.map((c) => c.fn).sort()).toEqual([
      "report_aged_payables",
      "report_aged_receivables",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. party naming / href fallbacks mirror the pure bridges
// ---------------------------------------------------------------------------

describe("party naming + href fallbacks match composeDebtorItems / composeCreditorItems", () => {
  it("a resolved customer with no name reads 'Unnamed customer'", async () => {
    h.data.report_aged_receivables = {
      [ORG_A]: [
        { invoice_id: "x", reference: "X", status: "sent", due_date: null, party_id: "c1", party_name: null, remaining: "10.00", age_days: null, bucket: "current" },
      ],
    };
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.debtors.rows[0]!.partyName).toBe("Unnamed customer");
    // No ageing date → current bucket AND disclosed as undated.
    expect(view.debtors.totals.undated).toBe(10);
  });

  it("a wholly-unresolved invoice is 'Unattributed'", async () => {
    h.data.report_aged_receivables = {
      [ORG_A]: [
        { invoice_id: "x", reference: "X", status: "sent", due_date: "2026-01-01", party_id: null, party_name: null, remaining: "10.00", age_days: 100, bucket: "d91_plus" },
      ],
    };
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.debtors.rows[0]!.partyName).toBe("Unattributed");
    expect(view.debtors.rows[0]!.items[0]!.href).toBe("/invoices/x");
  });

  it("a supplier-less bill is 'Unattributed' and links to /expenses", async () => {
    h.data.report_aged_payables = {
      [ORG_A]: [
        { bill_id: "b", reference: null, party_id: null, party_name: null, outstanding: "12.00", age_days: 5, bucket: "d1_30", date_iso: "2026-07-20" },
      ],
    };
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.creditors.rows[0]!.partyName).toBe("Unattributed");
    expect(view.creditors.rows[0]!.items[0]!.href).toBe("/expenses");
  });
});

// ---------------------------------------------------------------------------
// 3. the payables role gate
// ---------------------------------------------------------------------------

describe("the payables gate — a wrong number is worse than a withheld one", () => {
  it("owners and admins can read payables; nobody else can", () => {
    expect(canReadPayables("owner")).toBe(true);
    expect(canReadPayables("admin")).toBe(true);
    expect(canReadPayables("member")).toBe(false);
    expect(canReadPayables("staff")).toBe(false);
    expect(canReadPayables("")).toBe(false);
  });

  it("a non-admin gets creditorsVisible: false and an EMPTY ledger", async () => {
    const view = await buildAgedLedgers(ORG_A, "member", NOW);
    expect(view.creditorsVisible).toBe(false);
    expect(view.creditors.totals.total).toBe(0);
    expect(view.creditors.rows).toHaveLength(0);
  });

  it("a non-admin does not even ISSUE the money-out RPC", async () => {
    await buildAgedLedgers(ORG_A, "member", NOW);
    expect(h.calls.map((c) => c.fn)).not.toContain("report_aged_payables");
    // The debtor book is still served.
    expect(h.calls.map((c) => c.fn)).toContain("report_aged_receivables");
  });

  it("a non-admin still gets the full aged DEBTORS ledger", async () => {
    const view = await buildAgedLedgers(ORG_A, "member", NOW);
    expect(view.debtors.totals.total).toBe(750);
  });
});

// ---------------------------------------------------------------------------
// 4. loud reads
// ---------------------------------------------------------------------------

describe("loud reads — a failed query must never render as a settled ledger", () => {
  it("a failed receivables RPC sets loadError", async () => {
    h.failing.add("report_aged_receivables");
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(true);
    expect(view.debtors.totals.total).toBe(0);
  });

  it("a failed payables RPC sets loadError even though receivables succeeded", async () => {
    h.failing.add("report_aged_payables");
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(true);
    expect(view.debtors.totals.total).toBe(750);
  });

  it("a thrown client returns loadError, never a reassuring empty ledger", async () => {
    h.setThrow(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = await buildAgedLedgers(ORG_A, "owner", NOW);
      expect(view.loadError).toBe(true);
      expect(view.debtors.totals.total).toBe(0);
      // An as-at date is still returned so the page can render its banner.
      expect(view.asAtIso).toBe("2026-07-30");
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. source pins
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SERVICE = src("server/services/aged-ledgers.ts");
const PAGE = src("app/(app)/reports/ageing/page.tsx");
const MIGRATION = src("supabase/migrations/20261238000000_reports_aged_ledgers_rpc.sql");

describe("source pins — the report is READ-ONLY", () => {
  it("the service never mutates anything", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert("]) {
      expect(SERVICE, `aged-ledgers must not ${op}`).not.toContain(op);
    }
  });

  it("the service's ONLY rpc calls are the two read-only ageing functions", () => {
    const rpcNames = [...SERVICE.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rpcNames.sort()).toEqual(["report_aged_payables", "report_aged_receivables"]);
  });

  it("the page never mutates anything and declares no server action", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(PAGE, `the ageing page must not ${op}`).not.toContain(op);
    }
    expect(PAGE).not.toMatch(/"use server"/);
  });

  it("never names a CIS or cash money-out column — an aged listing carries none", () => {
    // The payables RPC reads supplier_payments only for `voided_at`; it never
    // selects gross_amount / cis_withheld / net_paid. Neither the service nor
    // the migration may name those columns.
    for (const col of ["gross_amount", "cis_withheld", "net_paid", "cis_deduction"]) {
      expect(SERVICE, `service must not name ${col}`).not.toContain(col);
      expect(MIGRATION, `migration must not name ${col}`).not.toContain(col);
    }
  });
});

describe("source pins — the migration carries the mandated guards", () => {
  it("both RPCs are org-membership guarded (current_org_ids + 42501)", () => {
    expect(MIGRATION).toContain("current_org_ids()");
    expect(MIGRATION).toContain("42501");
    // One guard clause per function.
    expect((MIGRATION.match(/current_org_ids\(\)\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the payables RPC additionally enforces the admin gate", () => {
    expect(MIGRATION).toContain("is_org_admin(p_org_id)");
  });

  it("both RPCs are SECURITY DEFINER with a pinned search_path and explicit grants", () => {
    expect((MIGRATION.match(/security definer/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((MIGRATION.match(/set search_path = public/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(MIGRATION).toContain(
      "grant execute on function public.report_aged_receivables(uuid, date) to authenticated;",
    );
    expect(MIGRATION).toContain(
      "grant execute on function public.report_aged_payables(uuid, date) to authenticated;",
    );
  });

  it("neither RPC writes a row", () => {
    expect(MIGRATION).not.toMatch(/\b(insert into|update\s+public\.|delete from)\b/i);
  });
});

describe("source pins — the page passes the active org and role", () => {
  it("the page passes the ACTIVE org and role, never a raw membership list", () => {
    expect(PAGE).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(PAGE).toMatch(/buildAgedLedgers\(\s*\n?\s*ctx\.org\.id,\s*\n?\s*ctx\.membership\.role,?\s*\n?\s*\)/);
  });

  it("staff are redirected off the whole debtor and creditor book", () => {
    expect(PAGE).toMatch(/ctx\.membership\.role === "staff"\) redirect\("\/me"\)/);
  });
});
