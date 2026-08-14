import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  exchangeCodeForTokens,
  isHmrcConnectable,
  isHmrcFlow,
  type HmrcFlow,
} from "@/lib/integrations/hmrc/oauth";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";

/**
 * HMRC MTD OAuth — CONNECT callback. DARK.
 *
 * HMRC redirects here with `?code=&state=`. This route:
 *   1. gates the caller (authenticated + org + admin),
 *   2. verifies the `state` echoed back matches the httpOnly cookie the connect
 *      route set (anti-CSRF, constant-time),
 *   3. exchanges the code for tokens — ONLY when HMRC is connectable — and
 *      upserts the connection row with the tokens ENCRYPTED before write.
 *
 * DARK INVARIANT. `isHmrcConnectable()` is false today (no client credentials,
 * NEXT_PUBLIC_FEATURE_HMRC_CONNECT off — two-switch), so this route
 * short-circuits with a 503 BEFORE `exchangeCodeForTokens` is ever called — no
 * `fetch`, no token, no `connected` row is written. The exchange (the only
 * network call) is structurally unreachable dark.
 *
 * LEGAL BOUNDARY. Even on the live path this only STORES tokens; it never
 * submits a return. Filing requires HMRC vendor recognition (a legal gate) and
 * the substrate stops at "prepared/held" (hmrc_submissions has no filed state).
 *
 * Tokens, once live, are AES-256-GCM encrypted application-side before they reach
 * the DB (see token-crypto.ts + the 20261099 migration). This build writes none.
 * No secret is ever logged.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Constant-time comparison of the echoed `state` against the cookie. A length
 * check first (timingSafeEqual throws on unequal lengths), then the timing-safe
 * compare — never a bare `===`/`!==` string compare on a security token.
 */
function stateMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const STATE_COOKIE = (f: string) => `hmrc_oauth_state_${f}`;
const VERIFIER_COOKIE = (f: string) => `hmrc_oauth_verifier_${f}`;
const VRN_COOKIE = (f: string) => `hmrc_oauth_vrn_${f}`;

/** Trim a VAT number to a non-empty handle, or null when truly absent. */
function normaliseVat(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Clear the single-use PKCE/state/VRN cookies on the callback response so a
 * consumed state+verifier pair cannot be replayed within the 600s cookie window.
 */
function clearOAuthCookies(res: NextResponse, flow: string): void {
  const expire = { path: "/", maxAge: 0 } as const;
  res.cookies.set(STATE_COOKIE(flow), "", expire);
  res.cookies.set(VERIFIER_COOKIE(flow), "", expire);
  res.cookies.set(VRN_COOKIE(flow), "", expire);
}

function backToSettings(origin: string, status: string, flow: string): NextResponse {
  const u = new URL(`${origin}/settings/integrations`);
  u.searchParams.set("hmrc", status);
  const res = NextResponse.redirect(u);
  clearOAuthCookies(res, flow);
  return res;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flow: string }> },
) {
  const { flow: flowRaw } = await params;
  if (!isHmrcFlow(flowRaw)) {
    return NextResponse.json({ ok: false, error: "unknown_flow" }, { status: 404 });
  }
  const flow: HmrcFlow = flowRaw;
  const { origin, searchParams } = new URL(request.url);

  // Auth + org + admin gate — a callback still writes tenant state.
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // DARK SHORT-CIRCUIT. Not connectable → do NOT exchange anything. The token
  // exchange below is structurally unreachable without HMRC client credentials +
  // the feature flag.
  if (!isHmrcConnectable()) {
    return NextResponse.json(
      {
        ok: false,
        flow,
        status: "not_configured",
        message: "HMRC is not configured; the connection was not completed.",
      },
      { status: 503 },
    );
  }

  // TOKEN-ENCRYPTION TRIPWIRE. A connectable HMRC MUST have a valid token
  // encryption key, or we REFUSE the exchange and write NOTHING. Enforces "no
  // plaintext token is ever written" in code: the encrypt-before-write below
  // would throw without a key, so we fail loudly here — before any exchange.
  if (!isTokenEncryptionConfigured()) {
    console.error("[hmrc] refusing exchange: token encryption key missing", { flow });
    return NextResponse.json(
      {
        ok: false,
        flow,
        status: "encryption_not_configured",
        message:
          "HMRC cannot be connected: INTEGRATION_TOKEN_ENCRYPTION_KEY is not set. " +
          "No token was requested or stored.",
      },
      { status: 500 },
    );
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Anti-CSRF: constant-time compare of the echoed state against the cookie.
  const stateCookie = request.cookies.get(STATE_COOKIE(flow))?.value ?? null;
  const verifier = request.cookies.get(VERIFIER_COOKIE(flow))?.value ?? null;
  if (!code || !state || !stateCookie || !verifier || !stateMatches(state, stateCookie)) {
    return backToSettings(origin, "state_mismatch", flow);
  }

  const redirectUri = `${origin}/api/integrations/hmrc/${flow}/callback`;
  const exchanged = await exchangeCodeForTokens({ flow, code, codeVerifier: verifier, redirectUri });

  if (!exchanged.ok) {
    return backToSettings(origin, "error", flow);
  }

  // Resolve the VRN. HMRC's OAuth callback returns ONLY code+state — never a VRN —
  // so we take the handle the connect route stashed (httpOnly cookie), falling
  // back to a fresh authed re-read of organizations.vat_number for the active org.
  // Only `no_vrn` when the org TRULY has no VAT number (the DB CHECK forbids a
  // `connected` row without one). The connect route precondition-checks this too,
  // so a real flow only reaches here with a VRN.
  const supabase = await createClient();
  let vrn = normaliseVat(request.cookies.get(VRN_COOKIE(flow))?.value ?? null);
  if (!vrn) {
    const { data: orgRow, error: orgErr } = await supabase
      .from("organizations")
      .select("vat_number" as never)
      .eq("id", ctx.org.id)
      .maybeSingle();
    if (orgErr) {
      return backToSettings(origin, "error", flow);
    }
    vrn = normaliseVat((orgRow as { vat_number?: unknown } | null)?.vat_number);
  }
  if (!vrn) {
    // The org has no VAT number at all — refuse rather than write an invalid row.
    return backToSettings(origin, "no_vrn", flow);
  }

  const refreshToken = exchanged.tokens.refreshToken;
  // hmrc_connections post-dates the generated types.ts; cast to a minimal upsert
  // builder. RLS (admin-write) is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("hmrc_connections").upsert(
    {
      org_id: ctx.org.id,
      provider: "hmrc",
      status: "connected",
      hmrc_vrn: vrn,
      // Tokens are AES-256-GCM encrypted application-side BEFORE they reach the
      // DB — the columns hold ciphertext, never a plaintext secret. The tripwire
      // above guarantees a key is present, so encryptToken cannot throw here.
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
    console.error("[hmrc] connection upsert failed", { flow, message: error.message });
    return backToSettings(origin, "error", flow);
  }

  return backToSettings(origin, "connected", flow);
}
