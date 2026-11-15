/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { mintState, asActor } from "./_actors";
import { waitForHydrated } from "./_hydration";

/**
 * D-17 held companies, in a real browser against the production build:
 *   ACTIVE      — normal operations work (control).
 *   SUSPENDED / CANCELLED — the OWNER keeps read-only access plus billing, export and
 *                 settings (recovery); operational writes are refused (no row is written);
 *                 admin and staff are locked out on /access-pending.
 * The database half (RESTRICTIVE policies + write-guard trigger, incl. SECURITY DEFINER RPCs)
 * is proved in __tests__/integration/adversarial/staff-field-operations.test.ts.
 */
const sfx = `hc${Date.now().toString(36)}`;
const PASSWORD = `E2e-${randomBytes(12).toString("hex")}`;
const STATE = (k: string) => `e2e/.auth/${sfx}-${k}.json`;
const email = (k: string) => `${sfx}-${k}@crewflow.test`;
const KEYS = ["owner", "admin", "staff"] as const;

let db: any;
const ids: Record<string, string> = {};
let org = "";

test.describe.configure({ mode: "serial" });
test.describe("D-17 held companies", () => {
  test.beforeAll(async () => {
    db = createClient(assertLocalE2eTarget("held-company spec"), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    org = (await db.from("organizations").insert({ name: `HC Co ${sfx}`, slug: `${sfx}-a`, status: "active" }).select("id").single()).data.id;
    for (const k of KEYS) {
      const c = await db.auth.admin.createUser({ email: email(k), password: PASSWORD, email_confirm: true });
      ids[k] = c.data.user!.id;
      await db.from("users").upsert({ id: ids[k], email: email(k), full_name: `HC ${k}` });
      await db.from("memberships").insert({ org_id: org, user_id: ids[k], role: k });
      await mintState(email(k), PASSWORD, STATE(k));
    }
  });

  test.afterAll(async () => {
    if (!db) return;
    await db.from("memberships").delete().eq("org_id", org);
    await db.from("stock_items").delete().eq("org_id", org);
    await db.from("organizations").delete().eq("id", org);
    for (const k of KEYS) {
      if (!ids[k]) continue;
      await db.from("users").delete().eq("id", ids[k]);
      await db.auth.admin.deleteUser(ids[k]);
    }
  });

  const setStatus = (status: string) => db.from("organizations").update({ status }).eq("id", org);
  const itemCount = async () => ((await db.from("stock_items").select("id").eq("org_id", org)).data ?? []).length;

  async function addItem(page: any, name: string) {
    await page.goto("/stock/items/new");
    await page.getByLabel("What is it?").fill(name);
    await page.getByLabel("Counted in").fill("ea");
    const btn = page.getByRole("button", { name: /add item/i });
    await waitForHydrated(btn);
    await btn.click();
  }

  test("ACTIVE · the owner works normally (control)", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await addItem(page, `Active item ${sfx}`);
      await expect.poll(itemCount, { timeout: 15_000 }).toBe(1);
    });
  });

  for (const status of ["suspended", "cancelled"] as const) {
    test(`${status.toUpperCase()} · owner keeps read-only access + billing / export / settings; no operational write; crew locked out`, async ({ browser }) => {
      test.setTimeout(120_000);
      await setStatus(status);
      const before = await itemCount();
      try {
        await asActor(browser, STATE("owner"), async (page) => {
          // read-only app access (NOT bounced to the lock screen)
          await page.goto("/dashboard");
          await expect(page).not.toHaveURL(/access-pending/);
          // recovery surfaces still work
          for (const path of ["/settings", "/settings/billing"]) {
            await page.goto(path);
            await expect(page, path).not.toHaveURL(/access-pending|login/);
            await expect(page.getByRole("heading").first()).toBeVisible();
          }
          const exp = await page.request.get("/api/accounting/export?from=2026-01-01&to=2026-12-31&format=csv");
          expect(exp.status(), "export stays available to a held owner").not.toBe(403);
          // an operational write is refused: the create form is not even offered (redirect with
          // read_only), and nothing is written — the database would also refuse it.
          await page.goto("/stock/items/new");
          await expect(page, "create form is refused in a held company").toHaveURL(/read_only/);
          expect(await itemCount(), "no row may be written in a held company").toBe(before);
        });
        for (const who of ["admin", "staff"]) {
          await asActor(browser, STATE(who), async (page) => {
            await page.goto("/dashboard");
            await expect(page, `${who} locked out while ${status}`).toHaveURL(/access-pending/);
          });
        }
      } finally {
        await setStatus("active");
      }
    });
  }

  test("ACTIVE AGAIN · everything works once the company is reactivated (never erased)", async ({ browser }) => {
    await asActor(browser, STATE("owner"), async (page) => {
      await addItem(page, `Reactivated item ${sfx}`);
      await expect.poll(itemCount, { timeout: 15_000 }).toBe(2);
    });
    await asActor(browser, STATE("staff"), async (page) => {
      await page.goto("/dashboard");
      await expect(page).not.toHaveURL(/access-pending/);
    });
  });
});
