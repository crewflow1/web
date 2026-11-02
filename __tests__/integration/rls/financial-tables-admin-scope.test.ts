import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Financial-table admin isolation — real Postgres, real JWTs (migration
 * 20261275000000).
 *
 * A pre-launch direct-API probe showed the post-sale billing tables (invoices,
 * invoice_payments, payments) had org-member-wide SELECT/INSERT/UPDATE policies,
 * so a restricted `staff` JWT could read — and write — the WHOLE org's billing
 * records straight through PostgREST, bypassing the route/UI gates. The migration
 * scopes these three tables to `is_org_admin(org_id)` (owner/admin), matching the
 * capability model (staff hold no financial capability). Quotes/quote_line_items
 * are deliberately NOT covered (staff quote-drafting is a tested legit flow).
 *
 * This proves the boundary at the DATABASE for every role, read AND write.
 */

type Res = { data: unknown[] | null; error: { code?: string; message: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Row): { select(c?: string): { single(): PromiseLike<{ data: Row | null; error: { code?: string; message: string } | null }> } } & PromiseLike<{ error: { code?: string; message: string } | null }>;
      select(c?: string): { eq(k: string, v: unknown): PromiseLike<Res> } & PromiseLike<Res>;
      update(r: Row): { eq(k: string, v: unknown): PromiseLike<Res> };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res> };
    };
  };

const TOKEN = `it-fin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PW = `Pw-${TOKEN}`;
const nowIso = new Date().toISOString();

async function mkUser(email: string, role: string, orgId: string): Promise<{ id: string; token: string }> {
  const created = await serviceClient().auth.admin.createUser({ email, password: PW, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role });
  const token = (await anonClient().auth.signInWithPassword({ email, password: PW })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${email}`);
  return { id, token };
}

describeIntegration("financial tables · admin-only SELECT/INSERT/UPDATE", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "", invoiceId = "";
  let owner = { id: "", token: "" };
  let admin = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let revoked = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  const insId = async (table: string, row: Row): Promise<string> =>
    String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "Fin A", slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: "Fin B", slug: `${TOKEN}-b` });
    if (!orgA || !orgB) throw new Error("org seed failed");
    owner = await mkUser(`${TOKEN}-owner@example.test`, "owner", orgA);
    admin = await mkUser(`${TOKEN}-admin@example.test`, "admin", orgA);
    staff = await mkUser(`${TOKEN}-staff@example.test`, "staff", orgA);
    revoked = await mkUser(`${TOKEN}-revoked@example.test`, "staff", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);

    // Service-role seeds org A's billing records (bypasses RLS).
    invoiceId = await insId("invoices", { org_id: orgA, number: `INV-${TOKEN}`, amount: 1000, vat_total: 200, status: "draft" });
    if (!invoiceId) throw new Error("invoice seed failed");
    await svc.from("invoice_payments").insert({ org_id: orgA, invoice_id: invoiceId, amount: 500, paid_at: nowIso });
    await svc.from("payments").insert({ org_id: orgA, amount: 500, paid_at: nowIso });
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
    for (const u of [owner.id, admin.id, staff.id, revoked.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const rows = async (token: string, table: string): Promise<number> => {
    const r = await db(userClient(token)).from(table).select("id").eq("org_id", orgA);
    return (r.data ?? []).length;
  };

  // --- SELECT: owner/admin see, everyone else sees nothing -------------------
  for (const table of ["invoices", "invoice_payments", "payments"]) {
    it(`${table}: OWNER reads org A's rows`, async () => {
      expect(await rows(owner.token, table)).toBeGreaterThan(0);
    });
    it(`${table}: ADMIN reads org A's rows`, async () => {
      expect(await rows(admin.token, table)).toBeGreaterThan(0);
    });
    it(`${table}: STAFF reads NOTHING (the fix)`, async () => {
      expect(await rows(staff.token, table)).toBe(0);
    });
    it(`${table}: cross-org OUTSIDER reads NOTHING`, async () => {
      expect(await rows(outsider.token, table)).toBe(0);
    });
  }

  // --- WRITE: staff cannot insert/update; owner can ------------------------
  it("STAFF cannot INSERT an invoice (RLS denies)", async () => {
    const r = await db(userClient(staff.token)).from("invoices").insert({ org_id: orgA, number: `X-${TOKEN}`, amount: 1 });
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  });

  it("STAFF cannot UPDATE an invoice (no row passes the policy)", async () => {
    const before = ((await svc.from("invoices").select("status").eq("id", invoiceId)).data?.[0] as { status?: string } | undefined)?.status;
    const r = await db(userClient(staff.token)).from("invoices").update({ status: "sent" }).eq("id", invoiceId);
    // UPDATE under RLS matches 0 rows for staff → nothing changes (status is NOT
    // the "sent" the staff tried to set, and is unchanged from before).
    const after = ((await svc.from("invoices").select("status").eq("id", invoiceId)).data?.[0] as { status?: string } | undefined)?.status;
    expect(after, JSON.stringify(r.error)).toBe(before);
    expect(after).not.toBe("sent");
  });

  it("OWNER can INSERT an invoice (legit flow preserved)", async () => {
    const r = await db(userClient(owner.token)).from("invoices").insert({ org_id: orgA, number: `OK-${TOKEN}`, amount: 1 }).select("id").single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(String(r.data?.id ?? "")).not.toBe("");
  });

  // --- Revocation: a staff member removed from the org reads nothing --------
  it("a REVOKED member reads nothing after membership removal", async () => {
    // (revoked is already a staff member → already sees nothing; prove it stays
    // denied after the membership row is deleted, i.e. no residual access.)
    await svc.from("memberships").delete().eq("user_id", revoked.id);
    expect(await rows(revoked.token, "invoices")).toBe(0);
  });

  // --- Quotes are intentionally NOT restricted (staff drafting is legit) ----
  it("QUOTES remain member-readable (deliberate — staff draft/send quotes)", async () => {
    const custId = await insId("customers", { org_id: orgA, name: "Fin Cust" });
    const qid = await insId("quotes", { org_id: orgA, customer_id: custId, number: `Q-${TOKEN}`, status: "draft", subtotal: 0, vat_total: 0, total: 0 });
    expect(qid).not.toBe("");
    const r = await db(userClient(staff.token)).from("quotes").select("id").eq("org_id", orgA);
    expect((r.data ?? []).length, "staff can still read quotes by design").toBeGreaterThan(0);
  });
});
