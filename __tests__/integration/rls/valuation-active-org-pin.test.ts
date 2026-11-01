import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * certify_valuation / generate_valuation_invoice are ACTIVE-ORG PINNED
 * (migration 20261267000000). Before the fix they derived org_id from the
 * valuation row and gated on is_org_admin(that org), so an admin of TWO orgs,
 * working in org A, could certify or invoice an org B valuation by its id. Now
 * both take the caller's active org (p_org_id); a valuation outside it is "not
 * found", and a caller who is not a member of p_org_id is refused with 42501.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; }
interface Ins extends PromiseLike<Res<null>> { select(c?: string): { single(): PromiseLike<Res<Row>> }; }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; }
type Rpc = (fn: string, args: Row) => PromiseLike<Res<unknown>>;
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc: Rpc };
const svc = () => db(serviceClient());
const TOKEN = `val-ao-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "", jobA = "", jobB = "", valA = "", valB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `VAO ${s}` });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}
const insId = async (table: string, r: Row): Promise<string> =>
  String((await svc().from(table).insert(r).select("id").single()).data?.id ?? "");
const statusOf = async (id: string): Promise<string> => {
  const r = await svc().from("job_valuations").select("status").eq("id", id);
  return String(r.data?.[0]?.status ?? "");
};
const submittedVal = (org: string, job: string) => ({
  org_id: org, job_id: job, sequence: 1, status: "submitted",
  work_completed_to_date: 1000, materials_on_site: 0, deductions: 0, vat_rate: 20,
});

describeIntegration("rls · valuation RPCs active-org pin (20261267)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `VAO A ${TOKEN}`, slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: `VAO B ${TOKEN}`, slug: `${TOKEN}-b` });
    const cA = await insId("customers", { org_id: orgA, name: "Cust A" });
    const cB = await insId("customers", { org_id: orgB, name: "Cust B" });
    jobA = await insId("jobs", { org_id: orgA, status: "in-progress", customer_id: cA });
    jobB = await insId("jobs", { org_id: orgB, status: "in-progress", customer_id: cB });
    for (const who of ["dual", "staffA"]) {
      const u = await mkUser(who);
      uid[who] = u.id; tok[who] = u.token;
    }
    // dual = admin of BOTH orgs (the defect actor). staffA = staff of org A only.
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.dual, role: "admin" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.dual, role: "admin" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffA, role: "staff" });
    valA = await insId("job_valuations", submittedVal(orgA, jobA));
    valB = await insId("job_valuations", submittedVal(orgB, jobB));
    if (!valA || !valB) throw new Error("valuation seed failed");
  });

  it("certify is pinned to the active org: a dual-org admin in org A cannot certify an org B valuation", async () => {
    const dual = db(userClient(tok.dual ?? ""));
    // Active in org A, targeting the org B valuation → pinned fetch misses → not found.
    const wrong = await dual.rpc("certify_valuation", { p_org_id: orgA, p_valuation_id: valB });
    expect(wrong.error, "cross-active-org certify must be refused").not.toBeNull();
    expect(await statusOf(valB), "org B valuation untouched").toBe("submitted");

    // Active in org B (their own other org) → allowed.
    const right = await dual.rpc("certify_valuation", { p_org_id: orgB, p_valuation_id: valB });
    expect(right.error, right.error?.message).toBeNull();
    expect(await statusOf(valB)).toBe("certified");
  });

  it("generate_valuation_invoice is pinned too", async () => {
    const dual = db(userClient(tok.dual ?? "")); // valB is now 'certified' from the prior test
    const wrong = await dual.rpc("generate_valuation_invoice", { p_org_id: orgA, p_valuation_id: valB });
    expect(wrong.error, "cross-active-org invoice generation must be refused").not.toBeNull();
    expect(await statusOf(valB), "still certified, not invoiced").toBe("certified");

    const right = await dual.rpc("generate_valuation_invoice", { p_org_id: orgB, p_valuation_id: valB });
    expect(right.error, right.error?.message).toBeNull();
    expect(await statusOf(valB)).toBe("invoiced");

    // Money math unchanged: net_certified_this = work(1000)+materials(0)+var(0)
    // -prev(0)-deductions(0) = 1000; VAT @20% = 200. The invoice the RPC minted
    // must carry exactly those (amount is ex-VAT, the full certified increment).
    const inv = await svc().from("invoices").select("amount, vat_total, status, org_id").eq("id", String(right.data));
    const r0 = inv.data?.[0];
    expect(Number(r0?.amount), "ex-VAT amount = net_certified_this").toBe(1000);
    expect(Number(r0?.vat_total), "VAT = net * 20%").toBe(200);
    expect(r0?.status, "born draft").toBe("draft");
    expect(String(r0?.org_id), "invoice billed within org B only").toBe(orgB);
  });

  it("a non-admin member is refused, and a non-member of p_org_id hits the 42501 guard", async () => {
    const staff = db(userClient(tok.staffA ?? ""));
    // staffA is a member of org A (passes the guard) but not an admin → refused.
    const notAdmin = await staff.rpc("certify_valuation", { p_org_id: orgA, p_valuation_id: valA });
    expect(notAdmin.error?.message ?? "", "staff cannot certify").toMatch(/owner or admin/i);
    expect(await statusOf(valA)).toBe("submitted");

    // staffA is NOT a member of org B → the current_org_ids()+42501 guard fires.
    const notMember = await staff.rpc("certify_valuation", { p_org_id: orgB, p_valuation_id: valA });
    expect(notMember.error, "a non-member of p_org_id is blocked by the guard").not.toBeNull();

    // anon → 42501 (empty current_org_ids()).
    const anon = await db(anonClient()).rpc("certify_valuation", { p_org_id: orgA, p_valuation_id: valA });
    expect(anon.error, "anon denied").not.toBeNull();
    expect(await statusOf(valA), "valA untouched throughout").toBe("submitted");
  });
});
