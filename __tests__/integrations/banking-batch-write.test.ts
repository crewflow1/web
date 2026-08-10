import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { encryptToken } from "@/lib/integrations/token-crypto";

/**
 * BANK-FEED WRITE PATH — batch-poisoning containment (the unswept C61 sibling).
 *
 * `insertLines` used to be a SINGLE un-chunked upsert with `if (error) throw`: one
 * uninsertable line (a "" posted_at → 22007, an amount past numeric(12,2) → 22003)
 * aborted the org's WHOLE batch (0 lines), and because createStatement ran first,
 * left an ORPHAN empty parent with a non-zero line_count. And a throw stranded the
 * feed: the outer catch recorded last_error only, status stayed 'connected',
 * last_sync_at never moved, so the next tick refetched the identical window and
 * re-aborted forever. These prove the fix:
 *
 *   A. createAdminGateway().insertLines chunks (<=500) and falls back per-row on a
 *      constraint error (good rows land, bad dropped, TERMINAL surfaced), never
 *      throwing for a row/infra error;
 *   B. the engine deletes the orphan parent when nothing lands, reconciles
 *      line_count to what actually inserted, goes TERMINAL on a persistent
 *      constraint, and keeps the connection live on a transient blip.
 */

// ── Mock the service-role admin client the gateway builds on (Part A) ──────────
let fakeAdmin: unknown = null;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin }));

import {
  createAdminGateway,
  syncBankConnection,
  type BankSyncGateway,
  type BankLinesWriteResult,
  type StoredBankConnection,
} from "@/server/services/bank-sync";
import type { BankStatementLineInsert } from "@/lib/integrations/banking/statement-map";

const ENC_KEY = Buffer.alloc(32, 7).toString("base64");
const ORG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const BANKING_ENV = [
  "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
  "BANKING_PROVIDER",
  "BANKING_CLIENT_ID",
  "BANKING_CLIENT_SECRET",
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
];
function enableTrueLayer(): void {
  process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
  process.env.BANKING_PROVIDER = "truelayer";
  process.env.BANKING_CLIENT_ID = "client-id";
  process.env.BANKING_CLIENT_SECRET = "client-secret";
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = ENC_KEY;
}

