import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-only loader for the customer portal — and the SINGLE authority for
 * portal token validity.
 *
 * The token in the URL is the entire auth surface: there's no Supabase JWT, so
 * we look up the customer + org on the service-role admin client, and knowledge
 * of the UUID is the credential. Because every portal page and action funnels
 * through here, this one function is where malformed / unknown / EXPIRED tokens
 * are rejected — individual routes never re-check, so they can never drift.
 *
 * Fails closed to null (→ InvalidLinkPage) on: bad UUID shape, no matching
 * customer, a DB error, OR a token whose portal_token_expires_at has passed. A
 * NULL expiry means the token never expires.
 *
 * On a SUCCESSFUL, non-expired load it also records usage — a debounced,
 * fire-and-forget touch of portal_token_last_used_at. That write is telemetry,
 * not authority: it runs only after validation, never for a rejected token, and
 * its failure is swallowed so it can never block a valid portal request.
 */

/** Debounce window for the last_used_at telemetry touch: at most one write per
 *  token per hour, regardless of request volume. */
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

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
        id, org_id, name, email, phone, portal_token_expires_at,
        portal_token_last_used_at,
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

  // EXPIRY — the auth decision, made here and nowhere else. A NULL expiry never
  // expires; a set expiry in the past fails closed exactly like an unknown
  // token, so an expired link reveals no customer/org/job/invoice/etc. data.
  const expiresAt = (data as { portal_token_expires_at: string | null })
    .portal_token_expires_at;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return null;
  }

  // USAGE TELEMETRY — only now that the token is valid AND unexpired. Awaited
  // (not fire-and-forget: in serverless a non-awaited write can be frozen out
  // before it lands), but it can NEVER throw — every failure is caught and
  // logged inside touchLastUsed — so a valid portal request never fails because
  // telemetry couldn't be written. Debounced in the DB, so the common case adds
  // no write at all. Expiry above never depended on this.
  await touchLastUsed(
    admin,
    token,
    (data as { portal_token_last_used_at: string | null })
      .portal_token_last_used_at,
  );

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

/**
 * Record portal usage — debounced, fire-and-forget.
 *
 * Skips the write entirely when the last touch was within the interval (the
 * common case, so most valid loads issue NO write). When it does write, the
 * UPDATE re-checks the interval in its OWN `WHERE` (`last_used_at IS NULL OR <
 * cutoff`), so two concurrent loads can't both land a write — the debounce is
 * enforced by Postgres, not by this in-memory pre-check, which is only a
 * fast-path to avoid a pointless round-trip.
 *
 * The `portal_token` filter keeps this scoped to exactly the one customer that
 * authenticated — the same identity that just passed validation — so it cannot
 * touch another customer's or org's row.
 *
 * Awaited internally but never rethrows: any failure is logged and dropped, so
 * a valid portal request never fails because telemetry couldn't be written.
 */
async function touchLastUsed(
  admin: ReturnType<typeof createAdminClient>,
  token: string,
  lastUsedAt: string | null,
): Promise<void> {
  try {
    const cutoffMs = Date.now() - LAST_USED_TOUCH_INTERVAL_MS;
    // Fast-path: recently touched → nothing to do.
    if (lastUsedAt && Date.parse(lastUsedAt) > cutoffMs) return;

    const cutoffIso = new Date(cutoffMs).toISOString();
    const { error } = await (
      admin.from("customers" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => {
            or: (f: string) => Promise<{ error: { message: string } | null }>;
          };
        };
      }
    )
      .update({ portal_token_last_used_at: new Date().toISOString() })
      .eq("portal_token", token)
      // Debounce in the DB so concurrent loads can't double-write.
      .or(`portal_token_last_used_at.is.null,portal_token_last_used_at.lt.${cutoffIso}`);
    if (error) {
      console.error("[customer-portal] last_used touch failed", error.message);
    }
  } catch (e) {
    // Telemetry must never break access.
    console.error(
      "[customer-portal] last_used touch threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}
