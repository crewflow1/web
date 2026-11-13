import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auth email isolation (comms+recovery launch readiness).
 *
 * Load-bearing deliverability fact that no behavioural test can assert directly:
 * the magic-link and password-reset emails do NOT flow through Resend. They are
 * minted and sent by Supabase Auth (`signInWithOtp` / `resetPasswordForEmail`)
 * via Supabase's OWN SMTP, so their deliverability depends on the Supabase Auth
 * SMTP dashboard config (the outstanding founder/CEO step) — NOT on
 * RESEND_API_KEY and not on anything in lib/email/*.
 *
 * This is a source-level regression guard: if someone later re-routes an auth
 * email through the Resend transport (`lib/email/send.ts`) they would silently
 * couple login/reset deliverability to the Resend key + verified domain, and
 * change which dashboard an operator must configure. This test makes that change
 * fail loudly here. Additive; reads source only, sends nothing.
 */

const ROOT = join(__dirname, "..", "..");
const authActions = readFileSync(
  join(ROOT, "app", "(auth)", "actions.ts"),
  "utf8",
);

describe("auth emails route through Supabase Auth SMTP, not Resend", () => {
  it("auth actions use Supabase Auth for magic-link + password reset", () => {
    expect(authActions).toContain("signInWithOtp");
    expect(authActions).toContain("resetPasswordForEmail");
  });

  it("auth actions do NOT import the Resend transport (lib/email/send)", () => {
    // The single Resend wrapper is lib/email/send.ts, re-exported as
    // "@/lib/email/send". No auth path should import it, or auth deliverability
    // would silently depend on RESEND_API_KEY + a verified sender domain.
    expect(authActions).not.toMatch(/from\s+["']@\/lib\/email\/send["']/);
    expect(authActions).not.toMatch(/from\s+["']@\/lib\/email\//);
    expect(authActions).not.toMatch(/\bsendEmail\b/);
  });
});
