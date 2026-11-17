import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { createOrgWithOwner, ensureUserRow, ownedOrgIds } from "@/server/services/bootstrap-account";

/**
 * Self-signup creates ONE company per person — real Postgres, the real bootstrap service.
 *
 * The onboarding form had no guard: a double click, the back button, a second tab or a retry
 * after a slow response each created another company with the same owner (and another sample
 * data set and another "new signup" notice to HQ). Proves:
 *   • a repeat submit returns the existing company and creates nothing;
 *   • two submits in flight at once still end with exactly one company and one membership;
 *   • HQ provisioning (no `singleCompany`) can still give an existing user a second company.
 */
const T = `single-${Date.now().toString(36)}`;
const svc = () => serviceClient();
let userId = "";
const created = new Set<string>();

const owned = async () => (await ownedOrgIds(userId));
const input = (n: number) => ({ userId, userEmail: `${T}@example.test`, name: `Single Co ${T}`, slug: `${T}-${n}-${Math.random().toString(36).slice(2, 7)}`, postcode: "BT1 1AA" });

describeIntegration("onboarding · one company per self-signup", () => {
  beforeAll(async () => {
    const u = await svc().auth.admin.createUser({ email: `${T}@example.test`, password: `Pw-${crypto.randomUUID()}`, email_confirm: true });
    if (u.error || !u.data.user) throw new Error(`user: ${u.error?.message}`);
    userId = u.data.user.id;
    await ensureUserRow({ id: userId, email: `${T}@example.test` });
  }, 120_000);

  afterAll(async () => {
    for (const id of new Set([...created, ...(userId ? await owned().catch(() => []) : [])])) {
      await svc().from("organizations").delete().eq("id", id);
    }
    if (userId) await svc().auth.admin.deleteUser(userId);
  }, 120_000);

  it("two submits in flight at once end with exactly one company and one owner membership", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => createOrgWithOwner({ ...input(n), singleCompany: true })));
    results.forEach((r) => created.add(r.orgId));
    const mine = await owned();
    expect(mine, "exactly one company survives").toHaveLength(1);
    expect(new Set(results.map((r) => r.orgId)), "every submit is sent to the same company").toEqual(new Set(mine));
    const orgs = await svc().from("organizations").select("id").like("slug", `${T}-%`);
    expect(orgs.error).toBeNull();
    expect((orgs.data ?? []).map((o) => o.id), "no orphan company left behind").toEqual(mine);
  }, 120_000);

  it("a repeat submit returns the existing company and creates nothing", async () => {
    const [first] = await owned();
    const again = await createOrgWithOwner({ ...input(9), singleCompany: true });
    expect(again).toEqual({ orgId: first, existing: true });
    expect(await owned()).toEqual([first]);
  }, 120_000);

  it("HQ provisioning is not restricted: without the flag an existing owner can be given a second company", async () => {
    const second = await createOrgWithOwner(input(20));
    created.add(second.orgId);
    expect(second.existing).toBeUndefined();
    expect(await owned()).toHaveLength(2);
  }, 120_000);
});
