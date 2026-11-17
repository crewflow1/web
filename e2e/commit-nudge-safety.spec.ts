/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, page-side instrumentation */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * The CommitNudge workaround (app/(app)/_components/commit-nudge.tsx) is side-effect free.
 *
 * It only re-renders an empty component after a form is submitted. These tests pin what that
 * must NEVER do: submit anything again, write anything again, make a network request, keep
 * timers alive, pile up timers on rapid saves, lose what a user is typing in another form, or
 * break navigation. Owner session, harness org, production build, real Postgres.
 *
 * Instrumentation (page-side, installed before the app loads): a capture-phase `submit`
 * listener registered FIRST marks the synchronous window in which the nudge schedules its
 * timers, so the timers it creates are counted exactly (created / cleared / fired).
 */
const SLUG = "e2e-harness-org";
const TAG = `cn${Date.now().toString(36)}`;
const WINDOW_MS = 16_000; // the nudge's last re-render is at 15 s
const db = createClient(assertLocalE2eTarget("commit-nudge-safety.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;
let org = "", staff = "", staffName = "", customer = "";

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__nudge = { created: 0, cleared: 0, fired: 0, live: new Set<number>(), submits: 0 };
    // Microtasks run between event listeners, so the "inside the submit dispatch" window is
    // closed by a macrotask; within it, only timers with the nudge's own delays are counted.
    const NUDGE = new Set([100, 200, 400, 700, 1000, 1500, 2000, 3000, 4000, 5500, 7000, 9000, 11500, 15000]);
    let inSubmit = false;
    const st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window);
    document.addEventListener("submit", () => { w.__nudge.submits += 1; inSubmit = true; st(() => { inSubmit = false; }, 0); }, true);
    (window as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      if (!inSubmit || !NUDGE.has(ms ?? -1)) return st(fn, ms, ...a);
      const id: number = st(() => { w.__nudge.fired += 1; w.__nudge.live.delete(id); fn(...a); }, ms);
      w.__nudge.created += 1; w.__nudge.live.add(id);
      return id;
    };
    (window as any).clearTimeout = (id?: number) => { if (id !== undefined && w.__nudge.live.has(id)) { w.__nudge.cleared += 1; w.__nudge.live.delete(id); } return ct(id); };
  });
}
const nudge = (page: Page) => page.evaluate(() => { const n = (window as any).__nudge; return { created: n.created, cleared: n.cleared, fired: n.fired, live: n.live.size, submits: n.submits }; });

