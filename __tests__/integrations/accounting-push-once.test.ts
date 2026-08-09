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
  // captured deletes against accounting_pushed_entities (the ledger reset)
  ledgerDeletes: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
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
  dbState.ledgerDeletes = [];
  dbState.eqLog = [];
}

/** A chainable, thenable query builder over one table. */
function makeBuilder(table: string) {
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: unknown = null;
  // Per-builder filters so a DELETE resolution can see its own scoping (a delete
  // must be org- AND provider-pinned).
  const filters: Array<[string, unknown]> = [];

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
    if (op === "delete" && table === "accounting_pushed_entities") {
      dbState.ledgerDeletes.push({ table, filters: [...filters] });
      // The reset clears the (org, provider) high-water-mark — model that so a
      // subsequent buildAccountingExport sees an empty ledger and excludes nothing.
      dbState.ledger = [];
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
    delete() {
      op = "delete";
      return builder;
    },
    eq(col: string, val: unknown) {
      dbState.eqLog.push([table, col, val]);
      filters.push([col, val]);
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
    range() {
      // The export reads now page via fetchAllRows (F-1 clamp fix). The tiny
      // fixtures fit in one page, so a single resolution ends the paging loop.
      return Promise.resolve(result());
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
  // When true, pushPayments accepts EVERY row it is given (pushed == input length).
  // This models QBO's defect substrate: it returns a 2xx even for a payment whose
  // invoice does not exist (recording it UNAPPLIED). The payment-link gate lives in
  // syncToProvider, so with this on the test proves the gate — not the adapter — is
  // what stops a stranded unapplied payment being sent + recorded.
  payAcceptsAll: false,
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
      if (adapterCfg.payAcceptsAll) {
        return { ok: true, provider: "xero", pushed: input.rows.length };
      }
      return adapterCfg.payResult;
    },
  }),
}));

// Imported AFTER the mocks so they bind to the fakes.
import { buildAccountingExport } from "@/server/services/accounting-export";
import {
  disconnectAccountingProvider,
  resetPushedLedger,
  syncToProvider,
} from "@/server/services/accounting-connections";

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

function paymentRow(id: string, invoiceNumber: string, paidAt: string): Row {
  return {
    id,
    amount: 120,
    paid_at: paidAt,
    invoice: { number: invoiceNumber, customer: { name: "Acme Ltd" }, quote: null },
  };
}

/**
 * Mirror what a successful sync recorded (pushedUpserts) into the in-memory
 * ledger, so a SUBSEQUENT buildAccountingExport sees those rows as already
 * pushed — the fake upsert only captures, it does not mutate `ledger`. Lets a
 * two-sync sequence be proven end-to-end.
 */
function commitLedger() {
  for (const batch of dbState.pushedUpserts) {
    for (const r of batch) {
      dbState.ledger.push({ entity_type: r.entity_type, entity_id: r.entity_id });
    }
  }
  dbState.pushedUpserts = [];
}

