import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * resolveApiKey — the Bearer-resolution authority (Train 9), against a mocked
 * admin client.
 *
 * Every null-path is proven: malformed header (no DB hit at all), unknown
 * hash, DB error (fail closed), revoked, expired. Plus the coarse
 * last_used_at debounce: pure predicate, fast-path skip, stale touch, and
 * "telemetry failure never blocks auth".
 */

// Hoisted so the vi.mock factory can close over it (rate-limit.test.ts shape).
const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import {
  LAST_USED_TOUCH_INTERVAL_MS,
  parseApiKeyFromAuthorization,
  resolveApiKey,
  shouldTouchLastUsed,
} from "@/lib/api-auth/resolve";
import { generateApiKey, hashApiKey } from "@/lib/api-auth/keygen";

type Row = {
  id: string;
  org_id: string;
  key_prefix: string;
  scopes: string[] | null;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
};

const KEY = generateApiKey();
const ROW: Row = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  key_prefix: KEY.keyPrefix,
  scopes: ["read:jobs"],
  revoked_at: null,
  expires_at: null,
  last_used_at: null,
};

let selectEq: ReturnType<typeof vi.fn>;
let updateOr: ReturnType<typeof vi.fn>;
let updateSpy: ReturnType<typeof vi.fn>;

/** Arm the mocked client: one select result + a recording update chain. */
function arm(row: Row | null, error: { message: string } | null = null) {
  selectEq = vi.fn().mockReturnValue({
    maybeSingle: () => Promise.resolve({ data: row, error }),
  });
  updateOr = vi.fn().mockResolvedValue({ error: null });
  updateSpy = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ or: updateOr }),
  });
  fromMock.mockImplementation(() => ({
    select: vi.fn().mockReturnValue({ eq: selectEq }),
    update: updateSpy,
  }));
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("parseApiKeyFromAuthorization", () => {
  const valid = KEY.plaintext;

  it("accepts `Bearer <key>` (scheme case-insensitive, surrounding space tolerated)", () => {
    expect(parseApiKeyFromAuthorization(`Bearer ${valid}`)).toBe(valid);
    expect(parseApiKeyFromAuthorization(`bearer ${valid}`)).toBe(valid);
    expect(parseApiKeyFromAuthorization(`  Bearer   ${valid}  `)).toBe(valid);
  });

  it("refuses every other shape", () => {
    expect(parseApiKeyFromAuthorization(null)).toBeNull();
    expect(parseApiKeyFromAuthorization(undefined)).toBeNull();
    expect(parseApiKeyFromAuthorization("")).toBeNull();
    expect(parseApiKeyFromAuthorization(valid)).toBeNull(); // no scheme
    expect(parseApiKeyFromAuthorization(`Basic ${valid}`)).toBeNull();
    expect(parseApiKeyFromAuthorization(`Bearer ${valid} extra`)).toBeNull();
    expect(parseApiKeyFromAuthorization("Bearer ")).toBeNull();
  });

  it("refuses tokens that are not exactly crewflow_sk_ + 43 base62 chars", () => {
    expect(parseApiKeyFromAuthorization(`Bearer ${valid.slice(0, -1)}`)).toBeNull();
    expect(parseApiKeyFromAuthorization(`Bearer ${valid}A`)).toBeNull();
    expect(
      parseApiKeyFromAuthorization(`Bearer crewflow_sk_${"_".repeat(43)}`),
    ).toBeNull();
    expect(
      parseApiKeyFromAuthorization(`Bearer wrongprefix_${"a".repeat(43)}`),
    ).toBeNull();
  });
});

describe("resolveApiKey — null paths", () => {
  it("missing/malformed header → null WITHOUT touching the database", async () => {
    arm(ROW);
    expect(await resolveApiKey(null)).toBeNull();
    expect(await resolveApiKey("Bearer not-a-key")).toBeNull();
    expect(await resolveApiKey(`Basic ${KEY.plaintext}`)).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("unknown hash → null", async () => {
    arm(null);
    expect(await resolveApiKey(`Bearer ${KEY.plaintext}`)).toBeNull();
    expect(selectEq).toHaveBeenCalledWith("key_hash", hashApiKey(KEY.plaintext));
  });

  it("DB error → null (fails CLOSED, never 'benefit of the doubt')", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    arm(ROW, { message: "boom" });
    expect(await resolveApiKey(`Bearer ${KEY.plaintext}`)).toBeNull();
    err.mockRestore();
  });

  it("revoked key → null, and NO last-used touch (telemetry only after validity)", async () => {
    arm({ ...ROW, revoked_at: new Date().toISOString() });
    expect(await resolveApiKey(`Bearer ${KEY.plaintext}`)).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("expired key → null, exactly like an unknown key", async () => {
    arm({ ...ROW, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await resolveApiKey(`Bearer ${KEY.plaintext}`)).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("a FUTURE expiry still resolves (expiry is a deadline, not a flag)", async () => {
    arm({ ...ROW, expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(await resolveApiKey(`Bearer ${KEY.plaintext}`)).not.toBeNull();
  });
});

describe("resolveApiKey — success + coarse last_used_at", () => {
  it("returns exactly {orgId, keyId, keyPrefix, scopes} for a live key", async () => {
    arm(ROW);
    const resolved = await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(resolved).toEqual({
      orgId: ROW.org_id,
      keyId: ROW.id,
      keyPrefix: ROW.key_prefix,
      scopes: ["read:jobs"],
    });
  });

  it("null scopes column degrades to [] (never undefined, never a throw)", async () => {
    arm({ ...ROW, scopes: null });
    const resolved = await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(resolved?.scopes).toEqual([]);
  });

  it("touches last_used_at when never used (WHERE re-checks the debounce in Postgres)", async () => {
    arm({ ...ROW, last_used_at: null });
    await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateOr).toHaveBeenCalledWith(
      expect.stringContaining("last_used_at.is.null,last_used_at.lt."),
    );
  });

  it("SKIPS the touch when used within the last minute (the fast-path)", async () => {
    arm({ ...ROW, last_used_at: new Date(Date.now() - 10_000).toISOString() });
    const resolved = await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(resolved).not.toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("touches again once the minute has passed", async () => {
    arm({
      ...ROW,
      last_used_at: new Date(Date.now() - LAST_USED_TOUCH_INTERVAL_MS - 1000).toISOString(),
    });
    await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("a FAILING touch never blocks authentication", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    arm(ROW);
    updateSpy.mockImplementation(() => {
      throw new Error("telemetry down");
    });
    const resolved = await resolveApiKey(`Bearer ${KEY.plaintext}`);
    expect(resolved).not.toBeNull();
    err.mockRestore();
  });
});

describe("shouldTouchLastUsed — the pure debounce predicate", () => {
  const now = Date.now();

  it("never-used → touch", () => {
    expect(shouldTouchLastUsed(null, now)).toBe(true);
  });

  it("used 30s ago → skip (coarse: at most one write per minute)", () => {
    expect(shouldTouchLastUsed(new Date(now - 30_000).toISOString(), now)).toBe(false);
  });

  it("used exactly at the interval boundary → touch", () => {
    expect(
      shouldTouchLastUsed(new Date(now - LAST_USED_TOUCH_INTERVAL_MS).toISOString(), now),
    ).toBe(true);
  });

  it("unparseable stored value → touch (self-heals instead of wedging)", () => {
    expect(shouldTouchLastUsed("not-a-date", now)).toBe(true);
  });
});
