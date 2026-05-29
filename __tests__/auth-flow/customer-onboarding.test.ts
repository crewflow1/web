import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer onboarding sign-in contract pins.
 *
 * The CEO blocker: Supabase's default invite email used PKCE-locked
 * code-exchange that fails on cross-device / incognito / desktop. We
 * now bypass Supabase's invite email entirely and send our own
 * branded link via Resend that the callback exchanges via verifyOtp
 * (no PKCE verifier required).
 *
 * Lock the contract so a future change can't silently break this
 * again.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("promoteDemoToCustomer no longer relies on Supabase's invite email", () => {
  const src = read("server/services/demo-lifecycle.ts");

  it("does NOT call admin.auth.admin.inviteUserByEmail (only mentioned in historical comments)", () => {
    // The call signature would look like `.inviteUserByEmail(` — comments
    // about the historical bug are allowed (they're educational).
    expect(src).not.toMatch(/\.inviteUserByEmail\(/);
  });

  it("uses createUser with email_confirm: true so the account is verified", () => {
    expect(src).toMatch(/admin\.auth\.admin\.createUser/);
    expect(src).toMatch(/email_confirm:\s*true/);
  });

  it("generates a magic-link URL via auth.admin.generateLink (type=magiclink)", () => {
    expect(src).toMatch(/admin\.auth\.admin\.generateLink/);
    expect(src).toMatch(/type:\s*"magiclink"/);
  });

  it("captures action_link from the generateLink response", () => {
    expect(src).toMatch(/action_link/);
  });

  it("sends the branded onboarding email with the magic link URL via Resend", () => {
    expect(src).toMatch(/customerOnboardingEmail/);
    expect(src).toMatch(/magicLinkUrl/);
  });

  it("handles existing auth user idempotently (createUser → already-exists fallback)", () => {
    expect(src).toMatch(/already (registered|exists|signed|been)/i);
    expect(src).toMatch(/auth_user_already_existed/);
  });
});

describe("customerOnboardingEmail template", () => {
  const src = read("lib/email/demo-templates.ts");

  it("exports customerOnboardingEmail (replaces onboardingWelcomeEmail)", () => {
    expect(src).toMatch(/export function customerOnboardingEmail/);
    expect(src).not.toMatch(/export function onboardingWelcomeEmail/);
  });

  it("renders the magic link as the primary CTA when provided", () => {
    expect(src).toMatch(/magicLinkUrl: string \| null/);
    expect(src).toMatch(/Sign in to/);
  });

  it("explains the single-use + recovery story to the customer", () => {
    expect(src).toMatch(/single-use/i);
    expect(src).toMatch(/fresh one/i);
  });

  it("mentions Google as an alternative sign-in path", () => {
    expect(src).toMatch(/Google/);
  });
});

describe("/auth/callback handles both verifyOtp and code-exchange flows", () => {
  const src = read("app/auth/callback/route.ts");

  it("reads token_hash + type query params", () => {
    expect(src).toMatch(/searchParams\.get\("token_hash"\)/);
    expect(src).toMatch(/searchParams\.get\("type"\)/);
  });

  it("calls verifyOtp when token_hash is present", () => {
    expect(src).toMatch(/supabase\.auth\.verifyOtp/);
  });

  it("keeps exchangeCodeForSession for OAuth / PKCE flow", () => {
    expect(src).toMatch(/exchangeCodeForSession/);
  });

  it("classifies Supabase 'already used' / 'expired' / 'invalid' errors distinctly", () => {
    expect(src).toMatch(/magic_link_used/);
    expect(src).toMatch(/magic_link_expired/);
    expect(src).toMatch(/magic_link_invalid/);
  });

  it("logs every failure path with structured context", () => {
    expect(src).toMatch(/event:\s*"auth\.callback\.error"/);
    expect(src).toMatch(/event:\s*"auth\.callback\.success"/);
  });

  it("redirects to /login with email hint when known so the form pre-fills", () => {
    expect(src).toMatch(/u\.searchParams\.set\("email", emailHint\)/);
  });

  it("super-admin always lands on /admin even with ?next=/dashboard", () => {
    expect(src).toMatch(/safeExplicit && safeExplicit\.startsWith\("\/admin"\)/);
  });
});

describe("/login page surfaces actionable errors", () => {
  const src = read("app/(auth)/login/page.tsx");

  it("reads ?email= query param and pre-fills the magic-link form", () => {
    expect(src).toMatch(/email\?:\s*string/);
    expect(src).toMatch(/defaultValue=\{emailHint\}/);
  });

  it("handles the new error codes from the callback", () => {
    expect(src).toMatch(/magic_link_used/);
    expect(src).toMatch(/magic_link_expired/);
    expect(src).toMatch(/magic_link_invalid/);
  });

  it("autofocuses the magic-link email field when arriving from a recoverable error", () => {
    expect(src).toMatch(/autoFocus=\{isRecoverableError\}/);
  });

  it("CTA label shifts to 'Send me a fresh magic link' on recoverable error", () => {
    expect(src).toMatch(/Send me a fresh magic link/);
  });
});

describe("HQ remains gated on isSuperAdminEmail only", () => {
  it("admin layout still uses isSuperAdminEmail + notFound (customers can't access)", () => {
    const src = read("app/admin/layout.tsx");
    expect(src).toMatch(/isSuperAdminEmail/);
    expect(src).toMatch(/notFound\(\)/);
  });
});

describe("Post-login redirect", () => {
  const callback = read("app/auth/callback/route.ts");

  it("non-super-admin default landing is /dashboard (their workspace)", () => {
    expect(callback).toMatch(/fallback = isAdmin \? "\/admin\/organizations" : "\/dashboard"/);
  });

  it("dashboard route uses requireOrgContext → onboarding/company if no org, else workspace", () => {
    const session = read("server/auth/session.ts");
    expect(session).toMatch(/if \(!ctx\) redirect\("\/onboarding\/company"\)/);
  });
});
