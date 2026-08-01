import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { API_KEY_REGEX, hashApiKey } from "@/lib/api-auth/keygen";

/**
 * Bearer API-key resolution (Train 9 substrate) — the SINGLE authority for
 * whether an `Authorization: Bearer crewflow_sk_…` header names a live key.
 *
 * The portal-token shape (app/customer-portal/_helpers.ts): every /api/v1
 * route funnels through here, so malformed / unknown / REVOKED / EXPIRED keys
 * are rejected in one place and individual routes can never drift. Fails
 * closed to null on: bad header shape, unknown hash, a DB error, a set
 * revoked_at, or a passed expires_at.
 *
 * NO CACHING, BY DESIGN: revoked_at and expires_at are read from Postgres on
 * EVERY call. An admin clicking "revoke" must kill the key on the very next
 * request — a resolver cache would turn revocation into "eventually". The
 * cost is one indexed unique-key lookup per API request, which is what an
 * auth check costs.
 *
 * TIMING SAFETY: the presented key is sha256-hashed BEFORE any comparison,
 * and the only equality performed is Postgres matching that digest against
 * the unique key_hash index. No code path compares attacker-controlled bytes
 * against a secret with early-exit semantics — to exploit index-comparison
 * timing an attacker would need to choose the DIGEST, i.e. invert sha256.
 * This is the standard hashed-lookup design; node's timingSafeEqual is
 * unnecessary because no plaintext-vs-plaintext comparison exists at all.
 *
 * SERVICE-ROLE lookup, deliberately: there is no user JWT on this path (the
 * key IS the credential), and key_hash is column-level-excluded from the
 * authenticated role anyway. The org boundary is enforced by returning the
 * key's own org_id — callers scope every downstream query with it.
 */

/** Debounce window for the coarse last_used_at touch: at most one write per
 *  key per minute, enforced in the UPDATE's own WHERE (portal precedent). */
export const LAST_USED_TOUCH_INTERVAL_MS = 60 * 1000;

export type ResolvedApiKey = {
  orgId: string;
  keyId: string;
  keyPrefix: string;
  scopes: string[];
};

/**
 * Extract the candidate key from an Authorization header value.
 * `Bearer` scheme only (case-insensitive, single token). Returns null on any
 * other shape so an obviously-invalid header never reaches the database.
 */
export function parseApiKeyFromAuthorization(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const candidate = match[1]!;
  return API_KEY_REGEX.test(candidate) ? candidate : null;
}

/** Pure half of the debounce: is the stored last_used_at stale enough that a
 *  touch write is worth attempting? (The DB re-checks in its own WHERE.) */
export function shouldTouchLastUsed(
  lastUsedAt: string | null,
  nowMs: number,
): boolean {
  if (!lastUsedAt) return true;
  const parsed = Date.parse(lastUsedAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= nowMs - LAST_USED_TOUCH_INTERVAL_MS;
}

type KeyRow = {
  id: string;
  org_id: string;
  key_prefix: string;
  scopes: string[] | null;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
};

type ReadError = { message: string } | null;

/** Minimal typed chain — api_keys post-dates the generated Database types
 *  (the house `as never` idiom for new tables). */
type ApiKeysRead = {
  select: (cols: string) => {
    eq: (
      col: string,
      value: string,
    ) => {
      maybeSingle: () => Promise<{ data: KeyRow | null; error: ReadError }>;
    };
  };
};
type ApiKeysTouch = {
  update: (row: { last_used_at: string }) => {
    eq: (
      col: string,
      value: string,
    ) => {
      or: (filter: string) => Promise<{ error: ReadError }>;
    };
  };
};

/**
 * Resolve an Authorization header to a live key, or null.
 *
 * Checks, in order, on EVERY call:
 *   1. header shape + key format (no DB hit for garbage);
 *   2. hash lookup (unique index on key_hash);
 *   3. revoked_at — a revoked key is dead immediately;
 *   4. expires_at — a passed expiry fails closed exactly like an unknown key.
 *
 * On success, coarsely touches last_used_at (≤ 1 write/min/key; failure is
 * logged and swallowed — telemetry must never break authentication, and it
 * runs only AFTER validation, never for a rejected key).
 */
export async function resolveApiKey(
  authorizationHeader: string | null | undefined,
): Promise<ResolvedApiKey | null> {
  const plaintext = parseApiKeyFromAuthorization(authorizationHeader);
  if (!plaintext) return null;

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("api_keys" as never) as unknown as ApiKeysRead
  )
    .select("id, org_id, key_prefix, scopes, revoked_at, expires_at, last_used_at")
    .eq("key_hash", hashApiKey(plaintext))
    .maybeSingle();

  if (error) {
    // Loud + fail closed: an auth check that cannot read must refuse, and the
    // failure must be visible — never "the key looked wrong".
    console.error("[api-auth] key lookup failed", error.message);
    return null;
  }
  if (!data) return null;

  // REVOCATION — checked on every call, no caching (see module header).
  if (data.revoked_at !== null) return null;

  // EXPIRY — a NULL expiry never expires; a passed one fails closed.
  if (data.expires_at !== null && Date.parse(data.expires_at) <= Date.now()) {
    return null;
  }

  // USAGE TELEMETRY — only now that the key is valid. Awaited (serverless can
  // freeze out a dangling write) but can never throw or block resolution.
  await touchLastUsed(admin, data.id, data.last_used_at);

  return {
    orgId: data.org_id,
    keyId: data.id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
  };
}

/**
 * Coarse last_used_at touch — the portal-token debounce shape
 * (app/customer-portal/_helpers.ts touchLastUsed, copied deliberately):
 * an in-memory fast-path skips recent touches, and the UPDATE re-checks the
 * interval in its OWN WHERE (`last_used_at IS NULL OR < cutoff`) so two
 * concurrent requests cannot both land a write — the debounce is enforced by
 * Postgres, not by this pre-check. Scoped by primary key to the exact key
 * that just authenticated. Never rethrows.
 */
async function touchLastUsed(
  admin: ReturnType<typeof createAdminClient>,
  keyId: string,
  lastUsedAt: string | null,
): Promise<void> {
  try {
    const nowMs = Date.now();
    if (!shouldTouchLastUsed(lastUsedAt, nowMs)) return;

    const cutoffIso = new Date(nowMs - LAST_USED_TOUCH_INTERVAL_MS).toISOString();
    const { error } = await (
      admin.from("api_keys" as never) as unknown as ApiKeysTouch
    )
      .update({ last_used_at: new Date(nowMs).toISOString() })
      .eq("id", keyId)
      // Debounce in the DB so concurrent requests can't double-write.
      .or(`last_used_at.is.null,last_used_at.lt.${cutoffIso}`);
    if (error) {
      console.error("[api-auth] last_used touch failed", error.message);
    }
  } catch (e) {
    // Telemetry must never break authentication.
    console.error(
      "[api-auth] last_used touch threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}
