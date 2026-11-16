/* eslint-disable @typescript-eslint/no-explicit-any -- seed/assert helpers: the generated
   Database types don't cover every table the spec touches, so DB access goes through a loose cast. */
import { randomBytes } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { mintState, asActor } from "./_actors";
import { waitForHydrated } from "./_hydration";

/**
 * Owner / admin management of the tenant-boundary tables — end to end, real sessions.
 *
 * `organizations`, `memberships` and `users` accept no client write (SELECT-only RLS,
 * no write grant). Company settings, own profile, the set-up checklist, the company
 * logo and staff invite / role / profile / remove authorise on the server from the
 * session and then write with the service role. The integration tier proves every
 * action against real Postgres (__tests__/integration/boundary-writes); this spec
 * proves the flows the way people perform them, in a production build, and that
 * each change is in the DATABASE and still shown after a page RELOAD.
 *
 * Rules pinned here:
 *   - owners always control company settings;
 *   - admins need `settings:manage` / `staff:manage`;
 *   - only owners modify owner/admin staff records (and only owners appoint admins);
 *   - cross-company access is always denied.
 *
 * Self-contained: it seeds its OWN two organisations and actors (unique suffix) so it
 * neither depends on nor disturbs the shared harness org, and it deletes them after.
 */

const sfx = `om${Date.now().toString(36)}`;
// Throwaway local-stack password, generated per run (never a literal).
const PASSWORD = `E2e-${randomBytes(12).toString("hex")}`;
const STATE = (k: string) => `e2e/.auth/${sfx}-${k}.json`;
const email = (k: string) => `${sfx}-${k}@crewflow.test`;

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

type Key =
  | "owner" | "adminNone" | "adminCap" | "staff" | "roleTarget" | "profileTarget" | "removeTarget"
  | "adminTarget" | "joiner" | "joiner2" | "ownerB" | "staffB";
const KEYS: Key[] = [
  "owner", "adminNone", "adminCap", "staff", "roleTarget", "profileTarget", "removeTarget",
  "adminTarget", "joiner", "joiner2", "ownerB", "staffB",
];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let db: any;
const ids = {} as Record<Key, string>;
let orgA = "";
let orgB = "";
let orgC = "";

async function mkUser(key: Key, fullName: string): Promise<string> {
  const created = await db.auth.admin.createUser({ email: email(key), password: PASSWORD, email_confirm: true });
  const id = created.data.user?.id as string | undefined;
  if (!id) throw new Error(`[owner-management] cannot create ${key}: ${created.error?.message}`);
  const up = await db.from("users").upsert({ id, email: email(key), full_name: fullName });
  if (up.error) throw new Error(`[owner-management] users upsert ${key}: ${up.error.message}`);
  return id;
}
async function member(org: string, key: Key, role: string): Promise<string> {
  const r = await db.from("memberships").insert({ org_id: org, user_id: ids[key], role }).select("id").single();
  if (r.error) throw new Error(`[owner-management] membership ${key}: ${r.error.message}`);
  return r.data.id as string;
}
const orgRow = async (id: string) =>
  (await db.from("organizations").select("*").eq("id", id).single()).data;
const userRow = async (key: Key) =>
  (await db.from("users").select("*").eq("id", ids[key]).single()).data;
const memRole = async (org: string, key: Key) =>
  (await db.from("memberships").select("role").eq("org_id", org).eq("user_id", ids[key]).maybeSingle()).data?.role ?? null;

const settingsOrgForm = (page: Page) =>
  page.locator("form", { has: page.getByRole("button", { name: "Save organisation" }) });
const profileForm = (page: Page) =>
  page.locator("form", { has: page.getByRole("button", { name: "Save profile" }) });

/** Submit a useActionState form and wait for the server action's own POST to answer. */
/**
 * Click a control only once React has hydrated it. These are streamed pages: before hydration a
 * click on "+ Add staff" is lost (the dialog never opens) and a form submit falls back to a native
 * POST that re-renders in place (no confirmation banner). Both showed up as intermittent failures
 * of this spec; see ./_hydration.ts for the mechanism.
 */
