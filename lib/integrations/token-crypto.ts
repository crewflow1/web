import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Integration token encryption — the shared, server-only AES-256-GCM envelope
 * used to protect OAuth access/refresh tokens AT REST for every provider
 * substrate (accounting + calendar today).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The OAuth substrates are shipped DARK. Their callbacks would, once live,
 * write provider tokens into `access_token` / `refresh_token` text columns. This
 * module makes "never store a plaintext token" a CODE guarantee rather than a
 * comment: callbacks encrypt before the DB write, the live consumer decrypts on
 * use, and a tripwire refuses the exchange when a connectable provider has no
 * key. This is a 0-migration seam — ciphertext is a self-describing string that
 * fits the existing text columns.
 *
 * ── THE KEY ─────────────────────────────────────────────────────────────────
 * `INTEGRATION_TOKEN_ENCRYPTION_KEY` — a base64-encoded 32 bytes (AES-256). It
 * is validated (present + decodes to exactly 32 bytes) before any crypto runs;
 * a missing or malformed key throws a clear error on encrypt/decrypt, and is
 * reported (WITHOUT throwing) by `isTokenEncryptionConfigured()` /
 * `hasEncryptionKey()` so the tripwire and two-switch logic can branch cleanly.
 * The key is read at call time (a deploy can rotate it) and NEVER logged.
 *
 * ── THE CIPHERTEXT ──────────────────────────────────────────────────────────
 * `v1:<iv_b64>:<tag_b64>:<ct_b64>` — a fresh random 12-byte IV per call, the
 * GCM auth tag, and the ciphertext, all base64. The `v1:` prefix is a format
 * version so the scheme can evolve without ambiguity. Decryption is
 * authenticated: any tamper (ciphertext, IV, or tag) fails the GCM check and
 * throws — a mutated token is never silently accepted.
 */

const ENV_KEY = "INTEGRATION_TOKEN_ENCRYPTION_KEY";
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length

/**
 * Read + validate the key WITHOUT throwing. Returns the 32-byte key buffer, or
 * null when the env var is absent, blank, not valid base64, or the wrong length.
 * This is the single source of truth both the throwing accessor and the
 * boolean predicates build on.
 */
function readKey(): Buffer | null {
  const raw = process.env[ENV_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), "base64");
  } catch {
    return null;
  }
  // Buffer.from(base64) is lenient (it drops invalid chars) rather than
  // throwing, so the LENGTH check is the real validator: a 32-byte result is
  // the only accepted shape.
  if (buf.length !== KEY_BYTES) return null;
  return buf;
}

/** The throwing accessor — validates the key and throws a clear error if absent/malformed. */
function requireKey(): Buffer {
  const key = readKey();
  if (!key) {
    throw new Error(
      `${ENV_KEY} is missing or malformed: expected a base64-encoded 32-byte key ` +
        `(AES-256). Set it before enabling any integration that stores OAuth tokens.`,
    );
  }
  return key;
}

/**
 * Is a valid encryption key present? Never throws — this is the predicate the
 * callback tripwire and any two-switch/darkness logic use to decide whether a
 * write may proceed. A `false` here means "no plaintext token may be written".
 */
export function isTokenEncryptionConfigured(): boolean {
  return readKey() !== null;
}

/** Alias of {@link isTokenEncryptionConfigured} — a boolean derivable without throwing. */
export function hasEncryptionKey(): boolean {
  return readKey() !== null;
}

/**
 * Encrypt a token into the self-describing `v1:<iv>:<tag>:<ct>` string. A fresh
 * random 12-byte IV is minted per call. Throws when the key is absent/malformed.
 */
export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new Error("encryptToken: plaintext must be a string");
  }
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Reverse {@link encryptToken}. Validates the `v1:` envelope, then performs an
 * AUTHENTICATED decrypt: a wrong key or any tamper (ciphertext, IV, or tag)
 * fails the GCM auth check and throws — never returns a corrupted token. Throws
 * when the key is absent/malformed or the format is unrecognised.
 */
export function decryptToken(ciphertext: string): string {
  if (typeof ciphertext !== "string") {
    throw new Error("decryptToken: ciphertext must be a string");
  }
  const key = requireKey();
  const parts = ciphertext.split(":");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new Error(
      "decryptToken: unrecognised ciphertext format (expected v1:<iv>:<tag>:<ct>)",
    );
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const body = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("decryptToken: bad IV length");
  if (tag.length !== TAG_BYTES) throw new Error("decryptToken: bad auth tag length");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // .final() throws (GCM auth failure) if key/iv/tag/body don't all agree.
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  return plaintext.toString("utf8");
}
