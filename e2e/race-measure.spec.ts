/* eslint-disable @typescript-eslint/no-explicit-any -- measurement harness: loose
   service-role casts, local-only, never part of CI. */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { assertLocalE2eTarget } from "./_guard";

/**
 * MANUAL MEASUREMENT HARNESS — skipped unless RACE_MEASURE=1 (never runs in CI).
 *
 * Measures the actual loss rate of the Next 15.5 deep-swap commit race
 * (vercel/next.js#83386; see fleet fix 8e4a846) for live flows. Each flow is
 * driven REPS times through the real production build; the outcome of every
 * submit is classified:
 *
 *   WIN    — page.url() reached the action's redirect target
 *   BOUNCE — middleware getUser() flake sent the POST to /login (excluded;
 *            documented separately in lib/supabase/middleware.ts)
 *   LOSS   — URL never changed but the row IS in the DB: the silent strand
 *
 * Run:  RACE_MEASURE=1 RACE_REPS=10 npx playwright test race-measure --reporter=list
 *
 * Measured on main @ 1d3116a (2026-07-29, next start, 10 reps each):
 *   permits-create             0% loss  (depth-4 cross-route, 1× revalidate)
 *   permits-update            60% loss  (depth-5 same-route, 1× same-route revalidate)
 *   templates-add-section    100% loss  (depth-5 same-route, 1× same-route revalidate)
 *   quotes-review              0% loss  (depth-4 same-route, 3× revalidate)
 *   payments-match             0% loss  (depth-5 same-route, 3× revalidate)
 *   assets-status            100% loss  (depth-4 same-route, 2× revalidate)
 *   inspection-save-progress  10% loss  (depth-6 same-route, 1× same-route revalidate)
 * Loss is page-specific — the big multi-form pages (permits [id], templates
 * [id], assets [id]) lose while lighter pages win even at 3× revalidate — not
 * a simple function of depth/revalidate count. That is why every depth-≥4
 * redirect() flow in the audited set was converted, not only the measured
 * losers: a currently-winning page is one feature's growth from the cliff.
 */

test.skip(!process.env.RACE_MEASURE, "manual measurement harness — set RACE_MEASURE=1 to run");

const REPS = Number(process.env.RACE_REPS ?? 10);
const NAV_TIMEOUT = 12_000;
const SLUG = "e2e-harness-org";
const JOB = "00000000-0000-0000-0000-000000000000";

test.use({ storageState: "e2e/.auth/owner.json" });
test.describe.configure({ mode: "serial" });

function svc() {
  return createClient(
    assertLocalE2eTarget("race-measure.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  ) as unknown as { from: (t: string) => any };
}

let ORG = "";
let OWNER = "";
let SECOND = "";

test.beforeAll(async () => {
  const db = svc();
  ORG = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
  if (!ORG) throw new Error("seeded org not found — run a normal spec once so globalSetup seeds");
  const members = (await db.from("memberships").select("user_id, role").eq("org_id", ORG)).data ?? [];
  OWNER = members.find((m: { role: string }) => m.role === "owner")?.user_id ?? members[0]?.user_id;
  SECOND = members.find((m: { user_id: string }) => m.user_id !== OWNER)?.user_id ?? OWNER;
});

/** React has attached a fiber to a form — client dispatch is live (fleet.spec.ts). */
async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
}

type Outcome = "WIN" | "BOUNCE" | "LOSS" | "LOSS_NO_WRITE";
const results: Record<string, Outcome[]> = {};

/** Click, then classify what the browser did. `landed` (optional) checks the DB
 *  so a LOSS is proven to be the silent strand (write committed, browser stuck). */
async function classify(
  page: Page,
  flow: string,
  target: RegExp,
  landed?: () => Promise<boolean>,
): Promise<Outcome> {
  let out: Outcome;
  try {
    await page.waitForURL(target, { timeout: NAV_TIMEOUT });
    out = "WIN";
  } catch {
    const url = page.url();
    if (/\/login/.test(url)) out = "BOUNCE";
    else if (landed) out = (await landed()) ? "LOSS" : "LOSS_NO_WRITE";
    else out = "LOSS";
  }
  (results[flow] ??= []).push(out);
  console.log(`[race] ${flow} rep=${results[flow].length} → ${out}  (${page.url().slice(0, 90)})`);
  return out;
}

test.afterAll(() => {
  console.log("\n=== RACE MEASUREMENT SUMMARY ===");
  for (const [flow, list] of Object.entries(results)) {
    const n = (o: Outcome) => list.filter((x) => x === o).length;
    const denom = list.length - n("BOUNCE");
    const lossPct = denom ? Math.round(((n("LOSS") + n("LOSS_NO_WRITE")) / denom) * 100) : 0;
    console.log(
      `${flow.padEnd(28)} reps=${list.length} win=${n("WIN")} loss=${n("LOSS")} loss_no_write=${n("LOSS_NO_WRITE")} bounce=${n("BOUNCE")}  → loss ${lossPct}%`,
    );
  }
});

/* ── 1. permits create — depth-4 cross-route (new → [id]), 1× revalidate(list) ── */
test("permits-create", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  for (let i = 0; i < REPS; i++) {
    const title = `Race PTW ${Date.now()}-${i}`;
    await page.goto("/health-safety/permits/new");
    await hydrated(page);
    await page.locator('select[name="permitType"]').selectOption("hot_works");
    await page.locator('input[name="title"]').fill(title);
    await page.locator('textarea[name="scope"]').fill("Race measurement scope");
    await page.getByRole("button", { name: /save draft/i }).click();
    await classify(page, "permits-create", /\/health-safety\/permits\/[0-9a-f-]{36}\?saved=created/, async () =>
      Boolean((await db.from("permits_to_work").select("id").eq("title", title).maybeSingle()).data),
    );
  }
});

