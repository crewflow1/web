import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Accounting OAuth CALLBACK — REBIND resets the push-once ledger (c29).
 *
 * THE BUG. The callback upserts accounting_connections onConflict (org, provider)
 * and overwrites external_tenant_id with NO old-vs-new comparison. So connecting
 * a DIFFERENT external tenant straight over the top of an existing connection
 * (a reconnect that skipped an explicit disconnect) left the OLD account's
 * push-once high-water-mark (accounting_pushed_entities) in place. Every id
 * already pushed to tenant A stayed excluded from the export to the (empty)
 * tenant B — a silent under-export.
 *
 * THE FIX, proven here: before persisting the new connection the route reads the
 * previously stored handle and, when it DIFFERS from the newly resolved one,
 * resets the ledger for (org, provider) so the fresh tenant re-pushes all history.
 * An unchanged handle (a plain token refresh / re-consent to the SAME account)
 * and a first-ever connect both reset NOTHING.
 *
 * Hermetic: no live provider HTTP (the OAuth module is a fake), no real Supabase
 * (the client is an in-memory fake). The DARK invariant is untouched — this test
 * FORCES the connectable path via a mock purely to exercise the rebind branch;
 * production stays dark (isProviderConnectable is false without credentials).
 */

const h = vi.hoisted(() => {
  const state = {
    existing: null as { external_tenant_id: string | null; realm_id: string | null } | null,
    newHandle: "tenant-NEW",
    deletes: [] as Array<Array<[string, unknown]>>,
    upserts: [] as Array<{ row: Record<string, unknown>; onConflict: string }>,
  };

  function makeBuilder(table: string) {
    let op: "select" | "delete" | "upsert" = "select";
    const filters: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {
      select() {
        op = "select";
        return builder;
      },
      upsert(row: unknown, opts: { onConflict: string }) {
        op = "upsert";
        if (table === "accounting_connections") {
          state.upserts.push({ row: row as Record<string, unknown>, onConflict: opts.onConflict });
        }
        return Promise.resolve({ error: null });
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return builder;
      },
      maybeSingle() {
        if (table === "accounting_connections" && op === "select") {
          return Promise.resolve({ data: state.existing, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: (v: { error: null }) => unknown, onR?: () => unknown) {
        if (op === "delete" && table === "accounting_pushed_entities") {
          state.deletes.push([...filters]);
        }
        return Promise.resolve({ error: null }).then(onF, onR);
      },
    };
    return builder;
  }

  const fakeClient = { from: (t: string) => makeBuilder(t) };
  return { state, fakeClient };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.fakeClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.fakeClient }));
vi.mock("@/lib/integrations/token-crypto", () => ({
  encryptToken: (v: string) => v,
  isTokenEncryptionConfigured: () => true,
}));
vi.mock("@/lib/integrations/accounting/oauth", () => ({
  isProviderConnectable: () => true,
  accountingRedirectUri: () => "https://crewflow.uk/api/integrations/accounting/xero/callback",
  exchangeCodeForTokens: async () => ({
    ok: true,
    tokens: {
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt: "2099-01-01T00:00:00Z",
      externalTenantId: h.state.newHandle,
      realmId: null,
    },
  }),
  resolveXeroTenantId: async () => ({ ok: true, tenantId: h.state.newHandle }),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { membership: { role: "owner" }, org: { id: "org-A" } },
    user: { id: "user-1" },
  }),
}));

const { GET } = await import(
  "@/app/api/integrations/accounting/[provider]/callback/route"
);

const STATE = "st-123";

function makeReq(provider: string): NextRequest {
  const url = `https://crewflow.uk/api/integrations/accounting/${provider}/callback?code=c1&state=${STATE}`;
  return new NextRequest(url, {
    headers: {
      cookie: `acct_oauth_state_${provider}=${STATE}; acct_oauth_verifier_${provider}=verifier-1`,
    },
  });
}

const params = (provider: string) => Promise.resolve({ provider });

beforeEach(() => {
  h.state.existing = null;
  h.state.newHandle = "tenant-NEW";
  h.state.deletes = [];
  h.state.upserts = [];
});

describe("accounting callback · rebind resets the push-once ledger", () => {
  it("REBIND to a DIFFERENT external tenant resets the ledger for (org, provider)", async () => {
    h.state.existing = { external_tenant_id: "tenant-OLD", realm_id: null };

    const res = await GET(makeReq("xero"), { params: params("xero") });
    // Redirected back to the connected state.
    expect(res.headers.get("location")).toContain("connect=connected");

    // The ledger was reset, org- AND provider-scoped, before the new connection.
    expect(h.state.deletes).toHaveLength(1);
    const filters = Object.fromEntries(h.state.deletes[0]!);
    expect(filters.org_id).toBe("org-A");
    expect(filters.provider).toBe("xero");
    // The new connection was still persisted with the new handle.
    expect(h.state.upserts).toHaveLength(1);
    expect(h.state.upserts[0]!.row.external_tenant_id).toBe("tenant-NEW");
  });

  it("re-consent to the SAME external tenant resets NOTHING", async () => {
    h.state.existing = { external_tenant_id: "tenant-NEW", realm_id: null };

    const res = await GET(makeReq("xero"), { params: params("xero") });
    expect(res.headers.get("location")).toContain("connect=connected");

    // No handle change → no ledger reset, but the connection is still upserted.
    expect(h.state.deletes).toHaveLength(0);
    expect(h.state.upserts).toHaveLength(1);
  });

  it("a FIRST-EVER connect (no prior handle) resets NOTHING", async () => {
    h.state.existing = null;

    const res = await GET(makeReq("xero"), { params: params("xero") });
    expect(res.headers.get("location")).toContain("connect=connected");

    expect(h.state.deletes).toHaveLength(0);
    expect(h.state.upserts).toHaveLength(1);
  });
});
