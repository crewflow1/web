import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  exchangeCodeForTokens,
  isProviderConnectable,
  resolveXeroTenantId,
  resolveSageBusinessId,
  accountingRedirectUri,
} from "@/lib/integrations/accounting/oauth";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";
import type { AccountingProvider } from "@/lib/integrations/accounting/adapters";
import { resetPushedLedger } from "@/server/services/accounting-connections";

/**
 * Accounting OAuth — CONNECT callback. DARK.
 *
 * The provider redirects here with `?code=&state=`. This route:
 *   1. gates the caller (authenticated + org + admin),
 *   2. verifies the `state` echoed back matches the httpOnly cookie the connect
 *      route set (anti-CSRF),
 *   3. exchanges the code for tokens — ONLY when the provider is connectable —
 *      and upserts the connection row.
 *
 * DARK INVARIANT. `isProviderConnectable` is false today (no client credentials,
 * FEATURE_ACCOUNTING_CONNECT off), so this route short-circuits BEFORE
 * `exchangeCodeForTokens` is ever called — no `fetch`, no token, no `connected`
 * row is written. The exchange (the only network call) is structurally
 * unreachable dark. Tokens, once live, are encrypted application-side before
 * they reach the DB (see the migration's "TOKENS AT REST" note); this build
 * writes none. No secret is ever logged.
 */

const VALID: readonly AccountingProvider[] = ["xero", "quickbooks", "sage"];

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Constant-time comparison of the echoed `state` against the cookie. A length
 * check first (timingSafeEqual throws on unequal lengths), then the timing-safe
 * compare — a mismatch leaks no timing signal. Mirrors the webhook-signature
 * idiom; never a bare `===`/`!==` string compare on a security token.
 */
function stateMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const STATE_COOKIE = (p: string) => `acct_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `acct_oauth_verifier_${p}`;

/**
 * Clear the single-use PKCE/state cookies on the callback response. Once a
 * callback has consumed a state+verifier pair it must not be replayable within
 * the 600s cookie window, so both are expired (maxAge 0, matching the path they
 * were set with) on every response that leaves this route after the dark guard.
 */
function clearOAuthCookies(res: NextResponse, provider: string): void {
  const expire = { path: "/", maxAge: 0 } as const;
  res.cookies.set(STATE_COOKIE(provider), "", expire);
  res.cookies.set(VERIFIER_COOKIE(provider), "", expire);
}

function backToReports(origin: string, status: string, provider: string): NextResponse {
  // The connect surface is /reports (which renders AccountingConnectionsPanel and
  // reads ?connect= to show the outcome banner). /reports/accounting is NOT a
  // routable page — only panel/action components live there — so redirecting the
  // OAuth return there dead-ended on a 404 after an otherwise-successful connect.
  const u = new URL(`${origin}/reports`);
  u.searchParams.set("connect", status);
  const res = NextResponse.redirect(u);
  clearOAuthCookies(res, provider);
  return res;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as AccountingProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as AccountingProvider;
  const { origin, searchParams } = new URL(request.url);

  // Auth + org + admin gate — a callback still writes tenant state, so it is
  // gated exactly like the initiation.
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  // DARK SHORT-CIRCUIT. Not connectable → do NOT exchange anything. This is the
  // structural guarantee: the token exchange below is unreachable without
  // provider client credentials + the feature flag.
  if (!isProviderConnectable(provider)) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "not_configured",
        message: `${provider} is not configured; the connection was not completed.`,
      },
      { status: 200 },
    );
  }

  // TOKEN-ENCRYPTION TRIPWIRE. A connectable provider MUST have a valid token
  // encryption key, or we REFUSE the exchange and write NOTHING. This enforces
  // "no plaintext token is ever written" in code: the encrypt-before-write below
  // would throw without a key, so we fail loudly here — before any token
  // exchange — rather than mid-write. Dark today (no creds ⇒ never connectable),
  // so this never triggers; on activation it forces the key to be set.
  if (!isTokenEncryptionConfigured()) {
    console.error("[accounting] refusing exchange: token encryption key missing", { provider });
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "encryption_not_configured",
        message:
          `${provider} cannot be connected: INTEGRATION_TOKEN_ENCRYPTION_KEY is ` +
          `not set. No token was requested or stored.`,
      },
      { status: 500 },
    );
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const realmId = searchParams.get("realmId"); // QuickBooks carries it here.

  // Anti-CSRF: the state echoed back must match the cookie the connect route set
  // (constant-time compare — never a bare string `!==` on a security token).
  const stateCookie = request.cookies.get(STATE_COOKIE(provider))?.value ?? null;
  const verifier = request.cookies.get(VERIFIER_COOKIE(provider))?.value ?? null;
  if (!code || !state || !stateCookie || !verifier || !stateMatches(state, stateCookie)) {
    return backToReports(origin, "state_mismatch", provider);
  }

  // Must match the connect route's redirect_uri exactly (OAuth requirement);
  // both derive it from the same helper — pinned when ACCOUNTING_REDIRECT_URI is
  // set, else the request origin.
  const redirectUri = accountingRedirectUri(provider, origin);
  const exchanged = await exchangeCodeForTokens({
    provider,
    code,
    codeVerifier: verifier,
    redirectUri,
    realmId,
  });

  if (!exchanged.ok) {
    return backToReports(origin, "error", provider);
  }

  // Xero's / Sage's code exchange returns tokens but NOT the account to act on —
  // resolve it via a follow-up call (Xero GET /connections → tenant; Sage GET
  // /businesses → business id) so the connection completes with a real account
  // handle (no more `no_account` dead-end). Both store the handle in
  // external_tenant_id and send it as their scoping header (Xero-tenant-id /
  // X-Business). QuickBooks carries its realm id on the callback query, so it
  // needs no follow-up. Every follow-up call is after the connectable guard, so
  // it is unreachable dark.
  let externalTenantId = exchanged.tokens.externalTenantId;
  if (provider === "xero" && !externalTenantId) {
    const resolved = await resolveXeroTenantId(exchanged.tokens.accessToken);
    if (!resolved.ok) {
      return backToReports(origin, "no_account", provider);
    }
    externalTenantId = resolved.tenantId;
  } else if (provider === "sage" && !externalTenantId) {
    const resolved = await resolveSageBusinessId(exchanged.tokens.accessToken);
    if (!resolved.ok) {
      return backToReports(origin, "no_account", provider);
    }
    externalTenantId = resolved.tenantId;
  }

  const handle = externalTenantId ?? exchanged.tokens.realmId;
  if (!handle) {
    // The DB CHECK forbids a connected row without an account handle; refuse
    // rather than write an invalid row.
    return backToReports(origin, "no_account", provider);
  }

  const refreshToken = exchanged.tokens.refreshToken;
  const supabase = await createClient();

  // REBIND GUARD. If this org was already connected to a DIFFERENT external
  // account under this provider (a reconnect that skipped an explicit
  // disconnect), the push-once ledger still holds the OLD account's
  // high-water-mark. Left in place, the new (empty) account would have every id
  // excluded from its export — the operator sees "already up to date" while the
  // new company's books never receive any history. Read the previously stored
  // handle (non-token columns, member-readable) and, when it DIFFERS from the
  // newly resolved one, reset the ledger BEFORE persisting the new connection so
  // the fresh tenant re-pushes all history. (An explicit disconnect resets it
  // too; this covers the connect-straight-over-the-top path.)
  const prev = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: { external_tenant_id: string | null; realm_id: string | null } | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data: existing, error: existingError } = await prev
    .from("accounting_connections")
    .select("external_tenant_id, realm_id")
    .eq("org_id", ctx.org.id)
    .eq("provider", provider)
    .maybeSingle();
  // LOUD. A failed read here must NOT be treated as "no prior handle" — that
  // would skip a needed ledger reset and silently under-export to the new tenant.
  // Surface the error instead of proceeding on a false negative.
  if (existingError) {
    throw readFailure("accounting connections: rebind handle", existingError);
  }
  const previousHandle = existing?.external_tenant_id ?? existing?.realm_id ?? null;
  if (previousHandle && previousHandle !== handle) {
    const reset = await resetPushedLedger(supabase, ctx.org.id, provider);
    // Refuse rather than connect over a stale ledger — a fresh account MUST start
    // from an empty high-water-mark or it silently under-exports.
    if (!reset.ok) {
      return backToReports(origin, "error", provider);
    }
  }

  // accounting_connections post-dates the generated types.ts; cast to a minimal
  // upsert builder. RLS (admin-write) is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("accounting_connections").upsert(
    {
      org_id: ctx.org.id,
      provider,
      status: "connected",
      external_tenant_id: externalTenantId,
      realm_id: exchanged.tokens.realmId,
      // Tokens are AES-256-GCM encrypted application-side BEFORE they reach the
      // DB — the columns hold ciphertext, never a plaintext secret. The tripwire
      // above guarantees a key is present, so encryptToken cannot throw here.
      // token_expires_at is not a secret and is stored as-is.
      access_token: encryptToken(exchanged.tokens.accessToken),
      refresh_token: refreshToken === null ? null : encryptToken(refreshToken),
      token_expires_at: exchanged.tokens.expiresAt,
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "org_id,provider" },
  );
  if (error) {
    // Never log the token payload — only a coarse failure signal.
    console.error("[accounting] connection upsert failed", { provider, message: error.message });
    return backToReports(origin, "error", provider);
  }

  return backToReports(origin, "connected", provider);
}