/* ── 2. permits update — depth-5 same-route PAGE swap, 1× revalidate(same route) ── */
test("permits-update", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  for (let i = 0; i < REPS; i++) {
    const id = randomUUID();
    await db.from("permits_to_work").insert({
      id, org_id: ORG, created_by: OWNER, permit_type: "hot_works",
      title: `Race update ${i}`, scope: "measure", status: "draft",
    });
    const newTitle = `Race updated ${Date.now()}-${i}`;
    await page.goto(`/health-safety/permits/${id}`);
    await hydrated(page);
    await page.locator('input[name="title"]').fill(newTitle);
    await page.getByRole("button", { name: /save changes/i }).click();
    await classify(page, "permits-update", new RegExp(`/health-safety/permits/${id}\\?saved=updated`), async () =>
      Boolean((await db.from("permits_to_work").select("id").eq("id", id).eq("title", newTitle).maybeSingle()).data),
    );
  }
});

/* ── 3. templates addSection — depth-5 same-route PAGE swap, 1× revalidate(same) ── */
test("templates-add-section", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  const tpl = (
    await db.from("asset_inspection_templates").insert({
      org_id: ORG, family_id: randomUUID(), version: 1, name: `Race template ${Date.now()}`,
      check_level: "pre_use_check", status: "draft", definition: { sections: [] }, created_by: OWNER,
    }).select("id").single()
  ).data;
  expect(tpl?.id).toBeTruthy();
  for (let i = 0; i < REPS; i++) {
    const section = `Race section ${Date.now()}-${i}`;
    await page.goto(`/assets/templates/${tpl.id}`);
    await hydrated(page);
    const form = page.locator("form", { has: page.locator('input[name="template_id"]') })
      .filter({ has: page.locator('input[name="title"]') });
    await form.locator('input[name="title"]').fill(section);
    await form.getByRole("button", { name: /^add$|add section/i }).click();
    await classify(page, "templates-add-section", new RegExp(`/assets/templates/${tpl.id}\\?saved=section`), async () => {
      const def = (await db.from("asset_inspection_templates").select("definition").eq("id", tpl.id).maybeSingle()).data?.definition;
      return JSON.stringify(def ?? {}).includes(section);
    });
  }
});

/* ── 4. quotes review (approve) — depth-4 same-route PAGE swap, 3× revalidatePath ──
 * The quotes page derives isAdmin from an org-wide memberships .single() that
 * ERRORS in any multi-member org (live bug, flagged separately), hiding the
 * approve button. The harness org has 2 members, so this test parks the second
 * membership for its duration to make the button render at all. */
test("quotes-review", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  let parked: Record<string, unknown> | null = null;
  if (SECOND && SECOND !== OWNER) {
    parked = (await db.from("memberships").select("*").eq("org_id", ORG).eq("user_id", SECOND).maybeSingle()).data;
    await db.from("memberships").delete().eq("org_id", ORG).eq("user_id", SECOND);
  }
  const cust = (
    await db.from("customers").insert({ org_id: ORG, name: `Race customer ${Date.now()}` }).select("id").single()
  ).data;
  expect(cust?.id).toBeTruthy();
  for (let i = 0; i < REPS; i++) {
    const q = (
      await db.from("quotes").insert({
        org_id: ORG, customer_id: cust.id, job_id: JOB, number: `RACE-${Date.now()}-${i}`,
        // Created by the OTHER member: a creator-owner with a second approver
        // present hides the Approve button (self-approval block).
        status: "pending_approval", subtotal: 1000, vat_total: 200, total: 1200, created_by: SECOND,
      }).select("id").single()
    ).data;
    expect(q?.id).toBeTruthy();
    try {
      await page.goto(`/quotes/${q.id}`);
      await hydrated(page);
      await page.locator('button[name="action"][value="approve"]').click({ timeout: 15_000 });
      await classify(page, "quotes-review", new RegExp(`/quotes/${q.id}\\?saved=approved`), async () =>
        (await db.from("quotes").select("status").eq("id", q.id).maybeSingle()).data?.status === "approved",
      );
    } catch (e) {
      if (parked) await db.from("memberships").upsert(parked);
      throw e;
    }
  }
  if (parked) await db.from("memberships").upsert(parked);
});

