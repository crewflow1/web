import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { recogniseCaller } from "@/server/services/caller-recognition";
import { selectReusableLead } from "@/lib/telephony/caller-recognition";
import { processInboundEnquiry, reconcileProvisionalLead } from "@/server/services/receptionist";

/**
 * Caller recognition against REAL Postgres — the security-critical surface.
 *
 * Proves, with no mocks:
 *   - TENANT ISOLATION: a number is only ever matched within the CALLED org. The same
 *     number owned by a different org is NEVER surfaced or linked cross-tenant.
 *   - number-format tolerance (national vs international reconcile via phone_sig).
 *   - the never-guess rules: multiple matches / withheld ⇒ ambiguous, link nothing.
 *   - open-matter reuse (requirement 4) vs a closed lead (new lead).
 *   - the inbound PIPELINE: a known customer's call creates a lead LINKED to them;
 *     duplicate and concurrent callbacks (same CallSid) create NO duplicate lead.
 */

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TOKEN = `crec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

let orgA = "";
let orgB = "";

async function mkOrg(tag: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `CRec ${tag}`, slug: `${TOKEN}-${tag}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkCustomer(org: string, name: string, phone: string): Promise<string> {
  const r = await svc().from("customers").insert({ org_id: org, name, phone }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkLead(org: string, extra: Row): Promise<string> {
  const r = await svc().from("leads").insert({ org_id: org, source: "phone", status: "new", ...extra }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function leadsForCustomer(org: string, customerId: string): Promise<Row[]> {
  const r = await svc().from("leads").select("id, customer_id, contact_phone").eq("org_id", org).eq("customer_id", customerId);
  expect(r.error, r.error?.message).toBeNull();
  return (r.data ?? []) as Row[];
}
async function mkEnquiry(org: string, sid: string, leadId: string): Promise<string> {
  const r = await svc()
    .from("inbound_enquiries")
    .insert({ org_id: org, channel: "phone", provider_message_id: sid, lead_id: leadId, status: "qualified" })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkCall(org: string, sid: string, leadId: string): Promise<string> {
  const r = await svc()
    .from("calls")
    .insert({ org_id: org, direction: "inbound", status: "completed", provider: "twilio", provider_call_id: sid, lead_id: leadId })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function leadExists(id: string): Promise<boolean> {
  const r = await svc().from("leads").select("id").eq("id", id).maybeSingle();
  return Boolean(r.data?.id);
}
async function callLeadId(id: string): Promise<string | null> {
  const r = await svc().from("calls").select("lead_id").eq("id", id).single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data.lead_id as string | null) ?? null;
}

describeIntegration("telephony · caller recognition (tenant-isolated, real PG)", () => {
  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
  });
  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
  });

  it("1. TENANT ISOLATION — the same number in two orgs matches only within the called org", async () => {
    const shared = "+447700900111";
    const custA = await mkCustomer(orgA, "Alice A", shared);
    const custB = await mkCustomer(orgB, "Bob B", shared);

    const inA = await recogniseCaller({ orgId: orgA, callerId: shared });
    expect(inA.status).toBe("single_customer");
    expect(inA.customer?.id).toBe(custA);
    expect(inA.customer?.id).not.toBe(custB); // never the other tenant's record

    const inB = await recogniseCaller({ orgId: orgB, callerId: shared });
    expect(inB.status).toBe("single_customer");
    expect(inB.customer?.id).toBe(custB);
  });

  it("2. a number that exists ONLY in another org is a no_match here (no cross-tenant leak)", async () => {
    const onlyB = "+447700900222";
    await mkCustomer(orgB, "Carol B", onlyB);
    const inA = await recogniseCaller({ orgId: orgA, callerId: onlyB });
    expect(inA.status).toBe("no_match");
    expect(inA.customer).toBeNull();
  });

  it("3. number-format tolerant — national form matches an internationally-stored number", async () => {
    const stored = "+44 7700 900333";
    const cust = await mkCustomer(orgA, "Dave D", stored);
    const r = await recogniseCaller({ orgId: orgA, callerId: "07700900333" });
    expect(r.status).toBe("single_customer");
    expect(r.customer?.id).toBe(cust);
  });

  it("4. (7) multiple customers on one number ⇒ ambiguous, no link", async () => {
    const dup = "+447700900444";
    await mkCustomer(orgA, "Eve One", dup);
    await mkCustomer(orgA, "Eve Two", dup);
    const r = await recogniseCaller({ orgId: orgA, callerId: dup });
    expect(r.status).toBe("multiple_customers");
    expect(r.ambiguous).toBe(true);
    expect(r.customer).toBeNull();
    expect(r.candidateLeads).toEqual([]);
  });

  it("5. single customer's OPEN leads are the reuse CANDIDATES (closed excluded); the matcher picks by project, not age", async () => {
    const phone = "+447700900555";
    const cust = await mkCustomer(orgA, "Fin Open", phone);
    const bath = await mkLead(orgA, { customer_id: cust, status: "new", service: "Bathroom refit", postcode: "BT9 5XY" });
    const kitchen = await mkLead(orgA, { customer_id: cust, status: "qualified", service: "Kitchen extension", postcode: "BT1 1AA" });
    await mkLead(orgA, { customer_id: cust, status: "won", service: "Old job", postcode: "BT1 1AA" }); // closed ⇒ excluded
    const r = await recogniseCaller({ orgId: orgA, callerId: phone });
    expect(r.status).toBe("single_customer");
    expect(r.candidateLeads.map((c) => c.id).sort()).toEqual([bath, kitchen].sort()); // open only
    // EVIDENCE-BASED reuse over the REAL candidate rows: same project ⇒ the right lead
    // (kitchen), NOT the oldest (bathroom); a different project ⇒ no reuse.
    expect(selectReusableLead({ service: "kitchen extension", postcode: "BT1 1AA" }, r.candidateLeads)).toBe(kitchen);
    expect(selectReusableLead({ service: "Driveway", postcode: "BT4 2AA" }, r.candidateLeads)).toBeNull();
  });

  it("6. a NON-customer caller gets NO reuse candidates (a phone match alone never reuses)", async () => {
    const phone = "+447700900666";
    await mkLead(orgA, { contact_phone: phone, status: "new", service: "Fencing", postcode: "BT2 2BB" });
    const r = await recogniseCaller({ orgId: orgA, callerId: phone });
    expect(r.status).toBe("no_match");
    expect(r.customer).toBeNull();
    expect(r.candidateLeads).toEqual([]);
  });

  it("7. (7) withheld caller id ⇒ withheld, link nothing", async () => {
    const r = await recogniseCaller({ orgId: orgA, callerId: "anonymous" });
    expect(r.status).toBe("withheld");
    expect(r.ambiguous).toBe(true);
    expect(r.candidateLeads).toEqual([]);
  });

  it("8. PIPELINE — a known customer's call creates a lead LINKED to that customer", async () => {
    const phone = "+447700900777";
    const cust = await mkCustomer(orgA, "Hanna Known", phone);
    const res = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: `${TOKEN}-CA8`, provider_message_id: `${TOKEN}-CA8` },
      { textback: "defer" },
    );
    expect(res.lead_id).toBeTruthy();
    const leads = await leadsForCustomer(orgA, cust);
    expect(leads.length).toBe(1);
    expect(leads[0]?.id).toBe(res.lead_id);
    expect(leads[0]?.contact_phone).toBe(phone); // caller persisted ⇒ future-matchable
  });

  it("9. PIPELINE — a DUPLICATE callback (same CallSid) creates NO duplicate lead", async () => {
    const phone = "+447700900888";
    const cust = await mkCustomer(orgA, "Ian Dup", phone);
    const sid = `${TOKEN}-CA9`;
    const first = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: sid, provider_message_id: sid },
      { textback: "defer" },
    );
    const second = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: sid, provider_message_id: sid },
      { textback: "defer" },
    );
    expect(second.lead_id).toBe(first.lead_id); // idempotent on CallSid
    expect((await leadsForCustomer(orgA, cust)).length).toBe(1);
  });

  it("10. PIPELINE — CONCURRENT callbacks (same CallSid) create exactly ONE enquiry + lead", async () => {
    const phone = "+447700900999";
    const cust = await mkCustomer(orgA, "Jo Race", phone);
    const sid = `${TOKEN}-CA10`;
    const input = { org_id: orgA, channel: "phone" as const, caller: phone, dedup_key: sid, provider_message_id: sid };
    await Promise.allSettled([
      processInboundEnquiry(input, { textback: "defer" }),
      processInboundEnquiry(input, { textback: "defer" }),
    ]);
    const enq = await svc().from("inbound_enquiries").select("id").eq("org_id", orgA).eq("provider_message_id", sid);
    expect(enq.error, enq.error?.message).toBeNull();
    expect((enq.data ?? []).length).toBe(1); // partial-unique (org, provider_message_id)
    expect((await leadsForCustomer(orgA, cust)).length).toBe(1); // exactly one lead, linked
  });

  it("11. PIPELINE — a caller matching a customer in ANOTHER org is NOT linked cross-tenant", async () => {
    const phone = "+447700900123";
    await mkCustomer(orgB, "Kurt OtherOrg", phone); // exists only in org B
    const res = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: `${TOKEN}-CA11`, provider_message_id: `${TOKEN}-CA11` },
      { textback: "defer" },
    );
    expect(res.lead_id).toBeTruthy();
    const lead = await svc().from("leads").select("id, customer_id").eq("id", res.lead_id).single();
    expect(lead.error, lead.error?.message).toBeNull();
    expect(lead.data.customer_id, "must not link to another tenant's customer").toBeNull();
  });

  it("12. REPEAT CALL — a known customer with an existing open lead gets a NEW lead, NOT the oldest reused", async () => {
    const phone = "+447700901212";
    const cust = await mkCustomer(orgA, "Liam Repeat", phone);
    // A pre-existing open matter for this customer.
    const existing = await mkLead(orgA, { customer_id: cust, status: "qualified", service: "Kitchen", postcode: "BT1 1AA" });
    // A fresh voice call (no transcript ⇒ no project evidence) must NOT fold into it.
    const res = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: `${TOKEN}-CA12`, provider_message_id: `${TOKEN}-CA12` },
      { textback: "defer" },
    );
    expect(res.lead_id).toBeTruthy();
    expect(res.lead_id).not.toBe(existing); // the key fix: no phone-only reuse
    const leads = await leadsForCustomer(orgA, cust);
    expect(leads.length).toBe(2); // existing matter preserved + a new lead, both linked to the customer
  });

  it("13. MULTIPLE OPEN PROJECTS — an evidence-less repeat call creates a new lead, reusing NEITHER project", async () => {
    const phone = "+447700901313";
    const cust = await mkCustomer(orgA, "Mia Multi", phone);
    const p1 = await mkLead(orgA, { customer_id: cust, status: "new", service: "Kitchen", postcode: "BT1 1AA" });
    const p2 = await mkLead(orgA, { customer_id: cust, status: "quoted", service: "Bathroom", postcode: "BT9 5XY" });
    const res = await processInboundEnquiry(
      { org_id: orgA, channel: "phone", caller: phone, dedup_key: `${TOKEN}-CA13`, provider_message_id: `${TOKEN}-CA13` },
      { textback: "defer" },
    );
    expect(res.lead_id).not.toBe(p1);
    expect(res.lead_id).not.toBe(p2);
    expect((await leadsForCustomer(orgA, cust)).length).toBe(3); // both projects untouched + new lead
  });

  // ── Completion-time reconciliation (transcript processed) ────────────────────
  // Seed the shape the voice completion path reaches: an existing open lead for the
  // customer, plus a PROVISIONAL lead created this call with its enquiry + call row.
  async function seedProvisional(tag: string, existing: { service: string; postcode: string }) {
    const phone = `+4477009030${tag}`;
    const cust = await mkCustomer(orgA, `Recon ${tag}`, phone);
    const existingLead = await mkLead(orgA, { customer_id: cust, status: "qualified", ...existing });
    const provisional = await mkLead(orgA, { customer_id: cust, status: "new" }); // no project yet
    const sid = `${TOKEN}-RC${tag}`;
    const enquiryId = await mkEnquiry(orgA, sid, provisional);
    const callRow = await mkCall(orgA, sid, provisional);
    return { cust, existingLead, provisional, sid, enquiryId, callRow };
  }

  it("14. MERGE — confident same-project transcript folds the provisional lead into the existing one", async () => {
    const s = await seedProvisional("14", { service: "Kitchen extension", postcode: "BT1 1AA" });
    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "kitchen extension", postcode: "BT1 1AA" }, // matches, case/format-insensitive
      confidence: 90,
    });
    expect(r.mergedInto).toBe(s.existingLead);
    expect(await leadExists(s.provisional)).toBe(false); // duplicate removed
    expect(await callLeadId(s.callRow)).toBe(s.existingLead); // call re-linked
    expect((await leadsForCustomer(orgA, s.cust)).length).toBe(1); // one lead remains
  });

  it("15. NO MERGE — a DIFFERENT project keeps the provisional lead (two distinct jobs)", async () => {
    const s = await seedProvisional("15", { service: "Kitchen extension", postcode: "BT1 1AA" });
    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "Bathroom refit", postcode: "BT9 5XY" },
      confidence: 95,
    });
    expect(r.mergedInto).toBeNull();
    expect(await leadExists(s.provisional)).toBe(true);
    expect((await leadsForCustomer(orgA, s.cust)).length).toBe(2); // both kept
  });

  it("16. NO MERGE — a LOW-confidence transcript never merges (destructive op needs proof)", async () => {
    const s = await seedProvisional("16", { service: "Kitchen extension", postcode: "BT1 1AA" });
    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "kitchen extension", postcode: "BT1 1AA" },
      confidence: 40, // below the merge floor
    });
    expect(r.mergedInto).toBeNull();
    expect(await leadExists(s.provisional)).toBe(true);
  });

  it("17. NO MERGE — ambiguous (two existing open leads match the same project)", async () => {
    const s = await seedProvisional("17", { service: "Kitchen extension", postcode: "BT1 1AA" });
    await mkLead(orgA, { customer_id: s.cust, status: "quoted", service: "Kitchen extension", postcode: "BT1 1AA" }); // 2nd match
    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "kitchen extension", postcode: "BT1 1AA" },
      confidence: 95,
    });
    expect(r.mergedInto).toBeNull(); // don't guess between two matching projects
    expect(await leadExists(s.provisional)).toBe(true);
  });

  it("18. NO MERGE — a transcript without a postcode is insufficient evidence", async () => {
    const s = await seedProvisional("18", { service: "Kitchen extension", postcode: "BT1 1AA" });
    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "kitchen extension", postcode: null },
      confidence: 95,
    });
    expect(r.mergedInto).toBeNull();
    expect(await leadExists(s.provisional)).toBe(true);
  });

  it("19. MERGE preserves data — notes folded, conversation + call history re-pointed, nothing orphaned", async () => {
    const s = await seedProvisional("19", { service: "Kitchen extension", postcode: "BT1 1AA" });
    // Put data ON the provisional + its call that must survive the merge.
    await svc().from("leads").update({ notes: "Caller prefers mornings" }).eq("id", s.provisional);
    const conv = await svc().from("conversations").insert({ org_id: orgA, channel: "voice", lead_id: s.provisional }).select("id").single();
    expect(conv.error, conv.error?.message).toBeNull();
    const convId = String(conv.data.id);
    const evt = await svc()
      .from("call_events")
      .insert({ org_id: orgA, call_id: s.callRow, event_type: "ringing", occurred_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(evt.error, evt.error?.message).toBeNull();

    const r = await reconcileProvisionalLead({
      orgId: orgA,
      providerCallId: s.sid,
      enquiryId: s.enquiryId,
      provisionalLeadId: s.provisional,
      project: { service: "kitchen extension", postcode: "BT1 1AA" },
      confidence: 90,
    });
    expect(r.mergedInto).toBe(s.existingLead);
    expect(await leadExists(s.provisional)).toBe(false);

    // notes folded into the surviving lead (not lost):
    const tgt = await svc().from("leads").select("notes").eq("id", s.existingLead).single();
    expect(String(tgt.data.notes ?? "")).toContain("Caller prefers mornings");
    // conversation re-pointed, not orphaned (would be SET NULL under a naive delete):
    const convAfter = await svc().from("conversations").select("lead_id").eq("id", convId).single();
    expect(convAfter.data.lead_id).toBe(s.existingLead);
    // call re-pointed + its history (call_events) survives on the call:
    expect(await callLeadId(s.callRow)).toBe(s.existingLead);
    const evtAfter = await svc().from("call_events").select("id").eq("id", String(evt.data.id)).maybeSingle();
    expect(evtAfter.data?.id).toBeTruthy();
  });
});