beforeEach(() => {
  fakeAdmin = null;
  for (const k of BANKING_ENV) delete process.env[k];
  vi.restoreAllMocks();
});
afterEach(() => {
  fakeAdmin = null;
  for (const k of BANKING_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

function line(over: Partial<BankStatementLineInsert> = {}): BankStatementLineInsert {
  return {
    org_id: ORG,
    bank_statement_id: "stmt-1",
    posted_at: "2026-07-01",
    amount: 1,
    description: null,
    reference: null,
    provider_tx_id: "tx-x",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A. createAdminGateway().insertLines — chunk + per-row fallback (no throw)
// ---------------------------------------------------------------------------

describe("createAdminGateway().insertLines — chunk + per-row fallback", () => {
  it("chunks a >500-line batch into <=500-per-statement upserts and sums the count", async () => {
    const batches: number[] = [];
    fakeAdmin = {
      from() {
        return {
          upsert(rows: unknown[]) {
            batches.push(rows.length);
            return Promise.resolve({ error: null, count: rows.length });
          },
        };
      },
    };
    const gw = createAdminGateway();
    const rows = Array.from({ length: 1200 }, (_, i) => line({ provider_tx_id: `tx-${i}` }));

    const res = await gw.insertLines(rows);

    expect(batches.length).toBeGreaterThan(1);
    for (const n of batches) expect(n).toBeLessThanOrEqual(500);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(1200);
    expect(res.inserted).toBe(1200);
    expect(res.constraintError).toBeNull();
    expect(res.transientError).toBeNull();
  });

  it("a 23514 chunk falls back per-row: good rows land, the poison row is dropped, TERMINAL", async () => {
    const POISON = "tx-poison";
    fakeAdmin = {
      from() {
        return {
          upsert(rows: Array<{ provider_tx_id?: string }>) {
            if (rows.length > 1) {
              return Promise.resolve({ error: { message: "check_violation", code: "23514" }, count: null });
            }
            const bad = rows[0]?.provider_tx_id === POISON;
            return Promise.resolve(
              bad
                ? { error: { message: "check_violation", code: "23514" }, count: null }
                : { error: null, count: 1 },
            );
          },
        };
      },
    };
    const gw = createAdminGateway();
    const rows = [
      line({ provider_tx_id: "tx-a" }),
      line({ provider_tx_id: POISON }),
      line({ provider_tx_id: "tx-b" }),
    ];

    const res = await gw.insertLines(rows);
    expect(res.inserted).toBe(2); // the two good lines landed
    expect(res.constraintError).toBe("check_violation");
    expect(res.transientError).toBeNull();
  });

  it("a transient (non-constraint) error bails without throwing", async () => {
    fakeAdmin = {
      from() {
        return {
          upsert() {
            return Promise.resolve({ error: { message: "server closed the connection", code: "08006" }, count: null });
          },
        };
      },
    };
    const gw = createAdminGateway();
    const res = await gw.insertLines([line({ provider_tx_id: "tx-a" })]);
    expect(res.inserted).toBe(0);
    expect(res.transientError).toBe("server closed the connection");
    expect(res.constraintError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B. Engine — orphan cleanup, line_count reconciliation, TERMINAL vs transient
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A TrueLayer router that serves two transactions on one account. */
function twoTxRouter() {
  return vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/data/v1/accounts")) {
      return json({ results: [{ account_id: "acc-1", display_name: "A" }] });
    }
    if (url.includes("/transactions")) {
      return json({
        results: [
          { transaction_id: "tx-1", timestamp: "2026-07-15T09:30:00Z", amount: 100, transaction_type: "CREDIT" },
          { transaction_id: "tx-2", timestamp: "2026-07-16T09:30:00Z", amount: -40, transaction_type: "DEBIT" },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

type Calls = {
  created: number[];
  deleted: string[];
  lineCountUpdates: Array<{ statementId: string; lineCount: number }>;
  synced: Array<{ lastError: string | null; status?: string; advanceSyncCursor?: boolean }>;
};

/** A gateway whose insertLines returns a scripted result, recording every write. */
function stubGateway(insertResult: BankLinesWriteResult): { gateway: BankSyncGateway; calls: Calls } {
  const calls: Calls = { created: [], deleted: [], lineCountUpdates: [], synced: [] };
  const gateway: BankSyncGateway = {
    listConnected: async () => [],
    saveRefreshedTokens: async () => {},
    existingProviderTxIds: async () => new Set<string>(),
    createStatement: async (_org, _fn, count) => {
      calls.created.push(count);
      return "stmt-1";
    },
    insertLines: async () => insertResult,
    deleteStatement: async (_org, id) => {
      calls.deleted.push(id);
    },
    updateStatementLineCount: async (_org, id, lineCount) => {
      calls.lineCountUpdates.push({ statementId: id, lineCount });
    },
    markSynced: async (_org, _p, fields) => {
      calls.synced.push(fields);
    },
  };
  return { gateway, calls };
}

function connection(): StoredBankConnection {
  return {
    orgId: ORG,
    provider: "truelayer",
    status: "connected",
    connectionRef: "conn-1",
    accessTokenCipher: encryptToken("access-1"),
    refreshTokenCipher: encryptToken("refresh-1"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastSyncAt: new Date("2026-07-10T00:00:00Z").toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
}

describe("syncBankConnection — orphan cleanup + line_count + TERMINAL/transient", () => {
  it("TOTAL constraint failure: deletes the orphan parent and goes TERMINAL (no cursor advance)", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", twoTxRouter());
    const { gateway, calls } = stubGateway({ inserted: 0, constraintError: "all bad", transientError: null });

    const res = await syncBankConnection(connection(), gateway);

    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("error");
    expect(res.inserted).toBe(0);
    // The empty parent is dropped — never an orphan with a non-zero line_count.
    expect(calls.deleted).toEqual(["stmt-1"]);
    // TERMINAL: status flipped to 'error', and the success cursor did NOT advance.
    const last = calls.synced.at(-1)!;
    expect(last.status).toBe("error");
    expect(last.advanceSyncCursor).toBeFalsy();
  });

  it("PARTIAL constraint drop: reconciles line_count to what landed and goes TERMINAL", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", twoTxRouter());
    // 2 candidate lines; only 1 landed (the other hit a CHECK the mapper doesn't mirror).
    const { gateway, calls } = stubGateway({ inserted: 1, constraintError: "one bad", transientError: null });

    const res = await syncBankConnection(connection(), gateway);

    expect(res.outcome).toBe("error");
    expect(res.inserted).toBe(1);
    // The parent was created with 2 then reconciled DOWN to the 1 that landed.
    expect(calls.created).toEqual([2]);
    expect(calls.lineCountUpdates).toEqual([{ statementId: "stmt-1", lineCount: 1 }]);
    expect(calls.deleted).toEqual([]); // not an orphan — a line landed
    const last = calls.synced.at(-1)!;
    expect(last.status).toBe("error");
    expect(last.advanceSyncCursor).toBeFalsy();
  });

  it("TRANSIENT insert error: deletes the orphan but keeps the connection 'connected' (retriable)", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", twoTxRouter());
    const { gateway, calls } = stubGateway({ inserted: 0, constraintError: null, transientError: "db blip" });

    const res = await syncBankConnection(connection(), gateway);

    expect(res.outcome).toBe("error");
    expect(calls.deleted).toEqual(["stmt-1"]); // orphan cleaned
    const last = calls.synced.at(-1)!;
    expect(last.lastError).toBeTruthy(); // recorded...
    expect(last.status).toBeUndefined(); // ...but NOT flipped to 'error' — still retriable
    expect(last.advanceSyncCursor).toBeFalsy(); // and the cursor stays put
  });

  it("CLEAN success: no delete, no line_count reconcile, cursor advances, self-heal", async () => {
    enableTrueLayer();
    vi.stubGlobal("fetch", twoTxRouter());
    const { gateway, calls } = stubGateway({ inserted: 2, constraintError: null, transientError: null });

    const res = await syncBankConnection(connection(), gateway);

    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("mapped");
    expect(res.inserted).toBe(2);
    expect(calls.deleted).toEqual([]);
    expect(calls.lineCountUpdates).toEqual([]); // inserted === created count ⇒ no reconcile
    const last = calls.synced.at(-1)!;
    expect(last.status).toBe("connected");
    expect(last.lastError).toBeNull();
    expect(last.advanceSyncCursor).toBe(true);
  });
});
