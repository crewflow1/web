import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Accounting PUSH-ONCE — the duplicate-invoice fix, proven at three layers.
 *
 * THE BUG. `syncToProvider` built the FULL invoice + payment history on every
 * sync and handed it to the provider adapter. Xero derived its Idempotency-Key
 * from the WHOLE batch body, so a later sync whose batch differed by one new row
 * ({A,B} → {A,B,C}) produced a DIFFERENT key and Xero re-created A and B (it
 * permits duplicate InvoiceNumbers). Activating accounting duplicated invoices.
 *
 * THE FIX, proven here:
 *   A. Xero now pushes PER-ROW with a STABLE per-entity Idempotency-Key seeded by
 *      the immutable CrewFlow row id — a re-push of the same invoice is the SAME
 *      key (a Xero no-op) regardless of what else is in the sync.
 *   B. `buildAccountingExport({ excludePushedFor })` returns ONLY rows not already
 *      in the push-once ledger, each carrying its `sourceId`. Adding an invoice
 *      and re-syncing yields ONLY the new invoice.
 *   C. `syncToProvider` records EXACTLY the accepted prefix (a failed push records
 *      nothing for its failed tail) and refuses (skipped_dark) when the adapter
 *      is dark.
 *
 * The DB-backed exclusion is ALSO proven against real Postgres in
 * __tests__/integration/rls/accounting-push-once.test.ts.
 */

// ── mocks: token crypto is identity; the adapter + Supabase clients are fakes ──
vi.mock("@/lib/integrations/token-crypto", () => ({
  decryptToken: (v: string) => v,
  encryptToken: (v: string) => v,
}));

type Row = Record<string, unknown>;

/** Configurable in-memory DB the fake clients resolve against. */
const dbState = {
  invoices: [] as Row[],
  payments: [] as Row[],
  ledger: [] as Row[], // accounting_pushed_entities rows: { entity_type, entity_id }
  secrets: null as Row | null,
  // captured writes
  exportLogInserts: [] as Row[],
  pushedUpserts: [] as Row[][],
  connUpdates: [] as Row[],
  eqLog: [] as Array<[string, string, unknown]>, // [table, col, val]
};

function resetDb() {
  dbState.invoices = [];
  dbState.payments = [];
  dbState.ledger = [];
  dbState.secrets = null;
  dbState.exportLogInserts = [];
  dbState.pushedUpserts = [];
  dbState.connUpdates = [];
  dbState.eqLog = [];
}

/** A chainable, thenable query builder over one table. */
function makeBuilder(table: string) {
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let payload: unknown = null;

  const result = (): { data: unknown; error: null } => {
    if (op === "select") {
      if (table === "invoices") return { data: dbState.invoices, error: null };
      if (table === "invoice_payments") return { data: dbState.payments, error: null };
      if (table === "accounting_pushed_entities") return { data: dbState.ledger, error: null };
      if (table === "accounting_connections") return { data: dbState.secrets, error: null };
      return { data: [], error: null };
    }
    if (op === "insert" && table === "accounting_export_log") {
      dbState.exportLogInserts.push(payload as Row);
    }
    if (op === "upsert" && table === "accounting_pushed_entities") {
      dbState.pushedUpserts.push(payload as Row[]);
    }
    if (op === "update" && table === "accounting_connections") {
      dbState.connUpdates.push(payload as Row);
    }
    return { data: null, error: null };
  };

  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    insert(row: unknown) {
      op = "insert";
      payload = row;
      return builder;
    },
    update(row: unknown) {
      op = "update";
      payload = row;
      return builder;
    },
    upsert(rows: unknown) {
      op = "upsert";
      payload = rows;
      return builder;
    },
    eq(col: string, val: unknown) {
      dbState.eqLog.push([table, col, val]);
      return builder;
    },
    neq() {
      return builder;
    },
    gte() {
      return builder;
    },
    lte() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result());
    },
    then(onF: (v: { data: unknown; error: null }) => unknown, onR?: () => unknown) {
      return Promise.resolve(result()).then(onF, onR);
    },
  };
  return builder;
}

const fakeClient = { from: (t: string) => makeBuilder(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient }));

// ── the adapter is a controllable fake (isAvailable + push results) ───────────
const adapterCfg = {
  available: true,
  invResult: null as unknown,
  payResult: null as unknown,
  invRows: [] as Row[],
  payRows: [] as Row[],
};

vi.mock("@/lib/integrations/accounting/adapters", () => ({
  getAccountingAdapter: () => ({
    provider: "xero",
    isAvailable: () => adapterCfg.available,
    pushInvoices: async (input: { rows: Row[] }) => {
      adapterCfg.invRows = input.rows;
      return adapterCfg.invResult;
    },
    pushPayments: async (input: { rows: Row[] }) => {
      adapterCfg.payRows = input.rows;
      return adapterCfg.payResult;
    },
  }),
}));

// Imported AFTER the mocks so they bind to the fakes.
import { buildAccountingExport } from "@/server/services/accounting-export";
import { syncToProvider } from "@/server/services/accounting-connections";

const ORG = "org-A";

const connectedSecrets = (): Row => ({
  status: "connected",
  access_token: "ACCESS",
  refresh_token: "REFRESH",
  token_expires_at: "2099-01-01T00:00:00Z",
  external_tenant_id: "TENANT-1",
  realm_id: null,
});

