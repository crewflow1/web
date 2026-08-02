import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  API_KEY_PREFIX,
  API_KEY_REGEX,
  API_KEY_SECRET_LENGTH,
  API_KEY_DISPLAY_CHARS,
  generateApiKey,
  hashApiKey,
} from "@/lib/api-auth/keygen";
import {
  SCOPES,
  SCOPE_LABELS,
  type Scope,
  hasScope,
  isScope,
  validateScopes,
} from "@/lib/api-auth/scopes";

/**
 * API-key substrate — keygen + scope registry (Train 9).
 *
 * The generation contract (format, entropy, hash) and the SCOPES drift guard:
 * the registry is a build fact, so any growth or rename must fail a test and
 * become a conscious diff line.
 */

describe("generateApiKey — format", () => {
  it("produces crewflow_sk_ + exactly 43 base62 chars, every time", () => {
    for (let i = 0; i < 100; i++) {
      const { plaintext } = generateApiKey();
      expect(plaintext).toMatch(API_KEY_REGEX);
      expect(plaintext).toHaveLength(API_KEY_PREFIX.length + API_KEY_SECRET_LENGTH);
    }
  });

  it("keyPrefix is the literal prefix + the first 8 secret chars of the plaintext", () => {
    const { plaintext, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(plaintext.slice(0, API_KEY_PREFIX.length + API_KEY_DISPLAY_CHARS));
    expect(keyPrefix).toMatch(/^crewflow_sk_[0-9A-Za-z]{8}$/);
  });

  it("keyHash is the hex sha256 of the FULL plaintext (prefix included)", () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(keyHash).toBe(createHash("sha256").update(plaintext, "utf8").digest("hex"));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never leaks the secret into the stored fields: prefix reveals only 8 chars", () => {
    const { plaintext, keyPrefix, keyHash } = generateApiKey();
    const secret = plaintext.slice(API_KEY_PREFIX.length);
    // The 35 undisclosed secret chars appear in neither stored column.
    expect(keyPrefix.includes(secret)).toBe(false);
    expect(keyHash.includes(secret)).toBe(false);
  });
});

describe("generateApiKey — entropy sanity", () => {
  it("500 keys are 500 distinct plaintexts and 500 distinct hashes", () => {
    const plain = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const k = generateApiKey();
      plain.add(k.plaintext);
      hashes.add(k.keyHash);
    }
    expect(plain.size).toBe(500);
    expect(hashes.size).toBe(500);
  });

  it("secret characters actually vary (no stuck positions, no biased padding)", () => {
    // Position 0 is the big-endian top of a uniform 256-bit integer; over 200
    // draws it must take many values. A padding bug (everything '0') or a
    // truncation bug (constant top byte) fails this loudly.
    const firstChars = new Set<string>();
    const lastChars = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const secret = generateApiKey().plaintext.slice(API_KEY_PREFIX.length);
      firstChars.add(secret[0]!);
      lastChars.add(secret[42]!);
    }
    expect(firstChars.size).toBeGreaterThan(5);
    expect(lastChars.size).toBeGreaterThan(20);
  });
});

describe("hashApiKey — stability", () => {
  it("matches the published SHA-256 test vector", () => {
    // FIPS 180-2 vector: sha256("abc"). If this moves, the algorithm moved —
    // and every stored key_hash in production would stop resolving.
    expect(hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and input-sensitive", () => {
    const { plaintext, keyHash } = generateApiKey();
    expect(hashApiKey(plaintext)).toBe(keyHash);
    expect(hashApiKey(plaintext + "x")).not.toBe(keyHash);
  });
});

describe("SCOPES registry — the drift guard", () => {
  it("v1 defines EXACTLY the per-resource read scopes — growing this list is a reviewed decision", () => {
    // Deep-equal, not contains: adding, renaming or removing a scope must
    // fail here and be changed consciously, together with its enforcement.
    expect([...SCOPES]).toEqual([
      "read:jobs",
      "read:customers",
      "read:invoices",
      "read:quotes",
    ]);
  });

  it("the compile-time union matches the runtime array", () => {
    // Type-level half of the guard: these lines fail `tsc` if Scope and the
    // array ever diverge.
    const fromUnion: Scope = "read:jobs";
    const fromArray: (typeof SCOPES)[number] = fromUnion;
    expect(isScope(fromArray)).toBe(true);
  });

  it("every scope has a UI label (a scope cannot be offered unnamed)", () => {
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual([...SCOPES].sort());
  });
});

describe("validateScopes", () => {
  it("accepts a known scope and dedupes repeats", () => {
    const r = validateScopes(["read:jobs", "read:jobs"]);
    expect(r).toEqual({ ok: true, scopes: ["read:jobs"] });
  });

  it("refuses unknown scopes and names them", () => {
    const r = validateScopes(["read:jobs", "write:jobs", "admin:*"]);
    expect(r).toEqual({ ok: false, invalid: ["write:jobs", "admin:*"] });
  });

  it("refuses the empty set — a key with no scopes is a creation mistake", () => {
    expect(validateScopes([])).toEqual({ ok: false, invalid: [] });
  });
});

describe("hasScope", () => {
  it("grants only what the row holds", () => {
    expect(hasScope(["read:jobs"], "read:jobs")).toBe(true);
    expect(hasScope([], "read:jobs")).toBe(false);
  });

  it("unknown strings in a stored grant never match — stale grants degrade to no access", () => {
    expect(hasScope(["write:jobs", "totally:made-up"], "read:jobs")).toBe(false);
  });
});
