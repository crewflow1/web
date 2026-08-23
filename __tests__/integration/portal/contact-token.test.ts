import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Customer portal — NAMED-CONTACT token auth, proved against real Postgres.
 *
 * The single portal authority (loadCustomerByPortalToken) has a second,
 * ADDITIVE resolution path: when a token matches no `customers.portal_token` it
 * falls through to `resolveContactToken`, which looks the token up on
 * `customer_contacts.portal_token` and resolves it to the contact's PARENT
 * customer + org. That path carries the same load-bearing security guarantees as
 * the primary path — fail-closed on any miss, contact-level expiry, and (the one
 * that matters most) a contact token can only ever surface its OWN parent
 * customer + org, never a second tenant boundary.
 *
 * The source-invariant suite (portal-token-expiry-authority, portal-contacts-
 * scope) pins these as SHAPE. This suite proves the BEHAVIOUR against real rows,
 * exactly as token-expiry.test.ts does for the primary customer-token path —
 * because "an expired/revoked contact token reveals nothing" and "a contact
 * token in org B never resolves to org A" are database behaviour a mock cannot
 * prove. The contact path was 0 rows in prod at authoring time — brand new, and
 * previously behaviourally unproven.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-cntok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HOUR = 60 * 60 * 1000;

describeIntegration("customer portal · named-contact token", () => {
  let orgAId = "";
  let orgBId = "";
  let custAId = "";
  let custBId = "";
  let load: typeof import("@/app/customer-portal/_helpers").loadCustomerByPortalToken;

  const uuid = () => crypto.randomUUID();
  const iso = (ms: number) => new Date(ms).toISOString();

  const mkCustomer = async (org: string) => {
    const res = await db(serviceClient())
      .from("customers")
      .insert({ org_id: org, name: `Cust ${uuid().slice(0, 8)}`, portal_token: uuid() })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return res.data?.id as string;
  };

  /** Insert an ENABLED named contact carrying its own scoped portal token.
   *  The schema CHECK (customer_contacts_token_access_agree) requires
   *  enabled=true ⇒ token present, so an enabled contact always has a token. */
  const mkContact = async (
    org: string,
    customer: string,
    portalToken: string,
    patch: Record<string, unknown> = {},
  ) => {
    const res = await db(serviceClient())
      .from("customer_contacts")
      .insert({
        org_id: org,
        customer_id: customer,
        name: `Contact ${portalToken.slice(0, 8)}`,
        role: "billing",
        portal_access_enabled: true,
        portal_token: portalToken,
        ...patch,
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return res.data?.id as string;
  };

  const readContact = async (id: string) => {
    const res = await db(serviceClient())
      .from("customer_contacts")
      .select("portal_token, portal_token_expires_at, portal_token_last_used_at")
      .eq("id", id)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    return res.data as {
      portal_token: string | null;
      portal_token_expires_at: string | null;
      portal_token_last_used_at: string | null;
    };
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const res = await svc
        .from("organizations")
        .insert({ name: `CnTok ${label}`, slug })
        .select("id")
        .single();
      expect(res.error, res.error?.message).toBeNull();
      if (label === "A") orgAId = res.data?.id as string;
      else orgBId = res.data?.id as string;
    }
    custAId = await mkCustomer(orgAId);
    custBId = await mkCustomer(orgBId);
    load = (await import("@/app/customer-portal/_helpers")).loadCustomerByPortalToken;
  });

  afterAll(async () => {
    // Teardown is ASSERTED (the 20261052 lesson): a swallowed failure here is
    // exactly how leaked fixtures hid a P1. customer_contacts is ON DELETE
    // CASCADE from both org and customer, so deleting the orgs is sufficient.
    for (const id of [orgAId, orgBId]) {
      if (!id) continue;
      const del = await db(serviceClient()).from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
  });

  // -------------------------------------------------------------------
  // Resolution to the PARENT customer
  // -------------------------------------------------------------------

  it("a valid contact token resolves to its PARENT customer + org", async () => {
    const tok = uuid();
    await mkContact(orgAId, custAId, tok);
    const res = await load(tok);
    expect(res).not.toBeNull();
    expect(res?.customer.id).toBe(custAId); // the PARENT customer, not the contact
    expect(res?.customer.org_id).toBe(orgAId);
  });

  it("carries the contact identity (informational only, never a new scope)", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok, {
      name: "Facilities Manager",
      role: "site",
    });
    const res = await load(tok);
    expect(res?.contact?.id).toBe(contactId);
    expect(res?.contact?.name).toBe("Facilities Manager");
    expect(res?.contact?.role).toBe("site");
    // Scope is STILL the parent customer — the contact identity never widens it.
    expect(res?.customer.id).toBe(custAId);
  });

  it("a contact token never surfaces a different customer than its parent", async () => {
    const tok = uuid();
    await mkContact(orgAId, custAId, tok);
    const res = await load(tok);
    expect(res?.customer.id).toBe(custAId);
    expect(res?.customer.id).not.toBe(custBId);
  });

  // -------------------------------------------------------------------
  // Expiry (contact-level, independent of the customer token)
  // -------------------------------------------------------------------

  it("a FUTURE contact-token expiry is valid", async () => {
    const tok = uuid();
    await mkContact(orgAId, custAId, tok, {
      portal_token_expires_at: iso(Date.now() + HOUR),
    });
    expect(await load(tok)).not.toBeNull();
  });

  it("a PAST contact-token expiry is rejected → null", async () => {
    const tok = uuid();
    await mkContact(orgAId, custAId, tok, {
      portal_token_expires_at: iso(Date.now() - HOUR),
    });
    expect(await load(tok)).toBeNull();
  });

  it("an expired contact token reveals NO parent-customer/org data", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok, {
      portal_token_expires_at: iso(Date.now() - 1000),
    });
    expect(await load(tok)).toBeNull(); // same shape as an unknown token
    // The row genuinely exists — proving it was expiry, not a missing row.
    expect((await readContact(contactId)).portal_token).toBe(tok);
  });

  // -------------------------------------------------------------------
  // Fail-closed + revocation
  // -------------------------------------------------------------------

  it("an unknown well-formed token matches neither customer nor contact → null", async () => {
    expect(await load(uuid())).toBeNull();
  });

  it("revoking a contact (disable + clear token) stops the old token resolving", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok);
    expect(await load(tok)).not.toBeNull();

    // Mirror a staff revoke: the CHECK forces enabled=false ⇒ token null, so a
    // disabled contact can never be reached by a stale token.
    const upd = await db(serviceClient())
      .from("customer_contacts")
      .update({ portal_access_enabled: false, portal_token: null })
      .eq("id", contactId);
    expect(upd.error, upd.error?.message).toBeNull();

    expect(await load(tok)).toBeNull(); // old token no longer resolves
  });

  // -------------------------------------------------------------------
  // Cross-tenant isolation — the guarantee that matters most
  // -------------------------------------------------------------------

  it("a contact token under org B resolves to org B's parent, never org A", async () => {
    const tok = uuid();
    await mkContact(orgBId, custBId, tok);
    const res = await load(tok);
    expect(res?.customer.id).toBe(custBId);
    expect(res?.customer.org_id).toBe(orgBId);
    expect(res?.customer.org_id).not.toBe(orgAId);
  });

  // -------------------------------------------------------------------
  // Telemetry — the CONTACT's last_used, debounced, never authority
  // -------------------------------------------------------------------

  it("a valid load stamps the CONTACT's last_used_at, not the parent customer's", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok);
    expect((await readContact(contactId)).portal_token_last_used_at).toBeNull();

    await load(tok);
    expect((await readContact(contactId)).portal_token_last_used_at).not.toBeNull();
  });

  it("a rejected (expired) contact load does NOT stamp last_used_at", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok, {
      portal_token_expires_at: iso(Date.now() - HOUR),
    });
    await load(tok); // rejected
    expect((await readContact(contactId)).portal_token_last_used_at).toBeNull();
  });

  it("the debounce holds: a second immediate load does NOT rewrite last_used_at", async () => {
    const tok = uuid();
    const contactId = await mkContact(orgAId, custAId, tok);
    await load(tok);
    const first = (await readContact(contactId)).portal_token_last_used_at;
    expect(first).not.toBeNull();

    await load(tok); // within the hour → debounced
    expect((await readContact(contactId)).portal_token_last_used_at).toBe(first);
  });

  it("the touch only affects the authenticating contact's row", async () => {
    const tokA = uuid();
    const tokB = uuid();
    const contactA = await mkContact(orgAId, custAId, tokA);
    const contactB = await mkContact(orgBId, custBId, tokB); // different org + customer

    await load(tokA);

    expect((await readContact(contactA)).portal_token_last_used_at).not.toBeNull();
    expect((await readContact(contactB)).portal_token_last_used_at).toBeNull();
  });
});
