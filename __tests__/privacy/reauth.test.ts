import { describe, expect, it, vi } from "vitest";

// reauth.ts builds a cookie-bound client only for its DEFAULT session reader;
// every test here injects its own, so the cookie client is never constructed.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("cookie client must not be used in these tests");
  },
}));

import {
  REAUTH_MAX_AGE_SECONDS,
  isSessionFresh,
  newestAuthentication,
  verifyReauthentication,
} from "@/server/auth/reauth";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000;

/** An unsigned JWT-shaped token carrying `payload` (reauth never trusts the signature itself). */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("re-authentication — reading the session's newest real authentication", () => {
  it("takes the NEWEST amr entry and ignores token refreshes", () => {
    const t = token({
      sub: USER,
      amr: [
        { method: "otp", timestamp: NOW - 5000 },
        { method: "password", timestamp: NOW - 120 },
        { method: "token_refresh", timestamp: NOW - 1 },
      ],
    });
    expect(newestAuthentication(t)).toEqual({ sub: USER, at: NOW - 120 });
  });

  it("returns null for anything malformed (never 'fresh by default')", () => {
    for (const bad of [
      "",
      "not-a-jwt",
      "a.b",
      `x.${Buffer.from("not json").toString("base64url")}.y`,
      token({ sub: USER }),
      token({ sub: USER, amr: [] }),
      token({ sub: USER, amr: "password" }),
      token({ sub: USER, amr: [{ method: "password", timestamp: "now" }] }),
      token({ amr: [{ method: "password", timestamp: NOW }] }),
      token({ sub: USER, amr: [{ method: "token_refresh", timestamp: NOW }] }),
    ]) {
      expect(newestAuthentication(bad), bad).toBeNull();
      expect(isSessionFresh(bad, USER, NOW), bad).toBe(false);
    }
  });

  it("is fresh only inside the window, for the SAME user, and never from the future", () => {
    const at = (age: number) => token({ sub: USER, amr: [{ method: "otp", timestamp: NOW - age }] });
    expect(isSessionFresh(at(0), USER, NOW)).toBe(true);
    expect(isSessionFresh(at(REAUTH_MAX_AGE_SECONDS), USER, NOW)).toBe(true);
    expect(isSessionFresh(at(REAUTH_MAX_AGE_SECONDS + 1), USER, NOW)).toBe(false);
    expect(isSessionFresh(at(6 * 3600), USER, NOW)).toBe(false);
    expect(isSessionFresh(at(-3600), USER, NOW), "a future timestamp is not freshness").toBe(false);
    expect(isSessionFresh(at(0), "22222222-2222-4222-8222-222222222222", NOW), "someone else's token").toBe(false);
  });
});

describe("re-authentication — verifyReauthentication", () => {
  const user = { id: USER, email: "person@example.test" };
  const fresh = token({ sub: USER, amr: [{ method: "otp", timestamp: NOW - 30 }] });
  const stale = token({ sub: USER, amr: [{ method: "otp", timestamp: NOW - 7200 }] });
  const now = () => new Date(NOW * 1000);

  it("accepts a correct password, checked for the SESSION user's email", async () => {
    const verifyPassword = vi.fn(async () => true);
    const r = await verifyReauthentication({ user, password: "correct horse" }, { verifyPassword, now });
    expect(r).toEqual({ ok: true, method: "password" });
    expect(verifyPassword).toHaveBeenCalledWith("person@example.test", "correct horse");
  });

  it("a WRONG password is a refusal — it never falls back to a fresh session", async () => {
    const currentAccessToken = vi.fn(async () => fresh);
    const r = await verifyReauthentication(
      { user, password: "wrong" },
      { verifyPassword: async () => false, currentAccessToken, now },
    );
    expect(r).toMatchObject({ ok: false, code: "password_incorrect" });
    expect(currentAccessToken).not.toHaveBeenCalled();
  });

  it("no password: a just-established session is accepted, a stale one is not", async () => {
    const verifyPassword = vi.fn(async () => true);
    expect(
      await verifyReauthentication({ user, password: "" }, { verifyPassword, currentAccessToken: async () => fresh, now }),
    ).toEqual({ ok: true, method: "recent_session" });
    expect(
      await verifyReauthentication({ user }, { verifyPassword, currentAccessToken: async () => stale, now }),
    ).toMatchObject({ ok: false, code: "stale_session" });
    expect(
      await verifyReauthentication({ user }, { verifyPassword, currentAccessToken: async () => null, now }),
    ).toMatchObject({ ok: false, code: "stale_session" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("a fresh token belonging to a DIFFERENT user proves nothing", async () => {
    const other = token({ sub: "22222222-2222-4222-8222-222222222222", amr: [{ method: "otp", timestamp: NOW - 5 }] });
    expect(
      await verifyReauthentication({ user }, { currentAccessToken: async () => other, now }),
    ).toMatchObject({ ok: false, code: "stale_session" });
  });

  it("fails CLOSED when the auth check itself errors", async () => {
    const boom = async () => {
      throw new Error("auth is down");
    };
    expect(await verifyReauthentication({ user, password: "x" }, { verifyPassword: boom, now })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await verifyReauthentication({ user }, { currentAccessToken: boom, now })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("a password cannot be checked for a user with no email", async () => {
    const verifyPassword = vi.fn(async () => true);
    const r = await verifyReauthentication({ user: { id: USER, email: null }, password: "x" }, { verifyPassword, now });
    expect(r).toMatchObject({ ok: false, code: "password_incorrect" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});