/* ── 5. payments confirm match — depth-5 same-route PAGE swap, 3× revalidatePath ── */
test("payments-match", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  const cust = (
    await db.from("customers").insert({ org_id: ORG, name: `Race payer ${Date.now()}` }).select("id").single()
  ).data;
  for (let i = 0; i < REPS; i++) {
    const inv = (
      await db.from("invoices").insert({
        org_id: ORG, customer_id: cust.id, job_id: JOB, number: `RINV-${Date.now()}-${i}`,
        amount: 1000, vat_total: 200, status: "sent", due_date: "2027-01-01",
      }).select("id").single()
    ).data;
    expect(inv?.id).toBeTruthy();
    const stmt = (
      await db.from("bank_statements").insert({
        org_id: ORG, filename: `race-${i}.csv`, uploaded_by: OWNER, line_count: 1, matched_count: 0,
      }).select("id").single()
    ).data;
    expect(stmt?.id).toBeTruthy();
    const line = (
      await db.from("bank_statement_lines").insert({
        org_id: ORG, bank_statement_id: stmt.id, posted_at: "2026-07-01", amount: 1200,
        description: "RACE PAYMENT", reference: `RINV-${Date.now()}-${i}`,
        matched_invoice_id: inv.id, match_confidence: 90, match_status: "suggested",
      }).select("id").single()
    ).data;
    expect(line?.id).toBeTruthy();
    await page.goto(`/payments/reconcile/${stmt.id}`);
    await hydrated(page);
    await page.locator('select[name="invoice_id"]').first().selectOption(inv.id);
    await page.getByRole("button", { name: /^confirm$/i }).first().click();
    await classify(page, "payments-match", new RegExp(`/payments/reconcile/${stmt.id}\\?saved=matched`), async () =>
      (await db.from("bank_statement_lines").select("match_status").eq("id", line.id).maybeSingle()).data
        ?.match_status === "confirmed",
    );
  }
});

/* ── 6. asset status — depth-4 same-route PAGE swap, 2× revalidatePath (control) ── */
test("assets-status", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  const asset = (
    await db.from("assets").insert({ org_id: ORG, name: `Race asset ${Date.now()}`, status: "active", created_by: OWNER })
      .select("id").single()
  ).data;
  expect(asset?.id).toBeTruthy();
  const flip = ["retired", "active"] as const;
  for (let i = 0; i < REPS; i++) {
    const target = flip[i % 2];
    await page.goto(`/assets/${asset.id}`);
    await hydrated(page);
    await page
      .locator("form", { has: page.locator(`input[name="status"][value="${target}"]`) })
      .getByRole("button")
      .click();
    await classify(page, "assets-status", new RegExp(`/assets/${asset.id}\\?saved=status`), async () =>
      (await db.from("assets").select("status").eq("id", asset.id).maybeSingle()).data?.status === target,
    );
  }
});

/* ── 7. inspection save-progress — depth-6 same-route PAGE swap, 1× revalidate(same) ── */
test("inspection-save-progress", async ({ page }) => {
  test.setTimeout(REPS * 45_000);
  const db = svc();
  const asset = (
    await db.from("assets").insert({ org_id: ORG, name: `Race insp asset ${Date.now()}`, status: "active", created_by: OWNER })
      .select("id").single()
  ).data;
  expect(asset?.id).toBeTruthy();
  const sections = [
    { key: "sec_race", title: "Race walkaround", items: [{ key: "item_race", label: "Check the thing", input: "pass_fail", required: false }] },
  ];
  for (let i = 0; i < REPS; i++) {
    const tplId = randomUUID();
    const insp = (
      await db.from("asset_inspections").insert({
        org_id: ORG, asset_id: asset.id, title: `Race run ${i}`, status: "draft",
        safety_critical: false, content: {}, template_id: null, template_version: 1,
        template_snapshot: {
          template_id: tplId, family_id: tplId, version: 1, name: `Race run ${i}`,
          check_level: "pre_use_check", sections,
        },
        created_by: OWNER,
      }).select("id").single()
    ).data;
    expect(insp?.id).toBeTruthy();
    await page.goto(`/assets/${asset.id}/inspections/${insp.id}`);
    await hydrated(page);
    await page.getByRole("button", { name: /save progress/i }).click();
    await classify(
      page,
      "inspection-save-progress",
      new RegExp(`/assets/${asset.id}/inspections/${insp.id}\\?saved=progress`),
    );
  }
});
