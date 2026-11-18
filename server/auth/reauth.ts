import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * RE-AUTHENTICATION for irreversible actions (account / company deletion,
 * staff erasure).
 *
 * A valid session is not enough to destroy data: a session can be hours old, on
 * a shared or unattended machine, or riding a cross-site request. Before any
 * deletion is recorded the caller must prove — server-side, now — that the
 * person at the keyboard is the account holder. Exactly one of two proofs is
 * accepted:
 *
 *   1. PASSWORD. If a password is supplied it is verified against Supabase Auth
 *      with a throw-away, non-persisting client (it never touches the request's
 *      cookies, and the session it creates is discarded at once). A WRONG
 *      password is a refusal — it never falls through to proof 2.
 *
 *   2. A JUST-ESTABLISHED SESSION. Magic-link and Google accounts have no
 *      password. For them (password left blank) the session's most recent real
 *      authentication — the newest `amr` entry of the access token — must be at
 *      most REAUTH_MAX_AGE_SECONDS old. In practice: sign out, sign back in,
 *      and delete within ten minutes. Token refreshes do not count.
 *
 * The access token is read from the request's own cookie session. It is only
 * trusted because the caller has ALREADY validated the session with Supabase
 * Auth (`requireUser` / `requireOrgContext` → `auth.getUser()`), and the user id
 * inside the token is checked against that validated user.
 */

/** A session older than this cannot authorise a deletion without a password. */
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;

export type ReauthResult =
  | { ok: true; method: "password" | "recent_session" }
  | { ok: false; code: "password_incorrect" | "stale_session" | "unavailable"; message: string };

export const REAUTH_MESSAGES = {
  password_incorrect: "That password is not correct. Nothing was deleted.",
  stale_session:
    "For your security, confirm it is you: enter your password, or sign out, sign back in and try again within 10 minutes.",
  unavailable: "We could not confirm your identity just now. Nothing was deleted. Please try again.",
} as const;

type AmrEntry = { method?: unknown; timestamp?: unknown };

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The newest REAL authentication time (unix seconds) recorded in an access
 * token's `amr` claim, with the token's subject. `token_refresh` entries are
 * ignored — refreshing a token is not the person proving who they are. Returns
 * null for anything malformed (which the caller treats as "not fresh").
 *
 * PURE: does not verify the signature. Callers must only pass a token that has
 * already been validated against Supabase Auth.
 */
export function newestAuthentication(accessToken: string): { sub: string; at: number } | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const amr = Array.isArray(payload.amr) ? (payload.amr as AmrEntry[]) : [];
  let newest = 0;
  for (const entry of amr) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.method === "token_refresh") continue;
    if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
      newest = Math.max(newest, entry.timestamp);
    }
  }
  if (!sub || newest <= 0) return null;
  return { sub, at: newest };
}

/** Is the token's newest real authentication within `maxAgeSeconds` of `nowSeconds`? */
export function isSessionFresh(
  accessToken: string,
  expectedUserId: string,
  nowSeconds: number,
  maxAgeSeconds: number = REAUTH_MAX_AGE_SECONDS,
): boolean {
  const newest = newestAuthentication(accessToken);
  if (!newest || newest.sub !== expectedUserId) return false;
  const age = nowSeconds - newest.at;
  // A timestamp from the future (beyond small clock skew) is not evidence of freshness.
  return age >= -60 && age <= maxAgeSeconds;
}

export type ReauthDeps = {
  /** Verify `password` for `email` WITHOUT touching the request's session. */
  verifyPassword?: (email: string, password: string) => Promise<boolean>;
  /** The current request's (already-validated) access token, or null. */
  currentAccessToken?: () => Promise<string | null>;
  now?: () => Date;
};

async function defaultVerifyPassword(email: string, password: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("reauth: Supabase is not configured");
  // A throw-away client: no cookies, nothing persisted, nothing refreshed.
  const probe = createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await probe.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  // Discard the session this check created (this client only — the user's real
  // session, held in the request cookies, is untouched).
  await probe.auth.signOut({ scope: "local" }).catch(() => undefined);
  return true;
}

async function defaultCurrentAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getSession();
  // A failed session read is NOT "no session": surface it so the caller fails
  // closed with `unavailable` rather than telling the user to sign in again.
  if (error) throw new Error(`reauth: session read failed: ${error.message}`);
  return data.session?.access_token ?? null;
}

/**
 * Prove, now, that the signed-in `user` is present. `user` MUST be the user
 * returned by `requireUser()` / `requireOrgContext()` for this request.
 */
export async function verifyReauthentication(
  params: { user: { id: string; email?: string | null }; password?: string | null },
  deps: ReauthDeps = {},
): Promise<ReauthResult> {
  const fail = (code: Exclude<ReauthResult, { ok: true }>["code"]): ReauthResult => ({
    ok: false,
    code,
    message: REAUTH_MESSAGES[code],
  });
  const password = typeof params.password === "string" ? params.password : "";

  try {
    if (password.length > 0) {
      if (!params.user.email) return fail("password_incorrect");
      const verify = deps.verifyPassword ?? defaultVerifyPassword;
      return (await verify(params.user.email, password))
        ? { ok: true, method: "password" }
        : fail("password_incorrect");
    }

    const token = await (deps.currentAccessToken ?? defaultCurrentAccessToken)();
    if (!token) return fail("stale_session");
    const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    return isSessionFresh(token, params.user.id, nowSeconds)
      ? { ok: true, method: "recent_session" }
      : fail("stale_session");
  } catch {
    // Fail closed: an auth outage must never be read as "identity confirmed".
    return fail("unavailable");
  }
}
