import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";

/**
 * Job Site Hub — mobile + accessibility regression.
 *
 * The hub exists for a site manager holding a phone, so the two things that
 * must not regress are: it renders at 375px with NO horizontal scroll, and its
 * three panels (site diary, snags, site timeline) are reachable, headed and
 * worded — status is never carried by colour alone.
 *
 * Seeds real site-ops rows onto the harness job via service-role, then
 * GET-navigates only; every write path is proved in the unit + integration
 * tiers. Axe is scoped to the three hub sections so this spec fails for the
 * hub's own accessibility, never for an unrelated panel on a busy page.
 */

const SLUG = "e2e-harness-org";
const JOB = "00000000-0000-0000-0000-000000000000"; // sentinel seeded by globalSetup
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const HUB_SECTIONS = [
  'section[aria-labelledby="job-diary-heading"]',
  'section[aria-labelledby="job-snags-heading"]',
  'section[aria-labelledby="job-timeline-heading"]',
];

function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("job site hub — mobile + accessibility", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  const stamp = Date.now();

  test.beforeAll(async () => {
    const db = svc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n);
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as
      | string
      | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const diary = await t("site_diary_entries")
      .insert({
        org_id: orgId,
        job_id: JOB,
        entry_date: "2026-07-18",
        weather: "Dry am, heavy rain pm",
        labour_count: 8,
        work_summary: `Hub ${stamp} — first fix upstairs, screed poured to plots 3 and 4`,
        delays: "Concrete wagon two hours late",
      })
      .select("id")
      .single();
    if (diary.error) throw new Error(`hub seed (diary): ${diary.error.message}`);

    // Every row carries the SAME keys: a PostgREST bulk insert does not fall back
    // to a column default for a key that is absent from one object — it writes NULL.
    const snags = await t("snags").insert([
      { org_id: orgId, job_id: JOB, title: `Hub ${stamp} cracked tile`, status: "open", priority: "high", location: "Plot 4 ensuite", due_date: "2026-01-01", resolved_at: null },
      { org_id: orgId, job_id: JOB, title: `Hub ${stamp} loose socket`, status: "open", priority: "low", location: null, due_date: null, resolved_at: null },
      { org_id: orgId, job_id: JOB, title: `Hub ${stamp} signed off`, status: "verified", priority: "medium", location: null, due_date: null, resolved_at: new Date().toISOString() },
    ]);
    if (snags.error) throw new Error(`hub seed (snags): ${snags.error.message}`);

    const talk = await t("toolbox_talks").insert({
      org_id: orgId,
      job_id: JOB,
      topic: `Hub ${stamp} working at height`,
      talk_date: "2026-07-18",
      attendee_count: 8,
    });
    if (talk.error) throw new Error(`hub seed (toolbox): ${talk.error.message}`);

    // A deliberately long, unbroken filename — the classic phone-overflow shape.
    const att = await t("tenant_attachments").insert({
      org_id: orgId,
      target_table: "jobs",
      target_id: JOB,
      filename: `hub-${stamp}-a-very-long-unbroken-site-photo-filename-from-a-phone-camera.jpg`,
      mime_type: "image/jpeg",
      storage_path: `${orgId}/jobs/${JOB}/hub-${stamp}.jpg`,
    });
    if (att.error) throw new Error(`hub seed (attachment): ${att.error.message}`);
  });

  test("every hub panel fits a 375px phone with nothing spilling past the edge", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/jobs/${JOB}`);
    await page.waitForLoadState("networkidle");

    // The hub is actually on the page (otherwise "it fits" is vacuous).
    await expect(page.getByRole("heading", { name: "Site diary", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Snags", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Site timeline", exact: true })).toBeVisible();

    for (const selector of HUB_SECTIONS) {
      const section = page.locator(selector).first();
      // The panel itself has no internal scroll…
      const width = await section.evaluate((el) => el.scrollWidth);
      expect(width, `${selector} fits 375px`).toBeLessThanOrEqual(375);
      // …and no descendant (a long filename, a status pill, a wide row) reaches
      // past the viewport edge. 1px of tolerance for sub-pixel layout rounding.
      const spills = await section.evaluate((el) => {
        const out: string[] = [];
        el.querySelectorAll("*").forEach((child) => {
          const r = child.getBoundingClientRect();
          if (r.right > 376) {
            out.push(`${child.tagName} right=${Math.round(r.right)} "${(child.textContent ?? "").trim().slice(0, 40)}"`);
          }
        });
        return out;
      });
      expect(spills, `${selector} has no element past the viewport edge`).toEqual([]);
    }
  });

  test("hub statuses are stated in words, not by colour alone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/jobs/${JOB}`);

    const snags = page.locator('section[aria-labelledby="job-snags-heading"]');
    await expect(snags).toContainText("High");
    await expect(snags).toContainText("Open");
    await expect(snags).toContainText("past due date");

    const diary = page.locator('section[aria-labelledby="job-diary-heading"]');
    await expect(diary).toContainText("Delay logged");
    await expect(diary).toContainText("18 Jul 2026");

    const timeline = page.locator('section[aria-labelledby="job-timeline-heading"]');
    await expect(timeline).toContainText("Diary");
    await expect(timeline).toContainText("Snag raised");
    await expect(timeline).toContainText("Photo");
  });

  test("the hub panels have no WCAG 2.2 A/AA violations", async ({ page }) => {
    await page.goto(`/jobs/${JOB}`);
    await page.waitForLoadState("networkidle");
    let builder = new AxeBuilder({ page }).withTags(WCAG);
    for (const selector of HUB_SECTIONS) builder = builder.include(selector);
    const results = await builder.analyze();
    expect(
      results.violations,
      JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2),
    ).toEqual([]);
  });
});
