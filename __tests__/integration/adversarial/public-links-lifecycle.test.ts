/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { createWorld, destroyWorld, svc, type World } from "./_fixture";
import { acceptQuoteByToken, declineQuoteByToken } from "@/app/(app)/quotes/actions";
import { POST as leadPost } from "@/app/api/public/lead/route";
import { resolveApiKey } from "@/lib/api-auth/resolve";
import { generateApiKey } from "@/lib/api-auth/keygen";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { gatePortalWrite, orgPublicWriteRefused, OrgNotAcceptingError } from "@/server/services/org-lifecycle";

const loadCustomerForPortalWrite = async (token: string, kind: "operational" | "payment" | "consent") =>
  gatePortalWrite(await loadCustomerByPortalToken(token), kind);

/**
 * D-17 — PUBLIC links and keys cannot get round the company lifecycle. Real route handlers /
 * server functions, real Postgres. For a company that is pending / suspended / rejected /
 * cancelled, none of these may create a job, an invoice, a lead, an enquiry or any other
 * operational record — and what MUST keep working (paying an existing invoice while suspended /
 * cancelled; the data subject's own consent / contact rights, always) still does.
 */
const HELD = ["pending", "suspended", "rejected", "cancelled"] as const;

describeIntegration("D-17 · public links, forms, inbound channels and API keys respect the company lifecycle", () => {
  let w: World | null = null;
  let customerId = "";
  const portalToken = crypto.randomUUID();
  let apiKeyPlain = "";
  let seq = 0;
  let ip = 0;

  const setStatus = async (status: string) => {
    const r = await svc().from("organizations").update({ status }).eq("id", w!.A.id);
    if (r.error) throw new Error(`org status: ${r.error.message}`);
  };
  const count = async (table: string) =>
    (await svc().from(table).select("id", { count: "exact", head: true }).eq("org_id", w!.A.id)).count ?? 0;
  const makeQuote = async () => {
    seq += 1;
    const token = `tok_${w!.tag}_${seq}`;
    const q = await svc().from("quotes").insert({
      org_id: w!.A.id, customer_id: customerId, number: `Q-${w!.tag}-${seq}`, status: "sent", subtotal: 1000, vat_total: 200, public_token: token,
    }).select("id").single();
    if (q.error) throw new Error(`quote: ${q.error.message}`);
    await svc().from("quote_line_items").insert({ quote_id: q.data!.id, org_id: w!.A.id, description: "Works", qty: 1, unit: "ea", unit_price: 1000, vat_rate: 20, line_total: 1000, sort_order: 0 });
    return { id: q.data!.id as string, token };
  };
  const lead = (email: string) => {
    ip += 1;
    return leadPost(new Request("http://localhost/api/public/lead", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${ip}.${ip}` },
      body: JSON.stringify({ orgSlug: w!.A.slug.toLowerCase(), name: "Pat Prospect", email, phone: "", service: "Extension", postcode: "SW1A 1AA", message: "Quote please, rear extension.", consent: true, website: "" }),
    }) as never);
  };

  beforeAll(async () => {
    const world = await createWorld("d17-public");
    w = world;
    const c = await svc().from("customers").insert({ org_id: world.A.id, name: `Public customer ${world.tag}`, portal_token: portalToken }).select("id").single();
    if (c.error) throw new Error(`customer: ${c.error.message}`);
    customerId = c.data!.id;
    const key = generateApiKey();
    const k = await svc().from("api_keys").insert({ org_id: world.A.id, name: `d17 ${world.tag}`, key_prefix: key.keyPrefix, key_hash: key.keyHash, scopes: ["read:jobs", "write:jobs"] });
    if (k.error) throw new Error(`api key: ${k.error.message}`);
    apiKeyPlain = key.plaintext;
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  it("ACTIVE (control) · the public paths work: quote acceptance creates the job + invoice, the form creates a lead, the key resolves, the portal writes", async () => {
    const q = await makeQuote();
    const jobs = await count("jobs");
    const res = await acceptQuoteByToken(q.token, "Active Signer", null);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await count("jobs")).toBe(jobs + 1);
    expect((await lead(`active-${w!.tag}@prospect.example`)).status).toBe(200);
    expect(await resolveApiKey(`Bearer ${apiKeyPlain}`)).not.toBeNull();
    expect(await loadCustomerForPortalWrite(portalToken, "operational")).not.toBeNull();
    const inbound = await processInboundEnquiry({ org_id: w!.A.id, channel: "phone", caller: "+447700900123", raw_text: "Need a quote", dedup_key: `CA-active-${w!.tag}` });
    expect(inbound.enquiry_id).toBeTruthy();
  }, 120_000);

  for (const state of HELD) {
    it(`${state.toUpperCase()} · no public path creates an operational record`, async () => {
      const world = w!;
      const q = await makeQuote(); // sent while active, answered while held
      try {
        await setStatus(state);
        const before = { jobs: await count("jobs"), invoices: await count("invoices"), leads: await count("leads"), enquiries: await count("inbound_enquiries") };

        // quote link: neither accept nor decline
        const acc = await acceptQuoteByToken(q.token, "Held Signer", null);
        expect(acc.ok, `accept while ${state}`).toBe(false);
        const dec = await declineQuoteByToken(q.token, "too dear");
        expect(dec.ok, `decline while ${state}`).toBe(false);
        expect((await svc().from("quotes").select("status, accepted_at").eq("id", q.id).single()).data).toMatchObject({ status: "sent", accepted_at: null });

        // public enquiry form
        expect((await lead(`${state}-${world.tag}@prospect.example`)).status, `lead form while ${state}`).toBe(403);

        // inbound call / SMS / WhatsApp / email (one shared ingestion core)
        await expect(processInboundEnquiry({ org_id: world.A.id, channel: "phone", caller: "+447700900456", raw_text: "hello", dedup_key: `CA-${state}-${world.tag}` }))
          .rejects.toBeInstanceOf(OrgNotAcceptingError);

        // public API key
        expect(await resolveApiKey(`Bearer ${apiKeyPlain}`), `API key while ${state}`).toBeNull();

        // customer portal: operational writes refused …
        expect(await loadCustomerForPortalWrite(portalToken, "operational"), `portal write while ${state}`).toBeNull();
        // … the customer's own consent / contact rights always work …
        expect(await loadCustomerForPortalWrite(portalToken, "consent"), `portal consent while ${state}`).not.toBeNull();
        // … and paying an EXISTING invoice works while suspended / cancelled only.
        const pay = await loadCustomerForPortalWrite(portalToken, "payment");
        if (state === "suspended" || state === "cancelled") expect(pay, `portal payment while ${state}`).not.toBeNull();
        else expect(pay, `portal payment while ${state}`).toBeNull();

        // the gate fails closed for an org that cannot be read
        expect(await orgPublicWriteRefused("00000000-0000-0000-0000-000000000000", "operational")).toBe(true);

        // GROUND TRUTH: nothing was created
        expect({ jobs: await count("jobs"), invoices: await count("invoices"), leads: await count("leads"), enquiries: await count("inbound_enquiries") }).toEqual(before);
      } finally {
        await setStatus("active");
      }
    }, 120_000);
  }

  it("REACTIVATED · the same quote link works again", async () => {
    const q = await makeQuote();
    await setStatus("suspended");
    expect((await acceptQuoteByToken(q.token, "Signer", null)).ok).toBe(false);
    await setStatus("active");
    expect((await acceptQuoteByToken(q.token, "Signer", null)).ok).toBe(true);
  }, 120_000);
});
