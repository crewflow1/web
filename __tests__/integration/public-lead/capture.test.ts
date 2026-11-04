import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { POST } from "@/app/api/public/lead/route";

/**
 * Public lead capture (POST /api/public/lead) — real route handler, real Postgres.
 * Proves: org is resolved from the slug server-side (no cross-tenant write), a
 * valid enquiry lands in the right org as a `web`/`new` lead, honeypot writes
 * nothing, an unknown slug 404s, and a double-submit dedups.
 */

type Row = Record<string, unknown>;
const db = (c: unknown) => c as unknown as { from(t: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const TOKEN = `it-plead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let ipCounter = 0;
function post(body: unknown): Promise<Response> {
  ipCounter += 1;
  return POST(
    new Request("http://localhost/api/public/lead", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${ipCounter}.${ipCounter}` },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function leadsFor(orgId: string): Promise<Row[]> {
  const r = await db(serviceClient()).from("leads").select("id, org_id, source, status, contact_name, contact_email, notes").eq("org_id", orgId);
  return (r.data ?? []) as Row[];
}

describeIntegration("public lead capture · POST /api/public/lead", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "";
  const slugA = `${TOKEN}-a`;
  const slugB = `${TOKEN}-b`;

  beforeAll(async () => {
    orgA = String((await svc.from("organizations").insert({ name: "Lead Co A", slug: slugA }).select("id").single()).data?.id ?? "");
    orgB = String((await svc.from("organizations").insert({ name: "Lead Co B", slug: slugB }).select("id").single()).data?.id ?? "");
    if (!orgA || !orgB) throw new Error("org seed failed");
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
  });

  const base = {
    name: "Pat Prospect",
    email: "pat@prospect.example",
    phone: "",
    service: "Extension",
    postcode: "SW1A 1AA",
    message: "Two-storey rear extension, need a quote.",
    consent: true,
    website: "",
  };

  it("creates a web/new lead in the org named by the slug", async () => {
    const res = await post({ ...base, orgSlug: slugA });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const rows = await leadsFor(orgA);
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe("web");
    expect(rows[0]!.status).toBe("new");
    expect(rows[0]!.contact_name).toBe("Pat Prospect");
  });

  it("never writes to another org (slug A only ever touches org A)", async () => {
    expect((await leadsFor(orgB)).length).toBe(0);
    // And a submit to slug B lands in org B, not org A.
    await post({ ...base, orgSlug: slugB, email: "b@prospect.example" });
    const bRows = await leadsFor(orgB);
    expect(bRows.length).toBe(1);
    expect(bRows[0]!.org_id).toBe(orgB);
  });

  it("honeypot-filled submission returns ok but writes NO lead", async () => {
    const before = (await leadsFor(orgA)).length;
    const res = await post({ ...base, orgSlug: slugA, email: "bot@spam.example", website: "http://spam" });
    expect(res.status).toBe(200);
    expect((await leadsFor(orgA)).length).toBe(before); // unchanged
  });

  it("unknown slug → 404, no lead", async () => {
    const res = await post({ ...base, orgSlug: `${TOKEN}-nope`, email: "x@prospect.example" });
    expect(res.status).toBe(404);
  });

  it("rejects missing consent (400) and writes nothing", async () => {
    const before = (await leadsFor(orgA)).length;
    const res = await post({ ...base, orgSlug: slugA, email: "noconsent@prospect.example", consent: false });
    expect(res.status).toBe(400);
    expect((await leadsFor(orgA)).length).toBe(before);
  });

  it("dedups a double-submit from the same contact within the window", async () => {
    const before = (await leadsFor(orgB)).length;
    const dupEmail = "dup@prospect.example";
    await post({ ...base, orgSlug: slugB, email: dupEmail });
    const mid = (await leadsFor(orgB)).length;
    expect(mid).toBe(before + 1);
    const res2 = await post({ ...base, orgSlug: slugB, email: dupEmail });
    expect((await res2.json()).deduped).toBe(true);
    expect((await leadsFor(orgB)).length).toBe(mid); // no second row
  });

  // ── Owner notification (the journey #1046 left open) ──────────────────────
  async function webLeadNotesFor(orgId: string): Promise<Row[]> {
    const r = await db(serviceClient())
      .from("notifications")
      .select("id, org_id, type, audience, audience_scope, source_module, source_id, action_url, title")
      .eq("org_id", orgId)
      .eq("type", "lead.web_enquiry");
    return (r.data ?? []) as Row[];
  }
  async function freshOrg(tag: string): Promise<string> {
    const id = String(
      (await svc.from("organizations").insert({ name: `Lead Co ${tag}`, slug: `${TOKEN}-${tag}` }).select("id").single()).data?.id ?? "",
    );
    if (!id) throw new Error("org seed failed");
    return id;
  }
  async function dropOrg(id: string): Promise<void> {
    await svc.from("notifications").delete().eq("org_id", id);
    await svc.from("leads").delete().eq("org_id", id);
    await svc.from("organizations").delete().eq("id", id);
  }

  it("a genuine web lead emits exactly ONE owner notification, pointed at that lead", async () => {
    const org = await freshOrg("n1");
    try {
      const res = await post({ ...base, orgSlug: `${TOKEN}-n1`, email: "notify@prospect.example" });
      expect(res.status).toBe(200);
      const notes = await webLeadNotesFor(org);
      expect(notes.length).toBe(1);
      const n = notes[0]!;
      // Commercial lead → tenant 'customer' audience, admins-only scope (never the whole crew).
      expect(n.audience).toBe("customer");
      expect(n.source_module).toBe("lead");
      const leads = await leadsFor(org);
      expect(n.source_id).toBe(leads[0]!.id);
      expect(String(n.action_url)).toBe(`/leads/${leads[0]!.id}`);
    } finally {
      await dropOrg(org);
    }
  });

  it("honeypot spam emits NO owner notification", async () => {
    const org = await freshOrg("n2");
    try {
      await post({ ...base, orgSlug: `${TOKEN}-n2`, email: "bot@spam.example", website: "http://spam" });
      expect((await webLeadNotesFor(org)).length).toBe(0);
    } finally {
      await dropOrg(org);
    }
  });

  it("a deduped double-submit does NOT emit a second notification (no alert spam)", async () => {
    const org = await freshOrg("n3");
    try {
      const email = "dupnote@prospect.example";
      await post({ ...base, orgSlug: `${TOKEN}-n3`, email });
      expect((await webLeadNotesFor(org)).length).toBe(1);
      const res2 = await post({ ...base, orgSlug: `${TOKEN}-n3`, email });
      expect((await res2.json()).deduped).toBe(true);
      expect((await webLeadNotesFor(org)).length).toBe(1); // still one — no spam
    } finally {
      await dropOrg(org);
    }
  });
});
