/**
 * CrewFlow — Web Push cryptography (RFC 8291 + RFC 8188 + RFC 8292), pure.
 *
 * The standards-based, dependency-free core of the Web Push channel. Node's
 * `crypto` has every primitive we need (P-256 ECDH, HKDF via HMAC-SHA256,
 * AES-128-GCM, ES256 signing) so there is NO third-party `web-push` dependency:
 * this module IS the encoder. It is deliberately kept PURE — only `node:crypto`,
 * no Supabase, no env, no `server-only`, no network — so the hermetic test tier
 * can prove it against the RFC 8291 Appendix A known-answer vector without a DB.
 *
 * The two halves a caller composes to POST a push:
 *   1. `encryptWebPushPayload` — RFC 8291 message encryption in the modern
 *      `aes128gcm` content-encoding (RFC 8188). Produces the request BODY.
 *   2. `buildVapidAuthHeader` — the RFC 8292 VAPID `Authorization` header
 *      (an ES256 JWT + the server public key) that identifies the sender.
 *
 * The IO half (subscription lookup, fetch, ret/prune, the DARK refuse-before-send
 * gate) lives in the `server-only` lib/notifications/push.ts.
 */

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";

// ---------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// ---------------------------------------------------------------------
// HKDF (RFC 5869) with SHA-256 — single-block expand (all our L <= 32).
// ---------------------------------------------------------------------

function hkdf(
  salt: Buffer,
  ikm: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  if (length > 32) {
    // Every derivation here is <= 32 bytes; a longer request is a programming
    // error, not a runtime condition, so fail loudly rather than silently.
    throw new Error(`hkdf: length ${length} exceeds single-block SHA-256 output`);
  }
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const t = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return t.subarray(0, length);
}

// RFC 8291 §3.4 — the fixed info-string literals. Pinned here (and asserted in
// the test) so a typo can never silently break interop with real browsers.
const WEBPUSH_KEY_INFO_PREFIX = Buffer.from("WebPush: info\0", "utf8");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");

/** RFC 8188 record size we advertise. 4096 comfortably fits a push payload. */
const RECORD_SIZE = 4096;

export type EncryptedPush = {
  /** The full aes128gcm content-coding body: header || ciphertext. */
  body: Buffer;
  /** The 16-byte content-encoding salt (also embedded in the body header). */
  salt: Buffer;
  /** The ephemeral server public key (uncompressed P-256 point, 65 bytes). */
  serverPublicKey: Buffer;
};

/**
 * Encrypt a push payload for one subscription per RFC 8291 (aes128gcm).
 *
 * `userPublicKey` / `userAuth` are the subscription's `keys.p256dh` / `keys.auth`
 * (base64url). The result `.body` is posted verbatim with headers
 * `Content-Encoding: aes128gcm` + `Content-Type: application/octet-stream`.
 *
 * `deterministic` injects a fixed server keypair + salt so the RFC 8291
 * Appendix A known-answer vector is reproducible in tests. Production callers
 * omit it → a fresh random ephemeral key and salt every message.
 */
export function encryptWebPushPayload(input: {
  payload: Buffer | string;
  userPublicKey: string;
  userAuth: string;
  deterministic?: { serverPrivateKey: Buffer; salt: Buffer };
}): EncryptedPush {
  const payload =
    typeof input.payload === "string"
      ? Buffer.from(input.payload, "utf8")
      : input.payload;
  const uaPublic = base64UrlDecode(input.userPublicKey);
  const authSecret = base64UrlDecode(input.userAuth);

  if (uaPublic.length !== 65) {
    throw new Error("webpush: subscription p256dh must be a 65-byte P-256 point");
  }
  if (authSecret.length !== 16) {
    throw new Error("webpush: subscription auth secret must be 16 bytes");
  }

  const ecdh = createECDH("prime256v1");
  if (input.deterministic) {
    ecdh.setPrivateKey(input.deterministic.serverPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed point
  const sharedSecret = ecdh.computeSecret(uaPublic); // 32 bytes
  const salt = input.deterministic ? input.deterministic.salt : randomBytes(16);

  // RFC 8291 §3.4: derive the IKM from the ECDH secret keyed by the auth secret.
  const keyInfo = Buffer.concat([WEBPUSH_KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // RFC 8188 content-encryption key + nonce, keyed by the message salt.
  const cek = hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = hkdf(salt, ikm, NONCE_INFO, 12);

  // Single, final record: payload || 0x02 delimiter (RFC 8188 last-record pad).
  const record = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(record),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // RFC 8188 header: salt(16) | rs(4, uint32 BE) | idlen(1) | keyid(as_public).
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([
    salt,
    rs,
    Buffer.from([asPublic.length]),
    asPublic,
  ]);

  return { body: Buffer.concat([header, ciphertext]), salt, serverPublicKey: asPublic };
}

// ---------------------------------------------------------------------
// VAPID (RFC 8292) — the ES256 JWT + Authorization header.
// ---------------------------------------------------------------------

/**
 * Build a P-256 private KeyObject from the raw VAPID keys.
 * `privateKey` is the base64url raw 32-byte scalar; `publicKey` the base64url
 * 65-byte uncompressed point (as emitted by `web-push generate-vapid-keys`).
 */
function importVapidPrivateKey(privateKey: string, publicKey: string) {
  const pub = base64UrlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("vapid: public key must be a 65-byte uncompressed P-256 point");
  }
  const d = base64UrlDecode(privateKey);
  if (d.length !== 32) {
    throw new Error("vapid: private key must be a 32-byte scalar");
  }
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(d),
      x: base64UrlEncode(pub.subarray(1, 33)),
      y: base64UrlEncode(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

/** The origin (scheme + host) of a push endpoint — the JWT `aud`. */
export function vapidAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

/**
 * Sign a VAPID JWT (ES256) for one push endpoint. `subject` must be a
 * `mailto:` or `https:` URI identifying the sender (RFC 8292 §2.1).
 * `expirySeconds` is clamped to the RFC's 24h maximum.
 */
export function signVapidJwt(
  keys: VapidKeys,
  audience: string,
  now: number = Date.now(),
  expirySeconds = 12 * 60 * 60,
): string {
  const exp = Math.floor(now / 1000) + Math.min(expirySeconds, 24 * 60 * 60);
  const header = base64UrlEncode(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"),
  );
  const body = base64UrlEncode(
    Buffer.from(
      JSON.stringify({ aud: audience, exp, sub: keys.subject }),
      "utf8",
    ),
  );
  const signingInput = `${header}.${body}`;
  const key = importVapidPrivateKey(keys.privateKey, keys.publicKey);
  // dsaEncoding 'ieee-p1363' yields the raw r||s (64 bytes) JOSE requires — NOT
  // the ASN.1/DER encoding `crypto.sign` would otherwise produce.
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** The full RFC 8292 `Authorization` header value for one endpoint. */
export function buildVapidAuthHeader(
  keys: VapidKeys,
  endpoint: string,
  now: number = Date.now(),
): string {
  const jwt = signVapidJwt(keys, vapidAudience(endpoint), now);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}
