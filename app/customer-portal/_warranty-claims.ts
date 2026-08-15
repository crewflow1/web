import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  buildPortalWarrantyClaimView,
  type PortalWarrantyClaimView,
} from "@/lib/warranties/claims";

/**
 * Customer-portal read-back of warranty claims (P3).
 *
 * SCOPING PROOF — the load-bearing barrier. A claim is a public.support_tickets
 * row, and the portal runs on the RLS-bypassing admin client, so the ONLY thing
 * keeping one customer from reading another's claims is this three-part filter:
 *
 *   1. the caller resolves the customer's OWN visible warranty ids first (via
 *      listPortalWarranties, itself job-scoped to org_id + customer_id) and
 *      passes them in;
 *   2. this reads support_tickets `.eq(org_id).eq(customer_id)` — the same
 *      customer scope every portal ticket read uses (20260706);
 *   3. AND `.in("warranty_id", warrantyIds)` — so a ticket only surfaces here if
 *      it is linked to one of THIS customer's OWN warranties. Never widened.
 *
 * All three must agree. An empty warranty set short-circuits to [] rather than
 * an unfiltered `.in()`.
 *
 * F-1: support_tickets is a high-value cross-tenant table read on the admin
 * client; PAGED via fetchAllRows on a stable unique order so a customer with
 * many claims is never silently truncated.
 *
 * PROJECTION: rows exit through buildPortalWarrantyClaimView ONLY — the assignee,
 * priority, internal HQ notes and the raw five-state status never round-trip.
 */

type TicketRow = {
  id: string;
  ticket_number: number;
  warranty_id: string;
  subject: string;
  status: string;
  created_at: string;
};

type Q = PromiseLike<{ data: TicketRow[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => Q;
  eq: (k: string, v: unknown) => Q;
  in: (k: string, v: unknown[]) => Q;
  order: (k: string, o: { ascending: boolean }) => Q;
  range: (from: number, to: number) => Q;
};

export async function listPortalWarrantyClaims(
  customerId: string,
  orgId: string,
  warrantyIds: string[],
): Promise<PortalWarrantyClaimView[]> {
  if (warrantyIds.length === 0) return [];
  const admin = createAdminClient();

  const { data, error } = await fetchAllRows<TicketRow>((from, to) =>
    (admin.from("support_tickets" as never) as unknown as { select: (c: string) => Q })
      .select("id, ticket_number, warranty_id, subject, status, created_at")
      .eq("org_id", orgId)
      .eq("customer_id", customerId)
      .in("warranty_id", warrantyIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (error) throw readFailure("portal warranty claims: tickets", error);
  return (data ?? []).map((row) => buildPortalWarrantyClaimView(row));
}
