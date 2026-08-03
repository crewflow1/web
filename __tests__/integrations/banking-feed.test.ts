import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TrueLayerAdapter } from "@/lib/integrations/banking/adapters/truelayer";
import {
  refreshAccessToken,
  exchangeCodeForTokens,
  resolveConnectionHandle,
} from "@/lib/integrations/banking/oauth";
import { encryptToken } from "@/lib/integrations/token-crypto";
import { mapStatementToLines } from "@/lib/integrations/banking/statement-map";
import {
  syncBankConnection,
  runBankSync,
  type BankSyncGateway,
  type StoredBankConnection,
} from "@/server/services/bank-sync";

/**
 * BANK-FEED ACTIVATION ENGINE — hermetic proofs (TrueLayer, mocked HTTP).
 *
 * These prove the (dark) TrueLayer feed is engineering-complete: real accounts +
 * per-account transactions fetch → statement-line mapping (signs/dates/amounts,
 * no drop/dupe), token refresh (proactive + reactive 401→refresh→retry), the sync
 * engine's idempotency (re-run = no duplicate lines, no empty parents), #456
 * org-pinning on writes, connect handle resolution via /data/v1/me, and the
 * dark-refuse-before-fetch invariant. ALL HTTP is mocked — no live bank is ever
 * contacted (the FCA gate is real; this only proves the code).
 */

// A valid base64-encoded 32-byte AES-256 key for token-crypto round-trips.
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

/** Flip the two-switch dark gate ON (+ a real encryption key) for the live path. */
function enableTrueLayer(): void {
  process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
  process.env.BANKING_PROVIDER = "truelayer";
  process.env.BANKING_CLIENT_ID = "client-id";
  process.env.BANKING_CLIENT_SECRET = "client-secret";
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = ENC_KEY;
}

const BANKING_ENV = [
  "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
  "BANKING_PROVIDER",
  "BANKING_CLIENT_ID",
  "BANKING_CLIENT_SECRET",
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
];

