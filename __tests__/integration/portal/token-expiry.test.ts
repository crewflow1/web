import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Customer portal token — expiry + usage tracking, proved against real Postgres.
 *
 * loadCustomerByPortalToken is the SINGLE authority for portal token validity
 * (every portal page/action funnels through it). These tests drive the REAL
 * loader against REAL rows, because the guarantees that matter — an expired
 * token reveals nothing, rotation invalidates the old token, the debounced
 * touch writes at most once per interval and only after a valid load — are
 * database behaviour a mock cannot prove.
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

const TOKEN = `it-ptok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HOUR = 60 * 60 * 1000;

describeIntegration("customer portal token · expiry + usage", () => {
  let orgId = "";
  let orgBId = "";
  let load: typeof import("@/app/customer-portal/_helpers").loadCustomerByPortalToken;

  const mkCustomer = async (
    org: string,
    portalToken: string,
    patch: Record<string, unknown> = {},
  ) => {
    const res = await db(serviceClient())
      .from("customers")
      .insert({ org_id: org, name: `Cust ${portalToken.slice(0, 8)}`, portal_token: portalToken, ...patch })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return res.data?.id as string;
  };

  const readCustomer = async (id: string) => {
    const res = await db(serviceClient())
      .from("customers")
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

  const uuid = () => crypto.randomUUID();
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    const svc = db(serviceClient());
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const res = await svc
        .from("organizations")
        .insert({ name: `PTok ${label}`, slug })
        .select("id")
        .single();
      expect(res.error, res.error?.message).toBeNull();
      if (label === "A") orgId = res.data?.id as string;
      else orgBId = res.data?.id as string;
    }
    load = (await import("@/app/customer-portal/_helpers")).loadCustomerByPortalToken;
  });

  afterAll(async () => {
    // Teardown is ASSERTED, not fire-and-forget. Until 20261052 this delete
    // silently failed (activity_log_org_id_fkey — the `customers` fixtures
    // carry an AFTER-DELETE activity trigger) and leaked every fixture row into
    // the shared database. Swallowing the error is what hid a P1 for so long,
    // so now a failed teardown fails the suite.
    for (const id of [orgId, orgBId]) {
      if (!id) continue;
      const del = await db(serviceClient()).from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
  });

  // -------------------------------------------------------------------
  // Validity + expiry
  // -------------------------------------------------------------------

  it("a token with NULL expiry is valid (existing links never break)", async () => {
    const tok = uuid();
    await mkCustomer(orgId, tok); // no expiry set
    const res = await load(tok);
    expect(res).not.toBeNull();
    expect(res?.customer.org_id).toBe(orgId);
  });

  it("a FUTURE expiry is valid", async () => {
    const tok = uuid();
    await mkCustomer(orgId, tok, { portal_token_expires_at: iso(Date.now() + HOUR) });
    expect(await load(tok)).not.toBeNull();
  });

  it("an expiry in the PAST is rejected → null", async () => {
    const tok = uuid();
    await mkCustomer(orgId, tok, { portal_token_expires_at: iso(Date.now() - HOUR) });
    expect(await load(tok)).toBeNull();
  });

  it("an expired token reveals NO customer/org data (fails closed like unknown)", async () => {
    const tok = uuid();
    const id = await mkCustomer(orgId, tok, {
      portal_token_expires_at: iso(Date.now() - 1000),
    });
    const res = await load(tok);
    // Same shape as an unknown token: nothing at all.
    expect(res).toBeNull();
    // And the row genuinely exists — proving it was expiry, not a missing row.
    expect((await readCustomer(id)).portal_token).toBe(tok);
  });

  it("a malformed token fails closed without a DB round-trip", async () => {
    expect(await load("not-a-uuid")).toBeNull();
    expect(await load("")).toBeNull();
  });

  it("an unknown (well-formed) token fails closed", async () => {
    expect(await load(uuid())).toBeNull();
  });

  // -------------------------------------------------------------------
  // Rotation ⊗ expiry
  // -------------------------------------------------------------------

  it("rotating the token invalidates the OLD token immediately", async () => {
    const oldTok = uuid();
    const id = await mkCustomer(orgId, oldTok);
    expect(await load(oldTok)).not.toBeNull();

    // Rotate (mirrors rotateCustomerPortalToken: new token, cleared expiry+usage).
    const newTok = uuid();
    await db(serviceClient())
      .from("customers")
      .update({
        portal_token: newTok,
        portal_token_expires_at: null,
        portal_token_last_used_at: null,
      })
      .eq("id", id);

    expect(await load(oldTok)).toBeNull(); // old no longer resolves
    expect(await load(newTok)).not.toBeNull(); // new works
  });

  it("rotation clears a prior expiry — the new link is not born expired", async () => {
    const oldTok = uuid();
    const id = await mkCustomer(orgId, oldTok, {
      portal_token_expires_at: iso(Date.now() - HOUR), // old link WAS expired
    });
    expect(await load(oldTok)).toBeNull();

    const newTok = uuid();
    await db(serviceClient())
      .from("customers")
      .update({
        portal_token: newTok,
        portal_token_expires_at: null,
        portal_token_last_used_at: null,
      })
      .eq("id", id);

    expect(await load(newTok)).not.toBeNull(); // valid despite the old expiry
  });

  // -------------------------------------------------------------------
  // Usage tracking (debounced, post-validation only)
  // -------------------------------------------------------------------

  it("a valid load stamps last_used_at when it was NULL", async () => {
    const tok = uuid();
    const id = await mkCustomer(orgId, tok);
    expect((await readCustomer(id)).portal_token_last_used_at).toBeNull();

    await load(tok);
    expect((await readCustomer(id)).portal_token_last_used_at).not.toBeNull();
  });

  it("a rejected (expired) load does NOT stamp last_used_at", async () => {
    const tok = uuid();
    const id = await mkCustomer(orgId, tok, {
      portal_token_expires_at: iso(Date.now() - HOUR),
    });
    await load(tok); // rejected
    expect((await readCustomer(id)).portal_token_last_used_at).toBeNull();
  });

  it("an unknown token writes nothing (no row to touch)", async () => {
    // Purely that it doesn't throw and returns null; there is no row to inspect.
    expect(await load(uuid())).toBeNull();
  });

  it("the debounce holds: a second immediate load does NOT rewrite last_used_at", async () => {
    const tok = uuid();
    const id = await mkCustomer(orgId, tok);
    await load(tok);
    const first = (await readCustomer(id)).portal_token_last_used_at;
    expect(first).not.toBeNull();

    await load(tok); // within the hour → debounced, no write
    const second = (await readCustomer(id)).portal_token_last_used_at;
    expect(second).toBe(first); // unchanged
  });

  it("a stale last_used_at IS refreshed on the next load", async () => {
    const tok = uuid();
    const id = await mkCustomer(orgId, tok, {
      portal_token_last_used_at: iso(Date.now() - 2 * HOUR), // older than the interval
    });
    const before = (await readCustomer(id)).portal_token_last_used_at;
    await load(tok);
    const after = (await readCustomer(id)).portal_token_last_used_at;
    expect(after).not.toBe(before); // a fresh stamp
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
  });

  // -------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------

  it("the usage touch only affects the authenticating customer's row", async () => {
    const tokA = uuid();
    const tokB = uuid();
    const idA = await mkCustomer(orgId, tokA);
    const idB = await mkCustomer(orgBId, tokB); // different org

    await load(tokA);

    expect((await readCustomer(idA)).portal_token_last_used_at).not.toBeNull();
    // B (another org, another customer) was untouched.
    expect((await readCustomer(idB)).portal_token_last_used_at).toBeNull();
  });

  it("the loaded org_id matches the token's own customer, never another", async () => {
    const tokB = uuid();
    await mkCustomer(orgBId, tokB);
    const res = await load(tokB);
    expect(res?.customer.org_id).toBe(orgBId);
    expect(res?.customer.org_id).not.toBe(orgId);
  });
});
