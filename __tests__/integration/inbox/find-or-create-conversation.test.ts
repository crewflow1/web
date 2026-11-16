/* eslint-disable @typescript-eslint/no-explicit-any -- loose service-client cast */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { findOrCreateConversation, type ConversationClient } from "@/lib/inbox/find-or-create-conversation";

/**
 * Real-Postgres proof for D-6: starting a conversation used an upsert whose
 * conflict target only matches a PARTIAL unique index, so it failed (42P10)
 * every time. The find-or-create helper must (a) create once, (b) reuse on a
 * second start, and (c) under TWO CONCURRENT starts leave exactly one row,
 * with both callers resolving to it (the 23505 loser re-selects).
 */
describeIntegration("inbox: find-or-create conversation (partial unique index)", () => {
  const db = serviceClient() as unknown as { from: (t: string) => any };
  let orgId = "";
  const slug = `it-inbox-foc-${Date.now()}`;
  const key = (ref: string) => ({ org_id: orgId, channel: "chat", contact_ref: ref });

  beforeAll(async () => {
    const o = await db.from("organizations").insert({ name: "IT Inbox FOC", slug, status: "active" }).select("id").single();
    if (o.error) throw new Error(o.error.message);
    orgId = o.data.id;
  });
  afterAll(async () => {
    await db.from("conversations").delete().eq("org_id", orgId);
    await db.from("organizations").delete().eq("id", orgId);
  });

  it("the old upsert shape is rejected by Postgres (the defect)", async () => {
    const r = await db.from("conversations").upsert({ ...key("old-shape"), status: "active" }, { onConflict: "org_id,channel,contact_ref" }).select("id");
    expect(r.error?.code).toBe("42P10");
  });

  it("creates once, then reuses and refreshes the same thread", async () => {
    const a = await findOrCreateConversation(db as ConversationClient, key("c-1"), { contact_name: "First", status: "active" });
    const b = await findOrCreateConversation(db as ConversationClient, key("c-1"), { contact_name: "Second", status: "active" });
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false, id: (a as { id: string }).id });
    const rows = (await db.from("conversations").select("id, contact_name").eq("org_id", orgId).eq("contact_ref", "c-1")).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].contact_name).toBe("Second");
  });

  it("two concurrent starts yield ONE conversation and the same id", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => findOrCreateConversation(db as ConversationClient, key("race"), { status: "active" })),
    );
    for (const r of runs) expect("error" in r ? r.error : null).toBeNull();
    expect(new Set(runs.map((r) => (r as { id: string }).id)).size).toBe(1);
    const rows = (await db.from("conversations").select("id").eq("org_id", orgId).eq("contact_ref", "race")).data;
    expect(rows).toHaveLength(1);
  });
});
