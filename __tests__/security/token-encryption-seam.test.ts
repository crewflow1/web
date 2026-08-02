import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TOKEN ENCRYPTION SEAM — source-level trust-boundary proofs (hermetic).
 *
 * The accounting + calendar OAuth substrates are shipped DARK. This suite proves
 * — against the SOURCE, comments stripped — that on activation:
 *   1. tokens are AES-256-GCM encrypted (encryptToken) on BOTH access_token AND
 *      refresh_token before they reach the DB, and NO plaintext token value is
 *      ever written;
 *   2. a token-encryption TRIPWIRE (isTokenEncryptionConfigured) gates each
 *      callback BEFORE the token exchange, so a connectable provider with no key
 *      writes nothing;
 *   3. the OAuth `state` is compared CONSTANT-TIME (timingSafeEqual), never a
 *      bare string `!==`;
 *   4. the shared crypto util is a real AES-256-GCM envelope keyed by
 *      INTEGRATION_TOKEN_ENCRYPTION_KEY, and the decrypt-on-use seam
 *      (decryptStoredTokens → decryptToken) exists in both oauth modules.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JS comments so assertions test EXECUTABLE code, not prose. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ACCT_CALLBACK = "app/api/integrations/accounting/[provider]/callback/route.ts";
const CAL_CALLBACK = "app/api/integrations/calendar/[provider]/callback/route.ts";
const ACCT_OAUTH = "lib/integrations/accounting/oauth.ts";
const CAL_OAUTH = "lib/integrations/calendar/oauth.ts";
const CRYPTO = "lib/integrations/token-crypto.ts";

const CALLBACKS: Array<[string, string]> = [
  ["accounting", ACCT_CALLBACK],
  ["calendar", CAL_CALLBACK],
];

// ---------------------------------------------------------------------------
// 1. ENCRYPT-BEFORE-WRITE — both tokens wrapped, no plaintext value written
// ---------------------------------------------------------------------------

describe("callbacks encrypt tokens before the DB write", () => {
  for (const [name, file] of CALLBACKS) {
    it(`${name}: access_token is written via encryptToken(...)`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(/access_token:\s*encryptToken\(/);
    });

    it(`${name}: refresh_token is written via encryptToken(...)`, () => {
      const code = codeOf(read(file));
      // refresh_token is nullable, so it is encrypted only when present.
      expect(code).toMatch(/refresh_token:[\s\S]{0,120}encryptToken\(/);
    });

    it(`${name}: NO plaintext token value is written to a token column`, () => {
      const code = codeOf(read(file));
      // The bare-plaintext assignments the seam replaced must be gone: a token
      // key whose VALUE is a raw token expression terminated by a comma/newline
      // (i.e. written straight to the column, not passed through encryptToken).
      expect(code).not.toMatch(/access_token:\s*exchanged\.tokens\.accessToken\s*[,\n]/);
      expect(code).not.toMatch(/refresh_token:\s*exchanged\.tokens\.refreshToken\s*[,\n]/);
      expect(code).not.toMatch(/access_token:\s*refreshToken\s*[,\n]/);
      expect(code).not.toMatch(/access_token:\s*accessToken\s*[,\n]/);
      // Every access_token/refresh_token WRITE goes through encryptToken (or an
      // explicit null): no token key is assigned a raw value or a bare identifier.
      const tokenWrites = code.match(/(?:access_token|refresh_token):\s*[^\n,]+/g) ?? [];
      expect(tokenWrites.length).toBeGreaterThanOrEqual(2);
      for (const w of tokenWrites) {
        expect(w).toMatch(/encryptToken\(|:\s*null/);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. THE TRIPWIRE — encryption key required, checked BEFORE the exchange
// ---------------------------------------------------------------------------

describe("callbacks refuse the exchange without an encryption key", () => {
  for (const [name, file] of CALLBACKS) {
    it(`${name}: isTokenEncryptionConfigured() gates the exchange path`, () => {
      const code = codeOf(read(file));
      const tripwireIdx = code.indexOf("isTokenEncryptionConfigured(");
      const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
      expect(tripwireIdx).toBeGreaterThan(-1);
      expect(exchangeIdx).toBeGreaterThan(-1);
      // The tripwire is checked BEFORE the token exchange — no exchange, no
      // write, when the key is absent.
      expect(tripwireIdx).toBeLessThan(exchangeIdx);
      // And it is used as a refusal guard (negated), not merely referenced.
      expect(code).toMatch(/if\s*\(\s*!isTokenEncryptionConfigured\(\)\s*\)/);
    });

    it(`${name}: the tripwire sits AFTER the connectable guard (stays dark)`, () => {
      const code = codeOf(read(file));
      const connectableIdx = code.search(/is(?:Calendar)?ProviderConnectable\(provider\)/);
      const tripwireIdx = code.indexOf("isTokenEncryptionConfigured(");
      expect(connectableIdx).toBeGreaterThan(-1);
      expect(connectableIdx).toBeLessThan(tripwireIdx);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. CONSTANT-TIME STATE COMPARE — timingSafeEqual, never a bare `!==`
// ---------------------------------------------------------------------------

describe("callbacks compare OAuth state constant-time", () => {
  for (const [name, file] of CALLBACKS) {
    it(`${name}: uses timingSafeEqual and no bare string compare`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(/timingSafeEqual/);
      expect(code).not.toMatch(/state !== stateCookie/);
      expect(code).not.toMatch(/state === stateCookie/);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. THE CRYPTO UTIL + DECRYPT-ON-USE SEAM
// ---------------------------------------------------------------------------

describe("token-crypto is a real AES-256-GCM envelope", () => {
  const code = codeOf(read(CRYPTO));

  it("uses aes-256-gcm keyed by INTEGRATION_TOKEN_ENCRYPTION_KEY", () => {
    expect(code).toMatch(/aes-256-gcm/);
    expect(code).toMatch(/INTEGRATION_TOKEN_ENCRYPTION_KEY/);
    expect(code).toMatch(/getAuthTag\(\)/);
    expect(code).toMatch(/setAuthTag\(/);
  });

  it("exports the seam surface", () => {
    for (const fn of [
      "encryptToken",
      "decryptToken",
      "isTokenEncryptionConfigured",
      "hasEncryptionKey",
    ]) {
      expect(code).toMatch(new RegExp(`export function ${fn}\\b`));
    }
  });

  it("is server-only and never logs a secret", () => {
    expect(code).toMatch(/server-only/);
    const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
    expect(logCalls).toHaveLength(0);
  });
});

describe("decrypt-on-use seam exists in both oauth modules", () => {
  for (const [name, file] of [
    ["accounting", ACCT_OAUTH],
    ["calendar", CAL_OAUTH],
  ] as const) {
    it(`${name}: decryptStoredTokens routes through decryptToken`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(/export function decryptStoredTokens\(/);
      expect(code).toMatch(/decryptToken\(/);
    });
  }
});
