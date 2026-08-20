import "server-only";
import {
  createPublicKey,
  createVerify,
  verify as cryptoVerify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

/**
 * OIDC Relying-Party ID-token validation — the RP-side trust boundary.
 *
 * A callback receives an authorization code, exchanges it for tokens at the
 * IdP, and calls {@link verifyIdToken} to turn the returned id_token into a
 * trusted identity. Validation is deliberately strict and self-contained
 * (Node crypto only, no external JWT lib):
 *
 *   1. ALG ALLOWLIST: only RS256/384/512 + ES256/384/512. "none" is rejected,
 *      and HS* (HMAC) is rejected outright — pinning to asymmetric verification
 *      closes the classic alg-confusion attack (signing an HS256 token with the
 *      public key as the HMAC secret).
 *   2. SIGNATURE verified against the IdP's JWKS key (matched by kid).
 *   3. CLAIMS: iss === configured issuer, aud includes client_id, exp not
 *      passed, iat/nbf sanity, and nonce === the value we generated at start
 *      (replay / injection defence).
 *
 * It NEVER provisions. The caller maps the verified email to an EXISTING
 * membership (deny-unmatched) — see lib/enterprise-sso/provisioning.ts.
 */

export type Jwk = {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
};

export type IdTokenVerifyOptions = {
  issuer: string;
  clientId: string;
  /** The nonce we generated at authorization start; the id_token MUST echo it. */
  expectedNonce: string;
  jwks: { keys: Jwk[] };
  clockSkewSec?: number;
  now?: Date;
};

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  [k: string]: unknown;
};

export type IdTokenResult =
  | { ok: true; email: string; sub: string; claims: IdTokenClaims }
  | { ok: false; reason: string };

// alg → node verification recipe. Asymmetric only.
const ALG_RECIPES: Record<
  string,
  { hash: string; keyType: "rsa" | "ec"; dsaEncoding?: "ieee-p1363" }
> = {
  RS256: { hash: "RSA-SHA256", keyType: "rsa" },
  RS384: { hash: "RSA-SHA384", keyType: "rsa" },
  RS512: { hash: "RSA-SHA512", keyType: "rsa" },
  ES256: { hash: "sha256", keyType: "ec", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", keyType: "ec", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", keyType: "ec", dsaEncoding: "ieee-p1363" },
};

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
function b64urlToJson<T>(s: string): T | null {
  try {
    return JSON.parse(b64urlToBuffer(s).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Verify + validate an OIDC id_token. Pure (no network): the caller supplies the
 * JWKS it fetched from the IdP discovery document, which keeps this exhaustively
 * testable.
 */
export function verifyIdToken(
  idToken: string,
  opts: IdTokenVerifyOptions,
): IdTokenResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  const skewMs = (opts.clockSkewSec ?? 120) * 1000;

  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_jwt" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = b64urlToJson<{ alg?: string; kid?: string; typ?: string }>(headerB64);
  if (!header) return { ok: false, reason: "malformed_header" };

  const alg = header.alg ?? "";
  const recipe = ALG_RECIPES[alg];
  // Rejects "none", HS256/384/512, and anything not explicitly allowlisted.
  if (!recipe) return { ok: false, reason: "disallowed_alg" };

  const claims = b64urlToJson<IdTokenClaims>(payloadB64);
  if (!claims) return { ok: false, reason: "malformed_payload" };

  // Select the JWKS key: match kid when present; else the sole matching-type key.
  const candidates = opts.jwks.keys.filter((k) =>
    recipe.keyType === "rsa" ? k.kty === "RSA" : k.kty === "EC",
  );
  const key =
    (header.kid && candidates.find((k) => k.kid === header.kid)) ||
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!key) return { ok: false, reason: "no_matching_key" };

  // Verify the signature over `header.payload`.
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = b64urlToBuffer(sigB64);
  let verified = false;
  try {
    const publicKey = createPublicKey({
      key: key as unknown as NodeJsonWebKey,
      format: "jwk",
    });
    if (recipe.keyType === "rsa") {
      const v = createVerify(recipe.hash);
      v.update(signingInput);
      v.end();
      verified = v.verify(publicKey, signature);
    } else {
      verified = cryptoVerify(
        recipe.hash,
        signingInput,
        { key: publicKey, dsaEncoding: recipe.dsaEncoding },
        signature,
      );
    }
  } catch {
    return { ok: false, reason: "signature_error" };
  }
  if (!verified) return { ok: false, reason: "signature_invalid" };

  // ── Claims ──
  if (claims.iss !== opts.issuer) return { ok: false, reason: "issuer_mismatch" };

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.clientId)) return { ok: false, reason: "audience_mismatch" };

  if (typeof claims.exp !== "number" || nowMs - skewMs >= claims.exp * 1000) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && nowMs + skewMs < claims.nbf * 1000) {
    return { ok: false, reason: "not_yet_valid" };
  }

  // Nonce binding — the token MUST echo the nonce we minted at start.
  if (!claims.nonce || claims.nonce !== opts.expectedNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }

  const email = resolveEmail(claims);
  if (!email) return { ok: false, reason: "no_email" };

  // ACCOUNT-TAKEOVER DEFENCE (F2): the account is keyed on the email string, so
  // an IdP that hands out UNVERIFIED emails could let one subject claim another
  // user's address. Require the standard OIDC `email_verified` claim to be
  // exactly boolean true. `email_verified` absent, false, or the string "true"
  // (some IdPs stringify it) that isn't a real boolean → reject. We deliberately
  // do NOT coerce "true"/"false" strings: the spec types this claim as a JSON
  // boolean, and accepting a stringified value would re-open the very ambiguity
  // this check closes. A misconfigured IdP is denied loudly rather than trusted.
  if (claims.email_verified !== true) {
    return { ok: false, reason: "email_unverified" };
  }

  return { ok: true, email, sub: String(claims.sub), claims };
}

function resolveEmail(claims: IdTokenClaims): string | null {
  const raw = typeof claims.email === "string" ? claims.email : null;
  if (raw && raw.includes("@")) return raw.trim().toLowerCase();
  return null;
}

// ── Network helpers (used by the callback route; kept thin + injectable) ──

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
};

/** Fetch the OIDC discovery document. Derives the well-known URL from issuer
 *  when no explicit discovery URL is configured. */
export async function fetchDiscovery(
  issuer: string,
  discoveryUrl?: string | null,
): Promise<OidcDiscovery> {
  const url =
    discoveryUrl && discoveryUrl.trim().length > 0
      ? discoveryUrl.trim()
      : `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as OidcDiscovery;
  // The discovery issuer MUST match the configured issuer (mix-up defence).
  if (doc.issuer !== issuer) throw new Error("OIDC discovery issuer mismatch");
  return doc;
}

export async function fetchJwks(jwksUri: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(jwksUri, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}
