import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildPortalFutureWorkView,
  type PortalFutureWorkView,
} from "@/lib/leads/portal";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Customer-portal read-back of future-work requests.
 *
 * SCOPING PROOF: public.leads carries BOTH org_id AND customer_id, and every
 * portal-submitted request is stamped with the token-resolved pair by
 * submitFutureWorkRequest (never from the form). This query filters on all
 * three of (org_id, customer_id, source='portal'), so:
 *   - another customer's requests are unreachable (customer_id filter);
 *   - another org's leads are unreachable (org_id filter);
 *   - staff-created leads that merely LINK this customer never appear
 *     (source filter) — those are internal pipeline records, and their
 *     titles/staging were written for staff eyes.
 *
 * PROJECTION: rows exit through buildPortalFutureWorkView ONLY. `notes` (staff
 * append internal commentary after triage), `estimated_value`, `ai_summary`,
 * `assigned_to` and the raw pipeline status are never selected — a column this
 * query does not read cannot leak by a later render change.
 */

type LeadRow = {
  id: string;
  service: string | null;
  status: string;
  created_at: string;
};

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type LeadChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          order: (
            k: string,
            o: { ascending: boolean },
          ) => { limit: (n: number) => PromiseLike<Res<LeadRow[]>> };
        };
      };
    };
  };
};

export async function listPortalFutureWorkRequests(
  customerId: string,
  orgId: string,
): Promise<PortalFutureWorkView[]> {
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("leads" as never) as unknown as LeadChain
  )
    .select("id, service, status, created_at")
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .eq("source", "portal")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw readFailure("portal future-work: requests", error);
  return (data ?? []).map((row) => buildPortalFutureWorkView(row));
}
