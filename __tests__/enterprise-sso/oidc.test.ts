import { describe, it, expect, beforeAll } from "vitest";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { verifyIdToken, type Jwk } from "@/lib/enterprise-sso/oidc";

/**
 * OIDC id_token validation — the RP trust boundary.
 *
 * Signs real RS256 JWTs and proves: a genuine token is accepted; a tampered
 * one, a wrong-key one, a "none"/HS256 alg-confusion attempt, and every failed
 * claim (issuer / aud / expiry / nonce) are rejected.
 */

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "client-123";
const NONCE = "nonce-abc";
const NOW = new Date("2026-06-01T00:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

let privPem: string;
let jwks: { keys: Jwk[] };

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

function makeJwt(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" },
  key = privPem,
): string {
  const si = `${b64url(header)}.${b64url(claims)}`;
  if (header.alg === "none") return `${si}.`;
  const sign = createSign("RSA-SHA256");
  sign.update(Buffer.from(si, "utf8"));
  sign.end();
  return `${si}.${sign.sign(key).toString("base64url")}`;
}

const baseClaims = () => ({
  iss: ISSUER,
  sub: "user-sub",
  aud: CLIENT_ID,
  exp: NOW_S + 3600,
  iat: NOW_S,
  nonce: NONCE,
  email: "user@example.com",
});

const opts = () => ({ issuer: ISSUER, clientId: CLIENT_ID, expectedNonce: NONCE, jwks, now: NOW });

beforeAll(() => {
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privPem = (kp.privateKey as KeyObject).export({ type: "pkcs1", format: "pem" }) as string;
  const jwk = (kp.publicKey as KeyObject).export({ format: "jwk" }) as Jwk;
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  jwks = { keys: [jwk] };
});

describe("verifyIdToken — happy path", () => {
  it("accepts a genuine token and extracts the email", () => {
    const res = verifyIdToken(makeJwt(baseClaims()), opts());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.email).toBe("user@example.com");
      expect(res.sub).toBe("user-sub");
    }
  });

  it("accepts an aud array containing the client_id", () => {
    const res = verifyIdToken(makeJwt({ ...baseClaims(), aud: ["other", CLIENT_ID] }), opts());
    expect(res.ok).toBe(true);
  });
});

describe("verifyIdToken — signature/alg rejections", () => {
  it("REJECTS a tampered payload", () => {
    const jwt = makeJwt(baseClaims());
    const [h, , s] = jwt.split(".");
    const evil = b64url({ ...baseClaims(), email: "attacker@evil.com" });
    const res = verifyIdToken(`${h}.${evil}.${s}`, opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_invalid");
  });

  it("REJECTS the alg=none downgrade", () => {
    const res = verifyIdToken(makeJwt(baseClaims(), { alg: "none", typ: "JWT" }), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("disallowed_alg");
  });

  it("REJECTS an HS256 alg-confusion attempt", () => {
    // Attacker forges an HS256 header hoping we HMAC-verify with the public key.
    const header = { alg: "HS256", typ: "JWT" };
    const si = `${b64url(header)}.${b64url(baseClaims())}`;
    const forged = `${si}.${Buffer.from("whatever").toString("base64url")}`;
    const res = verifyIdToken(forged, opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("disallowed_alg");
  });

  it("REJECTS a token signed by a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPriv = (other.privateKey as KeyObject).export({ type: "pkcs1", format: "pem" }) as string;
    const res = verifyIdToken(makeJwt(baseClaims(), undefined, otherPriv), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature_invalid");
  });
});

describe("verifyIdToken — claim rejections", () => {
  it("REJECTS an issuer mismatch", () => {
    const res = verifyIdToken(makeJwt({ ...baseClaims(), iss: "https://evil" }), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("issuer_mismatch");
  });

  it("REJECTS an audience mismatch", () => {
    const res = verifyIdToken(makeJwt({ ...baseClaims(), aud: "someone-else" }), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("audience_mismatch");
  });

  it("REJECTS an expired token", () => {
    const res = verifyIdToken(makeJwt({ ...baseClaims(), exp: NOW_S - 3600 }), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("REJECTS a nonce mismatch (replay/injection defence)", () => {
    const res = verifyIdToken(makeJwt({ ...baseClaims(), nonce: "wrong" }), opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("nonce_mismatch");
  });
});
