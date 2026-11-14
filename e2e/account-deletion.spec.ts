import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { asActor, mintState } from "./_actors";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Account & data deletion — the user-facing flow, end to end in a real browser.
 *
 * TWO MODES, decided by how the app under test was started:
 *
 *   • DEFAULT (FEATURE_ACCOUNT_DELETION unset — CI, and production today): the
 *     capability is DARK. The first test pins that state: the page offers the
 *     support-assisted path and renders no deletion control.
 *
 *   • E2E_ACCOUNT_DELETION=1 (the app was started with
 *     FEATURE_ACCOUNT_DELETION=true): the three happy paths run — a staff member
 *     deletes their own account, an admin erases a staff member, and the owner
 *     schedules then cancels deletion of the company.
 *
 * Every person and company here is synthetic, created by this spec with a
 * per-run tag and removed afterwards. LOCAL only (guarded).
 */
const LIVE = process.env.E2E_ACCOUNT_DELETION === "1";
const TAG = `e2edel${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const STATE = (who: string) => `e2e/.auth/${TAG}-${who}.json`;

type Person = { id: string; email: string; password: string };
let svc: SupabaseClient;
let orgId = "";
const ORG_NAME = `Deletion E2E ${TAG} Ltd`;
const people: Record<"owner" | "admin" | "leaver" | "erased", Person> = {
  owner: { id: "", email: `owner.${TAG}@deletion-e2e.invalid`, password: `Pw-${TAG}-owner-9!x` },
  admin: { id: "", email: `admin.${TAG}@deletion-e2e.invalid`, password: `Pw-${TAG}-admin-9!x` },
  leaver: { id: "", email: `leaver.${TAG}@deletion-e2e.invalid`, password: `Pw-${TAG}-leaver-9!x` },
  erased: { id: "", email: `erased.${TAG}@deletion-e2e.invalid`, password: `Pw-${TAG}-erased-9!x` },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => svc as unknown as { from: (t: string) => any; rpc: (f: string, a?: unknown) => any };

test.beforeAll(async () => {
  assertLocalE2eTarget("account-deletion.spec.ts");
  svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const org = await db()
    .from("organizations")
    .insert({ name: ORG_NAME, slug: `deletion-e2e-${TAG}`, status: "active" })
    .select("id")
    .single();
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data.id;
  for (const [role, p] of Object.entries(people) as Array<[keyof typeof people, Person]>) {
    const created = await svc.auth.admin.createUser({ email: p.email, password: p.password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    p.id = created.data.user!.id;
    await db().from("users").insert({ id: p.id, email: p.email, full_name: `E2E ${role} ${TAG}` });
    const membership = await db().from("memberships").insert({
      org_id: orgId,
      user_id: p.id,
      role: role === "owner" ? "owner" : role === "admin" ? "admin" : "staff",
    });
    expect(membership.error, membership.error?.message).toBeNull();
  }
  // Personal rows for the two people who will be removed.
  for (const p of [people.leaver, people.erased]) {
    await db().from("notifications").insert({ org_id: orgId, user_id: p.id, type: "info", title: `For ${p.email}` });
    await db().from("staff_compensation").insert({ user_id: p.id, emergency_contact: { name: `Kin of ${TAG}` } });
  }
});

test.afterAll(async () => {
  if (!svc) return;
  // Cancel any pending company deletion, then remove the fixture.
  const live = await db()
    .from("privacy_deletion_requests")
    .select("id")
    .eq("kind", "org").eq("target_org_id", orgId)
    .eq("status", "scheduled");
  for (const r of live.data ?? []) {
    await db().rpc("privacy_request_cancel", { p_request_id: r.id, p_actor_user_id: people.owner.id });
  }
  await db().from("organizations").delete().eq("id", orgId);
  for (const p of Object.values(people)) {
    if (!p.id) continue;
    await db().from("staff_compensation").delete().eq("user_id", p.id);
    await svc.auth.admin.deleteUser(p.id);
  }
});

async function as<T>(browser: Browser, who: keyof typeof people, fn: (page: Page) => Promise<T>): Promise<T> {
  const p = people[who];
  await mintState(p.email, p.password, STATE(who));
  return asActor(browser, STATE(who), fn);
}

test("dark by default: the page offers the support-assisted path and no deletion control", async ({ browser }) => {
  test.skip(LIVE, "the app under test has the capability switched on");
  await as(browser, "owner", async (page) => {
    await page.goto("/settings/account");
    await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
    await expect(page.getByText("Deletion is a support-assisted process for this workspace.")).toBeVisible();
    await expect(page.getByRole("button", { name: /delete my account/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /schedule deletion/i })).toHaveCount(0);
  });
});

test.describe("with the capability on", () => {
  test.skip(!LIVE, "start the app with FEATURE_ACCOUNT_DELETION=true and set E2E_ACCOUNT_DELETION=1");
  test.describe.configure({ mode: "serial" });

  test("a staff member deletes their OWN account — and the company is still there", async ({ browser }) => {
    await as(browser, "leaver", async (page) => {
      await page.goto("/settings/account");
      await expect(page.getByRole("heading", { name: "Delete my account" })).toBeVisible();
      // Not an owner → the company section is not offered at all.
      await expect(page.getByRole("heading", { name: "Delete company" })).toHaveCount(0);

      const submit = page.getByRole("button", { name: "Delete my account" });
      await expect(submit).toBeDisabled();
      await page.getByLabel("Type your email address to confirm").fill(people.leaver.email);
      await page.getByLabel("Your password").fill(people.leaver.password);
      await expect(submit).toBeEnabled();
      await submit.click();
      await page.waitForURL(/\/login/);
    });

    const auth = await svc.auth.admin.getUserById(people.leaver.id);
    expect(auth.data.user, "the login is gone").toBeNull();
    const membership = await db().from("memberships").select("id").eq("user_id", people.leaver.id);
    expect(membership.data).toEqual([]);
    const comp = await db().from("staff_compensation").select("user_id").eq("user_id", people.leaver.id);
    expect(comp.data).toEqual([]);
    // The company and everyone else are untouched.
    const org = await db().from("organizations").select("id").eq("id", orgId);
    expect(org.data?.length).toBe(1);
    const rest = await db().from("memberships").select("id").eq("org_id", orgId);
    expect(rest.data?.length).toBe(3);
  });

  test("an admin removes a staff member and erases their personal data — their login survives", async ({ browser }) => {
    await as(browser, "admin", async (page) => {
      await page.goto(`/staff/${people.erased.id}`);
      await expect(page.getByRole("heading", { name: "Remove and erase personal data" })).toBeVisible();
      const submit = page.getByRole("button", { name: "Remove and erase personal data" });
      await expect(submit).toBeDisabled();
      await page.getByLabel(/email address to confirm/i).fill(people.erased.email);
      await page.getByLabel("Your password").fill(people.admin.password);
      await submit.click();
      await page.waitForURL(/\/staff\?saved=erased/);
    });

    const membership = await db().from("memberships").select("id").eq("org_id", orgId).eq("user_id", people.erased.id);
    expect(membership.data).toEqual([]);
    const notes = await db().from("notifications").select("id").eq("org_id", orgId).eq("user_id", people.erased.id);
    expect(notes.data).toEqual([]);
    const comp = await db().from("staff_compensation").select("user_id").eq("user_id", people.erased.id);
    expect(comp.data).toEqual([]);
    const auth = await svc.auth.admin.getUserById(people.erased.id);
    expect(auth.data.user?.email, "an employer cannot delete someone's login").toBe(people.erased.email);
  });

  test("the owner schedules deletion of the company, sees the cooling-off, and cancels it", async ({ browser }) => {
    await as(browser, "owner", async (page) => {
      await page.goto("/settings/account");
      await expect(page.getByRole("heading", { name: "Delete company" })).toBeVisible();
      // Sole owner: their own account cannot be deleted first.
      await expect(page.getByText(/You are the only owner of/)).toBeVisible();

      const submit = page.getByRole("button", { name: new RegExp(`Schedule deletion of`) });
      await expect(submit).toBeDisabled();
      await page.getByLabel(/I understand that in 7 days/).check();
      await page.getByLabel(/Type the company name to confirm/).fill(ORG_NAME);
      await page.getByLabel("Your password").fill(people.owner.password);
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByRole("heading", { name: `${ORG_NAME} is scheduled for deletion` })).toBeVisible();
      const pending = await db().from("privacy_deletion_requests").select("status, scheduled_for").eq("kind", "org").eq("target_org_id", orgId);
      expect(pending.data?.length).toBe(1);
      expect(pending.data?.[0].status).toBe("scheduled");
      const days = (new Date(pending.data?.[0].scheduled_for).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      // Nothing has been deleted.
      const org = await db().from("organizations").select("id").eq("id", orgId);
      expect(org.data?.length).toBe(1);

      await page.getByRole("button", { name: "Cancel the deletion" }).click();
      await expect(page.getByRole("heading", { name: /is scheduled for deletion/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Schedule deletion of/ })).toBeVisible();
    });
    const after = await db().from("privacy_deletion_requests").select("status, cancelled_reason").eq("kind", "org").eq("target_org_id", orgId);
    expect(after.data).toEqual([{ status: "cancelled", cancelled_reason: "requester_cancelled" }]);
  });
});