test.use({ storageState: "e2e/.auth/owner.json" });
test.describe.configure({ mode: "serial" });
test.describe("commit nudge · no side effects (browser)", () => {
  test.beforeAll(async () => {
    org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!org) throw new Error("harness org not found — did globalSetup run?");
    const s = (await db.from("users").select("id, full_name").eq("email", "e2e-staff@crewflow.test").single()).data;
    staff = s.id; staffName = s.full_name;
    customer = (await db.from("customers").insert({ org_id: org, name: `Nudge ${TAG}` }).select("id").single()).data.id;
  });
  test.afterAll(async () => { await db.from("users").update({ full_name: staffName }).eq("id", staff); });

  test("one save = one request, one row; over the next 16 s: no further writes or server requests, every timer fires once and none is left", async ({ page }) => {
    test.setTimeout(60_000);
    await instrument(page);
    const inv = (await db.from("invoices").insert({ org_id: org, customer_id: customer, number: `CN-${TAG}-1`, status: "sent", amount: 100, vat_total: 20 }).select("id").single()).data.id;
    await page.goto(`/invoices/${inv}`);
    const form = page.locator("form", { has: page.locator('input[name="amount"]') }).last();
    const submit = form.getByRole("button", { name: "Record payment" });
    await waitForHydrated(submit);
    const requests: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.origin === new URL(page.url()).origin && !/\.(js|css|woff2?|png|svg|ico|webp|jpg)$/.test(u.pathname)) requests.push(`${r.method()} ${u.pathname}${r.headers()["next-action"] ? " [action]" : ""}${u.searchParams.has("_rsc") ? " [rsc]" : ""}`); });

    await form.locator('input[name="amount"]').fill("10");
    await submit.click();
    await expect(page.getByText("Payment recorded.")).toBeVisible({ timeout: 3_000 });
    const afterConfirm = requests.length;
    // CPU cost of the 14 re-renders: main-thread script time and long tasks over the window
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metric = async (name: string) => ((await cdp.send("Performance.getMetrics")).metrics.find((m: any) => m.name === name)?.value ?? 0) as number;
    const script0 = await metric("ScriptDuration");
    await page.evaluate(() => { (window as any).__long = 0; new PerformanceObserver((l) => { (window as any).__long += l.getEntries().length; }).observe({ type: "longtask", buffered: false }); });
    await page.waitForTimeout(WINDOW_MS);
    const scriptMs = Math.round(((await metric("ScriptDuration")) - script0) * 1000);
    const longTasks = await page.evaluate(() => (window as any).__long as number);
    console.log(`[nudge-cost] script time over ${WINDOW_MS / 1000} s after the save: ${scriptMs} ms; long tasks: ${longTasks}`);
    expect(scriptMs, "the re-renders are cheap").toBeLessThan(300);
    expect(longTasks, "no long task").toBe(0);

    const n = await nudge(page);
    expect(n.submits, "one submit").toBe(1);
    expect(n.created, "the nudge scheduled its 14 re-renders").toBe(14);
    expect(n.fired, "each fired exactly once").toBe(14);
    expect(n.live, "no timer left behind").toBe(0);
    const actions = requests.filter((r) => r.endsWith("[action]") || r.includes("[action]"));
    expect(actions.filter((r) => r.startsWith(`POST /invoices/${inv}`)).length, `one save request (${requests.join(", ")})`).toBe(1);
    expect(requests.slice(afterConfirm), "no request of any kind caused by the 14 re-renders").toEqual([]);
    expect(((await db.from("invoice_payments").select("id").eq("invoice_id", inv)).data ?? []).length, "exactly one payment row").toBe(1);
  });

  test("rapid saves: a double-click records one payment; two saves in a row each confirm, the timers restart instead of piling up", async ({ page }) => {
    test.setTimeout(60_000);
    await instrument(page);
    const inv = (await db.from("invoices").insert({ org_id: org, customer_id: customer, number: `CN-${TAG}-2`, status: "sent", amount: 100, vat_total: 20 }).select("id").single()).data.id;
    await page.goto(`/invoices/${inv}`);
    const form = page.locator("form", { has: page.locator('input[name="amount"]') }).last();
    const submit = form.getByRole("button", { name: "Record payment" });
    await waitForHydrated(submit);
    await form.locator('input[name="amount"]').fill("10");
    await submit.dblclick();
    await expect(page.getByText("Payment recorded.")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(1_500);
    expect(((await db.from("invoice_payments").select("id").eq("invoice_id", inv)).data ?? []).length, "double-click → one payment").toBe(1);

    // two genuine saves back to back on the staff page
    await page.goto(`/staff/${staff}`);
    const profile = page.locator("form", { has: page.locator('input[name="full_name"]') }).first();
    const save = profile.locator('button[type="submit"]').first();
    await waitForHydrated(save);
    const before = await nudge(page);
    await profile.locator('input[name="full_name"]').fill(`${staffName} one`);
    await save.click();
    await expect(page.getByText("Profile saved.")).toBeVisible({ timeout: 3_000 });
    await profile.locator('input[name="full_name"]').fill(`${staffName} two`);
    await save.click();
    await expect.poll(async () => (await db.from("users").select("full_name").eq("id", staff).single()).data.full_name, { timeout: 3_000 }).toBe(`${staffName} two`);
    const mid = await nudge(page);
    expect(mid.created - before.created, "14 per submit").toBe(28);
    expect(mid.live, "the first batch was cleared, not added to: at most 14 live").toBeLessThanOrEqual(14);
    await page.waitForTimeout(WINDOW_MS);
    expect((await nudge(page)).live, "none left").toBe(0);
    await expect(profile.locator('input[name="full_name"]')).toHaveValue(`${staffName} two`);
  });

  test("what a user is typing in ANOTHER form survives a save and 16 s of re-renders", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`/staff/${staff}`);
    const profile = page.locator("form", { has: page.locator('input[name="full_name"]') }).first();
    const qual = page.locator("form", { has: page.locator('input[name="title"]') }).first();
    const save = profile.locator('button[type="submit"]').first();
    await waitForHydrated(save);
    await qual.locator('input[name="title"]').fill(`Unsaved draft ${TAG}`);
    await profile.locator('input[name="full_name"]').fill(`${staffName} three`);
    await save.click();
    await expect(page.getByText("Profile saved.")).toBeVisible({ timeout: 3_000 });
    await page.waitForTimeout(WINDOW_MS);
    await expect(qual.locator('input[name="title"]'), "the unsaved draft is untouched").toHaveValue(`Unsaved draft ${TAG}`);
    expect(((await db.from("staff_qualifications").select("id").eq("user_id", staff).eq("title", `Unsaved draft ${TAG}`)).data ?? []).length, "and it was not submitted").toBe(0);
  });

  test("navigating away mid-save: the save lands once, the next page works, and leaving the app clears the timers without errors", async ({ page }) => {
    test.setTimeout(60_000);
    await instrument(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`/staff/${staff}`);
    const qual = page.locator("form", { has: page.locator('input[name="title"]') }).first();
    const add = qual.locator('button[type="submit"]').first();
    await waitForHydrated(add);
    const title = `Mid-nav ${TAG}`;
    await qual.locator('input[name="title"]').fill(title);
    await add.click();
    // leave straight away by an in-app link
    await page.locator('a[href="/jobs"]:visible').first().click();
    await expect(page).toHaveURL(/\/jobs(\?|$)/);
    await expect.poll(async () => ((await db.from("staff_qualifications").select("id").eq("user_id", staff).eq("title", title)).data ?? []).length, { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(3_000);
    expect(((await db.from("staff_qualifications").select("id").eq("user_id", staff).eq("title", title)).data ?? []).length, "still exactly one").toBe(1);
    // leave the app shell entirely (the nudge unmounts) — pending timers are cleared
    await page.goto("/privacy");
    await page.waitForTimeout(WINDOW_MS);
    expect(errors.filter((e) => !/Service Worker|favicon|ERR_ABORTED|net::/i.test(e)), "no client errors").toEqual([]);
  });
});
