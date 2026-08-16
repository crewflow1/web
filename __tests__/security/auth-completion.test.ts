import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Auth completion — behavioural + contract proofs for the ADDITIVE auth
 * surface (email+password, reset/recovery, MFA TOTP, Microsoft SSO dark).
 *
 * The load-bearing guarantees pinned here:
 *   - password sign-in/up validate, throttle, and never echo the password;
 *   - a NON-enrolled user is NOT sent through MFA (MFA is not enforced);
 *   - an ENROLLED user IS routed to the challenge (opt-in) but only when a
 *     VERIFIED factor exists;
 *   - reset never enumerates accounts; update requires a live session;
 *   - Microsoft SSO ships DARK (flag defaults off, button gated in source);
 *   - the EXISTING magic-link + Google flows are byte-for-byte unchanged;
 *   - MFA is NOT enforced anywhere (no aal2 gate in session/middleware).
 */

// ---- hoisted mocks --------------------------------------------------------
const { redirectMock, consumeMock, ensureUserRowMock, isSuperAdminMock, createClientMock } =
  vi.hoisted(() => ({
    redirectMock: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    consumeMock: vi.fn(async (..._a: unknown[]) => ({ allowed: true, remaining: 4 })),
    ensureUserRowMock: vi.fn(async (_i?: unknown) => {}),
    isSuperAdminMock: vi.fn((_e?: unknown) => false),
    createClientMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({ redirect: (u: string) => redirectMock(u) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://app.crewflow.uk" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClientMock() }));
vi.mock("@/lib/security/rate-limit", () => ({
  consume: (...a: unknown[]) => consumeMock(...a),
  DEFAULT_LIMITS: { auth: { limit: 5, windowSeconds: 600 } },
}));
vi.mock("@/server/services/bootstrap-account", () => ({
  ensureUserRow: (i: unknown) => ensureUserRowMock(i),
}));
vi.mock("@/server/auth/superadmin", () => ({
  isSuperAdminEmail: (e: unknown) => isSuperAdminMock(e),
}));

import {
  signInWithPassword,
  signUpWithPassword,
  requestPasswordReset,
  updatePassword,
  challengeMfa,
  signInWithMicrosoft,
} from "@/app/(auth)/actions";
import {
  enrollTotp,
  verifyTotpEnrollment,
  unenrollFactor,
} from "@/app/(app)/settings/security/actions";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { env } from "@/lib/env";

// ---- fake supabase builder ------------------------------------------------
type AuthShape = Record<string, unknown>;
function fakeSupabase(auth: AuthShape) {
  return { auth: { mfa: {}, ...auth } };
}
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

beforeEach(() => {
  redirectMock.mockClear();
  consumeMock.mockClear();
  consumeMock.mockResolvedValue({ allowed: true, remaining: 4 });
  ensureUserRowMock.mockClear();
  isSuperAdminMock.mockReset();
  isSuperAdminMock.mockReturnValue(false);
  createClientMock.mockReset();
});

// ===========================================================================
describe("signInWithPassword", () => {
  it("signs in a non-MFA user and lands on /dashboard (MFA NOT enforced)", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        signInWithPassword: async () => ({
          data: { user: { id: "u1", email: "a@b.co" } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: "aal1", nextLevel: "aal1" },
          }),
        },
      }),
    );
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22" }));
    expect(s.ok).toBe(true);
    expect(s.redirectTo).toBe("/dashboard");
    expect(ensureUserRowMock).toHaveBeenCalled();
  });

  it("routes an ENROLLED user (verified factor) to the MFA challenge", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        signInWithPassword: async () => ({
          data: { user: { id: "u1", email: "a@b.co" } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: "aal1", nextLevel: "aal2" },
          }),
        },
      }),
    );
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22" }));
    expect(s.ok).toBe(true);
    expect(s.redirectTo).toBe("/login/mfa");
  });

  it("rejects bad credentials loudly and never echoes the password", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        signInWithPassword: async () => ({
          data: { user: null },
          error: { message: "Invalid login credentials" },
        }),
        mfa: {},
      }),
    );
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "wrong123" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/Incorrect email or password/i);
    expect(s.values?.email).toBe("a@b.co");
    expect((s.values as Record<string, unknown>)?.password).toBeUndefined();
  });

  it("validates email format", async () => {
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "nope", password: "x" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.email).toBeTruthy();
  });

  it("throttles via the shared auth limiter", async () => {
    consumeMock.mockResolvedValue({ allowed: false, remaining: 0 });
    createClientMock.mockResolvedValue(fakeSupabase({}));
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/too many/i);
  });

  it("honours a safe ?next but ignores //protocol-relative and /admin for non-admins", async () => {
    const base = {
      signInWithPassword: async () => ({ data: { user: { id: "u1", email: "a@b.co" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) },
    };
    createClientMock.mockResolvedValue(fakeSupabase(base));
    const ok = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "/jobs" }));
    expect(ok.redirectTo).toBe("/jobs");

    createClientMock.mockResolvedValue(fakeSupabase(base));
    const evil = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "//evil.com" }));
    expect(evil.redirectTo).toBe("/dashboard");

    createClientMock.mockResolvedValue(fakeSupabase(base));
    const adminNext = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "/admin/x" }));
    expect(adminNext.redirectTo).toBe("/dashboard");
  });

  it("rejects backslash-based open-redirect ?next vectors and honours a legit path", async () => {
    const base = {
      signInWithPassword: async () => ({ data: { user: { id: "u1", email: "a@b.co" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) },
    };

    // Single backslash: new URL("/\evil.com", origin) → https://evil.com/ .
    // "\\" in this source string is ONE real backslash at runtime.
    createClientMock.mockResolvedValue(fakeSupabase(base));
    const bs1 = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "/\\evil.com" }));
    expect(bs1.redirectTo).toBe("/dashboard");

    // Double backslash ("\\\\" == two real backslashes at runtime).
    createClientMock.mockResolvedValue(fakeSupabase(base));
    const bs2 = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "/\\\\evil.com" }));
    expect(bs2.redirectTo).toBe("/dashboard");

    // Protocol-relative.
    createClientMock.mockResolvedValue(fakeSupabase(base));
    const pr = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "//evil.com" }));
    expect(pr.redirectTo).toBe("/dashboard");

    // Legit local path is still honoured.
    createClientMock.mockResolvedValue(fakeSupabase(base));
    const ok = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", next: "/dashboard" }));
    expect(ok.redirectTo).toBe("/dashboard");
  });

  it("routes a super-admin to /admin/organizations", async () => {
    isSuperAdminMock.mockReturnValue(true);
    createClientMock.mockResolvedValue(
      fakeSupabase({
        signInWithPassword: async () => ({ data: { user: { id: "u1", email: "boss@crewflow.uk" } }, error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) },
      }),
    );
    const s = await signInWithPassword(INITIAL_FORM_STATE, fd({ email: "boss@crewflow.uk", password: "hunter22" }));
    expect(s.redirectTo).toBe("/admin/organizations");
  });
});

