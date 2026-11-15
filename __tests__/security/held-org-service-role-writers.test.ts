import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * D-17 — held-company (suspended / cancelled) read-only, application half.
 *
 * The database refuses USER-JWT writes for a held company (migration 20261346: a RESTRICTIVE
 * org_is_writable policy on every client-writable org table, ANDed with every permissive
 * policy). A server action that writes with the SERVICE ROLE bypasses RLS, so it must refuse a
 * held company ITSELF. This test inventories every tenant-facing server-action file that both
 * uses createAdminClient and writes, and requires each to either call a held-aware guard or
 * appear in EXEMPT with the reason it is allowed (platform HQ, pre-tenant auth/onboarding, or
 * owner configuration / billing / recovery that D-17 explicitly keeps working).
 */
const ROOT = resolve(__dirname, "../..");
const GUARDS =
  /\b(requireCapability|requireCapabilityFor|requireCapabilityApi|requireAnyCapability|assertOrgWritable|isHeldStatus)\b/;

const EXEMPT: Record<string, string> = {
  // owner configuration, billing and recovery — D-17 keeps these working for a held owner
  "app/(app)/settings/actions.ts": "company settings + own profile: owner configuration (settings:manage is held-exempt)",
  "app/(app)/settings/security/actions.ts": "owner security settings (MFA / recovery)",
  "app/(app)/settings/marketplace/actions.ts": "owner marketplace listing configuration",
  "app/(app)/settings/webhooks/actions.ts": "owner integration configuration",
  "app/(app)/onboarding/setup/actions.ts": "owner set-up checklist state (own organisation row, management-gated)",
  // pre-tenant / platform
  "app/(auth)/actions.ts": "sign-in / sign-up: no tenant context yet",
  "app/onboarding/company/actions.ts": "creates a NEW company: no held tenant exists yet",
  "app/onboarding/join/actions.ts": "accepting an invite into an ACTIVE company; membership checked server-side",
  "app/admin/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/ai-boardroom/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/ai-receptionist/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/alerts/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/billing/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/customers/[id]/_stripe-actions.ts": "CrewFlow HQ super-admin (billing recovery)",
  "app/admin/customers/actions.ts": "CrewFlow HQ super-admin (suspend / reactivate / cancel)",
  "app/admin/demos/actions.ts": "CrewFlow HQ super-admin",
  "app/admin/support/actions.ts": "CrewFlow HQ super-admin",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (/actions\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("held-company read-only — service-role server actions refuse a held company (D-17)", () => {
  const files = walk(resolve(ROOT, "app")).map((p) => p.slice(ROOT.length + 1));
  const writers = files.filter((f) => {
    const src = readFileSync(resolve(ROOT, f), "utf8");
    return /createAdminClient/.test(src) && /\.(insert|update|upsert|delete)\(/.test(src);
  });

  it("finds the writers (sanity)", () => {
    expect(writers.length).toBeGreaterThan(20);
  });

  it.each(writers)("%s is held-aware or explicitly exempt", (f) => {
    if (EXEMPT[f]) return;
    expect(GUARDS.test(readFileSync(resolve(ROOT, f), "utf8")), `${f} writes with the service role but has no held-aware guard`).toBe(true);
  });

  it("every EXEMPT entry still exists (no stale exemption hides a new writer)", () => {
    for (const f of Object.keys(EXEMPT)) expect(files, f).toContain(f);
  });
});
