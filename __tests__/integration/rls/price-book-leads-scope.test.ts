import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Price-book + leads isolation — real Postgres, real JWTs (migration
 * 20261277000000). Direct staff-JWT probe showed both member-wide. price_book is
 * owner/admin-only (rate library); leads are owner/admin + the assignee only.
 */

type Res = { data: unknown[] | null; error: { code?: string; message: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Row): { select(c?: string): { single(): PromiseLike<{ data: Row | null; error: { code?: string; message: string } | null }> } };
      select(c?: string): { eq(k: string, v: unknown): PromiseLike<Res> };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res> };
    };
  };

const TOKEN = `it-pbl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describeIntegration("price_book + leads · isolation", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "", pbItem = "", leadAssigned = "", leadOther = "";
  let owner = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  const insId = async (table: string, row: Row): Promise<string> =>
    String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "PBL A", slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: "PBL B", slug: `${TOKEN}-b` });
    owner = await mkUser(`${TOKEN}-owner@example.test`, "owner", orgA);
    staff = await mkUser(`${TOKEN}-staff@example.test`, "staff", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);
    pbItem = await insId("price_book_items", { org_id: orgA, description: "Day rate" });
    leadAssigned = await insId("leads", { org_id: orgA, source: "phone", assigned_to: staff.id });
    leadOther = await insId("leads", { org_id: orgA, source: "web" });
    if (!pbItem || !leadAssigned || !leadOther) throw new Error("fixture failed");
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
    for (const u of [owner.id, staff.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const ids = async (token: string, table: string): Promise<string[]> => {
    const r = await db(userClient(token)).from(table).select("id").eq("org_id", orgA);
    return (r.data ?? []).map((x) => String((x as Row).id));
  };

  it("price_book: OWNER reads it, STAFF + cross-org read NOTHING", async () => {
    expect(await ids(owner.token, "price_book_items")).toContain(pbItem);
    expect(await ids(staff.token, "price_book_items")).toHaveLength(0);
    expect(await ids(outsider.token, "price_book_items")).toHaveLength(0);
  });

  it("leads: OWNER sees all", async () => {
    const seen = await ids(owner.token, "leads");
    expect(seen).toContain(leadAssigned);
    expect(seen).toContain(leadOther);
  });

  it("leads: STAFF sees ONLY leads assigned to them", async () => {
    const seen = await ids(staff.token, "leads");
    expect(seen, "assigned lead visible").toContain(leadAssigned);
    expect(seen, "unassigned lead hidden").not.toContain(leadOther);
  });

  it("leads: cross-org OUTSIDER sees nothing", async () => {
    expect(await ids(outsider.token, "leads")).toHaveLength(0);
  });
});
