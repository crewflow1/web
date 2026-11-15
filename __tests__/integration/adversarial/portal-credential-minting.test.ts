import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration } from "../_harness";
import { as, anon, createWorld, destroyWorld, svc, type World } from "./_fixture";

/**
 * ST-04 — a client could MINT its own customer-portal credential.
 *
 * `customer_contacts.portal_token` (+ `portal_access_enabled`) is a bearer credential:
 * app/customer-portal/_helpers.ts resolves it, with the service role, to the PARENT
 * customer and serves that customer's invoices, quotes, payments and documents — and
 * lets the holder act as the customer (accept a quote, upload a payment proof, …).
 *
 * The application never sets those columns from a client: contact access is "a
 * separate deliberate action" that is not built yet, and every in-app insert writes
 * `portal_access_enabled: false, portal_token: null`. But the table's RLS is
 * member-wide for INSERT/UPDATE and the columns were freely client-writable, so ANY
 * member — including a `staff` JWT that RLS denies all of invoices / quotes / payments —
 * could POST a contact row carrying a token of their own choosing straight to PostgREST
 * and then open /customer-portal/<that token>.
 *
 * Fix: migration 20261302000000 — a BEFORE INSERT/UPDATE guard that lets only the
 * service role set or change the three credential columns. Client rows with the
 * defaults (false / NULL / NULL) are unaffected, so the staff contact CRUD still works.
 */
