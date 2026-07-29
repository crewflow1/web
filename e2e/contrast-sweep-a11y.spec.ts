import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * Slate-tone contrast sweep — accessibility regression for the app-wide fix of
 * the two systemic sub-AA idioms (bg-slate-100 text-slate-500/400 chips at
 * 4.34:1/2.65:1, and text-slate-400 body/table text at ~2.9:1 on white). Each
 * route below carries at least one state that used to fail; the seeds force
 * those styled states to actually render (an empty page proves nothing), then
 * axe runs against the SETTLED page (settleForAxe — a scan fired straight
 * after goto audits the Suspense skeleton and silently passes).
 *
 * Seeds are service-role, GET-only navigation, and IDEMPOTENT on a persistent
 * local DB: every row has a fixed sentinel identity that is looked up first
 * and created only if absent. That matters doubly here — issued risk
 * assessments / permits / toolbox talks are undeletable at the DB for every
 * role including service_role (tg_*_block_delete_when_issued), so stamped
 * per-run rows would grow the shared DB forever (the pattern PR #477 removes
 * from the older axe specs). Those three also refuse non-draft INSERTs, so
 * absent sentinels are created as drafts and advanced through their legal
 * transitions, fail-loudly.
 */

const SLUG = "e2e-harness-org";
const JOB = "00000000-0000-0000-0000-000000000000"; // sentinel job from globalSetup
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function svc() {
  return createClient(assertLocalE2eTarget("contrast-sweep-a11y.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("slate-tone contrast sweep — accessibility", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  let srId = ""; // superseded site report (detail scan)
  let tplId = ""; // superseded template v1, family also has an archived v2
  let assetId = ""; // asset whose detail renders all four fixed sections
  let poId = ""; // cancelled purchase order
  let portalToken = ""; // customer portal token

  test.beforeAll(async () => {
    const db = svc();
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n); // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const must = async <T,>(p: Promise<{ data: T; error: { message: string } | null }>, what: string): Promise<T> => {
      const { data, error } = await p;
      if (error) throw new Error(`contrast seed: ${what} failed — ${error.message}`);
      return data;
    };
    /** Sentinel lookup: exactly zero or one org row may match (maybeSingle
     * throws on duplicates, which is the loud guard against reseeding bugs). */
    const find = async (table: string, match: Record<string, unknown>, what: string): Promise<{ id: string; status?: string } | null> =>
      (await must<{ id: string; status?: string } | null>(t(table).select("id, status").match({ org_id: orgId, ...match }).maybeSingle(), `find ${what}`)) ?? null;
    const findNoStatus = async (table: string, match: Record<string, unknown>, what: string): Promise<{ id: string } | null> =>
      (await must<{ id: string } | null>(t(table).select("id").match({ org_id: orgId, ...match }).maybeSingle(), `find ${what}`)) ?? null;

    // One-time best-effort sweep of this spec's OWN earlier per-run-stamped
    // rows (deletable tables only; stamped titles all embed a 17… epoch).
    // Errors are ignored — residue is cosmetic, and issued H&S rows can't be
    // deleted anyway.
    for (const [table, col, like] of [
      ["site_reports", "title", "A11y superseded report 17%"],
      ["site_reports", "title", "A11y archived report 17%"],
      ["site_reports", "title", "A11y portal report 17%"],
      ["purchase_orders", "number", "PO-E2E-17%"],
      ["customers", "name", "A11y portal customer 17%"],
    ] as const) {
      await t(table).delete().eq("org_id", orgId).like(col, like);
    }

    // --- site reports: superseded (rev 2, so the "rev" span renders) + archived.
    const SR_TITLE = "A11y superseded report E2E";
    srId =
      (await find("site_reports", { title: SR_TITLE }, "superseded site report"))?.id ??
      (
        await must<{ id: string }>(
          t("site_reports")
            .insert({ org_id: orgId, title: SR_TITLE, period_start: "2026-01-01", period_end: "2026-01-31", status: "superseded", revision: 2, report_number: "SR-A11Y-E2E", issued_at: new Date().toISOString() })
            .select("id").single(),
          "superseded site report",
        )
      ).id;
    if (!(await find("site_reports", { title: "A11y archived report E2E" }, "archived site report"))) {
      await must(
        t("site_reports").insert({ org_id: orgId, title: "A11y archived report E2E", period_start: "2026-02-01", period_end: "2026-02-28", status: "archived", revision: 1, report_number: "SR-A11Y-E2E-B", issued_at: new Date().toISOString() }).select("id").single(),
        "archived site report",
      );
    }

    // --- asset templates: family A carries superseded v1 + archived v2 (both
    // chips in the [id] version list); family B's single superseded version
    // guarantees a superseded face on the register (one face per family).
    const TPL_A = "A11y superseded checklist E2E";
    const famAv1 = await findNoStatus("asset_inspection_templates", { name: TPL_A, version: 1 }, "template famA v1");
    if (famAv1) {
      tplId = famAv1.id;
    } else {
      const famA = crypto.randomUUID();
      tplId = (
        await must<{ id: string }>(t("asset_inspection_templates").insert({ org_id: orgId, family_id: famA, version: 1, name: TPL_A, status: "superseded" }).select("id").single(), "template famA v1")
      ).id;
      await must(t("asset_inspection_templates").insert({ org_id: orgId, family_id: famA, version: 2, name: TPL_A, status: "archived" }).select("id").single(), "template famA v2");
    }
    if (!(await findNoStatus("asset_inspection_templates", { name: "A11y superseded face E2E", version: 1 }, "template famB v1"))) {
      await must(t("asset_inspection_templates").insert({ org_id: orgId, family_id: crypto.randomUUID(), version: 1, name: "A11y superseded face E2E", status: "superseded" }).select("id").single(), "template famB v1");
    }

    // --- asset detail: superseded inspection + paused inspection/service
    // schedules + cancelled maintenance case, all on one asset.
    const ensureAsset = async (name: string, extra: Record<string, unknown> = {}): Promise<string> =>
      (await findNoStatus("assets", { name }, `asset ${name}`))?.id ??
      (await must<{ id: string }>(t("assets").insert({ org_id: orgId, name, status: "active", ...extra }).select("id").single(), `asset ${name}`)).id;

    assetId = await ensureAsset("A11y contrast asset E2E");
    if (!(await find("asset_inspections", { asset_id: assetId, title: "A11y superseded inspection E2E" }, "superseded inspection"))) {
      await must(t("asset_inspections").insert({ org_id: orgId, asset_id: assetId, title: "A11y superseded inspection E2E", status: "superseded" }).select("id").single(), "superseded inspection");
    }
    if (!(await findNoStatus("asset_inspection_schedules", { asset_id: assetId }, "paused inspection schedule"))) {
      await must(t("asset_inspection_schedules").insert({ org_id: orgId, asset_id: assetId, template_id: tplId, next_due: "2026-08-01", active: false }).select("id").single(), "paused inspection schedule");
    }
    if (!(await findNoStatus("asset_service_schedules", { asset_id: assetId, maintenance_type: "service" }, "paused service schedule"))) {
      await must(t("asset_service_schedules").insert({ org_id: orgId, asset_id: assetId, maintenance_type: "service", next_due: "2026-08-01", active: false }).select("id").single(), "paused service schedule");
    }
    if (!(await find("asset_maintenance_cases", { asset_id: assetId, title: "A11y cancelled case E2E" }, "cancelled maintenance case"))) {
      await must(
        t("asset_maintenance_cases").insert({ org_id: orgId, asset_id: assetId, case_type: "breakdown", title: "A11y cancelled case E2E", status: "cancelled", cancellation_reason: "seeded for contrast scan", cancelled_at: new Date().toISOString() }).select("id").single(),
        "cancelled maintenance case",
      );
    }

    // --- holdings: one open assignment per asset (partial unique index), one
    // overdue (red chip) and one due in the future (slate chip + "since" text).
    for (const [name, due, yard] of [
      ["A11y held asset overdue E2E", "2020-01-01", "Yard 1"],
      ["A11y held asset due E2E", "2099-01-01", "Yard 2"],
    ] as const) {
      const held = await ensureAsset(name);
      if (!(await find("asset_assignments", { asset_id: held, status: "open" }, `open assignment ${yard}`))) {
        await must(t("asset_assignments").insert({ org_id: orgId, asset_id: held, assignment_type: "stored_at_depot", location: yard, expected_return_at: due }).select("id").single(), `assignment ${yard}`);
      }
    }

    // --- job safety section: withdrawn RAMS + closed permit + withdrawn
    // toolbox talk. Issued rows on all three tables are UNDELETABLE (even for
    // service_role) and non-draft INSERTs are refused, so each sentinel is
    // reused when present and otherwise created as a draft and advanced
    // through its legal transitions. A half-advanced leftover from a crashed
    // run resumes from whatever status it reached.
    const advance = async (table: string, id: string, status: string | undefined, steps: Array<{ from: string; patch: Record<string, unknown> }>, what: string): Promise<void> => {
      let current = status;
      for (const s of steps) {
        if (current !== s.from) continue;
        const next = await must<{ status: string }>(t(table).update(s.patch).eq("id", id).select("status").single(), `${what}: ${s.from} step`);
        current = next.status;
      }
      const target = steps[steps.length - 1]!.patch.status as string;
      if (current !== target) throw new Error(`contrast seed: ${what} is '${current}', expected '${target}'`);
    };

    const ra = await find("risk_assessments", { title: "A11y withdrawn RAMS E2E" }, "withdrawn RAMS");
    const raId = ra?.id ?? (await must<{ id: string }>(t("risk_assessments").insert({ org_id: orgId, job_id: JOB, title: "A11y withdrawn RAMS E2E", activity: "Roofing" }).select("id").single(), "draft RAMS")).id;
    await advance("risk_assessments", raId, ra?.status ?? "draft", [
      { from: "draft", patch: { status: "issued", reference: "RA-A11Y-W-E2E", issued_at: new Date().toISOString() } },
      { from: "issued", patch: { status: "withdrawn" } },
    ], "withdrawn RAMS");

    const permit = await find("permits_to_work", { title: "A11y closed permit E2E" }, "closed permit");
    const permitId = permit?.id ?? (await must<{ id: string }>(t("permits_to_work").insert({ org_id: orgId, job_id: JOB, permit_type: "hot_works", title: "A11y closed permit E2E", scope: "Welding" }).select("id").single(), "draft permit")).id;
    await advance("permits_to_work", permitId, permit?.status ?? "draft", [
      // Far-future window (2036): expiry is derived at read time and the
      // window freezes at issue, so a short window would flip an issued
      // sentinel to 'expired' on later runs. Closed is expiry-immune, but the
      // draft→issued hop must stay valid mid-seed.
      { from: "draft", patch: { status: "issued", reference: "PTW-A11Y-C-E2E", issued_at: new Date().toISOString(), valid_from: new Date().toISOString(), valid_until: "2036-01-01T00:00:00.000Z" } },
      { from: "issued", patch: { status: "closed", closed_at: new Date().toISOString() } },
    ], "closed permit");

    const talk = await find("toolbox_talks", { topic: "A11y withdrawn talk E2E" }, "withdrawn talk");
    const talkId = talk?.id ?? (await must<{ id: string }>(t("toolbox_talks").insert({ org_id: orgId, job_id: JOB, topic: "A11y withdrawn talk E2E", key_points: "Superseded briefing content" }).select("id").single(), "draft talk")).id;
    await advance("toolbox_talks", talkId, talk?.status ?? "draft", [
      {
        from: "draft",
        patch: {
          status: "issued", reference: "TBT-A11Y-W-E2E", issued_at: new Date().toISOString(),
          snapshot: {
            talk_reference: "TBT-A11Y-W-E2E", revision: 1, talk_date: new Date().toISOString().slice(0, 10),
            location: "Plot 4", site_label: "1 High St", delivered_by: "Site Manager",
            topic: "A11y withdrawn talk E2E", key_points: "Superseded briefing content",
            ppe: ["Hard hat"], rams_reference: null, rams_revision: null,
            permit_reference: null, permit_status_at_issue: null, external_attendees: [],
            issued_by_name: "Site Manager", issued_on: new Date().toISOString().slice(0, 10),
          },
        },
      },
      { from: "issued", patch: { status: "withdrawn" } },
    ], "withdrawn talk");

    // --- purchase orders: cancelled (line-through chip on the register, plain
    // chip on the detail — scan both). number is unique per org.
    poId =
      (await findNoStatus("purchase_orders", { number: "PO-A11Y-E2E" }, "cancelled purchase order"))?.id ??
      (
        await must<{ id: string }>(
          t("purchase_orders").insert({ org_id: orgId, number: "PO-A11Y-E2E", status: "cancelled", subtotal: 100, vat_total: 20, expected_date: "2026-09-01" }).select("id").single(),
          "cancelled purchase order",
        )
      ).id;

    // --- fleet vehicles: a plated van whose "Next due" column renders the
    // fixed "All current" text, and an unplated one for the italic
    // "No registration" cell.
    const van = await ensureAsset("A11y Transit E2E", { registration: "AB12 CDE" });
    if (!(await must<{ asset_id: string } | null>(t("fleet_vehicles").select("asset_id").eq("asset_id", van).maybeSingle(), "find van vehicle row"))) {
      await must(t("fleet_vehicles").insert({ asset_id: van, org_id: orgId, vehicle_class: "van", operational_status: "in_service", odometer_miles: 42000 }).select("asset_id").single(), "van vehicle row");
    }
    const tipper = await ensureAsset("A11y unplated tipper E2E");
    if (!(await must<{ asset_id: string } | null>(t("fleet_vehicles").select("asset_id").eq("asset_id", tipper).maybeSingle(), "find tipper vehicle row"))) {
      await must(t("fleet_vehicles").insert({ asset_id: tipper, org_id: orgId, operational_status: "in_service" }).select("asset_id").single(), "tipper vehicle row");
    }

    // --- onboarding: dismiss an optional step so the "Skipped" dot renders
    // (merge, never clobber, the org's onboarding_state jsonb — idempotent).
    const orgRow = await must<{ onboarding_state: Record<string, unknown> | null }>(
      t("organizations").select("onboarding_state").eq("id", orgId).single(),
      "read onboarding_state",
    );
    const state = (orgRow.onboarding_state ?? {}) as Record<string, unknown> & { dismissed_steps?: string[] };
    await must(
      t("organizations")
        .update({ onboarding_state: { ...state, dismissed_steps: [...new Set([...(state.dismissed_steps ?? []), "logo"])] } })
        .eq("id", orgId).select("id").single(),
      "dismiss logo step",
    );

    // --- customer portal: superseded rev-2 published report ("Superseded" chip
    // + "rev 2" span) next to an issued rev-1 ("Latest" chip).
    const customer =
      (await must<{ id: string; portal_token: string } | null>(t("customers").select("id, portal_token").match({ org_id: orgId, name: "A11y portal customer E2E" }).maybeSingle(), "find portal customer")) ??
      (await must<{ id: string; portal_token: string }>(t("customers").insert({ org_id: orgId, name: "A11y portal customer E2E" }).select("id, portal_token").single(), "portal customer"));
    portalToken = String(customer.portal_token);
    for (const [title, num, status, revision, start, end] of [
      ["A11y portal superseded E2E", "SR-A11Y-P-E2E", "superseded", 2, "2026-01-01", "2026-01-31"],
      ["A11y portal issued E2E", "SR-A11Y-P-E2E-B", "issued", 1, "2026-02-01", "2026-02-28"],
    ] as const) {
      if (!(await find("site_reports", { title }, `portal report ${status}`))) {
        await must(
          t("site_reports")
            .insert({ org_id: orgId, customer_id: customer.id, title, period_start: start, period_end: end, status, revision, report_number: num, issued_at: new Date().toISOString(), portal_published_at: new Date().toISOString() })
            .select("id").single(),
          `portal report ${status}`,
        );
      }
    }
  });

  for (const [name, path] of [
    ["site reports register (superseded + archived chips)", "/site-reports"],
    ["site report detail (superseded)", "DETAIL_SR"],
    ["asset templates register (superseded + archived faces)", "/assets/templates"],
    ["asset template detail (superseded + archived versions)", "DETAIL_TPL"],
    ["asset detail (chips + paused schedules + cancelled case)", "DETAIL_ASSET"],
    ["asset holdings (due-back chips + since text)", "/assets/holdings"],
    ["job hub (withdrawn RAMS, closed permit, withdrawn talk)", "JOB_HUB"],
    ["toolbox register (withdrawn talk chip)", "/toolbox"],
    ["purchase orders register (cancelled chip)", "/purchase-orders"],
    ["purchase order detail (cancelled)", "DETAIL_PO"],
    ["fleet vehicles table (Next due + unplated row)", "/fleet/vehicles"],
    ["onboarding setup (skipped step dot)", "/onboarding/setup"],
    ["job blueprints register", "BLUEPRINTS"],
    ["customer portal reports (superseded + rev span)", "PORTAL"],
  ] as const) {
    test(`${name} has no WCAG 2.2 A/AA violations`, async ({ page }) => {
      const url =
        path === "DETAIL_SR" ? `/site-reports/${srId}`
        : path === "DETAIL_TPL" ? `/assets/templates/${tplId}`
        : path === "DETAIL_ASSET" ? `/assets/${assetId}`
        : path === "DETAIL_PO" ? `/purchase-orders/${poId}`
        : path === "JOB_HUB" ? `/jobs/${JOB}`
        : path === "BLUEPRINTS" ? `/jobs/${JOB}/blueprints`
        : path === "PORTAL" ? `/customer-portal/${portalToken}/reports`
        : path;
      await page.goto(url);
      await settleForAxe(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, JSON.stringify(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
    });
  }
});
