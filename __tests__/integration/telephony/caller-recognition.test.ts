import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { recogniseCaller } from "@/server/services/caller-recognition";
import { processInboundEnquiry } from "@/server/services/receptionist";

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
    expect(r.reuseLeadId).toBeNull();
  });

  it("5. (4) single customer with an OPEN lead ⇒ reuse it; a CLOSED lead ⇒ new lead", async () => {
    const openPhone = "+447700900555";
    const openCust = await mkCustomer(orgA, "Fin Open", openPhone);
    const openLead = await mkLead(orgA, { customer_id: openCust, status: "qualified" });
    const rOpen = await recogniseCaller({ orgId: orgA, callerId: openPhone });
    expect(rOpen.status).toBe("single_customer");
    expect(rOpen.reuseLeadId).toBe(openLead);

    const closedPhone = "+447700900556";
    const closedCust = await mkCustomer(orgA, "Gus Closed", closedPhone);
    await mkLead(orgA, { customer_id: closedCust, status: "won" });
    const rClosed = await recogniseCaller({ orgId: orgA, callerId: closedPhone });
    expect(rClosed.status).toBe("single_customer");
    expect(rClosed.reuseLeadId).toBeNull(); // won is closed ⇒ not reused
  });

  it("6. (4,6) no customer but an OPEN lead on the number ⇒ reuse that lead", async () => {
    const phone = "+447700900666";
    const lead = await mkLead(orgA, { contact_phone: phone, status: "new" });
    const r = await recogniseCaller({ orgId: orgA, callerId: phone });
    expect(r.status).toBe("no_match");
    expect(r.customer).toBeNull();
    expect(r.reuseLeadId).toBe(lead);
  });

  it("7. (7) withheld caller id ⇒ withheld, link nothing", async () => {
    const r = await recogniseCaller({ orgId: orgA, callerId: "anonymous" });
    expect(r.status).toBe("withheld");
    expect(r.ambiguous).toBe(true);
    expect(r.reuseLeadId).toBeNull();
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
});