const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A TrueLayer /accounts + /transactions mock router. */
function trueLayerRouter(
  txByAccount: Record<string, unknown[]>,
  opts: { accountsStatus?: number; txStatus?: number } = {},
) {
  return vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/data/v1/accounts")) {
      if (opts.accountsStatus && opts.accountsStatus !== 200) {
        return json({ error: "unauthorized" }, opts.accountsStatus);
      }
      return json({
        results: Object.keys(txByAccount).map((id) => ({
          account_id: id,
          display_name: `Account ${id}`,
        })),
      });
    }
    const m = url.match(/\/data\/v1\/accounts\/([^/]+)\/transactions/);
    if (m) {
      if (opts.txStatus && opts.txStatus !== 200) {
        return json({ error: "unauthorized" }, opts.txStatus);
      }
      const acct = decodeURIComponent(m[1]!);
      return json({ results: txByAccount[acct] ?? [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
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
// 1. TrueLayer adapter — real accounts + per-account transactions fetch
// ---------------------------------------------------------------------------

describe("TrueLayerAdapter.fetchStatements — real transactions fetch + mapping", () => {
  it("fetches accounts + per-account transactions and normalises signs/dates/amounts", async () => {
    enableTrueLayer();
    const router = trueLayerRouter({
      "acc-1": [
        {
          transaction_id: "tx-credit",
          timestamp: "2026-07-15T09:30:00Z",
          amount: 250.5,
          transaction_type: "CREDIT",
          description: "ACME LTD",
          meta: { provider_reference: "INV-1" },
        },
        {
          transaction_id: "tx-debit",
          timestamp: "2026-07-16T12:00:00Z",
          amount: -80.25,
          transaction_type: "DEBIT",
          description: "SUPPLIER",
          meta: null,
        },
      ],
    });
    vi.stubGlobal("fetch", router);

    const res = await new TrueLayerAdapter().fetchStatements({
      accessToken: "access-1",
      connectionRef: "conn-1",
      since: "2026-07-01",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.statements).toHaveLength(1);
    const lines = mapStatementToLines(res.statements[0]!, {
      orgId: ORG,
      bankStatementId: "stmt-1",
    });
    expect(lines).toHaveLength(2);
    // CREDIT → positive, DEBIT → negative; magnitudes absolute; calendar day.
    expect(lines[0]).toMatchObject({
      posted_at: "2026-07-15",
      amount: 250.5,
      reference: "INV-1",
      provider_tx_id: "tx-credit",
    });
    expect(lines[1]).toMatchObject({
      posted_at: "2026-07-16",
      amount: -80.25,
      provider_tx_id: "tx-debit",
    });
    // The transactions call carried a bounded date-range window.
    const txCall = router.mock.calls.find((c) =>
      String(c[0]).includes("/transactions"),
    );
    expect(String(txCall?.[0])).toMatch(/from=2026-07-01/);
    expect(String(txCall?.[0])).toMatch(/to=/);
  });

  it("returns `unauthorized` on a 401 from /accounts (drives refresh→retry)", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", trueLayerRouter({ "acc-1": [] }, { accountsStatus: 401 }));
    const res = await new TrueLayerAdapter().fetchStatements({
      accessToken: "stale",
      connectionRef: "conn-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("returns `unauthorized` on a 401 from /transactions", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", trueLayerRouter({ "acc-1": [] }, { txStatus: 401 }));
    const res = await new TrueLayerAdapter().fetchStatements({
      accessToken: "stale",
      connectionRef: "conn-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthorized");
  });

  it("DARK-REFUSES before any fetch when unconfigured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await new TrueLayerAdapter().fetchStatements({
      accessToken: "x",
      connectionRef: "conn-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Token refresh + connection-handle resolution
// ---------------------------------------------------------------------------

describe("refreshAccessToken — grant_type=refresh_token", () => {
  it("posts refresh_token and returns fresh tokens (live)", async () => {
    enableTrueLayer();
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = String((init as { body?: string }).body);
      expect(body).toMatch(/grant_type=refresh_token/);
      expect(body).toMatch(/refresh_token=old-refresh/);
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await refreshAccessToken({ provider: "truelayer", refreshToken: "old-refresh" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tokens.accessToken).toBe("new-access");
    expect(res.tokens.refreshToken).toBe("new-refresh");
    expect(res.tokens.expiresAt).not.toBeNull();
  });

  it("keeps the existing refresh token when the aggregator does not rotate it", async () => {
    enableTrueLayer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 })),
    );
    const res = await refreshAccessToken({ provider: "truelayer", refreshToken: "keep-me" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tokens.refreshToken).toBe("keep-me");
  });

  it("REFUSES with no network call when dark", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await refreshAccessToken({ provider: "truelayer", refreshToken: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("connect handle resolution via /data/v1/me", () => {
  it("resolveConnectionHandle reads credentials_id + provider from /me (live)", async () => {
    enableTrueLayer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        expect(String(url)).toMatch(/\/data\/v1\/me$/);
        return json({
          results: [
            {
              credentials_id: "cred-abc",
              provider: { provider_id: "ob-monzo", display_name: "Monzo" },
            },
          ],
        });
      }),
    );
    const handle = await resolveConnectionHandle({ provider: "truelayer", accessToken: "a" });
    expect(handle).toEqual({
      connectionRef: "cred-abc",
      institutionId: "ob-monzo",
      institutionName: "Monzo",
    });
  });

  it("exchangeCodeForTokens resolves the connection handle from /me (not a query param)", async () => {
    enableTrueLayer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/connect/token")) {
          return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
        }
        if (u.endsWith("/data/v1/me")) {
          return json({
            results: [{ credentials_id: "cred-xyz", provider: { provider_id: "ob-starling", display_name: "Starling" } }],
          });
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    const res = await exchangeCodeForTokens({
      provider: "truelayer",
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://app.example/cb",
      // No connectionRef on the query — TrueLayer does not send one.
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tokens.connectionRef).toBe("cred-xyz");
    expect(res.tokens.institutionName).toBe("Starling");
  });

  it("resolveConnectionHandle is all-null + no fetch when dark", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const handle = await resolveConnectionHandle({ provider: "truelayer", accessToken: "a" });
    expect(handle.connectionRef).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Sync engine — idempotency, org-pin, refresh→retry, dark-refuse
// ---------------------------------------------------------------------------

type GatewayState = {
  inserted: Array<Record<string, unknown>>;
  /** org_id → set of provider_tx_ids already stored (org-scoped, as the DB is). */
  existing: Map<string, Set<string>>;
  statementsCreated: number;
  savedTokens: number;
  synced: Array<{ orgId: string; lastError: string | null; status?: string }>;
};

/** An in-memory, org-scoped gateway recording writes for assertions. */
function fakeGateway(overrides: Partial<BankSyncGateway> = {}): {
  gateway: BankSyncGateway;
  state: GatewayState;
} {
  const state: GatewayState = {
    inserted: [],
    existing: new Map(),
    statementsCreated: 0,
    savedTokens: 0,
    synced: [],
  };
  const gateway: BankSyncGateway = {
    listConnected: async () => [],
    saveRefreshedTokens: async () => {
      state.savedTokens += 1;
    },
    existingProviderTxIds: async (orgId, ids) => {
      const set = state.existing.get(orgId) ?? new Set<string>();
      return new Set(ids.filter((id) => set.has(id)));
    },
    createStatement: async () => {
      state.statementsCreated += 1;
      return `stmt-${state.statementsCreated}`;
    },
    insertLines: async (rows) => {
      for (const r of rows) {
        state.inserted.push(r as Record<string, unknown>);
        const orgId = String((r as { org_id?: string }).org_id);
        const id = (r as { provider_tx_id?: string }).provider_tx_id;
        if (id) {
          const set = state.existing.get(orgId) ?? new Set<string>();
          set.add(id); // subsequent org-scoped runs see it as existing
          state.existing.set(orgId, set);
        }
      }
    },
    markSynced: async (orgId, _provider, fields) => {
      state.synced.push({ orgId, ...fields });
    },
    ...overrides,
  };
  return { gateway, state };
}

function connection(over: Partial<StoredBankConnection> = {}): StoredBankConnection {
  return {
    orgId: ORG,
    provider: "truelayer",
    status: "connected",
    connectionRef: "conn-1",
    accessTokenCipher: encryptToken("access-1"),
    refreshTokenCipher: encryptToken("refresh-1"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), // future ⇒ no proactive refresh
    lastSyncAt: null,
    ...over,
  };
}

const TWO_TX = {
  "acc-1": [
    { transaction_id: "tx-1", timestamp: "2026-07-15T09:30:00Z", amount: 100, transaction_type: "CREDIT" },
    { transaction_id: "tx-2", timestamp: "2026-07-16T09:30:00Z", amount: -40, transaction_type: "DEBIT" },
  ],
};

describe("syncBankConnection — mapping, org-pin, idempotency", () => {
  it("imports new lines, org-pinned, with provider_tx_id and a parent statement", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", trueLayerRouter(TWO_TX));
    const fg = fakeGateway();

    const res = await syncBankConnection(connection(), fg.gateway);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("mapped");
    expect(res.inserted).toBe(2);
    expect(fg.state.statementsCreated).toBe(1);
    // #456: every inserted row is pinned to the synced org, bound to the parent.
    expect(fg.state.inserted).toHaveLength(2);
    for (const row of fg.state.inserted) {
      expect(row.org_id).toBe(ORG);
      expect(row.bank_statement_id).toBe("stmt-1");
    }
    expect(fg.state.inserted.map((r) => r.provider_tx_id)).toEqual(["tx-1", "tx-2"]);
  });

  it("IS IDEMPOTENT: a re-run over the same window inserts no duplicate lines and no empty parent", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", trueLayerRouter(TWO_TX));
    const fg = fakeGateway();

    const first = await syncBankConnection(connection(), fg.gateway);
    expect(first.inserted).toBe(2);

    // Second run: the gateway now reports both ids as existing.
    const second = await syncBankConnection(
      connection({ lastSyncAt: new Date().toISOString() }),
      fg.gateway,
    );
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("no_new");
    expect(second.inserted).toBe(0);
    expect(fg.state.inserted).toHaveLength(2); // unchanged
    expect(fg.state.statementsCreated).toBe(1); // no second parent created
  });

  it("dedupes duplicate tx ids WITHIN a single fetch batch", async () => {
    enableTrueLayer();
    vi.stubGlobal(
      "fetch",
      trueLayerRouter({
        "acc-1": [
          { transaction_id: "dup", timestamp: "2026-07-15", amount: 10, transaction_type: "CREDIT" },
          { transaction_id: "dup", timestamp: "2026-07-15", amount: 10, transaction_type: "CREDIT" },
        ],
      }),
    );
    const fg = fakeGateway();
    const res = await syncBankConnection(connection(), fg.gateway);
    expect(res.inserted).toBe(1);
    expect(fg.state.inserted).toHaveLength(1);
  });

  it("401 → refresh → retry once, then imports (reactive refresh)", async () => {
    enableTrueLayer();
    let accountsCalls = 0;
    const router = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.includes("/connect/token")) {
        const body = String((init as { body?: string })?.body ?? "");
        expect(body).toMatch(/grant_type=refresh_token/);
        return json({ access_token: "fresh", refresh_token: "fresh-ref", expires_in: 3600 });
      }
      if (u.endsWith("/data/v1/accounts")) {
        accountsCalls += 1;
        if (accountsCalls === 1) return json({ error: "unauthorized" }, 401);
        return json({ results: [{ account_id: "acc-1", display_name: "A" }] });
      }
      if (u.includes("/transactions")) {
        return json({ results: TWO_TX["acc-1"] });
      }
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal("fetch", router);
    const fg = fakeGateway();

    const res = await syncBankConnection(connection(), fg.gateway);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("mapped");
    expect(res.inserted).toBe(2);
    expect(fg.state.savedTokens).toBe(1); // the refreshed token was persisted
    expect(accountsCalls).toBe(2); // retried once after refresh
  });

  it("PROACTIVELY refreshes when the stored token is expired, before fetching", async () => {
    enableTrueLayer();
    let refreshed = false;
    const router = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/connect/token")) {
        refreshed = true;
        return json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
      }
      if (u.endsWith("/data/v1/accounts")) {
        expect(refreshed).toBe(true); // refresh happened BEFORE the fetch
        return json({ results: [{ account_id: "acc-1", display_name: "A" }] });
      }
      if (u.includes("/transactions")) return json({ results: [] });
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal("fetch", router);
    const fg = fakeGateway();

    const res = await syncBankConnection(
      connection({ tokenExpiresAt: new Date(Date.now() - 1000).toISOString() }),
      fg.gateway,
    );
    expect(res.ok).toBe(true);
    expect(fg.state.savedTokens).toBe(1);
  });

  it("DARK-REFUSES before any fetch or gateway write when unconfigured", async () => {
    // The encryption key is NOT part of the dark gate; set it only so the test
    // can build ciphertext. The BANKING_* switches stay unset ⇒ provider dark.
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = ENC_KEY;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const fg = fakeGateway();
    const res = await syncBankConnection(connection(), fg.gateway);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("skipped_dark");
    expect(spy).not.toHaveBeenCalled();
    expect(fg.state.inserted).toHaveLength(0);
    expect(fg.state.statementsCreated).toBe(0);
    expect(fg.state.synced).toHaveLength(0);
  });
});

describe("runBankSync — dark no-op across orgs", () => {
  it("returns ran:false and touches NO gateway when no provider is ready", async () => {
    const fg = fakeGateway({
      listConnected: vi.fn(async () => {
        throw new Error("must not list connections while dark");
      }),
    });
    const res = await runBankSync(fg.gateway);
    expect(res.ran).toBe(false);
    expect(res.results).toHaveLength(0);
  });

  it("iterates every connected org for the bound provider when live", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", trueLayerRouter(TWO_TX));
    const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const fg = fakeGateway({
      listConnected: async () => [connection(), connection({ orgId: orgB })],
    });
    const res = await runBankSync(fg.gateway);
    expect(res.ran).toBe(true);
    expect(res.provider).toBe("truelayer");
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.outcome === "mapped")).toBe(true);
    // Both orgs' lines were written, each pinned to its own org.
    const orgs = new Set(fg.state.inserted.map((r) => r.org_id));
    expect(orgs).toEqual(new Set([ORG, orgB]));
  });
});
