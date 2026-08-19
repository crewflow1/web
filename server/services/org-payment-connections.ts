import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  STRIPE_CONNECT_PROVIDER,
  type OnboardingConnectionRow,
} from "@/server/services/stripe-connect-onboarding";

/**
 * Org payment connections service — org-pinned reads + admin writes over the
 * org_payment_connections table (Stripe Connect binding). The onboarding
 * DECISION logic lives in stripe-connect-onboarding.ts (dependency-injected, pure);
 * this is the thin DB layer the settings page + the disconnect action use directly.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. The query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected" — reporting payments as not-connected when the read merely
 * errored is the precise lie loud reads exist to stop.
 *
 * NO SECRET COLUMNS. A Stripe connected-account id (acct_...) is a public handle,
 * not a credential (money moves via the platform Connect key + this account
 * header), so — unlike the bank / telematics / merchant substrates — there are no
 * token columns to strip. The full row is safe for a member to read.
 *
 * DARK. This service never creates an account or writes a 'connected' status —
 * that only happens after a real, gated onboarding in the connect/callback routes,
 * unreachable without the platform Connect key AND the feature flag.
 */

export type OrgPaymentConnectionState = {
  status: "disconnected" | "pending" | "connected" | "error";
  stripeAccountId: string | null;
  accountName: string | null;
  defaultCurrency: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

const SELECT_COLUMNS =
  "status, stripe_account_id, account_name, default_currency, " +
  "charges_enabled, payouts_enabled, details_submitted, " +
  "connected_at, last_synced_at, last_error";

type ConnectionRow = {
  status: string;
  stripe_account_id: string | null;
  account_name: string | null;
  default_currency: string | null;
  charges_enabled: boolean | null;
  payouts_enabled: boolean | null;
  details_submitted: boolean | null;
  connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
};

/** The disconnected default for an org with no row yet. */
function placeholder(): OrgPaymentConnectionState {
  return {
    status: "disconnected",
    stripeAccountId: null,
    accountName: null,
    defaultCurrency: "gbp",
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    connectedAt: null,
    lastSyncedAt: null,
    lastError: null,
  };
}

function toState(row: ConnectionRow): OrgPaymentConnectionState {
  return {
    status: (row.status as OrgPaymentConnectionState["status"]) ?? "disconnected",
    stripeAccountId: row.stripe_account_id,
    accountName: row.account_name,
    defaultCurrency: row.default_currency ?? "gbp",
    chargesEnabled: row.charges_enabled === true,
    payoutsEnabled: row.payouts_enabled === true,
    detailsSubmitted: row.details_submitted === true,
    connectedAt: row.connected_at,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

/**
 * The single Stripe Connect connection state for one org, defaulting to
 * disconnected when absent. Org-pinned + loud. RLS (member-read) is the real
 * authorisation for this read.
 */
export async function getOrgPaymentConnection(
  orgId: string,
): Promise<OrgPaymentConnectionState> {
  const supabase = await createClient();
  // org_payment_connections post-dates the generated types.ts; cast to a minimal
  // select builder (the accounting_connections idiom).
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: ConnectionRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("org_payment_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider", STRIPE_CONNECT_PROVIDER)
    .maybeSingle();
  if (error) throw readFailure("org payment connection: get", error);
  return data ? toState(data) : placeholder();
}

/**
 * Admin disconnect — clears the account binding + capability state and returns
 * the row to `disconnected`. The Stripe account itself is NOT deleted (Stripe
 * forbids deleting an account with a balance/history); we simply unbind it so the
 * pay-now gate closes. A later reconnect creates a fresh account. Org-pinned; the
 * admin-write RLS on org_payment_connections (20261120) is the real authority.
 */
export async function disconnectOrgPaymentConnection(
  orgId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("org_payment_connections")
    .update({
      status: "disconnected",
      stripe_account_id: null,
      account_name: null,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      connected_at: null,
      last_synced_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", STRIPE_CONNECT_PROVIDER);
  if (error) {
    console.error("[stripe-connect] disconnect failed", { message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Onboarding DB deps — the org-pinned read + writes the routes wire onto the
// (pure) onboarding orchestration. All run under the caller's JWT; the
// admin-write RLS on org_payment_connections (20261120) is the real authority.
// ---------------------------------------------------------------------------

/**
 * Load the org's connection row projected for the onboarding orchestration
 * (OnboardingConnectionRow). Org-pinned + loud. Returns null when no row exists.
 */
export async function loadOnboardingConnection(
  orgId: string,
): Promise<OnboardingConnectionRow | null> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: ConnectionRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("org_payment_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider", STRIPE_CONNECT_PROVIDER)
    .maybeSingle();
  if (error) throw readFailure("org payment connection: onboarding load", error);
  if (!data) return null;
  return {
    org_id: orgId,
    status: data.status ?? "disconnected",
    stripe_account_id: data.stripe_account_id,
    account_name: data.account_name,
    default_currency: data.default_currency ?? "gbp",
    charges_enabled: data.charges_enabled === true,
    payouts_enabled: data.payouts_enabled === true,
    details_submitted: data.details_submitted === true,
  };
}

type UpsertBuilder = {
  from: (t: string) => {
    upsert: (
      row: Record<string, unknown>,
      opts: { onConflict: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/**
 * Upsert the org's Stripe Connect binding (create/continue onboarding). Keyed on
 * (org_id, provider) — the unique constraint from 20261120 — so re-connecting
 * updates the existing row rather than duplicating. `connected_at` is only stamped
 * once the account is actually chargeable ('connected').
 */
export async function upsertOrgPaymentConnection(row: {
  orgId: string;
  connectedBy: string;
  status: string;
  stripeAccountId: string;
  accountName: string | null;
  defaultCurrency: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<void> {
  const supabase = (await createClient()) as unknown as UpsertBuilder;
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("org_payment_connections").upsert(
    {
      org_id: row.orgId,
      provider: STRIPE_CONNECT_PROVIDER,
      status: row.status,
      stripe_account_id: row.stripeAccountId,
      account_name: row.accountName,
      default_currency: row.defaultCurrency,
      charges_enabled: row.chargesEnabled,
      payouts_enabled: row.payoutsEnabled,
      details_submitted: row.detailsSubmitted,
      connected_by: row.connectedBy,
      connected_at: row.status === "connected" ? nowIso : null,
      last_synced_at: nowIso,
      last_error: null,
    },
    { onConflict: "org_id,provider" },
  );
  if (error) throw readFailure("org payment connection: upsert", error);
}

/**
 * Update the capability state + status on an EXISTING row (status refresh from
 * accounts.retrieve). Org-pinned. `connected_at` is stamped when the account
 * first becomes chargeable and left intact otherwise.
 */
export async function updateOrgPaymentStatus(row: {
  orgId: string;
  status: string;
  accountName: string | null;
  defaultCurrency: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  lastError: string | null;
}): Promise<void> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (r: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: row.status,
    account_name: row.accountName,
    default_currency: row.defaultCurrency,
    charges_enabled: row.chargesEnabled,
    payouts_enabled: row.payoutsEnabled,
    details_submitted: row.detailsSubmitted,
    last_synced_at: nowIso,
    last_error: row.lastError,
  };
  // Stamp connected_at the moment an account first becomes chargeable.
  if (row.status === "connected") patch.connected_at = nowIso;
  const { error } = await loose
    .from("org_payment_connections")
    .update(patch)
    .eq("org_id", row.orgId)
    .eq("provider", STRIPE_CONNECT_PROVIDER);
  if (error) throw readFailure("org payment connection: status update", error);
}
