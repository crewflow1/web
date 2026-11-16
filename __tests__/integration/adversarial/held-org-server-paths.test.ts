/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, svc, type World } from "./_fixture";

/**
 * D-17 — the not-active (pending / suspended / rejected / cancelled) lock, proved with REAL
 * GoTrue sessions through PostgREST, and the paths that must KEEP working:
 *
 *   A. a member of a non-active company cannot write through the Data API (tables AND the
 *      SECURITY DEFINER RPC path) — pending included — but can still READ;
 *   B. the SERVER keeps working: service_role writes (Stripe webhooks, crons, HQ,
 *      onboarding, recovery) and JWT-less SECURITY DEFINER calls are not stopped by the
 *      write guard on the 230 org tables;
 *   C. reactivation restores the company's own writes with all data intact (never erased).
 *
 * The Stripe webhook handler itself is driven across active / suspended / cancelled and back
 * in __tests__/integration/stripe/subscription-lifecycle.test.ts.
 */
const STATES = ["pending", "suspended", "rejected", "cancelled"] as const;

describeIntegration("D-17 · non-active companies: locked for members, open for the server", () => {
  let w: World | null = null;
  let siteId = "";
  let itemId = "";
  let customerId = "";

  const setStatus = async (status: string) => {
    const r = await svc().from("organizations").update({ status }).eq("id", w!.A.id);
    if (r.error) throw new Error(`org status: ${r.error.message}`);
  };
  const refused = (r: { error: { message: string } | null }, what: string) =>
    expect(r.error, `${what} must be refused`).not.toBeNull();

  beforeAll(async () => {
    const world = await createWorld("d17-held");
    w = world;
    const A = world.A.id;
    siteId = (await svc().from("sites").insert({ org_id: A, name: `held depot ${world.tag}`, kind: "depot" }).select("id").single()).data!.id;
    itemId = (await svc().from("stock_items").insert({ org_id: A, name: `held item ${world.tag}`, unit: "ea" }).select("id").single()).data!.id;
    customerId = (await svc().from("customers").insert({ org_id: A, name: `held customer ${world.tag}` }).select("id").single()).data!.id;
    const adj = await svc().rpc("record_stock_adjustment", { p_org_id: A, p_item_id: itemId, p_site_id: siteId, p_delta: 10, p_reason: "opening" });
    if (adj.error) throw new Error(`seed stock: ${adj.error.message}`);
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  for (const state of STATES) {
    it(`A · ${state.toUpperCase()} · owner / admin / staff JWTs cannot write through tables or SECURITY DEFINER RPCs, but the owner of a suspended / cancelled company still reads`, async () => {
      const world = w!;
      try {
        await setStatus(state);
        for (const who of ["owner", "admin", "staff"] as const) {
          const c = as(world.A[who].token);
          refused(await c.from("customers").insert({ org_id: world.A.id, name: `${who} while ${state}` }), `${who} customers insert (${state})`);
          refused(await c.from("sites").insert({ org_id: world.A.id, name: `${who} site ${state}`, kind: "depot" }), `${who} sites insert (${state})`);
          const upd = await c.from("customers").update({ name: "renamed" }).eq("id", customerId).select("id");
          expect(upd.error !== null || (upd.data ?? []).length === 0, `${who} customers update (${state})`).toBe(true);
          const del = await c.from("customers").delete().eq("id", customerId).select("id");
          expect(del.error !== null || (del.data ?? []).length === 0, `${who} customers delete (${state})`).toBe(true);
          refused(await c.rpc("record_stock_issue", { p_org_id: world.A.id, p_item_id: itemId, p_site_id: siteId, p_qty: 1, p_job_id: null, p_material_request_line_id: null, p_notes: "x" }), `${who} stock RPC (${state})`);
        }
        // reads: the OWNER of a suspended / cancelled company keeps read-only access (recovery /
        // export / the 30-day period); a pending / rejected company is locked for everyone.
        const read = await as(world.A.owner.token).from("customers").select("id").eq("id", customerId);
        expect((read.data ?? []).length, `owner read (${state})`).toBe(state === "suspended" || state === "cancelled" ? 1 : 0);
        // the row was never touched
        const truth = (await svc().from("customers").select("name").eq("id", customerId).single()).data;
        expect(truth!.name).toBe(`held customer ${world.tag}`);
      } finally {
        await setStatus("active");
      }
    });
  }

  it("B · the SERVER keeps working while the company is not active: service_role writes + JWT-less definer calls", async () => {
    const world = w!;
    try {
      for (const state of STATES) {
        await setStatus(state);
        // webhook / cron / HQ / onboarding writes use the service role
        const made = await svc().from("customers").insert({ org_id: world.A.id, name: `server write ${state}` }).select("id").single();
        expect(made.error, `service_role insert (${state}): ${JSON.stringify(made.error)}`).toBeNull();
        const upd = await svc().from("customers").update({ name: `server edit ${state}` }).eq("id", made.data!.id).select("id");
        expect(upd.error).toBeNull();
        expect((upd.data ?? []).length).toBe(1);
        const del = await svc().from("customers").delete().eq("id", made.data!.id).select("id");
        expect(del.error).toBeNull();
        expect((del.data ?? []).length).toBe(1);
        // a SECURITY DEFINER stock RPC called by the server (a job / webhook) passes the trigger
        const rpc = await svc().rpc("record_stock_adjustment", { p_org_id: world.A.id, p_item_id: itemId, p_site_id: siteId, p_delta: 1, p_reason: `server ${state}` });
        expect(rpc.error, `service_role definer RPC (${state}): ${JSON.stringify(rpc.error)}`).toBeNull();
      }
    } finally {
      await setStatus("active");
    }
  });

  it("C · reactivation: the company's own writes work again, and nothing was erased", async () => {
    const world = w!;
    await setStatus("cancelled");
    refused(await as(world.A.owner.token).from("customers").insert({ org_id: world.A.id, name: "while cancelled" }), "write while cancelled");
    // HQ / Stripe reactivation is a service-role update of organizations.status
    const re = await svc().from("organizations").update({ status: "active" }).eq("id", world.A.id);
    expect(re.error).toBeNull();
    const again = await as(world.A.owner.token).from("customers").insert({ org_id: world.A.id, name: "after reactivation" }).select("id").single();
    expect(again.error, JSON.stringify(again.error)).toBeNull();
    const survivors = await svc().from("customers").select("id").eq("org_id", world.A.id);
    expect((survivors.data ?? []).some((r: any) => r.id === customerId), "pre-hold data survived").toBe(true);
    // a trial company is writable too (self-serve trial)
    await setStatus("trial");
    ok(await as(world.A.owner.token).from("customers").insert({ org_id: world.A.id, name: "trial write" }), "trial company write");
    await setStatus("active");
  });
});

function ok(r: { error: { message: string } | null }, what: string) {
  expect(r.error, `${what}: ${JSON.stringify(r.error)}`).toBeNull();
}