describeIntegration("ADVERSARIAL · customer-portal credential minting via customer_contacts (ST-04)", () => {
  let w: World | null = null;
  let customerA = "";

  const resolve = async (token: string) => {
    const { loadCustomerByPortalToken } = await import("@/app/customer-portal/_helpers");
    return loadCustomerByPortalToken(token);
  };

  beforeAll(async () => {
    w = await createWorld("sectenant-pcm");
    const c = await svc().from("customers").insert({ org_id: w.A.id, name: `Portal Victim ${w.tag}` }).select("id").single();
    if (c.error) throw new Error(c.error.message);
    customerA = (c.data as { id: string }).id;
    // Staff see a customer only through an ASSIGNED job (customers: scoped select), and
    // the table's own same-org guard reads `customers` under the writer's RLS — so the
    // staff attacker needs an assignment for the mint to get as far as the credential
    // columns. That is the realistic insider: a fitter on one of the customer's jobs.
    const j = await svc().from("jobs").insert({ org_id: w.A.id, customer_id: customerA, assigned_to: w.A.staff.id }).select("id").single();
    if (j.error) throw new Error(j.error.message);
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  for (const role of ["staff", "admin", "owner"] as const) {
    it(`an org ${role} cannot INSERT a contact that carries a portal credential`, async () => {
      const world = w!;
      const token = randomUUID();
      const r = await as(world.A[role].token).from("customer_contacts").insert({
        org_id: world.A.id,
        customer_id: customerA,
        name: `minted by ${role}`,
        email: "x@example.test",
        portal_access_enabled: true,
        portal_token: token,
      });
      expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
      // The credential must not resolve — this is the actual exploit step.
      expect(await resolve(token)).toBeNull();
    });
  }

  it("a staff member cannot UPGRADE an existing contact into a portal credential", async () => {
    const world = w!;
    const created = await as(world.A.staff.token)
      .from("customer_contacts")
      .insert({ org_id: world.A.id, customer_id: customerA, name: "Plain contact", email: "plain@example.test" })
      .select("id")
      .single();
    expect(created.error, JSON.stringify(created.error)).toBeNull();
    const id = (created.data as { id: string }).id;

    const token = randomUUID();
    const up = await as(world.A.staff.token)
      .from("customer_contacts")
      .update({ portal_access_enabled: true, portal_token: token })
      .eq("id", id)
      .select("id");
    expect(up.error !== null || (up.data ?? []).length === 0, "the upgrade must be refused").toBe(true);
    const truth = await svc().from("customer_contacts").select("portal_access_enabled, portal_token").eq("id", id).single();
    expect(truth.data).toEqual({ portal_access_enabled: false, portal_token: null });
    expect(await resolve(token)).toBeNull();
  });

  it("a client cannot extend, re-key or re-enable a credential the SERVER minted", async () => {
    const world = w!;
    const serverToken = randomUUID();
    const expires = "2031-01-01T00:00:00+00:00";
    const minted = await svc()
      .from("customer_contacts")
      .insert({
        org_id: world.A.id,
        customer_id: customerA,
        name: "Server-provisioned contact",
        email: "srv@example.test",
        portal_access_enabled: true,
        portal_token: serverToken,
        portal_token_expires_at: expires,
      })
      .select("id")
      .single();
    expect(minted.error, "the service role must still be able to provision access").toBeNull();
    const id = (minted.data as { id: string }).id;

    const attackerToken = randomUUID();
    for (const patch of [
      { portal_token: attackerToken },
      { portal_token_expires_at: "2099-01-01T00:00:00+00:00" },
      { portal_token_expires_at: null },
    ]) {
      await as(world.A.staff.token).from("customer_contacts").update(patch).eq("id", id);
    }
    const truth = await svc()
      .from("customer_contacts")
      .select("portal_access_enabled, portal_token, portal_token_expires_at")
      .eq("id", id)
      .single();
    expect(truth.data?.portal_token).toBe(serverToken);
    expect(new Date(truth.data?.portal_token_expires_at as string).toISOString()).toBe(new Date(expires).toISOString());
    expect(await resolve(attackerToken)).toBeNull();

    // A non-credential edit by staff on the same row still works (no collateral damage).
    const edit = await as(world.A.staff.token).from("customer_contacts").update({ notes: "call after 4pm" }).eq("id", id).select("id");
    expect(edit.error, JSON.stringify(edit.error)).toBeNull();
    expect(edit.data).toHaveLength(1);
  });

  it("ST-07a (closed) · a staff member assigned to a customer's job can NOT read that customer's portal token", async () => {
    // customers.portal_token is the customer's bearer credential. `customers: scoped
    // select` lets staff see the customers of their assigned jobs — and RLS cannot hide a
    // column — so until 20261341 the insider this file is about could simply READ the
    // real credential. The column now carries no client SELECT grant at all (the "copy
    // portal link" panel reads it server-side after a customers:view check). The full
    // proof (select *, filters, embeds, the server reader) is rls/private-column-acl.
    const world = w!;
    const other = await svc().from("customers").insert({ org_id: world.A.id, name: "Unassigned customer" }).select("id").single();
    const staff = as(world.A.staff.token);
    const assigned = await staff.from("customers").select("id, portal_token").eq("id", customerA);
    expect(assigned.error?.code, JSON.stringify(assigned.error ?? assigned.data)).toBe("42501");
    // The row itself is still theirs to see (name / site contact) …
    const row = await staff.from("customers").select("id, name").eq("id", customerA);
    expect(row.data ?? []).toHaveLength(1);
    // … and a customer staff are NOT assigned to is still not readable at all.
    const unassigned = await staff.from("customers").select("id").eq("id", (other.data as { id: string }).id);
    expect(unassigned.data ?? []).toEqual([]);
  });

  it("control: the in-app shape (defaults only) still inserts for staff, and anon is refused outright", async () => {
    const world = w!;
    const ok = await as(world.A.staff.token).from("customer_contacts").insert({
      org_id: world.A.id,
      customer_id: customerA,
      name: "In-app shaped contact",
      phone: "07700 900123",
      portal_access_enabled: false,
      portal_token: null,
    });
    expect(ok.error, JSON.stringify(ok.error)).toBeNull();

    const token = randomUUID();
    const a = await anon().from("customer_contacts").insert({
      org_id: world.A.id,
      customer_id: customerA,
      name: "anon",
      email: "a@example.test",
      portal_access_enabled: true,
      portal_token: token,
    });
    expect(a.error).not.toBeNull();
    expect(await resolve(token)).toBeNull();
  });
});