function invoiceRow(id: string, number: string, sentAt: string): Row {
  return {
    id,
    number,
    status: "sent",
    amount: 100,
    vat_total: 20,
    total: 120,
    due_date: null,
    sent_at: sentAt,
    created_at: sentAt,
    customer: { name: "Acme Ltd" },
    quote: null,
  };
}

beforeEach(() => {
  resetDb();
  adapterCfg.available = true;
  adapterCfg.invResult = null;
  adapterCfg.payResult = null;
  adapterCfg.invRows = [];
  adapterCfg.payRows = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// B. buildAccountingExport exclusion — only not-yet-pushed rows, with sourceId
// ---------------------------------------------------------------------------

describe("buildAccountingExport push-once exclusion", () => {
  it("with an EMPTY ledger returns every row, each carrying its sourceId (#456 org-pinned)", async () => {
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    dbState.ledger = [];

    const { rows } = await buildAccountingExport({ orgId: ORG, excludePushedFor: "xero" });
    const invoices = rows.filter((r) => r.type === "invoice");
    expect(invoices.map((r) => r.sourceId).sort()).toEqual(["inv-A", "inv-B"]);

    // #456: org_id is pinned on the invoice read AND on the ledger read.
    const orgPins = dbState.eqLog.filter(([, col, val]) => col === "org_id" && val === ORG);
    expect(orgPins.length).toBeGreaterThanOrEqual(2);
    // The ledger read is pinned to the provider too.
    expect(
      dbState.eqLog.some(
        ([t, col, val]) =>
          t === "accounting_pushed_entities" && col === "provider" && val === "xero",
      ),
    ).toBe(true);
  });

  it("EXCLUDES rows already in the ledger — after A,B are recorded, only C is exported", async () => {
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
      invoiceRow("inv-C", "INV-C", "2026-07-03T09:00:00Z"),
    ];
    dbState.ledger = [
      { entity_type: "invoice", entity_id: "inv-A" },
      { entity_type: "invoice", entity_id: "inv-B" },
    ];

    const { rows } = await buildAccountingExport({ orgId: ORG, excludePushedFor: "xero" });
    const invoices = rows.filter((r) => r.type === "invoice");
    expect(invoices.map((r) => r.sourceId)).toEqual(["inv-C"]);
  });

  it("the CSV path (no provider) is unchanged: full ledger, NO sourceId", async () => {
    dbState.invoices = [invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z")];
    dbState.ledger = [{ entity_type: "invoice", entity_id: "inv-A" }]; // would be excluded on the push path

    const { rows } = await buildAccountingExport({ orgId: ORG });
    const invoices = rows.filter((r) => r.type === "invoice");
    // Not excluded (CSV exports everything) and carries no push-tracking id.
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.sourceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A + C. syncToProvider composition — records accepted prefix; dark-refuses
// ---------------------------------------------------------------------------

describe("syncToProvider push-once recording", () => {
  it("(e) dark-refuse: an unavailable adapter records skipped_dark and builds NOTHING", async () => {
    adapterCfg.available = false;
    dbState.invoices = [invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z")];

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.status).toBe("skipped_dark");
    // No push-once record on the dark path.
    expect(dbState.pushedUpserts).toHaveLength(0);
    expect(dbState.exportLogInserts.some((r) => r.status === "skipped_dark")).toBe(true);
  });

  it("(a) first sync pushes A,B and records BOTH ids to the ledger", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    dbState.ledger = [];
    adapterCfg.invResult = { ok: true, provider: "xero", pushed: 2 };
    adapterCfg.payResult = { ok: true, provider: "xero", pushed: 0 };

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(2);

    const recorded = dbState.pushedUpserts.flat();
    expect(recorded.map((r) => r.entity_id).sort()).toEqual(["inv-A", "inv-B"]);
    expect(recorded.every((r) => r.provider === "xero" && r.entity_type === "invoice")).toBe(true);
  });

  it("(c) a partial failure records ONLY the accepted prefix — the failed row is retried next time", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    dbState.ledger = [];
    // Xero accepted A (pushed:1) then failed on B.
    adapterCfg.invResult = {
      ok: false,
      provider: "xero",
      reason: "error",
      message: "Xero invoices push returned 400",
      pushed: 1,
    };
    adapterCfg.payResult = { ok: true, provider: "xero", pushed: 0 };

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(false);

    const recorded = dbState.pushedUpserts.flat();
    // Only the accepted invoice A is recorded; B is NOT, so it retries next sync.
    expect(recorded.map((r) => r.entity_id)).toEqual(["inv-A"]);
  });

  it("(b) with A,B already in the ledger, a re-sync pushes ONLY C (no re-push of A,B)", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
      invoiceRow("inv-C", "INV-C", "2026-07-03T09:00:00Z"),
    ];
    dbState.ledger = [
      { entity_type: "invoice", entity_id: "inv-A" },
      { entity_type: "invoice", entity_id: "inv-B" },
    ];
    adapterCfg.invResult = { ok: true, provider: "xero", pushed: 1 };
    adapterCfg.payResult = { ok: true, provider: "xero", pushed: 0 };

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(true);
    // The adapter only ever SAW invoice C — A and B were excluded before the push.
    expect(adapterCfg.invRows.map((r) => r.sourceId)).toEqual(["inv-C"]);
    expect(dbState.pushedUpserts.flat().map((r) => r.entity_id)).toEqual(["inv-C"]);
  });
});
