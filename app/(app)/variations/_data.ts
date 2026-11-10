import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type {
  VariationRequestStatus,
  VariationRequestUrgency,
  VariationRequesterType,
} from "@/lib/variation-requests/schema";

/**
 * Variations — the cross-job register's read layer.
 *
 * A variation REQUEST ("the client wants the kitchen socket moved — someone
 * needs to price it", `public.variation_requests`, mig 20261221000000) is
 * created job-scoped from the job workspace. This register is the org-wide view
 * that answers: WHAT HAS BEEN ASKED FOR that isn't yet a priced Variation Order,
 * so nothing falls through the cracks between the site and the commercial desk.
 *
 * Same contract as the /delays and /quality read layers:
 *   - Tenant (user-JWT) client only; never the service-role client.
 *   - ACTIVE-ORG PINNING: RLS (`current_org_ids()`) is the outer boundary, not
 *     the scope — a dual-org member would otherwise see both companies, so every
 *     read carries its own `.eq("org_id", orgId)` at the call site.
 *   - LOUD READS: a rejected query THROWS via @/lib/supabase/read-failure; an
 *     empty register must mean "genuinely none", never "the read failed".
 */

const VARIATION_COLS =
  "id, org_id, job_id, title, urgency, requester_type, requester_name, status, " +
  "variation_quote_id, created_at, updated_at";

export type VariationListRow = {
  id: string;
  org_id: string;
  job_id: string;
  title: string;
  urgency: VariationRequestUrgency;
  requester_type: VariationRequesterType;
  requester_name: string | null;
  status: VariationRequestStatus;
  variation_quote_id: string | null;
  created_at: string;
  updated_at: string;
};

export type VariationListItem = VariationListRow & { jobLabel: string | null };

/**
 * The register: every variation request in the ACTIVE org, newest first.
 *
 * PAGED (F-1). A register must show the COMPLETE set — a bare `.limit()` would
 * silently drop the oldest requests once an org passes the cap, so a long-open
 * request could vanish from the triage view. Page the whole set on a stable,
 * unique order (created_at desc + id desc tiebreaker) so no row shifts across a
 * page boundary.
 */
export async function listVariationRequests(
  orgId: string,
): Promise<VariationListItem[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<VariationListRow>((from, to) =>
    supabase
      .from("variation_requests")
      .select(VARIATION_COLS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{
      data: VariationListRow[] | null;
      error: unknown;
    }>,
  );
  if (error) {
    throw readFailure("variations: register", error as unknown as SupabaseReadError);
  }
  const rows = (data ?? []) as VariationListRow[];
  if (rows.length === 0) return [];
  const labels = await loadJobLabels(orgId, rows.map((r) => r.job_id));
  return rows.map((r) => ({ ...r, jobLabel: labels.get(r.job_id) ?? null }));
}

/** Batched job labels (customer name + scheduled date) — never one query per row. */
async function loadJobLabels(
  orgId: string,
  jobIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(jobIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .in("id", ids);
  if (error) throw readFailure("variations: job labels", error as unknown as SupabaseReadError);
  for (const j of data ?? []) {
    const customer = (j as unknown as { customer: { name: string | null } | null }).customer;
    const parts = [customer?.name ?? "Job", (j as { scheduled_date: string | null }).scheduled_date ?? null].filter(
      Boolean,
    );
    out.set((j as { id: string }).id, parts.join(" · "));
  }
  return out;
}
