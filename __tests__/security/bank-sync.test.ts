import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * BANK-FEED SYNC ENGINE (20261109) — trust-boundary source proofs.
 *
 * The activation engine (server/services/bank-sync.ts) + its cron seam are the
 * ONLY paths that read the encrypted token columns back and pull live bank data.
 * These pins hold the dark-by-default + refuse-before-fetch invariants at the
 * SOURCE level, alongside the runtime proofs in __tests__/integrations/banking-*:
 *   - the engine refuses before any fetch when the adapter is unavailable,
 *   - the cron route is CRON_SECRET-gated and dark-no-ops (204) BEFORE telemetry,
 *   - token refresh + handle resolution refuse without credentials,
 *   - no secret is ever logged,
 *   - the dedupe migration is additive (a plain unique index; writes nothing).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const ENGINE = "server/services/bank-sync.ts";
const CRON = "app/api/cron/bank-sync/route.ts";
const OAUTH = "lib/integrations/banking/oauth.ts";
const ADAPTER_TL = "lib/integrations/banking/adapters/truelayer.ts";
const MIG = "supabase/migrations/20261109000000_bank_statement_lines_provider_tx.sql";

describe("bank-sync engine — refuse-before-fetch + org-pinned writes", () => {
  const code = codeOf(read(ENGINE));

  it("refuses before fetch: the availability guard precedes fetchStatements", () => {
    const guardIdx = code.indexOf("adapter.isAvailable()");
    const fetchIdx = code.indexOf("adapter.fetchStatements(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(code).toMatch(/outcome:\s*"skipped_dark"/);
  });

  it("runBankSync no-ops without touching the DB when no provider is ready", () => {
    // The readiness gate returns BEFORE listConnected is ever called.
    const readyIdx = code.indexOf("bankingProviderReady(provider)");
    const listIdx = code.indexOf("gateway.listConnected(");
    expect(readyIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeLessThan(listIdx);
    expect(code).toMatch(/return \{ ran: false/);
  });

  it("reads token columns ONLY under the service-role admin client", () => {
    expect(code).toMatch(/createAdminClient\(\)/);
    // The token columns are read (service-role), never exposed to a tenant JWT.
    expect(code).toMatch(/access_token, refresh_token, token_expires_at/);
  });

  it("does a reactive refresh + single retry on unauthorized", () => {
    expect(code).toMatch(/reason === "unauthorized"/);
    expect(code).toMatch(/refreshAndPersist\(/);
  });

  it("FAIR ORDERING (C70): listConnected orders by last_sync_at nulls-first, NOT org_id", () => {
    // A pass has a wall-clock budget and clears only tens of orgs; a tick-stable
    // org_id order re-serviced the same head every tick while the tail was never
    // reached. Ordering by the success-only cursor (last_sync_at ASC, nulls-first)
    // pushes each just-synced org to the back so the tail leads the next pass.
    expect(code).toMatch(
      /\.order\(\s*"last_sync_at",\s*\{\s*ascending:\s*true,\s*nullsFirst:\s*true\s*\}\s*\)/,
    );
    // A deterministic tiebreak on the unique org_id follows (paginate contract), but
    // org_id must NOT be the PRIMARY sort any more.
    const primary = code.indexOf('.order("last_sync_at"');
    const orgIdOrder = code.indexOf('.order("org_id"');
    expect(primary).toBeGreaterThan(-1);
    expect(primary).toBeLessThan(orgIdOrder); // last_sync_at is primary, org_id is the tiebreak
  });

  it("PASS BUDGET (C70): runBankSync bounds the pass by a wall-clock budget and breaks", () => {
    // Without a budget the cron's maxDuration=60 kills the loop mid-pass, self-
    // stranding the tail. The loop must stop CLEANLY before starting an org it
    // cannot finish, leaving the rest for the next (fairly-ordered) pass.
    expect(code).toMatch(/PASS_BUDGET_MS/);
    expect(code).toMatch(/PER_ORG_BUDGET_MS/);
    // The break decision is a wall-clock check inside the per-org loop.
    expect(code).toMatch(/perOrgBudgetMs\s*>\s*passBudgetMs\)\s*break/);
  });

  it("logs NO secret", () => {
    const logs = code.match(/console\.\w+\([^;]*\)/g) ?? [];
    for (const call of logs) {
      expect(call).not.toMatch(/access_?token/i);
      expect(call).not.toMatch(/refresh_?token/i);
      expect(call).not.toMatch(/client_?secret/i);
    }
  });
});

describe("bank-sync cron — gated + dark 204 before telemetry", () => {
  const code = codeOf(read(CRON));

  it("is CRON_SECRET-gated (401 otherwise)", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
  });

  it("dark no-ops with a 204 BEFORE withCronTelemetry (zero DB access)", () => {
    const readyIdx = code.indexOf("bankingProviderReady(");
    const telemetryIdx = code.indexOf("withCronTelemetry(");
    const noopIdx = code.indexOf("status: 204");
    expect(readyIdx).toBeGreaterThan(-1);
    expect(telemetryIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeLessThan(telemetryIdx);
    expect(noopIdx).toBeLessThan(telemetryIdx);
  });
});

describe("oauth refresh + handle resolution refuse without credentials", () => {
  const code = codeOf(read(OAUTH));

  it("refreshAccessToken refuses (not_configured) without the connectable guard", () => {
    expect(code).toMatch(/grant_type:\s*"refresh_token"/);
    // The refresh path checks connectability and returns not_configured when dark.
    const fnIdx = code.indexOf("export async function refreshAccessToken");
    const guardIdx = code.indexOf("isBankingProviderConnectable(provider)", fnIdx);
    const grantIdx = code.indexOf('grant_type: "refresh_token"', fnIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(grantIdx);
  });

  it("resolveConnectionHandle refuses (all-null, no fetch) when not connectable", () => {
    const fnIdx = code.indexOf("export async function resolveConnectionHandle");
    const guardIdx = code.indexOf("isBankingProviderConnectable(provider)", fnIdx);
    const fetchIdx = code.indexOf("fetch(", fnIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });
});

describe("TrueLayer adapter — every fetch after the guard; 401 → unauthorized", () => {
  const code = codeOf(read(ADAPTER_TL));
  it("the FIRST fetch is after the isAvailable guard, and 401/403 map to unauthorized", () => {
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(code).toMatch(/status === 401 \|\| status === 403/);
    expect(code).toMatch(/reason:\s*"unauthorized"/);
  });
});

describe("dedupe migration 20261109 — additive, writes nothing", () => {
  const sql = sqlOnly(read(MIG));
  it("adds a nullable provider_tx_id column (CSV rows keep NULL)", () => {
    expect(sql).toMatch(/add column if not exists provider_tx_id text/i);
  });
  it("creates a PLAIN unique index on (org_id, provider_tx_id)", () => {
    // MUST be plain, not partial: the sync engine upserts with
    // `ON CONFLICT (org_id, provider_tx_id) DO NOTHING`, which Postgres cannot
    // infer against a partial index (that raises 42P10). NULLs-distinct keeps
    // CSV rows (provider_tx_id NULL) unaffected. See the runtime proof in
    // __tests__/integration/banking/bank-sync-dedupe.test.ts.
    expect(sql).toMatch(
      /create unique index if not exists\s+bank_statement_lines_org_provider_tx_uniq[\s\S]*\(org_id, provider_tx_id\)/i,
    );
    // No partial predicate — a WHERE would make it un-inferrable by ON CONFLICT.
    const idxIdx = sql.indexOf("create unique index");
    const idxStmt = sql.slice(idxIdx);
    expect(idxStmt).not.toMatch(/where\s+provider_tx_id\s+is\s+not\s+null/i);
  });
  it("writes no data (no insert/update)", () => {
    expect(sql).not.toMatch(/insert\s+into/i);
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
  });
});
