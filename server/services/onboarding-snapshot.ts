import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  OnboardingSnapshot,
  ChecklistStepId,
} from "@/lib/onboarding/checklist";

/**
 * Build the live onboarding snapshot for an org.
 *
 * Uses the user JWT (server client) so RLS scopes everything to the
 * caller's org automatically. Counts are HEAD requests with
 * `count: "exact"` — fast and don't pull row data we won't use.
 *
 * The `dismissed_steps` array lives on organizations.onboarding_state
 * jsonb (already a column) under key "dismissed_steps". We preserve
 * any other keys the rest of the app writes there.
 */

export type DismissedStepsJson = {
  dismissed_steps?: string[];
  /** Best-effort stamp of when the operator first opened /onboarding/setup. */
  started_at?: string | null;
  /** Stamped when computeProgress().pct first hits 100. */
  completed_at?: string | null;
  // Other keys may exist (e.g. "company": true from initial signup).
  [k: string]: unknown;
};

export async function buildOnboardingSnapshot(
  orgId: string,
): Promise<OnboardingSnapshot> {
  const supabase = await createClient();

  // Fetch the org row in one shot.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select(
      "name, phone, email, vat_number, logo_url, bank_details, default_terms, address, onboarding_state",
    )
    .eq("id", orgId)
    .maybeSingle();

  // Parallel counts — none of them touch the same table, so they fan
  // out concurrently and the response time is dominated by the slowest.
  const [
    { count: staffMembers },
    { count: customers },
    { count: invoices },
    { count: quotes },
    { count: importsCommitted },
  ] = await Promise.all([
    supabase
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .neq("role", "owner"),
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    supabase
      .from("quotes")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId),
    supabase
      .from("imports")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "committed"),
  ]);

  const onboardingState = (orgRow?.onboarding_state ??
    {}) as DismissedStepsJson;
  const dismissedArr = Array.isArray(onboardingState.dismissed_steps)
    ? onboardingState.dismissed_steps
    : [];
  const VALID_IDS: ReadonlyArray<ChecklistStepId> = [
    "company_profile",
    "logo",
    "vat",
    "bank",
    "terms",
    "staff",
    "customers",
    "imports",
    "invoices_import",
    "first_quote",
    "first_invoice",
    "connect_email",
  ];
  const dismissed = new Set<ChecklistStepId>(
    dismissedArr.filter((s): s is ChecklistStepId =>
      VALID_IDS.includes(s as ChecklistStepId),
    ),
  );

  const startedAtRaw = onboardingState.started_at;
  const completedAtRaw = onboardingState.completed_at;
  return {
    org: {
      name: orgRow?.name ?? null,
      phone: orgRow?.phone ?? null,
      email: (orgRow?.email as string | null) ?? null,
      vat_number: orgRow?.vat_number ?? null,
      logo_url: orgRow?.logo_url ?? null,
      bank_details:
        (orgRow?.bank_details as OnboardingSnapshot["org"]["bank_details"]) ??
        null,
      default_terms: orgRow?.default_terms ?? null,
      address:
        (orgRow?.address as OnboardingSnapshot["org"]["address"]) ?? null,
    },
    counts: {
      staffMembers: staffMembers ?? 0,
      customers: customers ?? 0,
      invoices: invoices ?? 0,
      quotes: quotes ?? 0,
      importsCommitted: importsCommitted ?? 0,
    },
    dismissed,
    timestamps: {
      started_at: typeof startedAtRaw === "string" ? startedAtRaw : null,
      completed_at: typeof completedAtRaw === "string" ? completedAtRaw : null,
    },
  };
}
