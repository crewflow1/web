/* eslint-disable @typescript-eslint/no-explicit-any -- raw rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { createWorld, destroyWorld, svc, type World } from "./_fixture";
import { loadNonActiveOrgIds } from "@/server/services/org-lifecycle";
import { runLeadFollowups } from "@/server/services/lead-followups";
import { runReviewRequestSends } from "@/server/services/review-requests";

/**
 * D-17 — a company that is not active stops chasing its customers. The scheduled senders
 * (invoice chasers, quote follow-ups, review requests, service / warranty reminders, lead
 * follow-ups, automation schedules) all skip the ids returned by loadNonActiveOrgIds; this
 * proves the set against real Postgres and drives two real senders end to end.
 */
describeIntegration("D-17 · scheduled customer reminders skip companies that are not active", () => {
  let w: World | null = null;
  const setStatus = async (org: string, status: string) => {
    const r = await svc().from("organizations").update({ status }).eq("id", org);
    if (r.error) throw new Error(r.error.message);
  };

  beforeAll(async () => {
    w = await createWorld("d17-remind");
  }, 120_000);
  afterAll(async () => {
    await setStatus(w!.A.id, "active");
    await destroyWorld(w);
  }, 120_000);

  it("loadNonActiveOrgIds contains pending / suspended / rejected / cancelled companies and never an active / trial one", async () => {
    const world = w!;
    for (const s of ["pending", "suspended", "rejected", "cancelled"]) {
      await setStatus(world.A.id, s);
      const held = await loadNonActiveOrgIds();
      expect(held.has(world.A.id), s).toBe(true);
      expect(held.has(world.B.id), "the active company").toBe(false);
    }
    for (const s of ["active", "trial"]) {
      await setStatus(world.A.id, s);
      expect((await loadNonActiveOrgIds()).has(world.A.id), s).toBe(false);
    }
  });

  it("review requests: a due request is NOT sent while the company is suspended, and is sent once it is active again", async () => {
    const world = w!;
    const cust = (await svc().from("customers").insert({ org_id: world.A.id, name: "Review Customer", email: `rev-${world.tag}@example.test` }).select("id").single()).data!;
    const rr = await svc().from("review_requests").insert({ org_id: world.A.id, customer_id: cust.id, platform: "google", status: "scheduled", send_at: new Date(Date.now() - 60_000).toISOString() }).select("id").single();
    expect(rr.error, JSON.stringify(rr.error)).toBeNull();
    const statusOf = async () => (await svc().from("review_requests").select("status").eq("id", rr.data!.id).single()).data!.status;

    await setStatus(world.A.id, "suspended");
    await runReviewRequestSends();
    expect(await statusOf(), "untouched while suspended").toBe("scheduled");

    await setStatus(world.A.id, "active");
    await runReviewRequestSends();
    expect(await statusOf(), "processed once active").not.toBe("scheduled");
  }, 120_000);

  it("lead follow-ups: no customer-facing follow-up is emitted for a cancelled company's lead", async () => {
    const world = w!;
    await svc().from("leads").insert({ org_id: world.A.id, source: "web", status: "new", contact_name: "Lee Lead", contact_email: `lead-${world.tag}@example.test`, created_at: new Date(Date.now() - 3 * 86400_000).toISOString() });
    // baseline AFTER the insert (creating a lead emits its own "new lead" notifications)
    const before = ((await svc().from("notifications").select("id").eq("org_id", world.A.id)).data ?? []).length;
    await setStatus(world.A.id, "cancelled");
    await runLeadFollowups();
    const after = ((await svc().from("notifications").select("id").eq("org_id", world.A.id)).data ?? []).length;
    expect(after, "no follow-up notification for a cancelled company").toBe(before);
    // control: the SAME lead IS followed up once the company is active again
    await setStatus(world.A.id, "active");
    await runLeadFollowups();
    const active = ((await svc().from("notifications").select("id").eq("org_id", world.A.id)).data ?? []).length;
    expect(active, "follow-up fires for the active company (the skip above was the lifecycle gate)").toBeGreaterThan(before);
  }, 120_000);
});

import { emitNotifications } from "@/server/services/notifications-service";

describeIntegration("D-17 · notifications for a company that is not active", () => {
  let w: World | null = null;
  beforeAll(async () => { w = await createWorld("d17-notif"); }, 120_000);
  afterAll(async () => {
    await svc().from("organizations").update({ status: "active" }).eq("id", w!.A.id);
    await destroyWorld(w);
  }, 120_000);

  it("a suspended company still gets its billing notice; operational notices are withheld from the tenant, HQ keeps its copy", async () => {
    const world = w!;
    await svc().from("organizations").update({ status: "suspended" }).eq("id", world.A.id);
    // the held-company list is cached per process for 60 s (a status change applies within a minute)
    (await import("@/server/services/org-lifecycle")).clearNonActiveOrgCache();
    const base = { org_id: world.A.id, user_id: null, priority: "medium" as const };
    await emitNotifications([
      { ...base, audience: "customer", type: `d17.op.${world.tag}`, category: "system", title: "Stock low" },
      { ...base, audience: "both", type: `d17.both.${world.tag}`, category: "system", title: "Job overdue" },
      { ...base, audience: "customer", type: `d17.bill.${world.tag}`, category: "billing", title: "Payment failed" },
      { ...base, audience: "hq", type: `d17.hq.${world.tag}`, category: "system", title: "HQ note" },
    ]);
    const rows = ((await svc().from("notifications").select("type, audience, category").eq("org_id", world.A.id).like("type", `d17.%.${world.tag}`)).data ?? []) as any[];
    const by = Object.fromEntries(rows.map((r) => [r.type.split(".")[1], r.audience]));
    expect(by.op, "operational tenant notice is withheld").toBeUndefined();
    expect(by.both, "a both-audience operational notice reaches HQ only").toBe("hq");
    expect(by.bill, "the billing notice is delivered to the company").toBe("customer");
    expect(by.hq, "HQ is never muted").toBe("hq");
  }, 120_000);
});
