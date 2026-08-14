import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { PlaidAdapter } from "@/lib/integrations/banking/adapters/plaid";
import { NordigenAdapter } from "@/lib/integrations/banking/adapters/nordigen";
import {
  mapStatementToLines,
  normalizePlaidTransactions,
  normalizeNordigenTransactions,
} from "@/lib/integrations/banking/statement-map";
import {
  syncBankConnection,
  type BankSyncGateway,
  type StoredBankConnection,
} from "@/server/services/bank-sync";
import { encryptToken } from "@/lib/integrations/token-crypto";

/**
 * PLAID + NORDIGEN bank-feed adapters — hermetic proofs (mocked HTTP).
 *
 * These prove the two (dark) real adapters are engineering-complete: real
 * accounts + transactions fetch → statement-line mapping (each provider's sign
 * convention normalised deterministically), Plaid OFFSET pagination (F-1), the
 * 401→unauthorized signal that drives the engine's refresh→retry, the SSRF guard
 * on the API-base override, engine idempotency (re-run = no duplicate lines), and
 * the dark-refuse-before-fetch invariant. ALL HTTP is mocked — no live bank is
 * ever contacted (the FCA gate is real; this only proves the code).
 */

const ENC_KEY = Buffer.alloc(32, 7).toString("base64");
const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const BANKING_ENV = [
  "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
  "BANKING_PROVIDER",
  "BANKING_CLIENT_ID",
  "BANKING_CLIENT_SECRET",
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  "PLAID_API_BASE_URL",
  "NORDIGEN_API_BASE_URL",
];

