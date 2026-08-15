import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  buildPortalContactView,
  type PortalContactView,
} from "@/lib/customers/contacts";

/**
 * Customer-portal read-back of a customer's named contacts (P3).
 *
 * SCOPING PROOF: customer_contacts carries org_id AND customer_id (bound to the
 * customer by a composite FK). This read filters on BOTH, resolved from the
 * token — so a customer sees only their OWN contacts, never another customer's,
 * even though the portal runs on the RLS-bypassing admin client. Never widened.
 *
 * PROJECTION: rows exit through buildPortalContactView ONLY, which has NO
 * portal_token field — the credential is never selected here and could not leak
 * even if a render changed. F-1: paged on a stable unique order.
 */

type ContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  portal_access_enabled: boolean;
};

type Q = PromiseLike<{ data: ContactRow[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => Q;
  eq: (k: string, v: unknown) => Q;
  order: (k: string, o: { ascending: boolean }) => Q;
  range: (from: number, to: number) => Q;
};

export async function listPortalContacts(
  customerId: string,
  orgId: string,
): Promise<PortalContactView[]> {
  const admin = createAdminClient();

  // NOTE: portal_token is deliberately NOT selected — only portal_access_enabled,
  // so the projection can say WHETHER a contact has access without ever touching
  // the credential itself.
  const { data, error } = await fetchAllRows<ContactRow>((from, to) =>
    (admin.from("customer_contacts" as never) as unknown as { select: (c: string) => Q })
      .select("id, name, email, phone, role, portal_access_enabled")
      .eq("org_id", orgId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("portal contacts: list", error);
  return (data ?? []).map((row) => buildPortalContactView(row));
}
