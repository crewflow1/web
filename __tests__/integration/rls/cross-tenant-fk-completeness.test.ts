import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * SYSTEMIC cross-tenant FK completeness guard (real Postgres).
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Cross-tenant reference integrity was applied table-by-table: invoices (#349),
 * invoice_payments (#351), jobs + leads (20261112000000), and finally quotes
 * (20261113000000). Each closed a BARE single-column FK — child.<ref> ->
 * parent(id) — by swapping it for a COMPOSITE FK — (child.<ref>, org_id) ->
 * parent(id, org_id) — so "the referenced row lives in the same org" becomes a
 * database invariant no writer (service-role included) can bypass.
 *
 * The failure mode of a table-by-table programme is a SILENT MISS: quotes was
 * the exact sibling of jobs/leads — same defect, WORSE blast radius (it renders
 * a foreign customer's name+email on the PUBLIC /q/[token] route) — and it was
 * left bare because nothing enforced completeness. This test is that missing
 * systemic check.
 *
 * WHAT IT DOES
 * ------------
 * Introspects the live schema for EVERY bare (single-column) FK where BOTH the
 * child and the parent carry an org_id — i.e. every FK that COULD point at
 * another tenant's row — and asserts each one is either:
 *   (a) already composite (in which case it does not appear in the query at
 *       all — quotes/jobs/leads customer/property/lead/job FKs have dropped out),
 *       or
 *   (b) present in the explicit ALLOWLIST below, with an honest reason.
 *
 * A NEW bare cross-tenant FK therefore FAILS CI until the author either makes it
 * composite or adds it to the allowlist with a justification — turning "did we
 * remember this table?" from tribal memory into a gate. The allowlist doubles as
 * the enumerated P2 cross-tenant hardening backlog.
 *
 * The allowlist was seeded from the live schema AFTER applying 20261113000000,
 * so it is the accurate current remaining set. Categories:
 *   - SELF_REFERENTIAL: child == parent (…_supersedes_id, …_regenerated_from,
 *     transferred_from_id, reinspection_of). Same-table, so same-org by
 *     construction — a row and its predecessor share org_id trivially.
 *   - INTERNAL_RLS: reached only via internal, authenticated, RLS-scoped paths,
 *     NOT via a public/service-role parent-embed the way quotes was. Real P2
 *     cross-tenant hardening backlog, but not a live PII-leak primitive.
 */

// child == parent — same-table lineage links, same-org by construction.
const SELF_REFERENTIAL: readonly string[] = [
  "asset_assignments_transferred_from_id_fkey",
  "asset_inspection_templates_supersedes_id_fkey",
  "asset_inspections_reinspection_of_fkey",
  "asset_inspections_supersedes_id_fkey",
  "asset_qr_identities_regenerated_from_fkey",
  "cis_monthly_returns_supersedes_id_fkey",
  "cis_statements_supersedes_id_fkey",
  "completion_certificates_supersedes_id_fkey",
  "risk_assessments_supersedes_id_fkey",
  "site_reports_supersedes_id_fkey",
  "toolbox_talks_supersedes_id_fkey",
];

// Internal, authenticated, RLS-scoped paths — the P2 hardening backlog. NOT
// reachable via a public/service-role parent-embed (the quotes /q/[token] class).
const INTERNAL_RLS: readonly string[] = [
  "ai_cost_reservations_invocation_id_fkey",
  "ai_quote_drafts_lead_id_fkey",
  "ai_quote_drafts_quote_id_fkey",
  "asset_assignments_asset_id_fkey",
  "asset_assignments_job_id_fkey",
  "asset_assignments_site_id_fkey",
  "asset_assignments_vehicle_asset_id_fkey",
  "asset_fuel_logs_supplier_id_fkey",
  "asset_inspection_overrides_asset_id_fkey",
  "asset_inspection_overrides_inspection_id_fkey",
  "asset_inspection_schedules_asset_id_fkey",
  "asset_inspection_schedules_template_id_fkey",
  "asset_inspections_asset_id_fkey",
  "asset_inspections_schedule_id_fkey",
  "asset_inspections_template_id_fkey",
  "asset_maintenance_case_costs_case_id_fkey",
  "asset_maintenance_cases_asset_id_fkey",
  "asset_maintenance_cases_schedule_id_fkey",
  "asset_maintenance_cases_source_assignment_id_fkey",
  "asset_maintenance_cases_source_inspection_id_fkey",
  "asset_maintenance_cases_supplier_id_fkey",
  "asset_qr_identities_asset_id_fkey",
  "asset_service_schedules_asset_id_fkey",
  "asset_service_schedules_supplier_id_fkey",
  "assets_supplier_id_fkey",
  "bank_statement_lines_bank_statement_id_fkey",
  "bank_statement_lines_matched_invoice_id_fkey",
  "bank_statement_lines_matched_payment_id_fkey",
  "blueprint_versions_blueprint_id_fkey",
  "blueprints_job_id_fkey",
  "calls_conversation_id_fkey",
  "calls_lead_id_fkey",
  "cis_monthly_return_lines_return_id_fkey",
  "cis_statement_payments_statement_id_fkey",
  "completion_certificates_customer_id_fkey",
  "completion_certificates_job_id_fkey",
  "conversations_customer_id_fkey",
  "conversations_lead_id_fkey",
  "expense_drafts_finance_id_fkey",
  "expense_drafts_supplier_id_fkey",
  "finances_job_id_fkey",
  "finances_purchase_order_id_fkey",
  "finances_supplier_id_fkey",
  "fleet_vehicles_finance_provider_id_fkey",
  "fleet_vehicles_home_site_id_fkey",
  "import_audit_import_id_fkey",
  "import_audit_import_row_id_fkey",
  "import_files_import_id_fkey",
  "import_rows_file_id_fkey",
  "import_rows_import_id_fkey",
  "inbound_enquiries_conversation_id_fkey",
  "inbound_enquiries_lead_id_fkey",
  "inspection_test_plans_job_id_fkey",
  "invoice_payments_bank_line_fkey",
  "invoice_payments_invoice_id_fkey",
  "invoice_reminders_invoice_id_fkey",
  "invoices_job_id_fkey",
  "invoices_quote_id_fkey",
  "job_billing_plans_job_id_fkey",
  "job_billing_stages_job_id_fkey",
  "job_document_versions_document_id_fkey",
  "job_documents_job_id_fkey",
  "lead_followup_state_lead_id_fkey",
  "leads_property_id_fkey",
  "material_requests_job_id_fkey",
  "messages_conversation_id_fkey",
  "missed_call_textbacks_call_id_fkey",
  "notification_email_queue_notification_id_fkey",
  "payments_customer_id_fkey",
  "payroll_lines_payroll_run_id_fkey",
  "permits_to_work_job_id_fkey",
  "permits_to_work_risk_assessment_id_fkey",
  "portal_uploads_customer_id_fkey",
  "properties_customer_id_fkey",
  "purchase_order_line_items_purchase_order_id_fkey",
  "purchase_orders_job_id_fkey",
  "purchase_orders_supplier_id_fkey",
  "quote_line_items_quote_id_fkey",
  "receptionist_messages_conversation_id_fkey",
  "receptionist_messages_enquiry_id_fkey",
  "retention_releases_job_id_fkey",
  "review_requests_customer_id_fkey",
  "review_requests_job_id_fkey",
  "risk_assessments_job_id_fkey",
  "rota_entries_job_id_fkey",
  "site_diary_entries_job_id_fkey",
  "site_reports_customer_id_fkey",
  "site_reports_job_id_fkey",
  "sites_vehicle_asset_id_fkey",
  "snags_job_id_fkey",
  "stock_items_preferred_supplier_id_fkey",
  "stock_movements_job_id_fkey",
  "support_messages_ticket_id_fkey",
  "support_tickets_customer_id_fkey",
  "time_entries_job_id_fkey",
  "time_entries_payroll_line_id_fkey",
  "toolbox_talks_job_id_fkey",
  "toolbox_talks_permit_to_work_id_fkey",
  "toolbox_talks_risk_assessment_id_fkey",
  "weather_watches_job_id_fkey",
  "weather_watches_site_id_fkey",
];

const SELF_REASON =
  "self-referential, same-table same-org by construction";
const INTERNAL_REASON =
  "internal authenticated RLS-protected path, not reachable via public/service-role parent-embed — P2 cross-tenant hardening backlog";

const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>([
  ...SELF_REFERENTIAL.map((c) => [c, SELF_REASON] as const),
  ...INTERNAL_RLS.map((c) => [c, INTERNAL_REASON] as const),
]);

// Bare FK names that MUST have dropped out (now composite). If any of these
// reappears in the query output, the composite-FK migration did not take.
const MUST_BE_COMPOSITE: readonly string[] = [
  "quotes_customer_id_fkey",
  "quotes_property_id_fkey",
  "quotes_lead_id_fkey",
  "quotes_job_id_fkey",
  "jobs_customer_id_fkey",
  "leads_customer_id_fkey",
];

type Row = { child: string; parent: string; conname: string };

/**
 * supabase-js cannot run arbitrary SQL, so the introspection query lives in the
 * catalog-only SECURITY-INVOKER function public._introspect_bare_cross_tenant_fks()
 * (migration 20261113000000), granted to service_role. It returns exactly the
 * query the guard is specified around: every bare single-column FK where both
 * child and parent carry org_id.
 */
async function bareCrossTenantFks(): Promise<Row[]> {
  const svc = serviceClient() as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const res = await svc.rpc("_introspect_bare_cross_tenant_fks", {});
  if (res.error) {
    throw new Error(
      `introspection RPC failed: ${res.error.message}. ` +
        "This test needs public._introspect_bare_cross_tenant_fks() (migration 20261113000000).",
    );
  }
  return (res.data as Row[]) ?? [];
}

describeIntegration("cross-tenant FK completeness · systemic guard", () => {
  it("every bare cross-tenant FK is either composite (absent) or explicitly allowlisted", async () => {
    const rows = await bareCrossTenantFks();
    expect(rows.length, "introspection returned no rows — query or RPC is wrong").toBeGreaterThan(0);

    const unexplained = rows
      .map((r) => r.conname)
      .filter((name) => !ALLOWLIST.has(name));

    expect(
      unexplained,
      `NEW bare cross-tenant FK(s) with no composite key and no allowlist entry:\n` +
        `${unexplained.join("\n")}\n\n` +
        `Fix: make it a COMPOSITE FK (col, org_id) -> parent(id, org_id) — the ` +
        `quotes/jobs/leads pattern — OR add it to the ALLOWLIST in this file with ` +
        `an honest reason (self-referential, or the internal-RLS backlog category).`,
    ).toEqual([]);
  });

  it("the composite-FK migrations took — the fixed bare FKs are gone", async () => {
    const rows = await bareCrossTenantFks();
    const present = new Set(rows.map((r) => r.conname));
    for (const bare of MUST_BE_COMPOSITE) {
      expect(
        present.has(bare),
        `${bare} is still a bare single-column FK — its composite migration did not apply`,
      ).toBe(false);
    }
  });

  it("the allowlist has no stale entries (every allowlisted FK still exists and is still bare)", async () => {
    const rows = await bareCrossTenantFks();
    const present = new Set(rows.map((r) => r.conname));
    const stale = [...ALLOWLIST.keys()].filter((name) => !present.has(name));
    expect(
      stale,
      `Allowlisted FK(s) no longer present as bare cross-tenant FKs — remove them ` +
        `from the allowlist (they were made composite or dropped):\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