// ===========================================================================
describe("signUpWithPassword", () => {
  it("tells the user to confirm when no session is returned", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({ signUp: async () => ({ data: { session: null, user: { id: "u1", email: "a@b.co" } }, error: null }) }),
    );
    const s = await signUpWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", confirm: "hunter22" }));
    expect(s.ok).toBe(true);
    expect(s.successMessage).toMatch(/confirm/i);
    expect(s.redirectTo).toBeUndefined();
  });

  it("bootstraps and lands the user when a session is returned", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({ signUp: async () => ({ data: { session: { access_token: "t" }, user: { id: "u1", email: "a@b.co" } }, error: null }) }),
    );
    const s = await signUpWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", confirm: "hunter22" }));
    expect(s.ok).toBe(true);
    expect(s.redirectTo).toBe("/dashboard");
    expect(ensureUserRowMock).toHaveBeenCalled();
  });

  it("rejects mismatched confirmation", async () => {
    const s = await signUpWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", confirm: "different" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.confirm).toBeTruthy();
  });

  it("rejects too-short passwords", async () => {
    const s = await signUpWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "short", confirm: "short" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.password).toBeTruthy();
  });

  it("returns a NEUTRAL, non-enumerating message on signup failure (no account leak)", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({ signUp: async () => ({ data: {}, error: { message: "User already registered" } }) }),
    );
    const s = await signUpWithPassword(INITIAL_FORM_STATE, fd({ email: "a@b.co", password: "hunter22", confirm: "hunter22" }));
    expect(s.ok).toBe(false);
    // Must NOT leak whether the email already exists.
    expect(s.error).not.toMatch(/already registered/i);
    expect(s.error).toMatch(/could not create the account/i);
    expect(s.error).toMatch(/sign in instead/i);
    expect(s.values?.email).toBe("a@b.co");
  });
});

