import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Ensure a `public.users` row exists that mirrors `auth.users`.
 *
 * Called from /auth/callback after a successful code exchange. We use the
 * service-role client because:
 *   - The user has a valid JWT at this point but RLS on `public.users`
 *     has no INSERT policy by design — bootstrap is a privileged op.
 *   - Idempotent via upsert: re-running on every login is safe.
 */
export async function ensureUserRow(input: {
  id: string;
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("users")
    .upsert(
      {
        id: input.id,
        email: input.email,
        full_name: input.fullName ?? null,
        avatar_url: input.avatarUrl ?? null,
        phone: input.phone ?? null,
      },
      { onConflict: "id" },
    );

  if (error) {
    console.error("[bootstrap] ensureUserRow failed", error);
    throw new Error("Failed to provision user record");
  }
}

/**
 * Create an organisation + owner membership in one go.
 *
 * Service-role client because:
 *   - At call time the user has no membership yet, so RLS on the orgs
 *     table can't yet evaluate `org_id in current_org_ids()`.
 *   - We want this to feel atomic. Supabase doesn't expose multi-statement
 *     transactions over PostgREST, so we do best-effort and roll back the
 *     org if the membership insert fails.
 */
export async function createOrgWithOwner(input: {
  userId: string;
  /** Caller may pass the user's email so we can look up an approved demo_request. */
  userEmail?: string | null;
  name: string;
  slug: string;
  phone?: string | null;
  vatNumber?: string | null;
  postcode?: string | null;
}): Promise<{ orgId: string }> {
  const supabase = createAdminClient();

  // Auto-trial wiring (migration 20260603000000): if the signing-up
  // user's email matches an approved demo_request, the CEO has
  // already pre-approved them — start the 14-day trial immediately
  // instead of dropping them at /access-pending. Trial window is
  // anchored to right now so the customer gets the full 14 days.
  let initialStatus: "pending" | "trial" = "pending";
  let trialEndsAt: string | null = null;
  let approvedDemoId: string | null = null;
  if (input.userEmail) {
    const normalisedEmail = input.userEmail.trim().toLowerCase();
    // approved_at landed in migration 20260603000000 and isn't in the
    // generated types yet — cast through unknown so tsc is happy until
    // the next `pnpm db:generate`.
    //
    // Demos can be approved via two surfaces today:
    //   1. /admin/organizations (legacy) — writes status='approved'.
    //   2. /admin/demos kanban (current) — writes status='won' (the
    //      new lifecycle vocab from app/admin/demos/actions.ts).
    //
    // Accept BOTH so a customer approved via either surface gets
    // their 14-day trial on first signup. Without this, anyone
    // approved through the kanban hits /access-pending instead of
    // their workspace.
    const { data: approvedRaw } = await supabase
      .from("demo_requests")
      .select("id, approved_at" as never)
      .eq("email", normalisedEmail)
      .in("status", ["approved", "won"])
      .order("approved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const approved = approvedRaw as unknown as
      | { id: string; approved_at: string | null }
      | null;
    if (approved?.id) {
      initialStatus = "trial";
      trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      approvedDemoId = approved.id;
    }
  }

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .insert({
      name: input.name,
      slug: input.slug,
      phone: input.phone ?? null,
      vat_number: input.vatNumber ?? null,
      address: input.postcode ? { postcode: input.postcode } : null,
      onboarding_state: { company: true },
      status: initialStatus,
      trial_ends_at: trialEndsAt,
    } as never)
    .select("id")
    .single();

  if (orgErr || !org) {
    console.error("[bootstrap] createOrg failed", orgErr);
    throw new Error("Failed to create organisation");
  }

  const { error: memErr } = await supabase.from("memberships").insert({
    org_id: org.id,
    user_id: input.userId,
    role: "owner",
  });

  if (memErr) {
    console.error("[bootstrap] createMembership failed", memErr);
    // Best-effort rollback so we don't leave an orphan org.
    await supabase.from("organizations").delete().eq("id", org.id);
    throw new Error("Failed to attach owner to organisation");
  }

  // If we promoted to trial via an approved demo, mark the demo_request
  // as having yielded a signup. Best-effort — the org is created either
  // way.
  if (approvedDemoId) {
    await supabase
      .from("demo_requests")
      .update({ internal_lead_id: null, status: "approved" } as never)
      .eq("id", approvedDemoId);
  }

  return { orgId: org.id };
}
