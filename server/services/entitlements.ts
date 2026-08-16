import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { isSelfServeBillingConfigured } from "@/lib/billing/self-serve";
import { planHasFeature } from "@/lib/billing/entitlements";
import { isPlanKey, type FeatureKey, type PlanKey } from "@/lib/billing/plans";

/**
 * ORG-level feature entitlement resolution — the server half of the gate.
 *
 * Reads the org's current plan (org_subscriptions projection → organizations.plan
 * fallback) and answers "does this org's plan include feature X?".
 *
 * ── THE DARK-ALLOW CONTRACT ──────────────────────────────────────────────────
 * While self-serve billing is dark (the two-switch gate is off), EVERY org
 * entitlement check returns ALLOW. So wiring orgHasEntitlement() into an existing
 * code path changes NOTHING in production until the feature is deliberately
 * switched on — the gate is inert by default. Only when billing is configured do
 * the catalogue's per-plan entitlements actually restrict anything.
 *
 * The plan→feature check itself is the pure, deterministic
 * lib/billing/entitlements.planHasFeature; this module only adds the DB read and
 * the dark override.
 */

/** Resolve the org's current plan_key from the DB (projection wins, else plan). */
export async function resolveOrgPlanKey(orgId: string): Promise<PlanKey> {
  const admin = createAdminClient();

  const subQ = admin.from("org_subscriptions" as never) as unknown as {
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: { plan_key?: string } | null;
          error: { message?: string | null; code?: string | null } | null;
        }>;
      };
    };
  };
  // Loud reads: a failed entitlement read must not silently degrade to 'trial'
  // (that would wrongly LOCK features). Bind error and throw.
  const { data: sub, error: subErr } = await subQ
    .select("plan_key")
    .eq("org_id", orgId)
    .maybeSingle();
  if (subErr) throw readFailure("entitlements: org_subscriptions", subErr);
  if (sub && isPlanKey(sub.plan_key)) return sub.plan_key;

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("plan" as never)
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) throw readFailure("entitlements: organizations plan", orgErr);
  const plan = (org as { plan?: string } | null)?.plan;
  return isPlanKey(plan) ? plan : "trial";
}

/**
 * Does this org's plan include `feature`? Returns TRUE (allow) whenever
 * self-serve billing is dark — the inert-by-default contract. Only enforces the
 * catalogue when billing is configured.
 */
export async function orgHasEntitlement(
  orgId: string,
  feature: FeatureKey,
): Promise<boolean> {
  if (!isSelfServeBillingConfigured()) return true; // dark ⇒ allow
  const planKey = await resolveOrgPlanKey(orgId);
  return planHasFeature(planKey, feature);
}