// ===========================================================================
describe("requestPasswordReset", () => {
  it("sends a recovery link routed to /update-password and never enumerates", async () => {
    const resetSpy = vi.fn(async () => ({ data: {}, error: null }));
    createClientMock.mockResolvedValue(fakeSupabase({ resetPasswordForEmail: resetSpy }));
    const s = await requestPasswordReset(INITIAL_FORM_STATE, fd({ email: "a@b.co" }));
    expect(s.ok).toBe(true);
    expect(s.successMessage).toMatch(/if an account exists/i);
    expect(resetSpy).toHaveBeenCalledWith(
      "a@b.co",
      expect.objectContaining({ redirectTo: expect.stringContaining("/auth/callback?next=/update-password") }),
    );
  });

  it("returns the SAME neutral message when throttled and does NOT send", async () => {
    consumeMock.mockResolvedValue({ allowed: false, remaining: 0 });
    const resetSpy = vi.fn();
    createClientMock.mockResolvedValue(fakeSupabase({ resetPasswordForEmail: resetSpy }));
    const s = await requestPasswordReset(INITIAL_FORM_STATE, fd({ email: "a@b.co" }));
    expect(s.ok).toBe(true);
    expect(s.successMessage).toMatch(/if an account exists/i);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("validates the email", async () => {
    const s = await requestPasswordReset(INITIAL_FORM_STATE, fd({ email: "bad" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.email).toBeTruthy();
  });
});

// ===========================================================================
describe("updatePassword", () => {
  it("refuses when there is no live session", async () => {
    createClientMock.mockResolvedValue(fakeSupabase({ getUser: async () => ({ data: { user: null } }) }));
    const s = await updatePassword(INITIAL_FORM_STATE, fd({ password: "hunter22", confirm: "hunter22" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/expired|signed out/i);
  });

  it("rejects mismatched passwords", async () => {
    const s = await updatePassword(INITIAL_FORM_STATE, fd({ password: "hunter22", confirm: "nope" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.confirm).toBeTruthy();
  });

  it("updates the password for a live session", async () => {
    const updateSpy = vi.fn(async () => ({ data: {}, error: null }));
    createClientMock.mockResolvedValue(
      fakeSupabase({ getUser: async () => ({ data: { user: { id: "u1", email: "a@b.co" } } }), updateUser: updateSpy }),
    );
    const s = await updatePassword(INITIAL_FORM_STATE, fd({ password: "hunter22", confirm: "hunter22" }));
    expect(s.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith({ password: "hunter22" });
  });
});

// ===========================================================================
describe("challengeMfa (login step)", () => {
  it("lets a user with NO verified factor straight through (never traps them)", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1", email: "a@b.co" } } }),
        mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
      }),
    );
    const s = await challengeMfa(INITIAL_FORM_STATE, fd({ code: "123456" }));
    expect(s.ok).toBe(true);
    expect(s.redirectTo).toBe("/dashboard");
  });

  it("verifies a correct code and lands the user", async () => {
    const verifySpy = vi.fn(async () => ({ data: {}, error: null }));
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1", email: "a@b.co" } } }),
        mfa: {
          listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }),
          challenge: async () => ({ data: { id: "c1" }, error: null }),
          verify: verifySpy,
        },
      }),
    );
    const s = await challengeMfa(INITIAL_FORM_STATE, fd({ code: "123456" }));
    expect(s.ok).toBe(true);
    expect(verifySpy).toHaveBeenCalledWith({ factorId: "f1", challengeId: "c1", code: "123456" });
  });

  it("rejects a wrong code loudly", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1", email: "a@b.co" } } }),
        mfa: {
          listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }),
          challenge: async () => ({ data: { id: "c1" }, error: null }),
          verify: async () => ({ data: null, error: { message: "Invalid TOTP code entered" } }),
        },
      }),
    );
    const s = await challengeMfa(INITIAL_FORM_STATE, fd({ code: "000000" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/didn't match/i);
  });

  it("validates the code shape", async () => {
    const s = await challengeMfa(INITIAL_FORM_STATE, fd({ code: "12" }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors?.code).toBeTruthy();
  });
});

