import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mfaGateDecision,
  isPrivilegedRole,
  MFA_PRIVILEGED_ROLES,
} from "@/lib/auth/mfa-policy";

/**
 * SECURITY — enforceable per-org MFA (org flag `require_mfa`, migration
 * 20261169000000).
 *
 * The decision is pure + FAIL-CLOSED: a privileged member of an MFA-required
 * org is blocked unless we can positively confirm an aal2 session. Default-off
 * is proven to change nothing. Source assertions pin the wiring in
 * requireOrgContext so a future edit can't quietly drop the gate or turn a null
 * flag into an open door.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const aal2 = { currentLevel: "aal2", nextLevel: "aal2" };
const aal1WithFactor = { currentLevel: "aal1", nextLevel: "aal2" };
const aal1NoFactor = { currentLevel: "aal1", nextLevel: "aal1" };

describe("mfaGateDecision — default OFF changes nothing", () => {
  for (const role of ["owner", "admin", "member", "staff"]) {
    it(`require_mfa=false → allow for role=${role}`, () => {
      expect(mfaGateDecision({ requireMfa: false, role, aal: aal1NoFactor })).toBe("allow");
      expect(mfaGateDecision({ requireMfa: false, role, aal: null })).toBe("allow");
    });
  }
});

describe("mfaGateDecision — enforcement targets ONLY privileged roles", () => {
  for (const role of ["member", "staff", "viewer", "", null, undefined]) {
    it(`non-privileged role=${String(role)} is never gated even when required`, () => {
      expect(mfaGateDecision({ requireMfa: true, role, aal: aal1NoFactor })).toBe("allow");
    });
  }
  it("owner + admin are the privileged roles", () => {
    expect(MFA_PRIVILEGED_ROLES).toEqual(["owner", "admin"]);
    expect(isPrivilegedRole("owner")).toBe(true);
    expect(isPrivilegedRole("admin")).toBe(true);
    expect(isPrivilegedRole("member")).toBe(false);
  });
});

describe("mfaGateDecision — privileged member in a required org", () => {
  for (const role of ["owner", "admin"]) {
    it(`${role} at aal2 → allow`, () => {
      expect(mfaGateDecision({ requireMfa: true, role, aal: aal2 })).toBe("allow");
    });
    it(`${role} at aal1 WITH a verified factor → challenge`, () => {
      expect(mfaGateDecision({ requireMfa: true, role, aal: aal1WithFactor })).toBe("challenge");
    });
    it(`${role} at aal1 with NO factor → enroll`, () => {
      expect(mfaGateDecision({ requireMfa: true, role, aal: aal1NoFactor })).toBe("enroll");
    });
    it(`${role} with UNKNOWN aal → enroll (FAIL-CLOSED, never allow)`, () => {
      expect(mfaGateDecision({ requireMfa: true, role, aal: null })).toBe("enroll");
      expect(mfaGateDecision({ requireMfa: true, role, aal: undefined })).toBe("enroll");
      expect(
        mfaGateDecision({ requireMfa: true, role, aal: { currentLevel: null, nextLevel: null } }),
      ).toBe("enroll");
    });
  }

  it("the only allow path under enforcement is a positively-confirmed aal2", () => {
    // Exhaustive: for a privileged role, allow iff currentLevel === "aal2".
    const levels = ["aal1", "aal2", null, undefined, "bogus"];
    for (const current of levels) {
      for (const next of levels) {
        const d = mfaGateDecision({
          requireMfa: true,
          role: "owner",
          aal: { currentLevel: current as string | null, nextLevel: next as string | null },
        });
        if (d === "allow") expect(current).toBe("aal2");
      }
    }
  });
});

describe("requireOrgContext — enforcement wiring is present + fail-closed", () => {
  const src = codeOf(read("server/auth/session.ts"));

  it("consults the pure decision on the resolved org context", () => {
    expect(src).toContain("mfaGateDecision");
    expect(src).toContain("enforceMfaPolicy");
  });

  it("default-off fast path: returns early when require_mfa is false", () => {
    expect(src).toMatch(/if \(!ctx\.org\.require_mfa\) return/);
  });

  it("exempts super-admins (HQ staff never gated by a tenant policy)", () => {
    expect(src).toMatch(/isSuperAdminEmail\(user\.email\)\) return/);
  });

  it("resolves AAL fail-closed (any error → null → enroll, never a pass)", () => {
    expect(src).toMatch(/catch\s*\{[\s\S]*?aal = null/);
  });

  it("redirects challenge → /login/mfa and enroll → /settings/security", () => {
    expect(src).toContain('redirect("/login/mfa")');
    expect(src).toContain('/settings/security?mfa=required');
  });

  it("allow-lists the enrol/challenge surfaces to prevent a redirect loop", () => {
    expect(src).toContain("MFA_GATE_ALLOWED_PREFIXES");
    expect(src).toContain("/settings/security");
    expect(src).toContain("onAllowedSurface");
  });
});

describe("require_mfa never defaults ON from a null column", () => {
  const src = codeOf(read("server/auth/session.ts"));
  it("a null/absent require_mfa resolves to false", () => {
    expect(src).toMatch(/require_mfa: row\.require_mfa \?\? false/);
  });
  it("the migration ships the flag default false", () => {
    const mig = read("supabase/migrations/20261169000000_org_mfa_policy.sql");
    expect(mig).toMatch(/require_mfa boolean not null default false/i);
  });
});
