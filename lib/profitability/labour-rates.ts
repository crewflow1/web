import { readFailure } from "@/lib/supabase/read-failure";
import type { createClient } from "@/lib/supabase/server";

type TenantClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Per-user hourly pay for an org's members — the rate side of
 * `buildJobCostInput`'s labour cost.
 *
 * Reads the org's `memberships` (org-pinned) for its user ids, then
 * `staff_compensation` for their `hourly_pay`. It deliberately mirrors the
 * DASHBOARD's rate source (memberships → compensation) so every surface costs
 * labour from the SAME rates: a worker who has left the org has no membership and
 * therefore no rate on ANY surface, so the dashboard and the per-job pages stay
 * in parity rather than disagreeing on ex-staff.
 *
 * `staff_compensation` (20261218) holds `hourly_pay` behind self-or-admin RLS —
 * it replaced the co-worker-readable `users.hourly_pay` so a co-worker can no
 * longer read another's pay. For the admin/owner contexts that compute labour
 * cost the map is IDENTICAL to the old users.hourly_pay read (their RLS admits
 * every org member's row); a non-admin viewer sees only their own rate, which is
 * why job cost/profit is not shown to non-admins (the commercial surfaces gate on
 * role). Like `users`, `staff_compensation` is a global table (no `org_id`),
 * scoped here by ids drawn from the org-pinned `memberships` read.
 *
 * LOUD: a failed membership or pay read THROWS rather than returning an empty
 * map. An empty map would zero every rate, drop labour cost to nothing, and
 * render jobs as more profitable than they are — the money-out defect this parity
 * work fixes.
 */
export async function loadOrgHourlyPay(
  supabase: TenantClient,
  orgId: string,
): Promise<Map<string, number>> {
  const { data: members, error: membersError } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId);
  if (membersError) throw readFailure("labour rates: memberships", membersError);
  const memberIds = [...new Set((members ?? []).map((m) => m.user_id))];
  const out = new Map<string, number>();
  if (memberIds.length === 0) return out;
  const { data, error } = await supabase
    .from("staff_compensation")
    .select("user_id, hourly_pay")
    .in("user_id", memberIds);
  if (error) throw readFailure("labour rates: user hourly pay", error);
  for (const row of data ?? []) out.set(row.user_id, Number(row.hourly_pay ?? 0));
  return out;
}