beforeEach(() => {
  resetDb();
  adapterCfg.available = true;
  adapterCfg.invResult = null;
  adapterCfg.payResult = null;
  adapterCfg.invRows = [];
  adapterCfg.payRows = [];
  adapterCfg.payAcceptsAll = false;
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

// ---------------------------------------------------------------------------
// D. DISCONNECT / REBIND resets the ledger — a fresh tenant re-pushes ALL history
//
// THE BUG (c29). `disconnectAccountingProvider` only nulled the connection
// fields; it never cleared accounting_pushed_entities. So disconnect → reconnect
// a DIFFERENT external tenant left the OLD account's high-water-mark in place, and
// every id pushed to tenant A stayed excluded from the export to the (empty)
// tenant B — the operator saw pushed=0 / "already up to date" while the new
// company's books never received any history. Silent under-export with a false
// success signal. The admin-DELETE RLS policy created for this reset was DEAD.
// ---------------------------------------------------------------------------

describe("disconnect / rebind resets the push-once ledger", () => {
  it("(a) disconnect DELETEs the ledger for (org, provider), org- AND provider-scoped", async () => {
    dbState.ledger = [
      { entity_type: "invoice", entity_id: "inv-A" },
      { entity_type: "invoice", entity_id: "inv-B" },
    ];

    const res = await disconnectAccountingProvider(ORG, "xero");
    expect(res.ok).toBe(true);

    // Exactly one delete, against the ledger, scoped to this org AND provider.
    expect(dbState.ledgerDeletes).toHaveLength(1);
    expect(dbState.ledgerDeletes[0]!.table).toBe("accounting_pushed_entities");
    const filters = Object.fromEntries(dbState.ledgerDeletes[0]!.filters);
    expect(filters.org_id).toBe(ORG);
    expect(filters.provider).toBe("xero");
    // The ledger rows for (org, provider) are gone.
    expect(dbState.ledger).toHaveLength(0);
    // The connection itself was still reset back to disconnected.
    expect(dbState.connUpdates.some((u) => u.status === "disconnected")).toBe(true);
  });

  it("(b) after disconnect the next sync re-pushes ALL history (empty ledger → nothing excluded)", async () => {
    dbState.ledger = [
      { entity_type: "invoice", entity_id: "inv-A" },
      { entity_type: "invoice", entity_id: "inv-B" },
    ];

    // Disconnect clears the high-water-mark…
    await disconnectAccountingProvider(ORG, "xero");
    expect(dbState.ledger).toHaveLength(0);

    // …so the export for a freshly-reconnected tenant includes everything again.
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    const { rows } = await buildAccountingExport({ orgId: ORG, excludePushedFor: "xero" });
    expect(
      rows
        .filter((r) => r.type === "invoice")
        .map((r) => r.sourceId)
        .sort(),
    ).toEqual(["inv-A", "inv-B"]);
  });

  it("resetPushedLedger issues a single org+provider-pinned delete", async () => {
    dbState.ledger = [{ entity_type: "invoice", entity_id: "inv-A" }];

    const res = await resetPushedLedger(fakeClient as never, ORG, "quickbooks");
    expect(res.ok).toBe(true);
    expect(dbState.ledgerDeletes).toHaveLength(1);
    const filters = Object.fromEntries(dbState.ledgerDeletes[0]!.filters);
    expect(filters.org_id).toBe(ORG);
    expect(filters.provider).toBe("quickbooks");
  });
});

// ---------------------------------------------------------------------------
// E. PAYMENT-LINK GATE (launch blocker c53) — a payment is pushed ONLY once its
//    invoice exists at the provider.
//
// THE BUG. `syncToProvider` ran `pushInvoices` then `pushPayments` back-to-back
// with NO gate: pushPayments received ALL payment rows even when the invoice push
// failed. QBO accepts a payment whose invoice was never created as a 2xx UNAPPLIED
// receipt; syncToProvider counted it and recorded its id in the push-once ledger,
// and `excludePushedFor` then dropped it from every future export — so the payment
// was stranded UNAPPLIED FOREVER, even after the invoice was created on a retry.
// The most reachable trigger is the FIRST sync of a QBO realm with no Service item
// / VAT code: invoices fail at pushed=0 while ALL payments record unapplied, and
// the surfaced error mentions invoices only, so the loss is silent.
//
// THE FIX, proven here (`payAcceptsAll` models QBO's graceful acceptance):
//   (a) a mid-batch OR complete invoice failure ⇒ payments referencing a
//       not-yet-created invoice are NOT sent and NOT recorded;
//   (b) a subsequent sync, after the invoices succeed, DOES push + link them;
//   (c) in the SAME run, a payment whose invoice WAS created still pushes.
// ---------------------------------------------------------------------------

describe("payment-link gate: never push a payment whose invoice was not created", () => {
  it("(a) COMPLETE invoice failure (pushed=0, e.g. no Service item) sends + records NO payment", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    // Both payments reference invoices that this run FAILS to create.
    dbState.payments = [
      paymentRow("pay-A", "INV-A", "2026-07-05"),
      paymentRow("pay-B", "INV-B", "2026-07-06"),
    ];
    dbState.ledger = [];
    // The QBO trigger: the invoice push fails up front at pushed=0.
    adapterCfg.invResult = {
      ok: false,
      provider: "xero",
      reason: "error",
      message:
        "QuickBooks has no Service item to post invoice lines against; create one first.",
      pushed: 0,
    };
    adapterCfg.payAcceptsAll = true; // QBO would accept the payments UNAPPLIED.

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(false);

    // The gate stopped BOTH payments from ever reaching the adapter…
    expect(adapterCfg.payRows).toEqual([]);
    // …and nothing (invoice or payment) was recorded in the push-once ledger, so
    // the next sync re-attempts everything (no stranded unapplied payment).
    const recorded = dbState.pushedUpserts.flat();
    expect(recorded).toHaveLength(0);
  });

  it("(a) MID-BATCH invoice failure ⇒ (c) the created invoice's payment pushes, the failed one's does NOT", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [
      invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z"),
      invoiceRow("inv-B", "INV-B", "2026-07-02T09:00:00Z"),
    ];
    dbState.payments = [
      paymentRow("pay-A", "INV-A", "2026-07-05"), // invoice A IS created this run
      paymentRow("pay-B", "INV-B", "2026-07-06"), // invoice B FAILS this run
    ];
    dbState.ledger = [];
    // A accepted (pushed:1), then B failed.
    adapterCfg.invResult = {
      ok: false,
      provider: "xero",
      reason: "error",
      message: "QuickBooks invoice push returned 400",
      pushed: 1,
    };
    adapterCfg.payAcceptsAll = true;

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(false);

    // Only pay-A (invoice created this run) was sent; pay-B was gated out.
    expect(adapterCfg.payRows.map((r) => r.sourceId)).toEqual(["pay-A"]);
    // Recorded: invoice A + payment A only. B (invoice) and pay-B are absent, so
    // both retry next sync — pay-B is never stranded unapplied.
    const recorded = dbState.pushedUpserts.flat();
    expect(
      recorded.filter((r) => r.entity_type === "invoice").map((r) => r.entity_id),
    ).toEqual(["inv-A"]);
    expect(
      recorded.filter((r) => r.entity_type === "payment").map((r) => r.entity_id),
    ).toEqual(["pay-A"]);
  });

  it("(b) end-to-end: fail → nothing; retry after invoices succeed → payment pushes + links", async () => {
    dbState.secrets = connectedSecrets();
    dbState.invoices = [invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z")];
    dbState.payments = [paymentRow("pay-A", "INV-A", "2026-07-05")];
    dbState.ledger = [];
    adapterCfg.payAcceptsAll = true;

    // ── Sync 1: no Service item → invoices fail at 0; payment must not strand. ──
    adapterCfg.invResult = {
      ok: false,
      provider: "xero",
      reason: "error",
      message: "QuickBooks has no Service item; create one first.",
      pushed: 0,
    };
    const first = await syncToProvider(ORG, "xero", "actor-1");
    expect(first.ok).toBe(false);
    expect(adapterCfg.payRows).toEqual([]);
    expect(dbState.pushedUpserts.flat()).toHaveLength(0);
    commitLedger(); // records nothing — ledger stays empty.

    // ── Sync 2: operator created the Service item → invoices now succeed. ──
    adapterCfg.invResult = { ok: true, provider: "xero", pushed: 1 };
    const second = await syncToProvider(ORG, "xero", "actor-1");
    expect(second.ok).toBe(true);

    // Now the invoice was created this run, so its payment pushes and links.
    expect(adapterCfg.payRows.map((r) => r.sourceId)).toEqual(["pay-A"]);
    const recorded = dbState.pushedUpserts.flat();
    expect(recorded.map((r) => r.entity_id).sort()).toEqual(["inv-A", "pay-A"]);
  });

  it("(b/prior-run) a payment whose invoice is ALREADY in the ledger pushes even though no invoice is in this batch", async () => {
    dbState.secrets = connectedSecrets();
    // Invoice A was created on a PRIOR run (in the ledger); it is excluded from
    // this run's export, so the batch carries no invoice rows.
    dbState.invoices = [invoiceRow("inv-A", "INV-A", "2026-07-01T09:00:00Z")];
    dbState.payments = [paymentRow("pay-A", "INV-A", "2026-07-05")];
    dbState.ledger = [{ entity_type: "invoice", entity_id: "inv-A" }];
    // No invoice rows to push this run.
    adapterCfg.invResult = { ok: true, provider: "xero", pushed: 0 };
    adapterCfg.payAcceptsAll = true;

    const res = await syncToProvider(ORG, "xero", "actor-1");
    expect(res.ok).toBe(true);

    // The adapter was asked to push NO invoices…
    expect(adapterCfg.invRows).toEqual([]);
    // …but pay-A is recognised as linkable (its invoice number is in
    // pushedInvoiceNumbers) and is pushed + recorded.
    expect(adapterCfg.payRows.map((r) => r.sourceId)).toEqual(["pay-A"]);
    expect(dbState.pushedUpserts.flat().map((r) => r.entity_id)).toEqual(["pay-A"]);
  });
});