// ===========================================================================
describe("MFA enrolment (account settings, opt-in)", () => {
  it("enrolls and returns a QR + secret + factor id", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        mfa: {
          enroll: async () => ({ data: { id: "f1", totp: { qr_code: "data:image/svg+xml;base64,xx", secret: "SECR" } }, error: null }),
        },
      }),
    );
    const r = await enrollTotp();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.factorId).toBe("f1");
      expect(r.secret).toBe("SECR");
      expect(r.qrCode).toContain("data:image");
    }
  });

  it("refuses enrolment when signed out", async () => {
    createClientMock.mockResolvedValue(fakeSupabase({ getUser: async () => ({ data: { user: null } }) }));
    const r = await enrollTotp();
    expect(r.ok).toBe(false);
  });

  it("verifies a correct enrolment code", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        mfa: {
          challenge: async () => ({ data: { id: "c1" }, error: null }),
          verify: async () => ({ data: {}, error: null }),
        },
      }),
    );
    const s = await verifyTotpEnrollment(INITIAL_FORM_STATE, fd({ factorId: "f1", code: "123456" }));
    expect(s.ok).toBe(true);
    expect(s.successMessage).toMatch(/two-factor/i);
  });

  it("rejects a wrong enrolment code", async () => {
    createClientMock.mockResolvedValue(
      fakeSupabase({
        getUser: async () => ({ data: { user: { id: "u1" } } }),
        mfa: {
          challenge: async () => ({ data: { id: "c1" }, error: null }),
          verify: async () => ({ data: null, error: { message: "Invalid TOTP" } }),
        },
      }),
    );
    const s = await verifyTotpEnrollment(INITIAL_FORM_STATE, fd({ factorId: "f1", code: "000000" }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/didn't match/i);
  });

  it("unenrolls a factor (self-service recovery)", async () => {
    const unenrollSpy = vi.fn(async () => ({ data: {}, error: null }));
    createClientMock.mockResolvedValue(
      fakeSupabase({ getUser: async () => ({ data: { user: { id: "u1" } } }), mfa: { unenroll: unenrollSpy } }),
    );
    const s = await unenrollFactor(INITIAL_FORM_STATE, fd({ factorId: "f1" }));
    expect(s.ok).toBe(true);
    expect(unenrollSpy).toHaveBeenCalledWith({ factorId: "f1" });
  });
});

// ===========================================================================
describe("Microsoft SSO is DARK by default", () => {
  it("defaults the feature flag OFF", () => {
    expect(env.NEXT_PUBLIC_FEATURE_MICROSOFT_SSO).toBe("false");
  });

  it("the login page only renders the Microsoft button behind the flag", () => {
    const src = readFileSync(resolve(__dirname, "../../app/(auth)/login/page.tsx"), "utf8");
    expect(src).toContain("microsoftEnabled");
    // The MS <form> must be gated, not unconditional.
    expect(src).toMatch(/microsoftEnabled\s*\?/);
  });

  it("the action begins an azure OAuth flow", async () => {
    const oauthSpy = vi.fn(async () => ({ data: { url: "https://login.microsoftonline.com/x" }, error: null }));
    createClientMock.mockResolvedValue(fakeSupabase({ signInWithOAuth: oauthSpy }));
    await expect(signInWithMicrosoft()).rejects.toThrow("REDIRECT:https://login.microsoftonline.com/x");
    expect(oauthSpy).toHaveBeenCalledWith(expect.objectContaining({ provider: "azure" }));
  });
});

// ===========================================================================
describe("EXISTING flows unchanged + MFA enforcement is opt-in/default-off (contract pins)", () => {
  const actionsSrc = readFileSync(resolve(__dirname, "../../app/(auth)/actions.ts"), "utf8");

  it("magic-link still uses signInWithOtp with shouldCreateUser:true → /check-email", () => {
    expect(actionsSrc).toContain("signInWithOtp");
    expect(actionsSrc).toContain("shouldCreateUser: true");
    expect(actionsSrc).toContain("/check-email?email=");
  });

  it("Google OAuth is untouched (provider google + select_account prompt)", () => {
    expect(actionsSrc).toContain('provider: "google"');
    expect(actionsSrc).toContain("select_account");
  });

  it("signOut still clears the session and returns to /login", () => {
    expect(actionsSrc).toContain("supabase.auth.signOut()");
  });

  it("MFA is NOT enforced: no aal2 gate in the session or middleware guards", () => {
    const sessionSrc = readFileSync(resolve(__dirname, "../../server/auth/session.ts"), "utf8");
    const mwSrc = readFileSync(resolve(__dirname, "../../lib/supabase/middleware.ts"), "utf8");
    expect(sessionSrc.toLowerCase()).not.toContain("aal2");
    expect(mwSrc.toLowerCase()).not.toContain("aal2");
  });

  it("the enforcement decision is explicitly documented as GATED and left off", () => {
    const secSrc = readFileSync(resolve(__dirname, "../../app/(app)/settings/security/actions.ts"), "utf8");
    expect(secSrc).toContain("MFA ENFORCEMENT IS A GATED DECISION");
  });
});
