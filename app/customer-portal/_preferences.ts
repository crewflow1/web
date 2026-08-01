import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildPortalPreferencesView,
  type PortalPreferencesView,
} from "@/lib/customers/portal-preferences";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Customer-portal preferences read.
 *
 * SCOPING PROOF: customer_portal_preferences' PRIMARY KEY is
 * (org_id, customer_id), and this lookup filters on both — the token-resolved
 * pair, never caller input — so it can address at most the one row belonging
 * to the authenticated customer. The composite FK in migration
 * 20261082000000 makes a row whose customer/org pair disagree unrepresentable.
 *
 * PROJECTION: the row exits through buildPortalPreferencesView only —
 * created_at and any column added later never reach the page.
 */

type PrefRow = {
  preferred_channel: string;
  contact_notes: string | null;
  updated_at: string | null;
};

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type PrefChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<Res<PrefRow>>;
      };
    };
  };
};

export async function loadPortalPreferences(
  customerId: string,
  orgId: string,
): Promise<PortalPreferencesView | null> {
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("customer_portal_preferences" as never) as unknown as PrefChain
  )
    .select("preferred_channel, contact_notes, updated_at")
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw readFailure("portal preferences: load", error);
  if (!data) return null;
  return buildPortalPreferencesView(data);
}
