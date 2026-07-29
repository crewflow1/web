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
 * Seeds are service-role and GET-only navigation; write paths are proven in
 * the per-domain suites. permits_to_work and toolbox_talks refuse non-draft
 * INSERTs (lifecycle triggers), so those seed draft-then-transition.
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

  const stamp = Date.now();
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

    // --- site reports: superseded (rev 2, so the "rev" span renders) + archived.
    srId = (
      await must<{ id: string }>(
        t("site_reports")
          .insert({ org_id: orgId, title: `A11y superseded report ${stamp}`, period_start: "2026-01-01", period_end: "2026-01-31", status: "superseded", revision: 2, report_number: `SR-E2E-${stamp}`, issued_at: new Date().toISOString() })
          .select("id").single(),
        "superseded site report",
      )
    ).id;
    await must(
      t("site_reports").insert({ org_id: orgId, title: `A11y archived report ${stamp}`, period_start: "2026-02-01", period_end: "2026-02-28", status: "archived", revision: 1, report_number: `SR-E2E-${stamp}-B`, issued_at: new Date().toISOString() }).select("id").single(),
      "archived site report",
    );

    // --- asset templates: family A carries superseded v1 + archived v2 (both
    // chips in the [id] version list); family B's single superseded version
    // guarantees a superseded face on the register (one face per family).
    const famA = crypto.randomUUID();
    const famB = crypto.randomUUID();
    tplId = (
      await must<{ id: string }>(
        t("asset_inspection_templates").insert({ org_id: orgId, family_id: famA, version: 1, name: `A11y superseded checklist ${stamp}`, status: "superseded" }).select("id").single(),
        "template famA v1",
      )
    ).id;
    await must(t("asset_inspection_templates").insert({ org_id: orgId, family_id: famA, version: 2, name: `A11y superseded checklist ${stamp}`, status: "archived" }).select("id").single(), "template famA v2");
    await must(t("asset_inspection_templates").insert({ org_id: orgId, family_id: famB, version: 1, name: `A11y superseded face ${stamp}`, status: "superseded" }).select("id").single(), "template famB v1");

    // --- asset detail: superseded inspection + paused inspection/service
    // schedules + cancelled maintenance case, all on one asset.
    assetId = (
      await must<{ id: string }>(t("assets").insert({ org_id: orgId, name: `A11y contrast asset ${stamp}`, status: "active" }).select("id").single(), "asset")
    ).id;
    await must(t("asset_inspections").insert({ org_id: orgId, asset_id: assetId, title: `A11y superseded inspection ${stamp}`, status: "superseded" }).select("id").single(), "superseded inspection");
    await must(
      t("asset_inspection_schedules").insert({ org_id: orgId, asset_id: assetId, template_id: tplId, next_due: "2026-08-01", active: false }).select("id").single(),
      "paused inspection schedule",
    );
    await must(
      t("asset_service_schedules").insert({ org_id: orgId, asset_id: assetId, maintenance_type: "service", next_due: "2026-08-01", active: false }).select("id").single(),
      "paused service schedule",
    );
    await must(
      t("asset_maintenance_cases").insert({ org_id: orgId, asset_id: assetId, case_type: "breakdown", title: `A11y cancelled case ${stamp}`, status: "cancelled", cancellation_reason: "seeded for contrast scan", cancelled_at: new Date().toISOString() }).select("id").single(),
      "cancelled maintenance case",
    );

    // --- holdings: one open assignment per asset (partial unique index), one
    // overdue (red chip) and one due in the future (slate chip + "since" text).
    const held1 = (await must<{ id: string }>(t("assets").insert({ org_id: orgId, name: `A11y held asset overdue ${stamp}`, status: "active" }).select("id").single(), "held asset 1")).id;
    const held2 = (await must<{ id: string }>(t("assets").insert({ org_id: orgId, name: `A11y held asset due ${stamp}`, status: "active" }).select("id").single(), "held asset 2")).id;
    await must(t("asset_assignments").insert({ org_id: orgId, asset_id: held1, assignment_type: "stored_at_depot", location: "Yard 1", expected_return_at: "2020-01-01" }).select("id").single(), "overdue assignment");
    await must(t("asset_assignments").insert({ org_id: orgId, asset_id: held2, assignment_type: "stored_at_depot", location: "Yard 2", expected_return_at: "2099-01-01" }).select("id").single(), "due-back assignment");

    // --- job safety section: withdrawn RAMS + closed permit + withdrawn
    // toolbox talk. All three tables refuse non-draft INSERTs (lifecycle
    // triggers), so each seeds draft-then-transition.
    const raId = (
      await must<{ id: string }>(
        t("risk_assessments").insert({ org_id: orgId, job_id: JOB, title: `A11y withdrawn RAMS ${stamp}`, activity: "Roofing" }).select("id").single(),
        "draft RAMS",
      )
    ).id;
    await must(
      t("risk_assessments").update({ status: "issued", reference: `RA-E2E-W-${stamp}`, issued_at: new Date().toISOString() }).eq("id", raId).select("status").single(),
      "RAMS issue",
    );
    await must(t("risk_assessments").update({ status: "withdrawn" }).eq("id", raId).select("status").single(), "RAMS withdraw");
    const permitId = (
      await must<{ id: string }>(
        t("permits_to_work").insert({ org_id: orgId, job_id: JOB, permit_type: "hot_works", title: `A11y closed permit ${stamp}`, scope: "Welding" }).select("id").single(),
        "draft permit",
      )
    ).id;
    await must(
      t("permits_to_work")
        .update({ status: "issued", reference: `PTW-E2E-C-${stamp}`, issued_at: new Date().toISOString(), valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString() })
        .eq("id", permitId).select("status").single(),
      "permit issue",
    );
    await must(t("permits_to_work").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", permitId).select("status").single(), "permit close");

    const talkId = (
      await must<{ id: string }>(
        t("toolbox_talks").insert({ org_id: orgId, job_id: JOB, topic: `A11y withdrawn talk ${stamp}`, key_points: "Superseded briefing content" }).select("id").single(),
        "draft talk",
      )
    ).id;
    const talkRef = `TBT-E2E-W-${stamp}`;
    await must(
      t("toolbox_talks")
        .update({
          status: "issued", reference: talkRef, issued_at: new Date().toISOString(),
          snapshot: {
            talk_reference: talkRef, revision: 1, talk_date: new Date().toISOString().slice(0, 10),
            location: "Plot 4", site_label: "1 High St", delivered_by: "Site Manager",
            topic: `A11y withdrawn talk ${stamp}`, key_points: "Superseded briefing content",
            ppe: ["Hard hat"], rams_reference: null, rams_revision: null,
            permit_reference: null, permit_status_at_issue: null, external_attendees: [],
            issued_by_name: "Site Manager", issued_on: new Date().toISOString().slice(0, 10),
          },
        })
        .eq("id", talkId).select("status").single(),
      "talk issue",
    );
    await must(t("toolbox_talks").update({ status: "withdrawn" }).eq("id", talkId).select("status").single(), "talk withdraw");

    // --- purchase orders: cancelled (line-through chip on the register, plain
    // chip on the detail — scan both).
    poId = (
      await must<{ id: string }>(
        t("purchase_orders").insert({ org_id: orgId, number: `PO-E2E-${stamp}`, status: "cancelled", subtotal: 100, vat_total: 20, expected_date: "2026-09-01" }).select("id").single(),
        "cancelled purchase order",
      )
    ).id;

    // --- fleet vehicles: a plated van whose "Next due" column renders the
    // fixed "All current" text, and an unplated one for the italic
    // "No registration" cell.
    const van = (await must<{ id: string }>(t("assets").insert({ org_id: orgId, name: `A11y Transit ${stamp}`, registration: "AB12 CDE", status: "active" }).select("id").single(), "van asset")).id;
    await must(t("fleet_vehicles").insert({ asset_id: van, org_id: orgId, vehicle_class: "van", operational_status: "in_service", odometer_miles: 42000 }).select("asset_id").single(), "van vehicle row");
    const tipper = (await must<{ id: string }>(t("assets").insert({ org_id: orgId, name: `A11y unplated tipper ${stamp}`, status: "active" }).select("id").single(), "tipper asset")).id;
    await must(t("fleet_vehicles").insert({ asset_id: tipper, org_id: orgId, operational_status: "in_service" }).select("asset_id").single(), "tipper vehicle row");

    // --- onboarding: dismiss an optional step so the "Skipped" dot renders
    // (merge, never clobber, the org's onboarding_state jsonb).
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
    const customer = await must<{ id: string; portal_token: string }>(
      t("customers").insert({ org_id: orgId, name: `A11y portal customer ${stamp}` }).select("id, portal_token").single(),
      "portal customer",
    );
    portalToken = String(customer.portal_token);
    await must(
      t("site_reports")
        .insert({ org_id: orgId, customer_id: customer.id, title: `A11y portal report ${stamp}`, period_start: "2026-01-01", period_end: "2026-01-31", status: "superseded", revision: 2, report_number: `SR-P-${stamp}`, issued_at: new Date().toISOString(), portal_published_at: new Date().toISOString() })
        .select("id").single(),
      "portal superseded report",
    );
    await must(
      t("site_reports")
        .insert({ org_id: orgId, customer_id: customer.id, title: `A11y portal report ${stamp}`, period_start: "2026-02-01", period_end: "2026-02-28", status: "issued", revision: 1, report_number: `SR-P-${stamp}-B`, issued_at: new Date().toISOString(), portal_published_at: new Date().toISOString() })
        .select("id").single(),
      "portal issued report",
    );
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
