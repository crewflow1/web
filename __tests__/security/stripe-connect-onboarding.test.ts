import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  beginStripeConnectOnboarding,
  refreshStripeConnectStatus,
  statusForAccount,
  accountBelongsToOrg,
  type BeginOnboardingDeps,
  type RefreshStatusDeps,
  type OnboardingConnectionRow,
  type StripeAccountShape,
} from "@/server/services/stripe-connect-onboarding";

/**
 * MP W2 — tenant Stripe Connect ONBOARDING trust-boundary proofs.
 *
 * Section 1: the flow is DARK. With portal payments unconfigured,
 * beginStripeConnectOnboarding + refreshStripeConnectStatus REFUSE before any
 * Stripe call or DB write.
 *
 * Section 2: onboarding creates + persists a connection (new Express account →
 * 'pending', hosted link minted), reuses an already-bound account (continue
 * onboarding — no second account), and is org-pinned.
 *
 * Section 3: status refresh maps Stripe's OWN capability flags onto the connection
 * status — charges_enabled → 'connected', else 'pending' — and persists a Stripe
 * failure as 'error' rather than leaving a stale 'connected'.
 *
 * Section 4: the migration (20261181) — additive capability columns, 'pending'
 * admitted, the connected-needs-account CHECK preserved, and it writes nothing.
 *
 * Section 5: the routes + service are wired to the dark gate + org-pinning.
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

const MIG_NEW = "supabase/migrations/20261181000000_stripe_connect_onboarding.sql";
const MIG_BASE = "supabase/migrations/20261120000000_portal_invoice_payments.sql";
const CONNECT_ROUTE = "app/api/integrations/stripe-connect/connect/route.ts";
const CALLBACK_ROUTE = "app/api/integrations/stripe-connect/callback/route.ts";
const REFRESH_ROUTE = "app/api/integrations/stripe-connect/refresh/route.ts";
const SERVICE = "server/services/org-payment-connections.ts";
const ADAPTER = "lib/payments/stripe-connect.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function accountShape(over: Partial<StripeAccountShape> = {}): StripeAccountShape {
  return {
    id: "acct_TEST",
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    default_currency: "gbp",
    business_profile: { name: "Acme Ltd" },
    // Every account the platform creates is stamped with its org (createAccount).
    metadata: { crewflow_org_id: "o1" },
    ...over,
  };
}

function connectionRow(over: Partial<OnboardingConnectionRow> = {}): OnboardingConnectionRow {
  return {
    org_id: "o1",
    status: "pending",
    stripe_account_id: "acct_EXISTING",
    account_name: "Acme Ltd",
    default_currency: "gbp",
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    ...over,
  };
}

const beginInput = {
  orgId: "o1",
  userId: "u1",
  businessName: "Acme Ltd",
  email: "admin@acme.test",
  country: "GB",
  appOrigin: "https://app.example",
};

// ---------------------------------------------------------------------------
// 1. DARK — refuse before any Stripe call / DB write
// ---------------------------------------------------------------------------

describe("onboarding is DARK without the two-switch gate", () => {
  it("beginStripeConnectOnboarding refuses (feature_disabled), touching NOTHING", async () => {
    let stripeCalled = false;
    let connectionLoaded = false;
    let upserted = false;
    const deps: BeginOnboardingDeps = {
      isConfigured: () => false, // dark
      loadConnection: async () => {
        connectionLoaded = true;
        return null;
      },
      stripe: {
        createAccount: async () => {
          stripeCalled = true;
          throw new Error("Stripe must not be reached while dark");
        },
        createAccountLink: async () => {
          stripeCalled = true;
          throw new Error("Stripe must not be reached while dark");
        },
        retrieveAccount: async () => {
          stripeCalled = true;
          throw new Error("Stripe must not be reached while dark");
        },
      },
      upsertConnection: async () => {
        upserted = true;
      },
    };
    const res = await beginStripeConnectOnboarding(deps, beginInput);
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(stripeCalled).toBe(false);
    expect(connectionLoaded).toBe(false); // the gate is FIRST — no I/O at all
    expect(upserted).toBe(false);
  });

  it("refreshStripeConnectStatus refuses (feature_disabled) with no Stripe call", async () => {
    let retrieved = false;
    const deps: RefreshStatusDeps = {
      isConfigured: () => false,
      loadConnection: async () => connectionRow(),
      stripe: {
        retrieveAccount: async () => {
          retrieved = true;
          throw new Error("unreachable");
        },
      },
      updateStatus: async () => undefined,
    };
    const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
    expect(res).toEqual({ ok: false, reason: "feature_disabled" });
    expect(retrieved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Onboarding creates + persists, reuses an account, org-pinned
// ---------------------------------------------------------------------------

describe("beginStripeConnectOnboarding create + persist", () => {
  it("creates a NEW account, persists it as 'pending', and mints a hosted link", async () => {
    let createdArgs: { orgId: string; country: string } | null = null;
    let linkArgs: { accountId: string; returnUrl: string; refreshUrl: string } | null = null;
    let saved: { status: string; stripeAccountId: string; orgId: string } | null = null;
    const deps: BeginOnboardingDeps = {
      isConfigured: () => true,
      loadConnection: async () => null, // no account yet
      stripe: {
        createAccount: async (a) => {
          createdArgs = { orgId: a.orgId, country: a.country };
          return accountShape({ id: "acct_NEW", charges_enabled: false });
        },
        createAccountLink: async (a) => {
          linkArgs = a;
          return { url: "https://connect.stripe.com/setup/acct_NEW" };
        },
        retrieveAccount: async () => {
          throw new Error("a brand-new account needs no ownership re-read");
        },
      },
      upsertConnection: async (r) => {
        saved = { status: r.status, stripeAccountId: r.stripeAccountId, orgId: r.orgId };
      },
    };
    const res = await beginStripeConnectOnboarding(deps, beginInput);
    expect(res).toMatchObject({ ok: true, accountId: "acct_NEW", created: true });
    if (res.ok) expect(res.url).toBe("https://connect.stripe.com/setup/acct_NEW");
    // Persisted BEFORE the redirect, org-pinned, and NOT yet chargeable → pending.
    expect(saved!.orgId).toBe("o1");
    expect(saved!.stripeAccountId).toBe("acct_NEW");
    expect(saved!.status).toBe("pending");
    expect(createdArgs!.orgId).toBe("o1");
    expect(createdArgs!.country).toBe("GB");
    // The return/refresh URLs point back at OUR callback/refresh routes.
    expect(linkArgs!.accountId).toBe("acct_NEW");
    expect(linkArgs!.returnUrl).toBe(
      "https://app.example/api/integrations/stripe-connect/callback",
    );
    expect(linkArgs!.refreshUrl).toBe(
      "https://app.example/api/integrations/stripe-connect/refresh",
    );
  });

  it("REUSES an already-bound account (continue onboarding — no second account)", async () => {
    let createCalls = 0;
    const deps: BeginOnboardingDeps = {
      isConfigured: () => true,
      loadConnection: async () => connectionRow({ stripe_account_id: "acct_EXISTING" }),
      stripe: {
        createAccount: async () => {
          createCalls += 1;
          return accountShape({ id: "acct_SHOULD_NOT" });
        },
        createAccountLink: async () => ({ url: "https://connect.stripe.com/setup/acct_EXISTING" }),
        retrieveAccount: async (id) => accountShape({ id }),
      },
      upsertConnection: async () => undefined,
    };
    const res = await beginStripeConnectOnboarding(deps, beginInput);
    expect(res).toMatchObject({ ok: true, accountId: "acct_EXISTING", created: false });
    expect(createCalls).toBe(0); // no new account minted
  });

  it("maps a Stripe failure to stripe_error without throwing", async () => {
    const deps: BeginOnboardingDeps = {
      isConfigured: () => true,
      loadConnection: async () => null,
      stripe: {
        createAccount: async () => {
          throw new Error("stripe boom");
        },
        createAccountLink: async () => ({ url: "x" }),
        retrieveAccount: async (id) => accountShape({ id }),
      },
      upsertConnection: async () => undefined,
    };
    const res = await beginStripeConnectOnboarding(deps, beginInput);
    expect(res).toMatchObject({ ok: false, reason: "stripe_error" });
  });
});

// ---------------------------------------------------------------------------
// 2b. OWNERSHIP — a bound account id is honoured only for an account the
// platform created for THIS org (platform metadata), never by id alone.
// ---------------------------------------------------------------------------

describe("a bound connected account must belong to the org", () => {
  for (const [label, metadata] of [
    ["another org's account", { crewflow_org_id: "o2" }],
    ["an account with no platform metadata", null],
    ["an account with an empty org stamp", { crewflow_org_id: "" }],
  ] as const) {
    it(`begin REFUSES to mint an onboarding link for ${label}`, async () => {
      let linkMinted = false;
      let upserted = false;
      let created = false;
      const deps: BeginOnboardingDeps = {
        isConfigured: () => true,
        loadConnection: async () => connectionRow({ stripe_account_id: "acct_FOREIGN" }),
        stripe: {
          createAccount: async () => {
            created = true;
            return accountShape({ id: "acct_NEW" });
          },
          createAccountLink: async () => {
            linkMinted = true;
            return { url: "https://connect.stripe.com/setup/acct_FOREIGN" };
          },
          retrieveAccount: async (id) => accountShape({ id, metadata: metadata as never }),
        },
        upsertConnection: async () => {
          upserted = true;
        },
      };
      const res = await beginStripeConnectOnboarding(deps, beginInput);
      expect(res).toEqual({ ok: false, reason: "account_not_owned" });
      expect(linkMinted).toBe(false);
      expect(upserted).toBe(false);
      expect(created).toBe(false);
    });

    it(`refresh does NOT adopt the state of ${label} and closes the pay-now gate`, async () => {
      let written: {
        status: string;
        chargesEnabled: boolean;
        payoutsEnabled: boolean;
        accountName: string | null;
        lastError: string | null;
      } | null = null;
      const deps: RefreshStatusDeps = {
        isConfigured: () => true,
        loadConnection: async () =>
          connectionRow({ stripe_account_id: "acct_FOREIGN", account_name: "Our Name" }),
        stripe: {
          retrieveAccount: async (id) =>
            accountShape({
              id,
              charges_enabled: true,
              payouts_enabled: true,
              business_profile: { name: "Someone Else Ltd" },
              metadata: metadata as never,
            }),
        },
        updateStatus: async (r) => {
          written = r;
        },
      };
      const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
      expect(res).toEqual({ ok: false, reason: "account_not_owned" });
      expect(written!.status).toBe("error");
      expect(written!.chargesEnabled).toBe(false);
      expect(written!.payoutsEnabled).toBe(false);
      expect(written!.accountName).toBe("Our Name"); // never the foreign account's name
      expect(written!.lastError).toBe("account_not_owned");
    });
  }

  it("accountBelongsToOrg matches the platform stamp exactly", () => {
    expect(accountBelongsToOrg(accountShape({ metadata: { crewflow_org_id: "o1" } }), "o1")).toBe(true);
    expect(accountBelongsToOrg(accountShape({ metadata: { crewflow_org_id: "o1" } }), "o2")).toBe(false);
    expect(accountBelongsToOrg(accountShape({ metadata: { crewflow_org_id: "o1" } }), "")).toBe(false);
    expect(accountBelongsToOrg(accountShape({ metadata: undefined }), "o1")).toBe(false);
  });

  it("the Stripe adapter carries the account's metadata into the shape", () => {
    const code = read("lib/payments/stripe-connect.ts");
    expect(code).toMatch(/metadata:\s*\{\s*crewflow_org_id:\s*orgId\s*\}/);
    expect(code).toMatch(/metadata:\s*account\.metadata\s*\?\?\s*null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Status refresh — capability → status mapping + failure handling
// ---------------------------------------------------------------------------

describe("statusForAccount ties 'connected' to charges_enabled", () => {
  it("charges_enabled → connected; otherwise pending", () => {
    expect(statusForAccount(accountShape({ charges_enabled: true }))).toBe("connected");
    expect(statusForAccount(accountShape({ charges_enabled: false }))).toBe("pending");
    expect(statusForAccount(accountShape({ charges_enabled: null }))).toBe("pending");
  });
});

describe("refreshStripeConnectStatus", () => {
  it("marks 'connected' only when Stripe reports charges_enabled", async () => {
    let written: { status: string; chargesEnabled: boolean } | null = null;
    const deps: RefreshStatusDeps = {
      isConfigured: () => true,
      loadConnection: async () => connectionRow(),
      stripe: {
        retrieveAccount: async () =>
          accountShape({ charges_enabled: true, payouts_enabled: true, details_submitted: true }),
      },
      updateStatus: async (r) => {
        written = { status: r.status, chargesEnabled: r.chargesEnabled };
      },
    };
    const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
    expect(res).toMatchObject({ ok: true, status: "connected", chargesEnabled: true });
    expect(written!.status).toBe("connected");
  });

  it("stays 'pending' when the account is not yet chargeable", async () => {
    let written: { status: string } | null = null;
    const deps: RefreshStatusDeps = {
      isConfigured: () => true,
      loadConnection: async () => connectionRow(),
      stripe: {
        retrieveAccount: async () =>
          accountShape({ charges_enabled: false, details_submitted: true }),
      },
      updateStatus: async (r) => {
        written = { status: r.status };
      },
    };
    const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
    expect(res).toMatchObject({ ok: true, status: "pending" });
    expect(written!.status).toBe("pending");
  });

  it("refuses not_connected when the org has no bound account", async () => {
    let retrieved = false;
    const deps: RefreshStatusDeps = {
      isConfigured: () => true,
      loadConnection: async () => null,
      stripe: {
        retrieveAccount: async () => {
          retrieved = true;
          throw new Error("unreachable");
        },
      },
      updateStatus: async () => undefined,
    };
    const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
    expect(res).toEqual({ ok: false, reason: "not_connected" });
    expect(retrieved).toBe(false);
  });

  it("[delete-the-fix] persists a Stripe failure as 'error' (never a stale connected)", async () => {
    let written: { status: string; lastError: string | null } | null = null;
    const deps: RefreshStatusDeps = {
      isConfigured: () => true,
      loadConnection: async () => connectionRow({ status: "connected", charges_enabled: true }),
      stripe: {
        retrieveAccount: async () => {
          throw new Error("account unavailable");
        },
      },
      updateStatus: async (r) => {
        written = { status: r.status, lastError: r.lastError };
      },
    };
    const res = await refreshStripeConnectStatus(deps, { orgId: "o1" });
    expect(res).toMatchObject({ ok: false, reason: "stripe_error" });
    // The stale 'connected' was overwritten with 'error' — the pay gate closes.
    expect(written!.status).toBe("error");
    expect(written!.lastError).toBe("account unavailable");
  });
});

// ---------------------------------------------------------------------------
// 4. Migration 20261181 — additive, 'pending', preserved CHECK, no writes
// ---------------------------------------------------------------------------

describe("migration 20261181 — additive capability columns + pending", () => {
  const sql = sqlOnly(read(MIG_NEW));
  const base = sqlOnly(read(MIG_BASE));

  it("adds the capability columns additively (IF NOT EXISTS, safe defaults)", () => {
    expect(sql).toMatch(/add column if not exists charges_enabled\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists payouts_enabled\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists details_submitted\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists last_synced_at\s+timestamptz/i);
  });

  it("admits 'pending' to the status CHECK (keeps disconnected/connected/error)", () => {
    expect(sql).toMatch(
      /add constraint org_payment_connections_status_check[\s\S]*check \(status in \('disconnected', 'pending', 'connected', 'error'\)\)/i,
    );
  });

  it("does NOT touch the connected-needs-account CHECK (still enforced from 20261120)", () => {
    // The base migration owns it; the new one must not drop/redefine it.
    expect(base).toMatch(/org_payment_connections_connected_needs_account/i);
    expect(sql).not.toMatch(/drop constraint org_payment_connections_connected_needs_account/i);
  });

  it("writes NOTHING (no seeded rows — dark by default)", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.org_payment_connections/i);
    expect(sql).not.toMatch(/update\s+public\.org_payment_connections\s+set/i);
  });

  it("does not edit the existing 20261120 migration's tables/policies", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Routes + service — dark-gated, org-pinned, admin-gated
// ---------------------------------------------------------------------------

describe("routes + service wiring", () => {
  it("connect route gates on config BEFORE the Stripe ops (dark → 503)", () => {
    const code = codeOf(read(CONNECT_ROUTE));
    expect(code).toMatch(/isConfigured:\s*\(\)\s*=>\s*isPortalPaymentsConfigured\(\)/);
    expect(code).toMatch(/feature_disabled/);
    expect(code).toMatch(/status:\s*503/);
    // Admin gate present.
    expect(code).toMatch(/isAdminRole\(ctx\.membership\.role\)/);
  });

  it("callback route RE-READS the account (never trusts a query param for completion)", () => {
    const code = codeOf(read(CALLBACK_ROUTE));
    expect(code).toMatch(/refreshStripeConnectStatus\(/);
    expect(code).toMatch(/retrieveAccount/);
    expect(code).toMatch(/isPortalPaymentsConfigured\(\)/);
  });

  it("refresh route re-mints a link via the same onboarding orchestration", () => {
    const code = codeOf(read(REFRESH_ROUTE));
    expect(code).toMatch(/beginStripeConnectOnboarding\(/);
    expect(code).toMatch(/isPortalPaymentsConfigured\(\)/);
  });

  it("service reads/writes are org-pinned AND provider-pinned", () => {
    const code = codeOf(read(SERVICE));
    // Every table access filters by org_id and the stripe provider.
    expect(code).toMatch(/\.eq\("org_id", orgId\)[\s\S]*?\.eq\("provider", STRIPE_CONNECT_PROVIDER\)/);
    // Disconnect clears the binding + capability state (pay gate closes).
    expect(code).toMatch(/status:\s*"disconnected"/);
    expect(code).toMatch(/stripe_account_id:\s*null/);
    expect(code).toMatch(/charges_enabled:\s*false/);
  });

  it("the adapter never reaches for the SaaS-billing key + throws if unconfigured", () => {
    const code = codeOf(read(ADAPTER));
    expect(code).toMatch(/getInvoiceStripe\(\)/);
    expect(code).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(code).toMatch(/is not configured/);
    // Express connected accounts requesting card_payments (direct charges).
    expect(code).toMatch(/type:\s*"express"/);
    expect(code).toMatch(/account_onboarding/);
  });
});
