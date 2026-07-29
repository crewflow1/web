import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

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
 *
 * Seeding is idempotent against a PERSISTENT local database: everything this
 * spec creates is deletable (no issued-evidence freeze applies to diary rows,
 * snags, DRAFT talks or job-target attachments), so beforeAll deletes this
 * spec's own signature rows and reseeds fixed "Hub E2E" rows — the
 * blueprint-pins pattern. The old per-run `Date.now()` titles existed to dodge
 * residue collisions and grew every hub panel (and the timeline, which reads
 * these tables directly) by four rows per local run, drifting the scanned DOM
 * ever further from fresh-volume CI's.
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
  return createClient(assertLocalE2eTarget("job-site-hub-mobile.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("job site hub — mobile + accessibility", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test.beforeAll(async () => {
    const db = svc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n);
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as
      | string
      | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    // Delete this spec's own rows from every earlier run (legacy stamped `Hub <ms>` titles
    // and the previous run's `Hub E2E` sentinels alike — one prefix covers both). Scoped to
    // the sentinel job + this signature so a concurrently-running spec's seeds (e.g.
    // blueprint-pins snags, toolbox-a11y talks) are never touched. Deleting a snag also
    // cascades any linked pin, never the reverse — so no strays in either direction.
    for (const [table, column] of [
      ["snags", "title"],
      ["site_diary_entries", "work_summary"],
      ["toolbox_talks", "topic"],
    ] as const) {
      const heal = await t(table).delete().eq("org_id", orgId).eq("job_id", JOB).like(column, "Hub %");
      if (heal.error) throw new Error(`hub cleanup (${table}): ${heal.error.message}`);
    }
    const healAtt = await t("tenant_attachments").delete().eq("org_id", orgId).eq("target_table", "jobs").eq("target_id", JOB).like("filename", "hub-%");
    if (healAtt.error) throw new Error(`hub cleanup (attachment): ${healAtt.error.message}`);

    const diary = await t("site_diary_entries")
      .insert({
        org_id: orgId,
        job_id: JOB,
        entry_date: "2026-07-18",
        weather: "Dry am, heavy rain pm",
        labour_count: 8,
        work_summary: "Hub E2E — first fix upstairs, screed poured to plots 3 and 4",
        delays: "Concrete wagon two hours late",
      })
      .select("id")
      .single();
    if (diary.error) throw new Error(`hub seed (diary): ${diary.error.message}`);

    // Every row carries the SAME keys: a PostgREST bulk insert does not fall back
    // to a column default for a key that is absent from one object — it writes NULL.
    const snags = await t("snags").insert([
      { org_id: orgId, job_id: JOB, title: "Hub E2E cracked tile", status: "open", priority: "high", location: "Plot 4 ensuite", due_date: "2026-01-01", resolved_at: null },
      { org_id: orgId, job_id: JOB, title: "Hub E2E loose socket", status: "open", priority: "low", location: null, due_date: null, resolved_at: null },
      { org_id: orgId, job_id: JOB, title: "Hub E2E signed off", status: "verified", priority: "medium", location: null, due_date: null, resolved_at: new Date().toISOString() },
    ]);
    if (snags.error) throw new Error(`hub seed (snags): ${snags.error.message}`);

    const talk = await t("toolbox_talks").insert({
      org_id: orgId,
      job_id: JOB,
      topic: "Hub E2E working at height",
      talk_date: "2026-07-18",
      attendee_count: 8,
    });
    if (talk.error) throw new Error(`hub seed (toolbox): ${talk.error.message}`);

    // A deliberately long, unbroken filename — the classic phone-overflow shape.
    const att = await t("tenant_attachments").insert({
      org_id: orgId,
      target_table: "jobs",
      target_id: JOB,
      filename: "hub-e2e-a-very-long-unbroken-site-photo-filename-from-a-phone-camera.jpg",
      mime_type: "image/jpeg",
      storage_path: `${orgId}/jobs/${JOB}/hub-e2e.jpg`,
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
    await settleForAxe(page);
    let builder = new AxeBuilder({ page }).withTags(WCAG);
    for (const selector of HUB_SECTIONS) builder = builder.include(selector);
    const results = await builder.analyze();
    expect(
      results.violations,
      JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2),
    ).toEqual([]);
  });
});
