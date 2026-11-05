import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Quotes admin-only isolation — real Postgres, real JWTs (migration
 * 20261278000000). D-13 (founder-approved): quotes + quote_line_items are
 * owner/admin only. This is the dedicated staff-JWT negative test, incl.
 * cross-org and revoked users, for SELECT/INSERT/UPDATE/DELETE via PostgREST.
 */

type Res = { data: unknown[] | null; error: { code?: string; message: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Row): { select(c?: string): { single(): PromiseLike<{ data: Row | null; error: { code?: string; message: string } | null }> } };
      select(c?: string): { eq(k: string, v: unknown): PromiseLike<Res> };
      update(r: Row): { eq(k: string, v: unknown): PromiseLike<Res> };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res> };
    };
  };

const TOKEN = `it-qao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PW = `Pw-${TOKEN}`;

async function mkUser(email: string, role: string, orgId: string): Promise<{ id: string; token: string }> {
  const created = await serviceClient().auth.admin.createUser({ email, password: PW, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role });
  const token = (await anonClient().auth.signInWithPassword({ email, password: PW })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${email}`);
  return { id, token };
}

describeIntegration("quotes · admin-only isolation (staff/cross-org/revoked denied)", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "", custA = "", quoteId = "", lineId = "";
  let owner = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let revoked = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  const insId = async (table: string, row: Row): Promise<string> =>
    String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "QAO A", slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: "QAO B", slug: `${TOKEN}-b` });
    owner = await mkUser(`${TOKEN}-owner@example.test`, "owner", orgA);
    staff = await mkUser(`${TOKEN}-staff@example.test`, "staff", orgA);
    revoked = await mkUser(`${TOKEN}-revoked@example.test`, "staff", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);
    custA = await insId("customers", { org_id: orgA, name: "QAO Cust" });
    quoteId = await insId("quotes", { org_id: orgA, customer_id: custA, number: `Q-${TOKEN}`, status: "draft", subtotal: 0, vat_total: 0, total: 0 });
    lineId = await insId("quote_line_items", { org_id: orgA, quote_id: quoteId, description: "Line" });
    if (!quoteId || !lineId) throw new Error("fixture failed");
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
    for (const u of [owner.id, staff.id, revoked.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const count = async (token: string, table: string): Promise<number> => {
    const r = await db(userClient(token)).from(table).select("id").eq("org_id", orgA);
    return (r.data ?? []).length;
  };

  it("OWNER reads quotes + line items", async () => {
    expect(await count(owner.token, "quotes")).toBeGreaterThan(0);
    expect(await count(owner.token, "quote_line_items")).toBeGreaterThan(0);
  });

  for (const [who, get] of [
    ["STAFF", () => staff.token],
    ["cross-org OUTSIDER", () => outsider.token],
  ] as const) {
    it(`${who} reads NO quotes and NO line items`, async () => {
      expect(await count(get(), "quotes")).toBe(0);
      expect(await count(get(), "quote_line_items")).toBe(0);
    });
  }

  it("STAFF cannot INSERT a quote (42501)", async () => {
    const r = await db(userClient(staff.token)).from("quotes").insert({ org_id: orgA, customer_id: custA, number: `X-${TOKEN}`, status: "draft", subtotal: 0, vat_total: 0, total: 0 }).select("id").single();
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  });

  it("STAFF cannot UPDATE or DELETE a quote (0 rows — it is unchanged)", async () => {
    await db(userClient(staff.token)).from("quotes").update({ status: "sent" }).eq("id", quoteId);
    await db(userClient(staff.token)).from("quotes").delete().eq("id", quoteId);
    const after = (await svc.from("quotes").select("status").eq("id", quoteId)).data?.[0] as { status?: string } | undefined;
    expect(after?.status).toBe("draft");
  });

  it("a REVOKED member reads no quotes after membership removal", async () => {
    await svc.from("memberships").delete().eq("user_id", revoked.id);
    expect(await count(revoked.token, "quotes")).toBe(0);
  });
});