function enable(provider: "plaid" | "nordigen"): void {
  process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
  process.env.BANKING_PROVIDER = provider;
  process.env.BANKING_CLIENT_ID = "client-id";
  process.env.BANKING_CLIENT_SECRET = "client-secret";
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = ENC_KEY;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  for (const k of BANKING_ENV) delete process.env[k];
  vi.restoreAllMocks();
});
afterEach(() => {
  for (const k of BANKING_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure normalisers — deterministic sign / date / id
// ---------------------------------------------------------------------------

describe("normalizePlaidTransactions — Plaid signs money-out POSITIVE", () => {
  it("positive amount → debit, negative amount → credit, absolute magnitude", () => {
    const out = normalizePlaidTransactions([
      { transaction_id: "p-out", date: "2026-07-15", amount: 80.25, name: "SUPPLIER", account_id: "acc-1" },
      { transaction_id: "p-in", date: "2026-07-16", amount: -250.5, merchant_name: "ACME", account_id: "acc-1", payment_meta: { reference_number: "INV-1" } },
    ]);
    expect(out[0]).toMatchObject({ id: "p-out", direction: "debit", amount: 80.25, description: "SUPPLIER" });
    expect(out[1]).toMatchObject({ id: "p-in", direction: "credit", amount: 250.5, description: "ACME", reference: "INV-1" });
  });
});

describe("normalizeNordigenTransactions — signed decimal STRING + id fallback", () => {
  it("negative → debit, positive → credit; falls back to internalTransactionId", () => {
    const out = normalizeNordigenTransactions([
      { transactionId: "n-1", bookingDate: "2026-07-15", transactionAmount: { amount: "250.50", currency: "GBP" }, remittanceInformationUnstructured: "ACME", endToEndId: "E2E-1" },
      { internalTransactionId: "int-2", bookingDate: "2026-07-16", transactionAmount: { amount: "-80.25", currency: "GBP" }, creditorName: "SUPPLIER" },
    ]);
    expect(out[0]).toMatchObject({ id: "n-1", direction: "credit", amount: 250.5, description: "ACME", reference: "E2E-1" });
    // No transactionId ⇒ the stable internalTransactionId becomes the dedupe key.
    expect(out[1]).toMatchObject({ id: "int-2", direction: "debit", amount: 80.25, description: "SUPPLIER" });
  });
});

// ---------------------------------------------------------------------------
// Plaid adapter — offset pagination, mapping, auth, dark, SSRF
// ---------------------------------------------------------------------------

describe("PlaidAdapter.fetchStatements", () => {
  it("pages via offset (F-1), groups per account, maps signs/dates over a bounded window", async () => {
    enable("plaid");
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: string }).body)) as {
        start_date: string;
        end_date: string;
        options: { count: number; offset: number };
      };
      // Bounded window carried to Plaid.
      expect(body.start_date).toBe("2026-07-01");
      expect(body.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (body.options.offset === 0) {
        return json({
          accounts: [{ account_id: "acc-1", name: "Current" }],
          transactions: [
            { transaction_id: "t1", date: "2026-07-15", amount: -100, name: "IN", account_id: "acc-1" },
            { transaction_id: "t2", date: "2026-07-16", amount: 40, name: "OUT", account_id: "acc-1" },
          ],
          total_transactions: 3,
        });
      }
      // Second page (offset 2).
      expect(body.options.offset).toBe(2);
      return json({
        accounts: [{ account_id: "acc-1", name: "Current" }],
        transactions: [
          { transaction_id: "t3", date: "2026-07-17", amount: 5, name: "OUT2", account_id: "acc-1" },
        ],
        total_transactions: 3,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await new PlaidAdapter().fetchStatements({
      accessToken: "access-item",
      connectionRef: "item-1",
      since: "2026-07-01",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fetchMock).toHaveBeenCalledTimes(2); // paged
    expect(res.statements).toHaveLength(1);
    const lines = mapStatementToLines(res.statements[0]!, { orgId: ORG, bankStatementId: "stmt-1" });
    expect(lines).toHaveLength(3);
    // amount -100 (money IN) → +100; amount 40 (money OUT) → -40.
    expect(lines[0]).toMatchObject({ posted_at: "2026-07-15", amount: 100, provider_tx_id: "t1" });
    expect(lines[1]).toMatchObject({ posted_at: "2026-07-16", amount: -40, provider_tx_id: "t2" });
    expect(lines[2]).toMatchObject({ posted_at: "2026-07-17", amount: -5, provider_tx_id: "t3" });
  });

  it("sends client_id + secret + access_token in the body (Plaid auth model)", async () => {
    enable("plaid");
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: string }).body)) as Record<string, unknown>;
      expect(body.client_id).toBe("client-id");
      expect(body.secret).toBe("client-secret");
      expect(body.access_token).toBe("access-item");
      return json({ accounts: [], transactions: [], total_transactions: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new PlaidAdapter().fetchStatements({ accessToken: "access-item", connectionRef: "item-1", since: null });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns `unauthorized` on a 401 (drives refresh→retry)", async () => {
    enable("plaid");
    vi.stubGlobal("fetch", vi.fn(async () => json({ error_code: "INVALID" }, 401)));
    const res = await new PlaidAdapter().fetchStatements({ accessToken: "stale", connectionRef: "item-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("DARK-REFUSES before any fetch when unconfigured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await new PlaidAdapter().fetchStatements({ accessToken: "x", connectionRef: "item-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("SSRF: a non-Plaid API-base override is rejected → falls back to production host", async () => {
    enable("plaid");
    process.env.PLAID_API_BASE_URL = "https://evil.example.com";
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url).startsWith("https://production.plaid.com/")).toBe(true);
      return json({ accounts: [], transactions: [], total_transactions: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new PlaidAdapter().fetchStatements({ accessToken: "a", connectionRef: "item-1" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("SSRF: a valid plaid.com subdomain override IS honoured (sandbox)", async () => {
    enable("plaid");
    process.env.PLAID_API_BASE_URL = "https://sandbox.plaid.com";
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url).startsWith("https://sandbox.plaid.com/")).toBe(true);
      return json({ accounts: [], transactions: [], total_transactions: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new PlaidAdapter().fetchStatements({ accessToken: "a", connectionRef: "item-1" });
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nordigen adapter — requisition→accounts→transactions, mapping, auth, dark, SSRF
// ---------------------------------------------------------------------------

/** A requisition + per-account transactions mock router. */
function nordigenRouter(
  accountIds: string[],
  bookedByAccount: Record<string, unknown[]>,
  opts: { reqStatus?: number; txStatus?: number } = {},
) {
  return vi.fn(async (input: unknown, _init?: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/v2/requisitions/")) {
      if (opts.reqStatus && opts.reqStatus !== 200) return json({}, opts.reqStatus);
      return json({ accounts: accountIds });
    }
    const m = url.match(/\/api\/v2\/accounts\/([^/]+)\/transactions\//);
    if (m) {
      if (opts.txStatus && opts.txStatus !== 200) return json({}, opts.txStatus);
      const acct = decodeURIComponent(m[1]!);
      return json({ transactions: { booked: bookedByAccount[acct] ?? [], pending: [] } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("NordigenAdapter.fetchStatements", () => {
  it("resolves requisition accounts, pulls BOOKED transactions, maps signs/dates over the window", async () => {
    enable("nordigen");
    const router = nordigenRouter(["acc-1"], {
      "acc-1": [
        { transactionId: "n-in", bookingDate: "2026-07-15", transactionAmount: { amount: "250.50" }, remittanceInformationUnstructured: "ACME", endToEndId: "E2E-1" },
        { internalTransactionId: "n-out", bookingDate: "2026-07-16", transactionAmount: { amount: "-80.25" }, creditorName: "SUPPLIER" },
      ],
    });
    vi.stubGlobal("fetch", router);

    const res = await new NordigenAdapter().fetchStatements({
      accessToken: "bearer-1",
      connectionRef: "req-1",
      since: "2026-07-01",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.statements).toHaveLength(1);
    const lines = mapStatementToLines(res.statements[0]!, { orgId: ORG, bankStatementId: "stmt-1" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ posted_at: "2026-07-15", amount: 250.5, provider_tx_id: "n-in", reference: "E2E-1" });
    // internalTransactionId is the dedupe key when no transactionId is present.
    expect(lines[1]).toMatchObject({ posted_at: "2026-07-16", amount: -80.25, provider_tx_id: "n-out" });
    // The transactions call carried a bounded date_from window.
    const txCall = router.mock.calls.find((c) => String(c[0]).includes("/transactions/"));
    expect(String(txCall?.[0])).toMatch(/date_from=2026-07-01/);
    // Bearer auth header carried the access token.
    const init = router.mock.calls[0]![1] as unknown as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe("Bearer bearer-1");
  });

  it("returns `unauthorized` on a 401 from the requisition read", async () => {
    enable("nordigen");
    vi.stubGlobal("fetch", nordigenRouter(["acc-1"], {}, { reqStatus: 401 }));
    const res = await new NordigenAdapter().fetchStatements({ accessToken: "stale", connectionRef: "req-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("returns `unauthorized` on a 403 from the transactions read", async () => {
    enable("nordigen");
    vi.stubGlobal("fetch", nordigenRouter(["acc-1"], { "acc-1": [] }, { txStatus: 403 }));
    const res = await new NordigenAdapter().fetchStatements({ accessToken: "stale", connectionRef: "req-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("errors (no fetch of accounts) when no requisition ref is bound", async () => {
    enable("nordigen");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await new NordigenAdapter().fetchStatements({ accessToken: "a", connectionRef: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
    expect(spy).not.toHaveBeenCalled();
  });

  it("DARK-REFUSES before any fetch when unconfigured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await new NordigenAdapter().fetchStatements({ accessToken: "x", connectionRef: "req-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("SSRF: a non-GoCardless API-base override falls back to the production host", async () => {
    enable("nordigen");
    process.env.NORDIGEN_API_BASE_URL = "http://169.254.169.254";
    const router = vi.fn(async (url: unknown) => {
      expect(String(url).startsWith("https://bankaccountdata.gocardless.com/")).toBe(true);
      return json({ accounts: [] });
    });
    vi.stubGlobal("fetch", router);
    await new NordigenAdapter().fetchStatements({ accessToken: "a", connectionRef: "req-1" });
    expect(router).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Engine idempotency — the shared sync engine dedupes both providers' imports
// ---------------------------------------------------------------------------

type Inserted = Record<string, unknown>;
function fakeGateway() {
  const existing = new Map<string, Set<string>>();
  const inserted: Inserted[] = [];
  let statements = 0;
  const gateway: BankSyncGateway = {
    listConnected: async () => [],
    saveRefreshedTokens: async () => {},
    existingProviderTxIds: async (orgId, ids) => {
      const set = existing.get(orgId) ?? new Set<string>();
      return new Set(ids.filter((id) => set.has(id)));
    },
    createStatement: async () => `stmt-${++statements}`,
    insertLines: async (rows) => {
      for (const r of rows) {
        inserted.push(r as Inserted);
        const orgId = String((r as { org_id?: string }).org_id);
        const id = (r as { provider_tx_id?: string }).provider_tx_id;
        if (id) {
          const set = existing.get(orgId) ?? new Set<string>();
          set.add(id);
          existing.set(orgId, set);
        }
      }
      return { inserted: rows.length, constraintError: null, transientError: null };
    },
    deleteStatement: async () => {},
    updateStatementLineCount: async () => {},
    markSynced: async () => {},
  };
  return { gateway, state: { inserted, get statements() { return statements; } } };
}

function plaidConnection(over: Partial<StoredBankConnection> = {}): StoredBankConnection {
  return {
    orgId: ORG,
    provider: "plaid",
    status: "connected",
    connectionRef: "item-1",
    accessTokenCipher: encryptToken("access-item"),
    refreshTokenCipher: encryptToken("refresh-1"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastSyncAt: null,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe("sync engine idempotency across the new adapters (Plaid)", () => {
  it("a re-run over the same window inserts NO duplicate lines", async () => {
    enable("plaid");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          accounts: [{ account_id: "acc-1", name: "Current" }],
          transactions: [
            { transaction_id: "t1", date: "2026-07-15", amount: -100, account_id: "acc-1" },
            { transaction_id: "t2", date: "2026-07-16", amount: 40, account_id: "acc-1" },
          ],
          total_transactions: 2,
        }),
      ),
    );
    const fg = fakeGateway();
    const first = await syncBankConnection(plaidConnection(), fg.gateway);
    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(2);

    const second = await syncBankConnection(
      plaidConnection({ lastSyncAt: new Date().toISOString() }),
      fg.gateway,
    );
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("no_new");
    expect(second.inserted).toBe(0);
    expect(fg.state.inserted).toHaveLength(2); // unchanged
  });
});