async function clickHydrated(target: Locator): Promise<void> {
  await waitForHydrated(target);
  await target.click();
}

async function submitAction(page: Page, pathPrefix: string, click: () => Promise<void>) {
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith(pathPrefix),
  );
  await click();
  expect((await done).status()).toBeLessThan(400);
}

test.describe.configure({ mode: "serial" });

test.describe("owner & admin management persists, and lesser roles are refused", () => {
  test.beforeAll(async () => {
    assertLocalE2eTarget("owner-management spec (e2e/owner-management.spec.ts)");
    if (!url || !svcKey) throw new Error("[owner-management] missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    db = createClient(url, svcKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const names: Record<Key, string> = {
      owner: "OM Owner", adminNone: "OM Admin None", adminCap: "OM Admin Cap", staff: "OM Staff Viewer",
      roleTarget: "OM Role Target", profileTarget: "OM Profile Target", removeTarget: "OM Remove Target",
      adminTarget: "OM Admin Target", joiner: "OM Joiner", joiner2: "OM Joiner Two",
      ownerB: "OM Other Owner", staffB: "OM Other Staff",
    };
    for (const k of KEYS) ids[k] = await mkUser(k, names[k]);

    const a = await db.from("organizations").insert({ name: `OM Co ${sfx}`, slug: `${sfx}-a`, status: "active" }).select("id").single();
    const b = await db.from("organizations").insert({ name: `OM Other Co ${sfx}`, slug: `${sfx}-b`, status: "active" }).select("id").single();
    if (a.error || b.error) throw new Error(`[owner-management] org seed: ${a.error?.message ?? b.error?.message}`);
    orgA = a.data.id;
    orgB = b.data.id;

    await member(orgA, "owner", "owner");
    await member(orgA, "adminNone", "admin");
    const capMem = await member(orgA, "adminCap", "admin");
    await member(orgA, "staff", "staff");
    await member(orgA, "roleTarget", "staff");
    await member(orgA, "profileTarget", "staff");
    await member(orgA, "removeTarget", "staff");
    await member(orgA, "adminTarget", "admin");
    // A THIRD org shared by the owner (as plain staff) and the joiner: the only way the
    // owner's RLS-scoped user lookup can SEE a non-member (users are readable only by
    // self and co-members), which is what routes inviteStaff to its direct-add branch.
    const c = await db.from("organizations").insert({ name: `OM Shared Co ${sfx}`, slug: `${sfx}-c`, status: "active" }).select("id").single();
    if (c.error) throw new Error(`[owner-management] org C seed: ${c.error.message}`);
    orgC = c.data.id;
    await member(orgC, "owner", "staff");
    await member(orgC, "joiner", "staff");
    await member(orgB, "ownerB", "owner");
    await member(orgB, "staffB", "staff");
    // adminCap holds BOTH management capabilities; adminNone holds none (default-deny).
    for (const [module, action] of [["settings", "manage"], ["staff", "manage"]]) {
      const g = await db.from("membership_permissions").insert({ org_id: orgA, membership_id: capMem, module, action });
      if (g.error) throw new Error(`[owner-management] grant ${module}:${action}: ${g.error.message}`);
    }

    for (const k of ["owner", "adminNone", "adminCap", "staff", "ownerB"] as Key[]) {
      await mintState(email(k), PASSWORD, STATE(k));
    }
  });

  test.afterAll(async () => {
    if (!db) return;
    // Best-effort local cleanup of everything this spec created.
    for (const org of [orgA, orgB, orgC].filter(Boolean)) {
      const files = await db.storage.from("company-logos").list(org);
      if (files.data?.length) await db.storage.from("company-logos").remove(files.data.map((f: any) => `${org}/${f.name}`));
      await db.from("membership_permissions").delete().eq("org_id", org);
      await db.from("memberships").delete().eq("org_id", org);
      await db.from("organizations").delete().eq("id", org);
    }
    for (const k of KEYS) {
      if (!ids[k]) continue;
      await db.from("users").delete().eq("id", ids[k]);
      await db.auth.admin.deleteUser(ids[k]);
    }
  });

  // ---------------------------------------------------------------- a) company settings
  test("a) owner saves company settings; DB row and value after reload", async ({ browser }) => {
    const phone = `028 90${String(Date.now()).slice(-6)}`;
    const vat = "GB123456789";
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto("/settings");
      const form = settingsOrgForm(page);
      await expect(form).toBeVisible();
      await form.locator('input[name="name"]').fill(`OM Co ${sfx} Renamed`);
      await form.locator('input[name="phone"]').fill(phone);
      await form.locator('input[name="vat_number"]').fill(vat);
      await form.locator('input[name="address_city"]').fill("Belfast");
      await submitAction(page, "/settings", () => clickHydrated(form.getByRole("button", { name: "Save organisation" })));
      await expect(page.getByText(/Couldn't save organisation|don't have permission|Only admins\/owners/)).toHaveCount(0);
      // The confirmation banner (the screen's only success feedback).
      await expect(page.getByText("Organisation saved.")).toBeVisible();

      const row = await orgRow(orgA);
      expect(row.name).toBe(`OM Co ${sfx} Renamed`);
      expect(row.phone).toBe(phone);
      expect(row.vat_number).toBe(vat);
      expect(row.address?.city).toBe("Belfast");

      await page.reload();
      const again = settingsOrgForm(page);
      await expect(again.locator('input[name="name"]')).toHaveValue(`OM Co ${sfx} Renamed`);
      await expect(again.locator('input[name="phone"]')).toHaveValue(phone);
      await expect(again.locator('input[name="vat_number"]')).toHaveValue(vat);
    });
  });

  // ---------------------------------------------------------------- b) own profile
  test("b) user edits their own profile; DB row and value after reload", async ({ browser }) => {
    // The owner, and a plain staff member (own details are everyone's to edit).
    for (const [who, name, phone] of [
      ["owner", "OM Owner Edited", "07700 900111"],
      ["staff", "OM Staff Edited", "07700 900222"],
    ] as const) {
      await asActor(browser, STATE(who), async (page) => {
        await page.goto("/settings");
        const form = profileForm(page);
        await form.locator('input[name="full_name"]').fill(name);
        await form.locator('input[name="phone"]').fill(phone);
        await submitAction(page, "/settings", () => clickHydrated(form.getByRole("button", { name: "Save profile" })));
        await expect(page.getByText("Profile saved.")).toBeVisible();
        const row = await userRow(who);
        expect(row.full_name).toBe(name);
        expect(row.phone).toBe(phone);
        await page.reload();
        await expect(profileForm(page).locator('input[name="full_name"]')).toHaveValue(name);
        await expect(profileForm(page).locator('input[name="phone"]')).toHaveValue(phone);
      });
    }
  });

  // ---------------------------------------------------------------- c) logo
  test("c) owner uploads then clears the logo; organizations.logo_path + Storage object", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto("/settings");
      await expect(page.getByText("No logo yet")).toBeVisible();
      await page.locator('input[type="file"][name="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
      await submitAction(page, "/settings", () => clickHydrated(page.getByRole("button", { name: "Upload", exact: true })));
      await expect(page.getByRole("img", { name: "Company logo" })).toBeVisible();

      const row = await orgRow(orgA);
      expect(row.logo_path).toMatch(new RegExp(`^${orgA}/logo-`));
      const obj = await db.storage.from("company-logos").download(row.logo_path);
      expect(obj.error).toBeNull();
      expect(obj.data?.size).toBe(PNG.length);

      await page.reload();
      await expect(page.getByRole("img", { name: "Company logo" })).toBeVisible();

      page.once("dialog", (d) => void d.accept());
      await submitAction(page, "/settings", () => clickHydrated(page.getByRole("button", { name: "Remove", exact: true })));
      await expect(page.getByText("No logo yet")).toBeVisible();
      expect((await orgRow(orgA)).logo_path).toBeNull();
      const gone = await db.storage.from("company-logos").download(row.logo_path);
      expect(gone.error).not.toBeNull();

      await page.reload();
      await expect(page.getByText("No logo yet")).toBeVisible();
    });
  });

  // ---------------------------------------------------------------- d) checklist
  test("d) owner skips then restores a set-up checklist step; organizations.onboarding_state", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto("/onboarding/setup");
      const skip = page.getByRole("button", { name: "Skip for now" }).first();
      await expect(skip).toBeVisible();
      await clickHydrated(skip);
      await expect(page).toHaveURL(/saved=skipped/);
      const skipped = (await orgRow(orgA)).onboarding_state?.dismissed_steps as string[] | undefined;
      expect(skipped?.length).toBe(1);

      await page.goto("/onboarding/setup");
      await expect(page.getByRole("button", { name: "Bring back" })).toHaveCount(1);

      await clickHydrated(page.getByRole("button", { name: "Bring back" }));
      await expect(page).toHaveURL(/saved=unskipped/);
      expect(((await orgRow(orgA)).onboarding_state?.dismissed_steps as string[]) ?? []).toHaveLength(0);
      await page.goto("/onboarding/setup");
      await expect(page.getByRole("button", { name: "Bring back" })).toHaveCount(0);
    });
  });

  // ---------------------------------------------------------------- e) add staff
  test("e) owner adds staff: direct-add writes the membership; a stranger's address goes down the invite path (no email, no membership)", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto("/staff");
      // e1: joiner is visible to the owner via the shared org -> DIRECT ADD.
      await clickHydrated(page.getByRole("button", { name: "+ Add staff" }).first());
      let dialog = page.getByRole("dialog");
      // The dialog moves focus to its first field just after it opens. Typing before that lands
      // the text in "Full name" — wait for the focus hand-over, then fill.
      await expect(page.getByRole("dialog").locator('input[name="full_name"]')).toBeFocused();
      await dialog.locator('input[name="full_name"]').fill("OM Joiner");
      await dialog.locator('input[name="email"]').fill(email("joiner"));
      await dialog.locator('select[name="role"]').selectOption("staff");
      await clickHydrated(dialog.getByRole("button", { name: "Send invite" }));
      await expect(dialog.getByText(/added to /)).toBeVisible();
      await expect(dialog.getByText(/Invite emailed/)).toHaveCount(0);
      expect(await memRole(orgA, "joiner")).toBe("staff");
      await page.reload();
      await expect(page.getByText("OM Joiner", { exact: true }).first()).toBeVisible();

      // e2: joiner2 is invisible to the owner (no shared org) -> INVITE path. The local env
      // has no mail provider key, so the action reports it could not send and NOTHING
      // is emailed; crucially no membership is created for a stranger.
      await clickHydrated(page.getByRole("button", { name: "+ Add staff" }).first());
      dialog = page.getByRole("dialog");
      // The dialog moves focus to its first field just after it opens. Typing before that lands
      // the text in "Full name" — wait for the focus hand-over, then fill.
      await expect(page.getByRole("dialog").locator('input[name="full_name"]')).toBeFocused();
      await dialog.locator('input[name="email"]').fill(email("joiner2"));
      await dialog.locator('select[name="role"]').selectOption("staff");
      await clickHydrated(dialog.getByRole("button", { name: "Send invite" }));
      await expect(dialog.getByText("Couldn't send the invite email. Check the address and try again.")).toBeVisible();
      expect(await memRole(orgA, "joiner2")).toBeNull();
    });
  });

  // ---------------------------------------------------------------- f) role
  test("f) owner changes a role staff -> admin -> staff; membership row and value after reload", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      const profile = `/staff/${ids.roleTarget}`;
      for (const [to, expectDb] of [["admin", "admin"], ["staff", "staff"]] as const) {
        await page.goto(profile);
        const form = page.locator("form", { has: page.getByRole("button", { name: "Update", exact: true }) });
        await form.locator('select[name="role"]').selectOption(to);
        await submitAction(page, "/staff/", () => clickHydrated(form.getByRole("button", { name: "Update", exact: true })));
        await expect(page).toHaveURL(/saved=role/);
        expect(await memRole(orgA, "roleTarget")).toBe(expectDb);
        await page.goto(profile);
        await expect(page.locator('select[name="role"]').first()).toHaveValue(to);
      }
    });
  });

  // ---------------------------------------------------------------- g) staff profile
  test("g) owner edits a staff profile; users row and value after reload", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      const profile = `/staff/${ids.profileTarget}`;
      await page.goto(profile);
      const form = profileForm(page);
      await form.locator('input[name="full_name"]').fill("OM Profile Edited");
      await form.locator('input[name="phone"]').fill("07700 900333");
      await submitAction(page, "/staff/", () => clickHydrated(form.getByRole("button", { name: "Save profile" })));
      await expect(page.getByText(/Couldn't save|don't have permission|Only the owner/)).toHaveCount(0);
      // "Some POST under /staff/ resolved" does not prove THIS save landed; wait for the row.
      await expect.poll(async () => (await userRow("profileTarget")).full_name, { timeout: 15_000 }).toBe("OM Profile Edited");
      const row = await userRow("profileTarget");
      expect(row.phone).toBe("07700 900333");
      await page.goto(profile);
      await expect(profileForm(page).locator('input[name="full_name"]')).toHaveValue("OM Profile Edited");
      await expect(profileForm(page).locator('input[name="phone"]')).toHaveValue("07700 900333");
    });
  });

  // ---------------------------------------------------------------- h) remove
  test("h) owner removes a staff member; membership row gone, absent from list after reload, user record kept", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto(`/staff/${ids.removeTarget}`);
      page.once("dialog", (d) => void d.accept());
      await clickHydrated(page.getByRole("button", { name: "Remove", exact: true }));
      await expect(page).toHaveURL(/saved=removed/);
      expect(await memRole(orgA, "removeTarget")).toBeNull();
      expect((await userRow("removeTarget")).id).toBe(ids.removeTarget); // identity persists
      await page.goto("/staff");
      await expect(page.getByText("OM Remove Target")).toHaveCount(0);
    });
  });

  // ---------------------------------------------------------------- i) rejections
  test("i1) staff: no settings control, no staff admin; checklist skip is refused; nothing changes", async ({ browser }) => {
    const before = await orgRow(orgA);
    await asActor(browser, STATE("staff"), async (page) => {
      await page.goto("/settings");
      await expect(page.getByRole("button", { name: "Save organisation" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);

      await page.goto("/onboarding/setup");
      // The page lists the checklist read-only for staff but still renders its
      // buttons; the invariant is that the ACTION refuses them (management gate),
      // so press one and prove nothing is written (asserted on the row below).
      const skip = page.getByRole("button", { name: "Skip for now" }).first();
      if (await skip.count()) {
        await clickHydrated(skip);
        // The refused action bounces staff /dashboard?error=forbidden -> /me in TWO navigations.
        // Wait for the FINAL one to land; "networkidle" alone can fire between the two, and the
        // next goto is then interrupted by the pending navigation to /me.
        await page.waitForURL(/\/me(\?|$)/, { timeout: 15_000 });
        await page.waitForLoadState("networkidle");
      }

      await page.goto("/staff");
      // Staff are bounced off the roster to /me through the same two-step chain; let it FINISH
      // before the next navigation, or that goto is aborted by the in-flight redirect.
      await page.waitForURL(/\/me(\?|$)/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("button", { name: "+ Add staff" })).toHaveCount(0);

      await page.goto(`/staff/${ids.profileTarget}`);
      await page.waitForLoadState("networkidle");
      for (const name of ["Save profile", "Update", "Remove"]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
    });
    const after = await orgRow(orgA);
    expect(after.name).toBe(before.name);
    expect(after.onboarding_state).toEqual(before.onboarding_state);
    expect(await memRole(orgA, "profileTarget")).toBe("staff");
  });

  test("i2) admin without settings:manage / staff:manage cannot save settings or edit/add staff", async ({ browser }) => {
    const before = await orgRow(orgA);
    await asActor(browser, STATE("adminNone"), async (page) => {
      await page.goto("/settings");
      const form = settingsOrgForm(page);
      await form.locator('input[name="phone"]').fill("000 NOT SAVED");
      await submitAction(page, "/settings", () => clickHydrated(form.getByRole("button", { name: "Save organisation" })));
      await expect(page.getByText("Only admins/owners can edit organisation details.")).toBeVisible();
      // The success banner must never accompany a refused save.
      await expect(page.getByText("Organisation saved.")).toHaveCount(0);

      await page.goto(`/staff/${ids.profileTarget}`);
      const pf = profileForm(page);
      await pf.locator('input[name="full_name"]').fill("OM Must Not Save");
      await submitAction(page, "/staff/", () => clickHydrated(pf.getByRole("button", { name: "Save profile" })));
      await expect(page.getByText("You don't have permission to edit staff records.")).toBeVisible();

      await page.goto("/staff");
      await clickHydrated(page.getByRole("button", { name: "+ Add staff" }).first());
      const dialog = page.getByRole("dialog");
      // The dialog moves focus to its first field just after it opens. Typing before that lands
      // the text in "Full name" — wait for the focus hand-over, then fill.
      await expect(page.getByRole("dialog").locator('input[name="full_name"]')).toBeFocused();
      await dialog.locator('input[name="email"]').fill(email("joiner2"));
      await dialog.locator('select[name="role"]').selectOption("staff");
      await clickHydrated(dialog.getByRole("button", { name: "Send invite" }));
      await expect(dialog.getByText("You don't have permission to add staff.")).toBeVisible();
    });
    const after = await orgRow(orgA);
    expect(after.phone).toBe(before.phone);
    expect(after.name).toBe(before.name);
    expect((await userRow("profileTarget")).full_name).toBe("OM Profile Edited");
    expect(await memRole(orgA, "joiner2")).toBeNull();
  });

  test("i3) admin WITH settings:manage can save settings (capability is the gate)", async ({ browser }) => {
    await asActor(browser, STATE("adminCap"), async (page) => {
      await page.goto("/settings");
      const form = settingsOrgForm(page);
      await form.locator('input[name="phone"]').fill("028 9000 4444");
      await submitAction(page, "/settings", () => clickHydrated(form.getByRole("button", { name: "Save organisation" })));
      await expect(page.getByText("Organisation saved.")).toBeVisible();
      expect((await orgRow(orgA)).phone).toBe("028 9000 4444");
      await page.reload();
      await expect(settingsOrgForm(page).locator('input[name="phone"]')).toHaveValue("028 9000 4444");
    });
  });

  test("i4) admin (even with staff:manage) cannot edit an owner/admin record, appoint an admin, or remove the owner", async ({ browser }) => {
    await asActor(browser, STATE("adminCap"), async (page) => {
      // Edit the owner's and a fellow admin's record -> refused, rows untouched.
      for (const key of ["owner", "adminTarget"] as Key[]) {
        const beforeName = (await userRow(key)).full_name;
        await page.goto(`/staff/${ids[key]}`);
        const pf = profileForm(page);
        await pf.locator('input[name="full_name"]').fill("OM Must Not Save");
        await submitAction(page, "/staff/", () => clickHydrated(pf.getByRole("button", { name: "Save profile" })));
        await expect(page.getByText("Only the owner can edit an owner's or admin's record.")).toBeVisible();
        expect((await userRow(key)).full_name).toBe(beforeName);
      }

      // Appoint an admin via the add-staff dialog -> refused, no membership.
      await page.goto("/staff");
      await clickHydrated(page.getByRole("button", { name: "+ Add staff" }).first());
      const dialog = page.getByRole("dialog");
      // The dialog moves focus to its first field just after it opens. Typing before that lands
      // the text in "Full name" — wait for the focus hand-over, then fill.
      await expect(page.getByRole("dialog").locator('input[name="full_name"]')).toBeFocused();
      await dialog.locator('input[name="email"]').fill(email("joiner2"));
      await dialog.locator('select[name="role"]').selectOption("admin");
      await clickHydrated(dialog.getByRole("button", { name: "Send invite" }));
      await expect(dialog.getByText("Only the owner can appoint an admin.").first()).toBeVisible();
      expect(await memRole(orgA, "joiner2")).toBeNull();

      // Promote a staff member to admin via the role form -> refused.
      await page.goto(`/staff/${ids.profileTarget}`);
      const rf = page.locator("form", { has: page.getByRole("button", { name: "Update", exact: true }) });
      await rf.locator('select[name="role"]').selectOption("admin");
      await clickHydrated(rf.getByRole("button", { name: "Update", exact: true }));
      await page.waitForLoadState("networkidle");
      await expect(page).not.toHaveURL(/saved=role/);
      expect(await memRole(orgA, "profileTarget")).toBe("staff");

      // Change a fellow admin's role -> refused.
      await page.goto(`/staff/${ids.adminTarget}`);
      const af = page.locator("form", { has: page.getByRole("button", { name: "Update", exact: true }) });
      await af.locator('select[name="role"]').selectOption("staff");
      await clickHydrated(af.getByRole("button", { name: "Update", exact: true }));
      await page.waitForLoadState("networkidle");
      await expect(page).not.toHaveURL(/saved=role/);
      expect(await memRole(orgA, "adminTarget")).toBe("admin");

      // The owner's record offers no Remove and a disabled role control.
      await page.goto(`/staff/${ids.owner}`);
      await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
    });
    expect(await memRole(orgA, "owner")).toBe("owner");
  });

  test("i5) the last (only) owner cannot be removed or demoted: no control is offered, row intact", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await page.goto(`/staff/${ids.owner}`);
      await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
    });
    expect(await memRole(orgA, "owner")).toBe("owner");
  });

  test("i6) another organisation's owner cannot see or affect this organisation", async ({ browser }) => {
    const aBefore = await orgRow(orgA);
    await asActor(browser, STATE("ownerB"), async (page) => {
      // Their /settings is THEIR org's; saving changes only org B.
      await page.goto("/settings");
      const form = settingsOrgForm(page);
      await expect(form.locator('input[name="name"]')).toHaveValue(`OM Other Co ${sfx}`);
      await form.locator('input[name="phone"]').fill("028 9000 5555");
      await submitAction(page, "/settings", () => clickHydrated(form.getByRole("button", { name: "Save organisation" })));
      await expect(page.getByText("Organisation saved.")).toBeVisible();

      // Org A's staff records are not reachable by id from org B's session.
      for (const key of ["profileTarget", "owner", "adminTarget"] as Key[]) {
        await page.goto(`/staff/${ids[key]}`);
        await expect(page.getByRole("button", { name: "Save profile" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText("OM Profile Edited");
      }
    });
    const aAfter = await orgRow(orgA);
    expect(aAfter.phone).toBe(aBefore.phone);
    expect(aAfter.name).toBe(aBefore.name);
    expect((await orgRow(orgB)).phone).toBe("028 9000 5555");
    expect((await userRow("profileTarget")).full_name).toBe("OM Profile Edited");
    expect(await memRole(orgA, "profileTarget")).toBe("staff");
    expect(await memRole(orgB, "staffB")).toBe("staff");
  });
});
