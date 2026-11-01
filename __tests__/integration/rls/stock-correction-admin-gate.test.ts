import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * record_stock_correction is ADMIN-ONLY (20261266000000), against real Postgres.
 *
 * A correction REVERSES a posted movement and feeds job profitability, so it
 * carries the same owner/admin gate as record_stock_adjustment. The enforcing
 * control is the RPC itself (callable directly via PostgREST), not the action
 * layer — so these proofs call the RPC with a MEMBER's and an ADMIN's own JWT.
 *
 * Proven here:
 *   1. PERMISSION — a MEMBER's correction is refused with 42501
 *      (insufficient_privilege); an ADMIN's succeeds. The gate is the RPC.
 *   2. REGRESSION — the SAME member can still issue AND transfer stock
 *      (the routine operational acts stay member-level; the PR must not break
 *      normal staff functionality).
 *   3. TENANT ISOLATION — a principal who is NOT a member of the org (here an
 *      admin of a DIFFERENT org) cannot correct the org's movement: is_org_admin
 *      is false for them, so the gate refuses before anything is read.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  single(): PromiseLike<Res<Row>>;
}
interface Ins {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-scag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("record_stock_correction · admin-only gate (20261266000000)", () => {
  let orgA = "";
  let orgB = "";
  let adminToken = "";
  let memberToken = "";
  let outsiderToken = ""; // an ADMIN of org B — a non-member of org A
  let itemA = "";
  let siteFrom = "";
  let siteTo = "";
  let issueToCorrect = ""; // a member-issued movement, used as the correction target

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: `SCAG ${suffix}` }).select("id").single();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  async function addMember(orgId: string, userId: string, role: "owner" | "admin" | "staff"): Promise<void> {
    const m = await svc().from("memberships").insert({ org_id: orgId, user_id: userId, role }).select("user_id").single();
    expect(m.error, m.error?.message).toBeNull();
  }

  async function makeItem(orgId: string, name: string): Promise<string> {
    const r = await svc().from("stock_items").insert({ org_id: orgId, name, unit: "ea" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeSite(orgId: string, name: string): Promise<string> {
    const r = await svc().from("sites").insert({ org_id: orgId, name, kind: "depot" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg(`${TOKEN} A`, `${TOKEN}-a`);
    orgB = await makeOrg(`${TOKEN} B`, `${TOKEN}-b`);

    const admin = await makeUser("admin");
    const member = await makeUser("member");
    const outsider = await makeUser("outsider");
    adminToken = admin.token;
    memberToken = member.token;
    outsiderToken = outsider.token;

    await addMember(orgA, admin.id, "admin");
    await addMember(orgA, member.id, "staff"); // a non-admin member (role 'staff')
    await addMember(orgB, outsider.id, "admin"); // admin of B only — not a member of A

    itemA = await makeItem(orgA, `${TOKEN} item`);
    siteFrom = await makeSite(orgA, `${TOKEN} from`);
    siteTo = await makeSite(orgA, `${TOKEN} to`);

    // Seed a positive balance at siteFrom via a service-role adjustment (bypasses
    // the admin gate legitimately — service_role is the trusted, non-tenant path).
    const seed = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: siteFrom,
      p_delta: 100,
      p_reason: "seed for correction-gate test",
    });
    expect(seed.error, seed.error?.message).toBeNull();
  });

  afterAll(async () => {
    // Org teardown cascades the fixtures; service-role only.
    for (const org of [orgA, orgB]) {
      if (org) await (svc().from("organizations") as unknown as { delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> } }).delete().eq("id", org);
    }
  });

  it("REGRESSION: a MEMBER can still ISSUE stock (routine op stays member-level)", async () => {
    const issue = await rpc(userClient(memberToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: siteFrom,
      p_qty: 10,
      p_notes: "member issue — regression",
    });
    expect(issue.error, issue.error?.message).toBeNull();
    expect(typeof issue.data).toBe("string");
    issueToCorrect = String(issue.data);
  });

  it("REGRESSION: a MEMBER can still TRANSFER stock between sites", async () => {
    const transfer = await rpc(userClient(memberToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: siteFrom,
      p_to_site_id: siteTo,
      p_qty: 5,
      p_notes: "member transfer — regression",
    });
    expect(transfer.error, transfer.error?.message).toBeNull();
    expect(typeof transfer.data).toBe("string");
  });

  it("PERMISSION: a MEMBER is REFUSED when correcting a movement (42501)", async () => {
    expect(issueToCorrect).not.toBe("");
    const corr = await rpc(userClient(memberToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issueToCorrect,
      p_reason: "member tries to reverse — must be refused",
    });
    expect(corr.error, "a member must NOT be able to correct a movement").not.toBeNull();
    expect(corr.error?.code).toBe("42501");
  });

  it("PERMISSION: an ADMIN CAN correct the same movement (capability preserved)", async () => {
    expect(issueToCorrect).not.toBe("");
    const corr = await rpc(userClient(adminToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issueToCorrect,
      p_reason: "admin reverses the mistaken issue",
    });
    expect(corr.error, corr.error?.message).toBeNull();
    expect(typeof corr.data).toBe("string");
  });

  it("TENANT ISOLATION: an admin of ANOTHER org cannot correct this org's movement", async () => {
    // Seed a fresh issue to target (the one above is already corrected).
    const issue = await rpc(userClient(memberToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: siteFrom,
      p_qty: 3,
      p_notes: "target for cross-org attempt",
    });
    expect(issue.error, issue.error?.message).toBeNull();
    const targetId = String(issue.data);

    const corr = await rpc(userClient(outsiderToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: targetId,
      p_reason: "cross-org attempt — must be refused",
    });
    expect(corr.error, "an outsider admin must NOT correct org A's movement").not.toBeNull();
    // is_org_admin(orgA) is false for a non-member, so the admin gate refuses
    // first — a bare 42501, before the movement is ever read.
    expect(corr.error?.code).toBe("42501");
  });
});
