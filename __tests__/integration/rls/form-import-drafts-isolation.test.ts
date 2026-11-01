/* eslint-disable @typescript-eslint/no-explicit-any -- form_import_drafts post-
   dates the generated Database types until the migration is applied + types
   regenerated, so test queries go through a loose client shape. */
import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * FEATURE 2 — form_import_drafts RLS isolation, against real Postgres
 * (migration 20261264000000).
 *
 * A draft is ORG-scoped AND SELF-scoped: only its creator, within their org,
 * may read / edit / discard it. This proves the two locks hold for the most
 * ordinary client (an authenticated member), which a unit test cannot:
 *   - a DIFFERENT member of the SAME org cannot read another member's draft;
 *   - a member of ANOTHER org cannot read it, and cannot insert a draft stamped
 *     with the first org's id (the WITH CHECK half);
 *   - the creator can.
 */

type Loose = { from: (t: string) => any };
const svc = () => serviceClient() as unknown as Loose;

describeIntegration("form_import_drafts · org + self isolation (20261262)", () => {
  const T = `fid_${Date.now().toString(36)}`;
  let orgA = "";
  let orgB = "";
  let userA = "";
  let userA2 = "";
  let tokenA = "";
  let tokenA2 = "";
  let tokenB = "";
  let draftId = "";

  async function makeUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${label}@x.test`;
    const pw = `Pw-${T}-${label}`;
    const created = await serviceClient().auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: label }).select("id").single();
    if (mirrored.error) throw new Error(mirrored.error.message);
    const s = await anonClient().auth.signInWithPassword({ email, password: pw });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const oA = await svc().from("organizations").insert({ name: `A ${T}`, slug: `${T}-a` }).select("id").single();
    const oB = await svc().from("organizations").insert({ name: `B ${T}`, slug: `${T}-b` }).select("id").single();
    if (oA.error || oB.error) throw new Error(oA.error?.message ?? oB.error?.message);
    orgA = String(oA.data.id);
    orgB = String(oB.data.id);

    const a = await makeUser("a");
    const a2 = await makeUser("a2");
    const b = await makeUser("b");
    userA = a.id;
    userA2 = a2.id;
    tokenA = a.token;
    tokenA2 = a2.token;
    tokenB = b.token;

    for (const [uid, org] of [
      [userA, orgA],
      [userA2, orgA],
      [b.id, orgB],
    ] as const) {
      const mem = await svc().from("memberships").insert({ user_id: uid, org_id: org, role: "staff" }).select("id").single();
      if (mem.error) throw new Error(mem.error.message);
    }
  });

  it("the creator can insert and read their own draft", async () => {
    const client = userClient(tokenA) as unknown as Loose;
    const ins = await client
      .from("form_import_drafts")
      .insert({ org_id: orgA, form_type: "customer", extracted: { name: "Acme" }, created_by: userA })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    draftId = String(ins.data.id);

    const read = await client.from("form_import_drafts").select("id, extracted").eq("id", draftId).maybeSingle();
    expect(read.error).toBeNull();
    expect(read.data?.extracted?.name).toBe("Acme");
  });

  it("a DIFFERENT member of the SAME org cannot read it", async () => {
    const client = userClient(tokenA2) as unknown as Loose;
    const read = await client.from("form_import_drafts").select("id").eq("id", draftId).maybeSingle();
    expect(read.error).toBeNull(); // RLS filters rows; it does not error
    expect(read.data).toBeNull();
    void userA2;
  });

  it("a member of ANOTHER org cannot read it", async () => {
    const client = userClient(tokenB) as unknown as Loose;
    const read = await client.from("form_import_drafts").select("id").eq("id", draftId).maybeSingle();
    expect(read.error).toBeNull();
    expect(read.data).toBeNull();
  });

  it("a member of another org cannot insert a draft stamped with org A (WITH CHECK)", async () => {
    const client = userClient(tokenB) as unknown as Loose;
    const ins = await client
      .from("form_import_drafts")
      .insert({ org_id: orgA, form_type: "customer", extracted: {}, created_by: userA })
      .select("id")
      .single();
    // RLS WITH CHECK rejects the write (org not theirs, created_by not them).
    expect(ins.error).not.toBeNull();
  });

  it("a member cannot forge a draft as another user even in their own org", async () => {
    const client = userClient(tokenA2) as unknown as Loose;
    const ins = await client
      .from("form_import_drafts")
      .insert({ org_id: orgA, form_type: "customer", extracted: {}, created_by: userA })
      .select("id")
      .single();
    // created_by must equal auth.uid() — stamping it as userA is refused.
    expect(ins.error).not.toBeNull();
  });

  it("the form_type CHECK refuses an unknown type", async () => {
    const client = userClient(tokenA) as unknown as Loose;
    const ins = await client
      .from("form_import_drafts")
      .insert({ org_id: orgA, form_type: "not_a_form", extracted: {}, created_by: userA })
      .select("id")
      .single();
    expect(ins.error).not.toBeNull();
  });
});
