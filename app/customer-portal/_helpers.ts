import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-only loader for the customer portal.
 *
 * The token in the URL is the entire auth surface — there's no Supabase
 * JWT in play, so we use the service-role admin client to look up the
 * customer + their org. Knowledge of the UUID is the credential.
 *
 * Returns null if the token doesn't match a customer row.
 */

export type PortalCustomer = {
  id: string;
  org_id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type PortalOrg = {
  id: string;
  name: string;
  phone: string | null;
  logo_url: string | null;
  address: {
    line1?: string;
    city?: string;
    postcode?: string;
  } | null;
};

export async function loadCustomerByPortalToken(
  token: string,
): Promise<{ customer: PortalCustomer; org: PortalOrg } | null> {
  // Token must look like a uuid before we hit the DB so a stray "/quotes"
  // path segment can't trigger an obviously-invalid lookup.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return null;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select(
      `
        id, org_id, name, email, phone,
        org:organizations ( id, name, phone, logo_url, address )
      `,
    )
    .eq("portal_token", token)
    .maybeSingle();

  if (error) {
    console.error("[customer-portal] lookup failed", error);
    return null;
  }
  if (!data || !data.org) return null;

  return {
    customer: {
      id: data.id,
      org_id: data.org_id,
      name: data.name,
      email: data.email,
      phone: data.phone,
    },
    org: {
      id: data.org.id,
      name: data.org.name,
      phone: data.org.phone ?? null,
      logo_url: data.org.logo_url ?? null,
      address:
        (data.org.address as PortalOrg["address"]) ?? null,
    },
  };
}
