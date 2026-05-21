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
  name: string;
  slug: string;
  phone?: string | null;
  vatNumber?: string | null;
  postcode?: string | null;
}): Promise<{ orgId: string }> {
  const supabase = createAdminClient();

  // Access gate (migration 20260602000000): brand-new signups land in
  // 'pending' status and cannot use the product until a CrewFlow admin
  // approves them. status is set explicitly so the intent reads in
  // grep, even though it matches the column default.
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .insert({
      name: input.name,
      slug: input.slug,
      phone: input.phone ?? null,
      vat_number: input.vatNumber ?? null,
      address: input.postcode ? { postcode: input.postcode } : null,
      onboarding_state: { company: true },
      status: "pending",
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

  return { orgId: org.id };
}
