-- ROLLBACK of migrations 20261340000000 … 20261346000000 (D-17 least-privilege).
-- GENERATED from an exact catalogue diff (schema at 20261327 vs schema at 20261346) and TESTED:
-- running it on a database at 20261346 returns every policy, trigger, function, table grant and column grant in schema public to
-- exactly the 20261327 state (only five documentation COMMENTs on columns differ; see ROLLBACK.md). It changes NO data — policies, triggers, functions and
-- grants only — so it is safe to run with customers online.
--
-- ORDER: run THIS FIRST, while the D-17 application is still serving (it runs on either schema).
-- Only afterwards, if needed, restore the pre-D-17 application — that build cannot run on the
-- migrated schema (it reads columns 20261341–43 remove from the Data API). See ROLLBACK.md.
-- It REOPENS the holes D-17 closed. After running, mark the seven versions reverted:
--   supabase migration repair --status reverted 20261346000000 20261345000000 20261344000000 \
--     20261343000000 20261342000000 20261341000000 20261340000000
\set ON_ERROR_STOP on
begin;

-- 1. triggers added by D-17
drop trigger if exists "held_org_write_guard" on public."accounting_connections";
drop trigger if exists "held_org_write_guard" on public."accounting_export_log";
drop trigger if exists "held_org_write_guard" on public."accounting_pushed_entities";
drop trigger if exists "held_org_write_guard" on public."activity_log";
drop trigger if exists "held_org_write_guard" on public."admin_alert_state";
drop trigger if exists "held_org_write_guard" on public."ai_budget_control_audit";
drop trigger if exists "held_org_write_guard" on public."ai_cost_reservations";
drop trigger if exists "held_org_write_guard" on public."ai_employee_budget_limits";
drop trigger if exists "held_org_write_guard" on public."ai_invocations";
drop trigger if exists "held_org_write_guard" on public."ai_org_budget_ceilings";
drop trigger if exists "held_org_write_guard" on public."ai_quote_drafts";
drop trigger if exists "held_org_write_guard" on public."ai_receptionist_setups";
drop trigger if exists "held_org_write_guard" on public."ai_reply_audits";
drop trigger if exists "held_org_write_guard" on public."ai_reply_delivery_receipts";
drop trigger if exists "held_org_write_guard" on public."ai_reply_send_claims";
drop trigger if exists "held_org_write_guard" on public."ai_reply_transports";
drop trigger if exists "held_org_write_guard" on public."api_keys";
drop trigger if exists "held_org_write_guard" on public."api_request_log";
drop trigger if exists "held_org_write_guard" on public."asset_assignments";
drop trigger if exists "held_org_write_guard" on public."asset_calibration_certificates";
drop trigger if exists "held_org_write_guard" on public."asset_depreciation_settings";
drop trigger if exists "held_org_write_guard" on public."asset_fuel_logs";
drop trigger if exists "held_org_write_guard" on public."asset_inspection_overrides";
drop trigger if exists "held_org_write_guard" on public."asset_inspection_schedules";
drop trigger if exists "held_org_write_guard" on public."asset_inspection_templates";
drop trigger if exists "held_org_write_guard" on public."asset_inspections";
drop trigger if exists "held_org_write_guard" on public."asset_maintenance_case_costs";
drop trigger if exists "held_org_write_guard" on public."asset_maintenance_cases";
drop trigger if exists "held_org_write_guard" on public."asset_qr_identities";
drop trigger if exists "held_org_write_guard" on public."asset_service_schedules";
drop trigger if exists "held_org_write_guard" on public."assets";
drop trigger if exists "held_org_write_guard" on public."automation_approvals";
drop trigger if exists "held_org_write_guard" on public."automation_custom_rules";
drop trigger if exists "held_org_write_guard" on public."automation_rules";
drop trigger if exists "held_org_write_guard" on public."automation_runs";
drop trigger if exists "held_org_write_guard" on public."automation_schedules";
drop trigger if exists "held_org_write_guard" on public."automation_workflow_versions";
drop trigger if exists "held_org_write_guard" on public."bank_connections";
drop trigger if exists "held_org_write_guard" on public."bank_statement_lines";
drop trigger if exists "held_org_write_guard" on public."bank_statements";
drop trigger if exists "held_org_write_guard" on public."blueprint_markup";
drop trigger if exists "held_org_write_guard" on public."blueprint_pin_comments";
drop trigger if exists "held_org_write_guard" on public."blueprint_pins";
drop trigger if exists "held_org_write_guard" on public."blueprint_versions";
drop trigger if exists "client_audit_columns_guard" on public."blueprints";
drop trigger if exists "held_org_write_guard" on public."blueprints";
drop trigger if exists "held_org_write_guard" on public."briefing_dismissals";
drop trigger if exists "held_org_write_guard" on public."calendar_connections";
drop trigger if exists "held_org_write_guard" on public."calendar_event_links";
drop trigger if exists "held_org_write_guard" on public."calendar_pulled_events";
drop trigger if exists "held_org_write_guard" on public."calendar_watch_channels";
drop trigger if exists "held_org_write_guard" on public."call_events";
drop trigger if exists "held_org_write_guard" on public."calls";
drop trigger if exists "held_org_write_guard" on public."cis_bill_details";
drop trigger if exists "held_org_write_guard" on public."cis_contractor_profiles";
drop trigger if exists "held_org_write_guard" on public."cis_monthly_return_lines";
drop trigger if exists "held_org_write_guard" on public."cis_monthly_returns";
drop trigger if exists "held_org_write_guard" on public."cis_payment_snapshots";
drop trigger if exists "held_org_write_guard" on public."cis_statement_payments";
drop trigger if exists "held_org_write_guard" on public."cis_statements";
drop trigger if exists "held_org_write_guard" on public."cis_subcontractors";
drop trigger if exists "held_org_write_guard" on public."comm_events";
drop trigger if exists "held_org_write_guard" on public."completion_certificates";
drop trigger if exists "held_org_write_guard" on public."compliance_documents";
drop trigger if exists "held_org_write_guard" on public."conversations";
drop trigger if exists "held_org_write_guard" on public."customer_contacts";
drop trigger if exists "held_org_write_guard" on public."customer_portal_preferences";
drop trigger if exists "held_org_write_guard" on public."customers";
drop trigger if exists "client_audit_columns_guard" on public."delay_events";
drop trigger if exists "held_org_write_guard" on public."delay_events";
drop trigger if exists "held_org_write_guard" on public."email_inbound_routes";
drop trigger if exists "held_org_write_guard" on public."email_webhook_events";
drop trigger if exists "held_org_write_guard" on public."expense_budgets";
drop trigger if exists "held_org_write_guard" on public."expense_drafts";
drop trigger if exists "held_org_write_guard" on public."finances";
drop trigger if exists "held_org_write_guard" on public."fleet_vehicles";
drop trigger if exists "held_org_write_guard" on public."form_import_drafts";
drop trigger if exists "held_org_write_guard" on public."goods_received_lines";
drop trigger if exists "held_org_write_guard" on public."goods_received_notes";
drop trigger if exists "held_org_write_guard" on public."health_score_events";
drop trigger if exists "held_org_write_guard" on public."hmrc_connections";
drop trigger if exists "held_org_write_guard" on public."hmrc_submissions";
drop trigger if exists "held_org_write_guard" on public."holiday_entitlements";
drop trigger if exists "held_org_write_guard" on public."import_audit";
drop trigger if exists "held_org_write_guard" on public."import_files";
drop trigger if exists "held_org_write_guard" on public."import_rows";
drop trigger if exists "held_org_write_guard" on public."imports";
drop trigger if exists "held_org_write_guard" on public."inbound_enquiries";
drop trigger if exists "held_org_write_guard" on public."inspection_plan_items";
drop trigger if exists "client_audit_columns_guard" on public."inspection_plan_template_items";
drop trigger if exists "held_org_write_guard" on public."inspection_plan_template_items";
drop trigger if exists "client_audit_columns_guard" on public."inspection_plan_templates";
drop trigger if exists "held_org_write_guard" on public."inspection_plan_templates";
drop trigger if exists "held_org_write_guard" on public."inspection_signoffs";
drop trigger if exists "held_org_write_guard" on public."inspection_test_plans";
drop trigger if exists "held_org_write_guard" on public."inspection_witness_invitations";
drop trigger if exists "held_org_write_guard" on public."internal_notes";
drop trigger if exists "held_org_write_guard" on public."invoice_line_items";
drop trigger if exists "held_org_write_guard" on public."invoice_payment_intents";
drop trigger if exists "held_org_write_guard" on public."invoice_payments";
drop trigger if exists "held_org_write_guard" on public."invoice_reminders";
drop trigger if exists "held_org_write_guard" on public."invoices";
drop trigger if exists "held_org_write_guard" on public."job_assignments";
drop trigger if exists "held_org_write_guard" on public."job_billing_plans";
drop trigger if exists "held_org_write_guard" on public."job_billing_stages";
drop trigger if exists "held_org_write_guard" on public."job_budgets";
drop trigger if exists "client_audit_columns_guard" on public."job_checklists";
drop trigger if exists "held_org_write_guard" on public."job_checklists";
drop trigger if exists "held_org_write_guard" on public."job_document_versions";
drop trigger if exists "client_audit_columns_guard" on public."job_documents";
drop trigger if exists "held_org_write_guard" on public."job_documents";
drop trigger if exists "held_org_write_guard" on public."job_milestone_dependencies";
drop trigger if exists "held_org_write_guard" on public."job_milestones";
drop trigger if exists "held_org_write_guard" on public."job_programme_baselines";
drop trigger if exists "client_audit_columns_guard" on public."job_progress_observations";
drop trigger if exists "held_org_write_guard" on public."job_progress_observations";
drop trigger if exists "held_org_write_guard" on public."job_template_checklist_items";
drop trigger if exists "held_org_write_guard" on public."job_template_milestones";
drop trigger if exists "held_org_write_guard" on public."job_templates";
drop trigger if exists "held_org_write_guard" on public."job_valuation_variations";
drop trigger if exists "held_org_write_guard" on public."job_valuations";
drop trigger if exists "held_org_write_guard" on public."job_warranties";
drop trigger if exists "held_org_write_guard" on public."jobs";
drop trigger if exists "held_org_write_guard" on public."lead_followup_state";
drop trigger if exists "held_org_write_guard" on public."leads";
drop trigger if exists "held_org_write_guard" on public."leave_requests";
drop trigger if exists "held_org_write_guard" on public."maintenance_reminder_log";
drop trigger if exists "held_org_write_guard" on public."marketplace_entitlements";
drop trigger if exists "held_org_write_guard" on public."marketplace_installs";
drop trigger if exists "held_org_write_guard" on public."marketplace_partners";
drop trigger if exists "held_org_write_guard" on public."material_request_lines";
drop trigger if exists "held_org_write_guard" on public."material_requests";
drop trigger if exists "held_org_write_guard" on public."merchant_catalogue_items";
drop trigger if exists "held_org_write_guard" on public."merchant_connections";
drop trigger if exists "held_org_write_guard" on public."merchant_po_submissions";
drop trigger if exists "held_org_write_guard" on public."messages";
drop trigger if exists "held_org_write_guard" on public."missed_call_textbacks";
drop trigger if exists "held_org_write_guard" on public."ncr_corrective_actions";
drop trigger if exists "held_org_write_guard" on public."non_conformance_reports";
drop trigger if exists "held_org_write_guard" on public."notification_digest_cursors";
drop trigger if exists "held_org_write_guard" on public."notification_email_queue";
drop trigger if exists "held_org_write_guard" on public."notification_preferences";
drop trigger if exists "held_org_write_guard" on public."notifications";
drop trigger if exists "held_org_write_guard" on public."org_payment_connections";
drop trigger if exists "held_org_write_guard" on public."org_scim_config";
drop trigger if exists "held_org_write_guard" on public."org_settings";
drop trigger if exists "held_org_write_guard" on public."org_sso_config";
drop trigger if exists "held_org_write_guard" on public."payments";
drop trigger if exists "held_org_write_guard" on public."payroll_line_adjustments";
drop trigger if exists "held_org_write_guard" on public."payroll_lines";
drop trigger if exists "held_org_write_guard" on public."payroll_runs";
drop trigger if exists "held_org_write_guard" on public."payroll_tax_profiles";
drop trigger if exists "held_org_write_guard" on public."pension_enrolments";
drop trigger if exists "held_org_write_guard" on public."permission_audit";
drop trigger if exists "client_audit_columns_guard" on public."permit_conditions";
drop trigger if exists "held_org_write_guard" on public."permit_conditions";
drop trigger if exists "held_org_write_guard" on public."permits_to_work";
drop trigger if exists "held_org_write_guard" on public."phone_numbers";
drop trigger if exists "held_org_write_guard" on public."portal_uploads";
drop trigger if exists "held_org_write_guard" on public."price_book_items";
drop trigger if exists "held_org_write_guard" on public."properties";
drop trigger if exists "held_org_write_guard" on public."purchase_order_line_items";
drop trigger if exists "held_org_write_guard" on public."purchase_orders";
drop trigger if exists "held_org_write_guard" on public."push_deliveries";
drop trigger if exists "held_org_write_guard" on public."push_subscriptions";
drop trigger if exists "held_org_write_guard" on public."quote_line_items";
drop trigger if exists "held_org_write_guard" on public."quote_template_lines";
drop trigger if exists "held_org_write_guard" on public."quote_templates";
drop trigger if exists "held_org_write_guard" on public."quote_versions";
drop trigger if exists "held_org_write_guard" on public."quotes";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_actions";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_authorisations";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_claim_reassignments";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_claim_releases";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_claims";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_coordinations";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_executions";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_fulfilments";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_lifecycles";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_orchestrations";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_outcomes";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_recoveries";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_resolutions";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversation_verifications";
drop trigger if exists "held_org_write_guard" on public."receptionist_conversations";
drop trigger if exists "held_org_write_guard" on public."receptionist_messages";
drop trigger if exists "held_org_write_guard" on public."receptionist_review_resolutions";
drop trigger if exists "held_org_write_guard" on public."report_subscriptions";
drop trigger if exists "held_org_write_guard" on public."retention_policies";
drop trigger if exists "held_org_write_guard" on public."retention_purge_log";
drop trigger if exists "held_org_write_guard" on public."retention_releases";
drop trigger if exists "held_org_write_guard" on public."review_requests";
drop trigger if exists "held_org_write_guard" on public."risk_assessment_hazards";
drop trigger if exists "held_org_write_guard" on public."risk_assessments";
drop trigger if exists "held_org_write_guard" on public."rota_entries";
drop trigger if exists "held_org_write_guard" on public."safety_acknowledgements";
drop trigger if exists "held_org_write_guard" on public."service_booking_slots";
drop trigger if exists "held_org_write_guard" on public."service_bookings";
drop trigger if exists "held_org_write_guard" on public."service_catalog";
drop trigger if exists "held_org_write_guard" on public."signatures";
drop trigger if exists "held_org_write_guard" on public."site_diary_entries";
drop trigger if exists "held_org_write_guard" on public."site_inductions";
drop trigger if exists "held_org_write_guard" on public."site_reports";
drop trigger if exists "client_audit_columns_guard" on public."site_visitors";
drop trigger if exists "held_org_write_guard" on public."site_visitors";
drop trigger if exists "held_org_write_guard" on public."sites";
drop trigger if exists "held_org_write_guard" on public."sms_deliveries";
drop trigger if exists "held_org_write_guard" on public."snags";
drop trigger if exists "held_org_write_guard" on public."sso_consumed_assertions";
drop trigger if exists "held_org_write_guard" on public."sso_provisioning_audit";
drop trigger if exists "held_org_write_guard" on public."staff_qualifications";
drop trigger if exists "held_org_write_guard" on public."staff_secrets";
drop trigger if exists "held_org_write_guard" on public."stock_items";
drop trigger if exists "held_org_write_guard" on public."stock_movements";
drop trigger if exists "stock_movements_admin_writer" on public."stock_movements";
drop trigger if exists "held_org_write_guard" on public."stocktake_lines";
drop trigger if exists "held_org_write_guard" on public."stocktake_sessions";
drop trigger if exists "held_org_write_guard" on public."supplier_payment_allocations";
drop trigger if exists "held_org_write_guard" on public."supplier_payments";
drop trigger if exists "held_org_write_guard" on public."suppliers";
drop trigger if exists "held_org_write_guard" on public."support_messages";
drop trigger if exists "held_org_write_guard" on public."support_tickets";
drop trigger if exists "held_org_write_guard" on public."telematics_connections";
drop trigger if exists "held_org_write_guard" on public."telematics_readings";
drop trigger if exists "held_org_write_guard" on public."tenant_attachments";
drop trigger if exists "held_org_write_guard" on public."tenant_search_documents";
drop trigger if exists "held_org_write_guard" on public."time_entries";
drop trigger if exists "held_org_write_guard" on public."toolbox_talks";
drop trigger if exists "held_org_write_guard" on public."variation_requests";
drop trigger if exists "held_org_write_guard" on public."voice_notes";
drop trigger if exists "held_org_write_guard" on public."weather_watches";
drop trigger if exists "held_org_write_guard" on public."webhook_deliveries";
drop trigger if exists "held_org_write_guard" on public."webhook_endpoints";
drop trigger if exists "held_org_write_guard" on public."whatsapp_assistant_actions";
drop trigger if exists "held_org_write_guard" on public."whatsapp_inbound_media";
drop trigger if exists "held_org_write_guard" on public."whatsapp_number_routes";
drop trigger if exists "held_org_write_guard" on public."whatsapp_optouts";
drop trigger if exists "held_org_write_guard" on public."whatsapp_webhook_events";
drop trigger if exists "held_org_write_guard" on public."worker_acknowledgements";
drop trigger if exists "held_org_write_guard" on public."worker_signoff_tokens";

-- 2. policies added / changed by D-17
drop policy if exists "accounting_connections: held org read-only delete" on public."accounting_connections";
drop policy if exists "accounting_connections: held org read-only insert" on public."accounting_connections";
drop policy if exists "accounting_connections: held org read-only update" on public."accounting_connections";
drop policy if exists "accounting_export_log: held org read-only delete" on public."accounting_export_log";
drop policy if exists "accounting_export_log: held org read-only insert" on public."accounting_export_log";
drop policy if exists "accounting_export_log: held org read-only update" on public."accounting_export_log";
drop policy if exists "accounting_pushed_entities: held org read-only delete" on public."accounting_pushed_entities";
drop policy if exists "accounting_pushed_entities: held org read-only insert" on public."accounting_pushed_entities";
drop policy if exists "accounting_pushed_entities: held org read-only update" on public."accounting_pushed_entities";
drop policy if exists "ai_budget_control_audit: held org read-only delete" on public."ai_budget_control_audit";
drop policy if exists "ai_budget_control_audit: held org read-only insert" on public."ai_budget_control_audit";
drop policy if exists "ai_budget_control_audit: held org read-only update" on public."ai_budget_control_audit";
drop policy if exists "ai_cost_reservations: held org read-only delete" on public."ai_cost_reservations";
drop policy if exists "ai_cost_reservations: held org read-only insert" on public."ai_cost_reservations";
drop policy if exists "ai_cost_reservations: held org read-only update" on public."ai_cost_reservations";
drop policy if exists "ai_employee_budget_limits: held org read-only delete" on public."ai_employee_budget_limits";
drop policy if exists "ai_employee_budget_limits: held org read-only insert" on public."ai_employee_budget_limits";
drop policy if exists "ai_employee_budget_limits: held org read-only update" on public."ai_employee_budget_limits";
drop policy if exists "ai_invocations: held org read-only delete" on public."ai_invocations";
drop policy if exists "ai_invocations: held org read-only insert" on public."ai_invocations";
drop policy if exists "ai_invocations: held org read-only update" on public."ai_invocations";
drop policy if exists "ai_org_budget_ceilings: held org read-only delete" on public."ai_org_budget_ceilings";
drop policy if exists "ai_org_budget_ceilings: held org read-only insert" on public."ai_org_budget_ceilings";
drop policy if exists "ai_org_budget_ceilings: held org read-only update" on public."ai_org_budget_ceilings";
drop policy if exists "ai_quote_drafts: held org read-only delete" on public."ai_quote_drafts";
drop policy if exists "ai_quote_drafts: held org read-only insert" on public."ai_quote_drafts";
drop policy if exists "ai_quote_drafts: held org read-only update" on public."ai_quote_drafts";
drop policy if exists "ai_receptionist_setups: held org read-only delete" on public."ai_receptionist_setups";
drop policy if exists "ai_receptionist_setups: held org read-only insert" on public."ai_receptionist_setups";
drop policy if exists "ai_receptionist_setups: held org read-only update" on public."ai_receptionist_setups";
drop policy if exists "api_keys: held org read-only delete" on public."api_keys";
drop policy if exists "api_keys: held org read-only insert" on public."api_keys";
drop policy if exists "api_keys: held org read-only update" on public."api_keys";
drop policy if exists "asset_assignments: admin or field insert" on public."asset_assignments";
drop policy if exists "asset_assignments: admin or field update" on public."asset_assignments";
drop policy if exists "asset_assignments: admin-only delete" on public."asset_assignments";
drop policy if exists "asset_assignments: assignee reads own" on public."asset_assignments";
drop policy if exists "asset_assignments: held org read-only delete" on public."asset_assignments";
drop policy if exists "asset_assignments: held org read-only insert" on public."asset_assignments";
drop policy if exists "asset_assignments: held org read-only update" on public."asset_assignments";
drop policy if exists "asset_calibration_certificates: admin-only delete" on public."asset_calibration_certificates";
drop policy if exists "asset_calibration_certificates: admin-only insert" on public."asset_calibration_certificates";
drop policy if exists "asset_calibration_certificates: admin-only update" on public."asset_calibration_certificates";
drop policy if exists "asset_calibration_certificates: held org read-only delete" on public."asset_calibration_certificates";
drop policy if exists "asset_calibration_certificates: held org read-only insert" on public."asset_calibration_certificates";
drop policy if exists "asset_calibration_certificates: held org read-only update" on public."asset_calibration_certificates";
drop policy if exists "asset_depreciation_settings: held org read-only delete" on public."asset_depreciation_settings";
drop policy if exists "asset_depreciation_settings: held org read-only insert" on public."asset_depreciation_settings";
drop policy if exists "asset_depreciation_settings: held org read-only update" on public."asset_depreciation_settings";
drop policy if exists "asset_fuel_logs: admin or field insert" on public."asset_fuel_logs";
drop policy if exists "asset_fuel_logs: admin-only delete" on public."asset_fuel_logs";
drop policy if exists "asset_fuel_logs: admin-only update" on public."asset_fuel_logs";
drop policy if exists "asset_fuel_logs: held org read-only delete" on public."asset_fuel_logs";
drop policy if exists "asset_fuel_logs: held org read-only insert" on public."asset_fuel_logs";
drop policy if exists "asset_fuel_logs: held org read-only update" on public."asset_fuel_logs";
drop policy if exists "asset_inspection_overrides: held org read-only delete" on public."asset_inspection_overrides";
drop policy if exists "asset_inspection_overrides: held org read-only insert" on public."asset_inspection_overrides";
drop policy if exists "asset_inspection_overrides: held org read-only update" on public."asset_inspection_overrides";
drop policy if exists "asset_inspection_schedules: held org read-only delete" on public."asset_inspection_schedules";
drop policy if exists "asset_inspection_schedules: held org read-only insert" on public."asset_inspection_schedules";
drop policy if exists "asset_inspection_schedules: held org read-only update" on public."asset_inspection_schedules";
drop policy if exists "asset_inspection_templates: admin-only delete" on public."asset_inspection_templates";
drop policy if exists "asset_inspection_templates: admin-only insert" on public."asset_inspection_templates";
drop policy if exists "asset_inspection_templates: admin-only update" on public."asset_inspection_templates";
drop policy if exists "asset_inspection_templates: held org read-only delete" on public."asset_inspection_templates";
drop policy if exists "asset_inspection_templates: held org read-only insert" on public."asset_inspection_templates";
drop policy if exists "asset_inspection_templates: held org read-only update" on public."asset_inspection_templates";
drop policy if exists "asset_inspections: admin or field insert" on public."asset_inspections";
drop policy if exists "asset_inspections: admin or field update" on public."asset_inspections";
drop policy if exists "asset_inspections: admin-only delete" on public."asset_inspections";
drop policy if exists "asset_inspections: held org read-only delete" on public."asset_inspections";
drop policy if exists "asset_inspections: held org read-only insert" on public."asset_inspections";
drop policy if exists "asset_inspections: held org read-only update" on public."asset_inspections";
drop policy if exists "asset_maintenance_case_costs: held org read-only delete" on public."asset_maintenance_case_costs";
drop policy if exists "asset_maintenance_case_costs: held org read-only insert" on public."asset_maintenance_case_costs";
drop policy if exists "asset_maintenance_case_costs: held org read-only update" on public."asset_maintenance_case_costs";
drop policy if exists "asset_maintenance_cases: admin or field insert" on public."asset_maintenance_cases";
drop policy if exists "asset_maintenance_cases: admin-only delete" on public."asset_maintenance_cases";
drop policy if exists "asset_maintenance_cases: admin-only update" on public."asset_maintenance_cases";
drop policy if exists "asset_maintenance_cases: held org read-only delete" on public."asset_maintenance_cases";
drop policy if exists "asset_maintenance_cases: held org read-only insert" on public."asset_maintenance_cases";
drop policy if exists "asset_maintenance_cases: held org read-only update" on public."asset_maintenance_cases";
drop policy if exists "asset_qr_identities: admin-only delete" on public."asset_qr_identities";
drop policy if exists "asset_qr_identities: admin-only insert" on public."asset_qr_identities";
drop policy if exists "asset_qr_identities: admin-only update" on public."asset_qr_identities";
drop policy if exists "asset_qr_identities: held org read-only delete" on public."asset_qr_identities";
drop policy if exists "asset_qr_identities: held org read-only insert" on public."asset_qr_identities";
drop policy if exists "asset_qr_identities: held org read-only update" on public."asset_qr_identities";
drop policy if exists "asset_service_schedules: held org read-only delete" on public."asset_service_schedules";
drop policy if exists "asset_service_schedules: held org read-only insert" on public."asset_service_schedules";
drop policy if exists "asset_service_schedules: held org read-only update" on public."asset_service_schedules";
drop policy if exists "assets: admin-only delete" on public."assets";
drop policy if exists "assets: admin-only insert" on public."assets";
drop policy if exists "assets: admin-only update" on public."assets";
drop policy if exists "assets: held org read-only delete" on public."assets";
drop policy if exists "assets: held org read-only insert" on public."assets";
drop policy if exists "assets: held org read-only update" on public."assets";
drop policy if exists "automation_approvals: held org read-only delete" on public."automation_approvals";
drop policy if exists "automation_approvals: held org read-only insert" on public."automation_approvals";
drop policy if exists "automation_approvals: held org read-only update" on public."automation_approvals";
drop policy if exists "automation_custom_rules: held org read-only delete" on public."automation_custom_rules";
drop policy if exists "automation_custom_rules: held org read-only insert" on public."automation_custom_rules";
drop policy if exists "automation_custom_rules: held org read-only update" on public."automation_custom_rules";
drop policy if exists "automation_rules: held org read-only delete" on public."automation_rules";
drop policy if exists "automation_rules: held org read-only insert" on public."automation_rules";
drop policy if exists "automation_rules: held org read-only update" on public."automation_rules";
drop policy if exists "automation_schedules: held org read-only delete" on public."automation_schedules";
drop policy if exists "automation_schedules: held org read-only insert" on public."automation_schedules";
drop policy if exists "automation_schedules: held org read-only update" on public."automation_schedules";
drop policy if exists "automation_workflow_versions: held org read-only delete" on public."automation_workflow_versions";
drop policy if exists "automation_workflow_versions: held org read-only insert" on public."automation_workflow_versions";
drop policy if exists "automation_workflow_versions: held org read-only update" on public."automation_workflow_versions";
drop policy if exists "bank_connections: held org read-only delete" on public."bank_connections";
drop policy if exists "bank_connections: held org read-only insert" on public."bank_connections";
drop policy if exists "bank_connections: held org read-only update" on public."bank_connections";
drop policy if exists "bank_statement_lines: held org read-only delete" on public."bank_statement_lines";
drop policy if exists "bank_statement_lines: held org read-only insert" on public."bank_statement_lines";
drop policy if exists "bank_statement_lines: held org read-only update" on public."bank_statement_lines";
drop policy if exists "bank_statements: held org read-only delete" on public."bank_statements";
drop policy if exists "bank_statements: held org read-only insert" on public."bank_statements";
drop policy if exists "bank_statements: held org read-only update" on public."bank_statements";
drop policy if exists "blueprint_markup: held org read-only delete" on public."blueprint_markup";
drop policy if exists "blueprint_markup: held org read-only insert" on public."blueprint_markup";
drop policy if exists "blueprint_markup: held org read-only update" on public."blueprint_markup";
drop policy if exists "blueprint_pin_comments: held org read-only delete" on public."blueprint_pin_comments";
drop policy if exists "blueprint_pin_comments: held org read-only insert" on public."blueprint_pin_comments";
drop policy if exists "blueprint_pin_comments: held org read-only update" on public."blueprint_pin_comments";
drop policy if exists "blueprint_pins: held org read-only delete" on public."blueprint_pins";
drop policy if exists "blueprint_pins: held org read-only insert" on public."blueprint_pins";
drop policy if exists "blueprint_pins: held org read-only update" on public."blueprint_pins";
drop policy if exists "blueprint_versions: held org read-only delete" on public."blueprint_versions";
drop policy if exists "blueprint_versions: held org read-only insert" on public."blueprint_versions";
drop policy if exists "blueprint_versions: held org read-only update" on public."blueprint_versions";
drop policy if exists "blueprints: held org read-only delete" on public."blueprints";
drop policy if exists "blueprints: held org read-only insert" on public."blueprints";
drop policy if exists "blueprints: held org read-only update" on public."blueprints";
drop policy if exists "briefing_dismissals: held org read-only delete" on public."briefing_dismissals";
drop policy if exists "briefing_dismissals: held org read-only insert" on public."briefing_dismissals";
drop policy if exists "briefing_dismissals: held org read-only update" on public."briefing_dismissals";
drop policy if exists "calendar_connections: held org read-only delete" on public."calendar_connections";
drop policy if exists "calendar_connections: held org read-only insert" on public."calendar_connections";
drop policy if exists "calendar_connections: held org read-only update" on public."calendar_connections";
drop policy if exists "calendar_event_links: held org read-only delete" on public."calendar_event_links";
drop policy if exists "calendar_event_links: held org read-only insert" on public."calendar_event_links";
drop policy if exists "calendar_event_links: held org read-only update" on public."calendar_event_links";
drop policy if exists "calendar_pulled_events: held org read-only delete" on public."calendar_pulled_events";
drop policy if exists "calendar_pulled_events: held org read-only insert" on public."calendar_pulled_events";
drop policy if exists "calendar_pulled_events: held org read-only update" on public."calendar_pulled_events";
drop policy if exists "calendar_watch_channels: held org read-only delete" on public."calendar_watch_channels";
drop policy if exists "calendar_watch_channels: held org read-only insert" on public."calendar_watch_channels";
drop policy if exists "calendar_watch_channels: held org read-only update" on public."calendar_watch_channels";
drop policy if exists "call_events: held org read-only delete" on public."call_events";
drop policy if exists "call_events: held org read-only insert" on public."call_events";
drop policy if exists "call_events: held org read-only update" on public."call_events";
drop policy if exists "calls: held org read-only delete" on public."calls";
drop policy if exists "calls: held org read-only insert" on public."calls";
drop policy if exists "calls: held org read-only update" on public."calls";
drop policy if exists "cis_bill_details: held org read-only delete" on public."cis_bill_details";
drop policy if exists "cis_bill_details: held org read-only insert" on public."cis_bill_details";
drop policy if exists "cis_bill_details: held org read-only update" on public."cis_bill_details";
drop policy if exists "cis_contractor_profiles: held org read-only delete" on public."cis_contractor_profiles";
drop policy if exists "cis_contractor_profiles: held org read-only insert" on public."cis_contractor_profiles";
drop policy if exists "cis_contractor_profiles: held org read-only update" on public."cis_contractor_profiles";
drop policy if exists "cis_monthly_return_lines: held org read-only delete" on public."cis_monthly_return_lines";
drop policy if exists "cis_monthly_return_lines: held org read-only insert" on public."cis_monthly_return_lines";
drop policy if exists "cis_monthly_return_lines: held org read-only update" on public."cis_monthly_return_lines";
drop policy if exists "cis_monthly_returns: held org read-only delete" on public."cis_monthly_returns";
drop policy if exists "cis_monthly_returns: held org read-only insert" on public."cis_monthly_returns";
drop policy if exists "cis_monthly_returns: held org read-only update" on public."cis_monthly_returns";
drop policy if exists "cis_payment_snapshots: held org read-only delete" on public."cis_payment_snapshots";
drop policy if exists "cis_payment_snapshots: held org read-only insert" on public."cis_payment_snapshots";
drop policy if exists "cis_payment_snapshots: held org read-only update" on public."cis_payment_snapshots";
drop policy if exists "cis_statement_payments: held org read-only delete" on public."cis_statement_payments";
drop policy if exists "cis_statement_payments: held org read-only insert" on public."cis_statement_payments";
drop policy if exists "cis_statement_payments: held org read-only update" on public."cis_statement_payments";
drop policy if exists "cis_statements: held org read-only delete" on public."cis_statements";
drop policy if exists "cis_statements: held org read-only insert" on public."cis_statements";
drop policy if exists "cis_statements: held org read-only update" on public."cis_statements";
drop policy if exists "cis_subcontractors: held org read-only delete" on public."cis_subcontractors";
drop policy if exists "cis_subcontractors: held org read-only insert" on public."cis_subcontractors";
drop policy if exists "cis_subcontractors: held org read-only update" on public."cis_subcontractors";
drop policy if exists "comm_events: held org read-only delete" on public."comm_events";
drop policy if exists "comm_events: held org read-only insert" on public."comm_events";
drop policy if exists "comm_events: held org read-only update" on public."comm_events";
drop policy if exists "completion_certificates: held org read-only delete" on public."completion_certificates";
drop policy if exists "completion_certificates: held org read-only insert" on public."completion_certificates";
drop policy if exists "completion_certificates: held org read-only update" on public."completion_certificates";
drop policy if exists "compliance_documents: held org read-only delete" on public."compliance_documents";
drop policy if exists "compliance_documents: held org read-only insert" on public."compliance_documents";
drop policy if exists "compliance_documents: held org read-only update" on public."compliance_documents";
drop policy if exists "conversations: held org read-only delete" on public."conversations";
drop policy if exists "conversations: held org read-only insert" on public."conversations";
drop policy if exists "conversations: held org read-only update" on public."conversations";
drop policy if exists "customer_contacts: held org read-only delete" on public."customer_contacts";
drop policy if exists "customer_contacts: held org read-only insert" on public."customer_contacts";
drop policy if exists "customer_contacts: held org read-only update" on public."customer_contacts";
drop policy if exists "customer_portal_preferences: held org read-only delete" on public."customer_portal_preferences";
drop policy if exists "customer_portal_preferences: held org read-only insert" on public."customer_portal_preferences";
drop policy if exists "customer_portal_preferences: held org read-only update" on public."customer_portal_preferences";
drop policy if exists "customers: held org read-only delete" on public."customers";
drop policy if exists "customers: held org read-only insert" on public."customers";
drop policy if exists "customers: held org read-only update" on public."customers";
drop policy if exists "delay_events: held org read-only delete" on public."delay_events";
drop policy if exists "delay_events: held org read-only insert" on public."delay_events";
drop policy if exists "delay_events: held org read-only update" on public."delay_events";
drop policy if exists "email_inbound_routes: held org read-only delete" on public."email_inbound_routes";
drop policy if exists "email_inbound_routes: held org read-only insert" on public."email_inbound_routes";
drop policy if exists "email_inbound_routes: held org read-only update" on public."email_inbound_routes";
drop policy if exists "expense_budgets: held org read-only delete" on public."expense_budgets";
drop policy if exists "expense_budgets: held org read-only insert" on public."expense_budgets";
drop policy if exists "expense_budgets: held org read-only update" on public."expense_budgets";
drop policy if exists "expense_drafts: held org read-only delete" on public."expense_drafts";
drop policy if exists "expense_drafts: held org read-only insert" on public."expense_drafts";
drop policy if exists "expense_drafts: held org read-only update" on public."expense_drafts";
drop policy if exists "expense_drafts: no member approved insert" on public."expense_drafts";
drop policy if exists "finances: held org read-only delete" on public."finances";
drop policy if exists "finances: held org read-only insert" on public."finances";
drop policy if exists "finances: held org read-only update" on public."finances";
drop policy if exists "fleet_vehicles: admin-only delete" on public."fleet_vehicles";
drop policy if exists "fleet_vehicles: admin-only insert" on public."fleet_vehicles";
drop policy if exists "fleet_vehicles: admin-only update" on public."fleet_vehicles";
drop policy if exists "fleet_vehicles: held org read-only delete" on public."fleet_vehicles";
drop policy if exists "fleet_vehicles: held org read-only insert" on public."fleet_vehicles";
drop policy if exists "fleet_vehicles: held org read-only update" on public."fleet_vehicles";
drop policy if exists "form_import_drafts: held org read-only delete" on public."form_import_drafts";
drop policy if exists "form_import_drafts: held org read-only insert" on public."form_import_drafts";
drop policy if exists "form_import_drafts: held org read-only update" on public."form_import_drafts";
drop policy if exists "goods_received_lines: admin or field insert" on public."goods_received_lines";
drop policy if exists "goods_received_lines: admin-only delete" on public."goods_received_lines";
drop policy if exists "goods_received_lines: admin-only update" on public."goods_received_lines";
drop policy if exists "goods_received_lines: held org read-only delete" on public."goods_received_lines";
drop policy if exists "goods_received_lines: held org read-only insert" on public."goods_received_lines";
drop policy if exists "goods_received_lines: held org read-only update" on public."goods_received_lines";
drop policy if exists "goods_received_notes: admin or field insert" on public."goods_received_notes";
drop policy if exists "goods_received_notes: admin or field update" on public."goods_received_notes";
drop policy if exists "goods_received_notes: admin-only delete" on public."goods_received_notes";
drop policy if exists "goods_received_notes: held org read-only delete" on public."goods_received_notes";
drop policy if exists "goods_received_notes: held org read-only insert" on public."goods_received_notes";
drop policy if exists "goods_received_notes: held org read-only update" on public."goods_received_notes";
drop policy if exists "hmrc_connections: held org read-only delete" on public."hmrc_connections";
drop policy if exists "hmrc_connections: held org read-only insert" on public."hmrc_connections";
drop policy if exists "hmrc_connections: held org read-only update" on public."hmrc_connections";
drop policy if exists "hmrc_submissions: held org read-only delete" on public."hmrc_submissions";
drop policy if exists "hmrc_submissions: held org read-only insert" on public."hmrc_submissions";
drop policy if exists "hmrc_submissions: held org read-only update" on public."hmrc_submissions";
drop policy if exists "holiday_entitlements: held org read-only delete" on public."holiday_entitlements";
drop policy if exists "holiday_entitlements: held org read-only insert" on public."holiday_entitlements";
drop policy if exists "holiday_entitlements: held org read-only update" on public."holiday_entitlements";
drop policy if exists "import_audit: held org read-only delete" on public."import_audit";
drop policy if exists "import_audit: held org read-only insert" on public."import_audit";
drop policy if exists "import_audit: held org read-only update" on public."import_audit";
drop policy if exists "import_files: held org read-only delete" on public."import_files";
drop policy if exists "import_files: held org read-only insert" on public."import_files";
drop policy if exists "import_files: held org read-only update" on public."import_files";
drop policy if exists "import_rows: held org read-only delete" on public."import_rows";
drop policy if exists "import_rows: held org read-only insert" on public."import_rows";
drop policy if exists "import_rows: held org read-only update" on public."import_rows";
drop policy if exists "imports: held org read-only delete" on public."imports";
drop policy if exists "imports: held org read-only insert" on public."imports";
drop policy if exists "imports: held org read-only update" on public."imports";
drop policy if exists "inbound_enquiries: held org read-only delete" on public."inbound_enquiries";
drop policy if exists "inbound_enquiries: held org read-only insert" on public."inbound_enquiries";
drop policy if exists "inbound_enquiries: held org read-only update" on public."inbound_enquiries";
drop policy if exists "inspection_plan_items: held org read-only delete" on public."inspection_plan_items";
drop policy if exists "inspection_plan_items: held org read-only insert" on public."inspection_plan_items";
drop policy if exists "inspection_plan_items: held org read-only update" on public."inspection_plan_items";
drop policy if exists "inspection_plan_template_items: held org read-only delete" on public."inspection_plan_template_items";
drop policy if exists "inspection_plan_template_items: held org read-only insert" on public."inspection_plan_template_items";
drop policy if exists "inspection_plan_template_items: held org read-only update" on public."inspection_plan_template_items";
drop policy if exists "inspection_plan_templates: held org read-only delete" on public."inspection_plan_templates";
drop policy if exists "inspection_plan_templates: held org read-only insert" on public."inspection_plan_templates";
drop policy if exists "inspection_plan_templates: held org read-only update" on public."inspection_plan_templates";
drop policy if exists "inspection_signoffs: held org read-only delete" on public."inspection_signoffs";
drop policy if exists "inspection_signoffs: held org read-only insert" on public."inspection_signoffs";
drop policy if exists "inspection_signoffs: held org read-only update" on public."inspection_signoffs";
drop policy if exists "inspection_test_plans: held org read-only delete" on public."inspection_test_plans";
drop policy if exists "inspection_test_plans: held org read-only insert" on public."inspection_test_plans";
drop policy if exists "inspection_test_plans: held org read-only update" on public."inspection_test_plans";
drop policy if exists "inspection_witness_invitations: held org read-only delete" on public."inspection_witness_invitations";
drop policy if exists "inspection_witness_invitations: held org read-only insert" on public."inspection_witness_invitations";
drop policy if exists "inspection_witness_invitations: held org read-only update" on public."inspection_witness_invitations";
drop policy if exists "invoice_line_items: held org read-only delete" on public."invoice_line_items";
drop policy if exists "invoice_line_items: held org read-only insert" on public."invoice_line_items";
drop policy if exists "invoice_line_items: held org read-only update" on public."invoice_line_items";
drop policy if exists "invoice_payment_intents: held org read-only delete" on public."invoice_payment_intents";
drop policy if exists "invoice_payment_intents: held org read-only insert" on public."invoice_payment_intents";
drop policy if exists "invoice_payment_intents: held org read-only update" on public."invoice_payment_intents";
drop policy if exists "invoice_payments: held org read-only delete" on public."invoice_payments";
drop policy if exists "invoice_payments: held org read-only insert" on public."invoice_payments";
drop policy if exists "invoice_payments: held org read-only update" on public."invoice_payments";
drop policy if exists "invoice_reminders: held org read-only delete" on public."invoice_reminders";
drop policy if exists "invoice_reminders: held org read-only insert" on public."invoice_reminders";
drop policy if exists "invoice_reminders: held org read-only update" on public."invoice_reminders";
drop policy if exists "invoices: held org read-only delete" on public."invoices";
drop policy if exists "invoices: held org read-only insert" on public."invoices";
drop policy if exists "invoices: held org read-only update" on public."invoices";
drop policy if exists "job_billing_plans: held org read-only delete" on public."job_billing_plans";
drop policy if exists "job_billing_plans: held org read-only insert" on public."job_billing_plans";
drop policy if exists "job_billing_plans: held org read-only update" on public."job_billing_plans";
drop policy if exists "job_billing_stages: held org read-only delete" on public."job_billing_stages";
drop policy if exists "job_billing_stages: held org read-only insert" on public."job_billing_stages";
drop policy if exists "job_billing_stages: held org read-only update" on public."job_billing_stages";
drop policy if exists "job_budgets: held org read-only delete" on public."job_budgets";
drop policy if exists "job_budgets: held org read-only insert" on public."job_budgets";
drop policy if exists "job_budgets: held org read-only update" on public."job_budgets";
drop policy if exists "job_checklists: held org read-only delete" on public."job_checklists";
drop policy if exists "job_checklists: held org read-only insert" on public."job_checklists";
drop policy if exists "job_checklists: held org read-only update" on public."job_checklists";
drop policy if exists "job_document_versions: held org read-only delete" on public."job_document_versions";
drop policy if exists "job_document_versions: held org read-only insert" on public."job_document_versions";
drop policy if exists "job_document_versions: held org read-only update" on public."job_document_versions";
drop policy if exists "job_documents: held org read-only delete" on public."job_documents";
drop policy if exists "job_documents: held org read-only insert" on public."job_documents";
drop policy if exists "job_documents: held org read-only update" on public."job_documents";
drop policy if exists "job_milestone_dependencies: held org read-only delete" on public."job_milestone_dependencies";
drop policy if exists "job_milestone_dependencies: held org read-only insert" on public."job_milestone_dependencies";
drop policy if exists "job_milestone_dependencies: held org read-only update" on public."job_milestone_dependencies";
drop policy if exists "job_milestones: held org read-only delete" on public."job_milestones";
drop policy if exists "job_milestones: held org read-only insert" on public."job_milestones";
drop policy if exists "job_milestones: held org read-only update" on public."job_milestones";
drop policy if exists "job_programme_baselines: held org read-only delete" on public."job_programme_baselines";
drop policy if exists "job_programme_baselines: held org read-only insert" on public."job_programme_baselines";
drop policy if exists "job_programme_baselines: held org read-only update" on public."job_programme_baselines";
drop policy if exists "job_progress_observations: held org read-only delete" on public."job_progress_observations";
drop policy if exists "job_progress_observations: held org read-only insert" on public."job_progress_observations";
drop policy if exists "job_progress_observations: held org read-only update" on public."job_progress_observations";
drop policy if exists "job_template_checklist_items: held org read-only delete" on public."job_template_checklist_items";
drop policy if exists "job_template_checklist_items: held org read-only insert" on public."job_template_checklist_items";
drop policy if exists "job_template_checklist_items: held org read-only update" on public."job_template_checklist_items";
drop policy if exists "job_template_milestones: held org read-only delete" on public."job_template_milestones";
drop policy if exists "job_template_milestones: held org read-only insert" on public."job_template_milestones";
drop policy if exists "job_template_milestones: held org read-only update" on public."job_template_milestones";
drop policy if exists "job_templates: held org read-only delete" on public."job_templates";
drop policy if exists "job_templates: held org read-only insert" on public."job_templates";
drop policy if exists "job_templates: held org read-only update" on public."job_templates";
drop policy if exists "job_valuation_variations: held org read-only delete" on public."job_valuation_variations";
drop policy if exists "job_valuation_variations: held org read-only insert" on public."job_valuation_variations";
drop policy if exists "job_valuation_variations: held org read-only update" on public."job_valuation_variations";
drop policy if exists "job_valuations: held org read-only delete" on public."job_valuations";
drop policy if exists "job_valuations: held org read-only insert" on public."job_valuations";
drop policy if exists "job_valuations: held org read-only update" on public."job_valuations";
drop policy if exists "job_warranties: admin-only delete" on public."job_warranties";
drop policy if exists "job_warranties: admin-only insert" on public."job_warranties";
drop policy if exists "job_warranties: admin-only update" on public."job_warranties";
drop policy if exists "job_warranties: held org read-only delete" on public."job_warranties";
drop policy if exists "job_warranties: held org read-only insert" on public."job_warranties";
drop policy if exists "job_warranties: held org read-only update" on public."job_warranties";
drop policy if exists "jobs: held org read-only delete" on public."jobs";
drop policy if exists "jobs: held org read-only insert" on public."jobs";
drop policy if exists "jobs: held org read-only update" on public."jobs";
drop policy if exists "lead_followup_state: held org read-only delete" on public."lead_followup_state";
drop policy if exists "lead_followup_state: held org read-only insert" on public."lead_followup_state";
drop policy if exists "lead_followup_state: held org read-only update" on public."lead_followup_state";
drop policy if exists "leads: held org read-only delete" on public."leads";
drop policy if exists "leads: held org read-only insert" on public."leads";
drop policy if exists "leads: held org read-only update" on public."leads";
drop policy if exists "leave_requests: held org read-only delete" on public."leave_requests";
drop policy if exists "leave_requests: held org read-only insert" on public."leave_requests";
drop policy if exists "leave_requests: held org read-only update" on public."leave_requests";
drop policy if exists "maintenance_reminder_log: held org read-only delete" on public."maintenance_reminder_log";
drop policy if exists "maintenance_reminder_log: held org read-only insert" on public."maintenance_reminder_log";
drop policy if exists "maintenance_reminder_log: held org read-only update" on public."maintenance_reminder_log";
drop policy if exists "marketplace_partners: held org read-only delete" on public."marketplace_partners";
drop policy if exists "marketplace_partners: held org read-only insert" on public."marketplace_partners";
drop policy if exists "marketplace_partners: held org read-only update" on public."marketplace_partners";
drop policy if exists "material_request_lines: held org read-only delete" on public."material_request_lines";
drop policy if exists "material_request_lines: held org read-only insert" on public."material_request_lines";
drop policy if exists "material_request_lines: held org read-only update" on public."material_request_lines";
drop policy if exists "material_requests: held org read-only delete" on public."material_requests";
drop policy if exists "material_requests: held org read-only insert" on public."material_requests";
drop policy if exists "material_requests: held org read-only update" on public."material_requests";
drop policy if exists "material_requests: no member decided insert" on public."material_requests";
drop policy if exists "material_requests: no member decision" on public."material_requests";
drop policy if exists "merchant_catalogue_items: held org read-only delete" on public."merchant_catalogue_items";
drop policy if exists "merchant_catalogue_items: held org read-only insert" on public."merchant_catalogue_items";
drop policy if exists "merchant_catalogue_items: held org read-only update" on public."merchant_catalogue_items";
drop policy if exists "merchant_connections: held org read-only delete" on public."merchant_connections";
drop policy if exists "merchant_connections: held org read-only insert" on public."merchant_connections";
drop policy if exists "merchant_connections: held org read-only update" on public."merchant_connections";
drop policy if exists "merchant_po_submissions: held org read-only delete" on public."merchant_po_submissions";
drop policy if exists "merchant_po_submissions: held org read-only insert" on public."merchant_po_submissions";
drop policy if exists "merchant_po_submissions: held org read-only update" on public."merchant_po_submissions";
drop policy if exists "messages: held org read-only delete" on public."messages";
drop policy if exists "messages: held org read-only insert" on public."messages";
drop policy if exists "messages: held org read-only update" on public."messages";
drop policy if exists "missed_call_textbacks: held org read-only delete" on public."missed_call_textbacks";
drop policy if exists "missed_call_textbacks: held org read-only insert" on public."missed_call_textbacks";
drop policy if exists "missed_call_textbacks: held org read-only update" on public."missed_call_textbacks";
drop policy if exists "ncr_corrective_actions: held org read-only delete" on public."ncr_corrective_actions";
drop policy if exists "ncr_corrective_actions: held org read-only insert" on public."ncr_corrective_actions";
drop policy if exists "ncr_corrective_actions: held org read-only update" on public."ncr_corrective_actions";
drop policy if exists "non_conformance_reports: held org read-only delete" on public."non_conformance_reports";
drop policy if exists "non_conformance_reports: held org read-only insert" on public."non_conformance_reports";
drop policy if exists "non_conformance_reports: held org read-only update" on public."non_conformance_reports";
drop policy if exists "notification_preferences: held org read-only delete" on public."notification_preferences";
drop policy if exists "notification_preferences: held org read-only insert" on public."notification_preferences";
drop policy if exists "notification_preferences: held org read-only update" on public."notification_preferences";
drop policy if exists "notifications: held org read-only delete" on public."notifications";
drop policy if exists "notifications: held org read-only insert" on public."notifications";
drop policy if exists "notifications: held org read-only update" on public."notifications";
drop policy if exists "org_payment_connections: held org read-only delete" on public."org_payment_connections";
drop policy if exists "org_payment_connections: held org read-only insert" on public."org_payment_connections";
drop policy if exists "org_payment_connections: held org read-only update" on public."org_payment_connections";
drop policy if exists "org_settings: held org read-only delete" on public."org_settings";
drop policy if exists "org_settings: held org read-only insert" on public."org_settings";
drop policy if exists "org_settings: held org read-only update" on public."org_settings";
drop policy if exists "payments: held org read-only delete" on public."payments";
drop policy if exists "payments: held org read-only insert" on public."payments";
drop policy if exists "payments: held org read-only update" on public."payments";
drop policy if exists "payroll_line_adjustments: held org read-only delete" on public."payroll_line_adjustments";
drop policy if exists "payroll_line_adjustments: held org read-only insert" on public."payroll_line_adjustments";
drop policy if exists "payroll_line_adjustments: held org read-only update" on public."payroll_line_adjustments";
drop policy if exists "payroll_lines: held org read-only delete" on public."payroll_lines";
drop policy if exists "payroll_lines: held org read-only insert" on public."payroll_lines";
drop policy if exists "payroll_lines: held org read-only update" on public."payroll_lines";
drop policy if exists "payroll_runs: held org read-only delete" on public."payroll_runs";
drop policy if exists "payroll_runs: held org read-only insert" on public."payroll_runs";
drop policy if exists "payroll_runs: held org read-only update" on public."payroll_runs";
drop policy if exists "payroll_tax_profiles: held org read-only delete" on public."payroll_tax_profiles";
drop policy if exists "payroll_tax_profiles: held org read-only insert" on public."payroll_tax_profiles";
drop policy if exists "payroll_tax_profiles: held org read-only update" on public."payroll_tax_profiles";
drop policy if exists "pension_enrolments: held org read-only delete" on public."pension_enrolments";
drop policy if exists "pension_enrolments: held org read-only insert" on public."pension_enrolments";
drop policy if exists "pension_enrolments: held org read-only update" on public."pension_enrolments";
drop policy if exists "permit_conditions: held org read-only delete" on public."permit_conditions";
drop policy if exists "permit_conditions: held org read-only insert" on public."permit_conditions";
drop policy if exists "permit_conditions: held org read-only update" on public."permit_conditions";
drop policy if exists "permit_conditions: parent must be readable" on public."permit_conditions";
drop policy if exists "permits_to_work: held org read-only delete" on public."permits_to_work";
drop policy if exists "permits_to_work: held org read-only insert" on public."permits_to_work";
drop policy if exists "permits_to_work: held org read-only update" on public."permits_to_work";
drop policy if exists "permits_to_work: issue needs approval" on public."permits_to_work";
drop policy if exists "permits_to_work: issue needs approval ins" on public."permits_to_work";
drop policy if exists "phone_numbers: held org read-only delete" on public."phone_numbers";
drop policy if exists "phone_numbers: held org read-only insert" on public."phone_numbers";
drop policy if exists "phone_numbers: held org read-only update" on public."phone_numbers";
drop policy if exists "price_book_items: held org read-only delete" on public."price_book_items";
drop policy if exists "price_book_items: held org read-only insert" on public."price_book_items";
drop policy if exists "price_book_items: held org read-only update" on public."price_book_items";
drop policy if exists "properties: admin-only delete" on public."properties";
drop policy if exists "properties: admin-only insert" on public."properties";
drop policy if exists "properties: admin-only update" on public."properties";
drop policy if exists "properties: held org read-only delete" on public."properties";
drop policy if exists "properties: held org read-only insert" on public."properties";
drop policy if exists "properties: held org read-only update" on public."properties";
drop policy if exists "po_line_items: field reads open orders" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: admin-only delete" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: admin-only insert" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: admin-only update" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: held org read-only delete" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: held org read-only insert" on public."purchase_order_line_items";
drop policy if exists "purchase_order_line_items: held org read-only update" on public."purchase_order_line_items";
drop policy if exists "purchase_orders: admin-only delete" on public."purchase_orders";
drop policy if exists "purchase_orders: admin-only insert" on public."purchase_orders";
drop policy if exists "purchase_orders: admin-only update" on public."purchase_orders";
drop policy if exists "purchase_orders: field reads open orders" on public."purchase_orders";
drop policy if exists "purchase_orders: held org read-only delete" on public."purchase_orders";
drop policy if exists "purchase_orders: held org read-only insert" on public."purchase_orders";
drop policy if exists "purchase_orders: held org read-only update" on public."purchase_orders";
drop policy if exists "push_subscriptions: held org read-only delete" on public."push_subscriptions";
drop policy if exists "push_subscriptions: held org read-only insert" on public."push_subscriptions";
drop policy if exists "push_subscriptions: held org read-only update" on public."push_subscriptions";
drop policy if exists "quote_line_items: held org read-only delete" on public."quote_line_items";
drop policy if exists "quote_line_items: held org read-only insert" on public."quote_line_items";
drop policy if exists "quote_line_items: held org read-only update" on public."quote_line_items";
drop policy if exists "quote_template_lines: held org read-only delete" on public."quote_template_lines";
drop policy if exists "quote_template_lines: held org read-only insert" on public."quote_template_lines";
drop policy if exists "quote_template_lines: held org read-only update" on public."quote_template_lines";
drop policy if exists "quote_templates: held org read-only delete" on public."quote_templates";
drop policy if exists "quote_templates: held org read-only insert" on public."quote_templates";
drop policy if exists "quote_templates: held org read-only update" on public."quote_templates";
drop policy if exists "quote_versions: held org read-only delete" on public."quote_versions";
drop policy if exists "quote_versions: held org read-only insert" on public."quote_versions";
drop policy if exists "quote_versions: held org read-only update" on public."quote_versions";
drop policy if exists "quotes: held org read-only delete" on public."quotes";
drop policy if exists "quotes: held org read-only insert" on public."quotes";
drop policy if exists "quotes: held org read-only update" on public."quotes";
drop policy if exists "report_subscriptions: held org read-only delete" on public."report_subscriptions";
drop policy if exists "report_subscriptions: held org read-only insert" on public."report_subscriptions";
drop policy if exists "report_subscriptions: held org read-only update" on public."report_subscriptions";
drop policy if exists "retention_policies: held org read-only delete" on public."retention_policies";
drop policy if exists "retention_policies: held org read-only insert" on public."retention_policies";
drop policy if exists "retention_policies: held org read-only update" on public."retention_policies";
drop policy if exists "retention_purge_log: held org read-only delete" on public."retention_purge_log";
drop policy if exists "retention_purge_log: held org read-only insert" on public."retention_purge_log";
drop policy if exists "retention_purge_log: held org read-only update" on public."retention_purge_log";
drop policy if exists "retention_releases: held org read-only delete" on public."retention_releases";
drop policy if exists "retention_releases: held org read-only insert" on public."retention_releases";
drop policy if exists "retention_releases: held org read-only update" on public."retention_releases";
drop policy if exists "review_requests: held org read-only delete" on public."review_requests";
drop policy if exists "review_requests: held org read-only insert" on public."review_requests";
drop policy if exists "review_requests: held org read-only update" on public."review_requests";
drop policy if exists "risk_assessment_hazards: held org read-only delete" on public."risk_assessment_hazards";
drop policy if exists "risk_assessment_hazards: held org read-only insert" on public."risk_assessment_hazards";
drop policy if exists "risk_assessment_hazards: held org read-only update" on public."risk_assessment_hazards";
drop policy if exists "risk_assessment_hazards: parent must be readable" on public."risk_assessment_hazards";
drop policy if exists "risk_assessments: held org read-only delete" on public."risk_assessments";
drop policy if exists "risk_assessments: held org read-only insert" on public."risk_assessments";
drop policy if exists "risk_assessments: held org read-only update" on public."risk_assessments";
drop policy if exists "risk_assessments: publish needs approval" on public."risk_assessments";
drop policy if exists "risk_assessments: publish needs approval ins" on public."risk_assessments";
drop policy if exists "rota_entries: held org read-only delete" on public."rota_entries";
drop policy if exists "rota_entries: held org read-only insert" on public."rota_entries";
drop policy if exists "rota_entries: held org read-only update" on public."rota_entries";
drop policy if exists "safety_acknowledgements: held org read-only delete" on public."safety_acknowledgements";
drop policy if exists "safety_acknowledgements: held org read-only insert" on public."safety_acknowledgements";
drop policy if exists "safety_acknowledgements: held org read-only update" on public."safety_acknowledgements";
drop policy if exists "service_booking_slots: held org read-only delete" on public."service_booking_slots";
drop policy if exists "service_booking_slots: held org read-only insert" on public."service_booking_slots";
drop policy if exists "service_booking_slots: held org read-only update" on public."service_booking_slots";
drop policy if exists "service_bookings: held org read-only delete" on public."service_bookings";
drop policy if exists "service_bookings: held org read-only insert" on public."service_bookings";
drop policy if exists "service_bookings: held org read-only update" on public."service_bookings";
drop policy if exists "service_catalog: held org read-only delete" on public."service_catalog";
drop policy if exists "service_catalog: held org read-only insert" on public."service_catalog";
drop policy if exists "service_catalog: held org read-only update" on public."service_catalog";
drop policy if exists "signatures: held org read-only delete" on public."signatures";
drop policy if exists "signatures: held org read-only insert" on public."signatures";
drop policy if exists "signatures: held org read-only update" on public."signatures";
drop policy if exists "site_diary_entries: held org read-only delete" on public."site_diary_entries";
drop policy if exists "site_diary_entries: held org read-only insert" on public."site_diary_entries";
drop policy if exists "site_diary_entries: held org read-only update" on public."site_diary_entries";
drop policy if exists "site_inductions: held org read-only delete" on public."site_inductions";
drop policy if exists "site_inductions: held org read-only insert" on public."site_inductions";
drop policy if exists "site_inductions: held org read-only update" on public."site_inductions";
drop policy if exists "site_reports: held org read-only delete" on public."site_reports";
drop policy if exists "site_reports: held org read-only insert" on public."site_reports";
drop policy if exists "site_reports: held org read-only update" on public."site_reports";
drop policy if exists "site_visitors: held org read-only delete" on public."site_visitors";
drop policy if exists "site_visitors: held org read-only insert" on public."site_visitors";
drop policy if exists "site_visitors: held org read-only update" on public."site_visitors";
drop policy if exists "sites: held org read-only delete" on public."sites";
drop policy if exists "sites: held org read-only insert" on public."sites";
drop policy if exists "sites: held org read-only update" on public."sites";
drop policy if exists "snags: held org read-only delete" on public."snags";
drop policy if exists "snags: held org read-only insert" on public."snags";
drop policy if exists "snags: held org read-only update" on public."snags";
drop policy if exists "staff_qualifications: held org read-only delete" on public."staff_qualifications";
drop policy if exists "staff_qualifications: held org read-only insert" on public."staff_qualifications";
drop policy if exists "staff_qualifications: held org read-only update" on public."staff_qualifications";
drop policy if exists "staff_secrets: held org read-only delete" on public."staff_secrets";
drop policy if exists "staff_secrets: held org read-only insert" on public."staff_secrets";
drop policy if exists "staff_secrets: held org read-only update" on public."staff_secrets";
drop policy if exists "stock_items: admin-only delete" on public."stock_items";
drop policy if exists "stock_items: admin-only insert" on public."stock_items";
drop policy if exists "stock_items: admin-only update" on public."stock_items";
drop policy if exists "stock_items: held org read-only delete" on public."stock_items";
drop policy if exists "stock_items: held org read-only insert" on public."stock_items";
drop policy if exists "stock_items: held org read-only update" on public."stock_items";
drop policy if exists "stock_movements: held org read-only delete" on public."stock_movements";
drop policy if exists "stock_movements: held org read-only insert" on public."stock_movements";
drop policy if exists "stock_movements: held org read-only update" on public."stock_movements";
drop policy if exists "stocktake_lines: admin or field update" on public."stocktake_lines";
drop policy if exists "stocktake_lines: admin-only delete" on public."stocktake_lines";
drop policy if exists "stocktake_lines: admin-only insert" on public."stocktake_lines";
drop policy if exists "stocktake_lines: held org read-only delete" on public."stocktake_lines";
drop policy if exists "stocktake_lines: held org read-only insert" on public."stocktake_lines";
drop policy if exists "stocktake_lines: held org read-only update" on public."stocktake_lines";
drop policy if exists "stocktake_sessions: admin-only delete" on public."stocktake_sessions";
drop policy if exists "stocktake_sessions: admin-only insert" on public."stocktake_sessions";
drop policy if exists "stocktake_sessions: admin-only update" on public."stocktake_sessions";
drop policy if exists "stocktake_sessions: held org read-only delete" on public."stocktake_sessions";
drop policy if exists "stocktake_sessions: held org read-only insert" on public."stocktake_sessions";
drop policy if exists "stocktake_sessions: held org read-only update" on public."stocktake_sessions";
drop policy if exists "supplier_payment_allocations: held org read-only delete" on public."supplier_payment_allocations";
drop policy if exists "supplier_payment_allocations: held org read-only insert" on public."supplier_payment_allocations";
drop policy if exists "supplier_payment_allocations: held org read-only update" on public."supplier_payment_allocations";
drop policy if exists "supplier_payments: held org read-only delete" on public."supplier_payments";
drop policy if exists "supplier_payments: held org read-only insert" on public."supplier_payments";
drop policy if exists "supplier_payments: held org read-only update" on public."supplier_payments";
drop policy if exists "suppliers: admin-only delete" on public."suppliers";
drop policy if exists "suppliers: admin-only insert" on public."suppliers";
drop policy if exists "suppliers: admin-only update" on public."suppliers";
drop policy if exists "suppliers: held org read-only delete" on public."suppliers";
drop policy if exists "suppliers: held org read-only insert" on public."suppliers";
drop policy if exists "suppliers: held org read-only update" on public."suppliers";
drop policy if exists "support_messages: held org read-only delete" on public."support_messages";
drop policy if exists "support_messages: held org read-only insert" on public."support_messages";
drop policy if exists "support_messages: held org read-only update" on public."support_messages";
drop policy if exists "support_tickets: held org read-only delete" on public."support_tickets";
drop policy if exists "support_tickets: held org read-only insert" on public."support_tickets";
drop policy if exists "support_tickets: held org read-only update" on public."support_tickets";
drop policy if exists "telematics_connections: held org read-only delete" on public."telematics_connections";
drop policy if exists "telematics_connections: held org read-only insert" on public."telematics_connections";
drop policy if exists "telematics_connections: held org read-only update" on public."telematics_connections";
drop policy if exists "telematics_readings: held org read-only delete" on public."telematics_readings";
drop policy if exists "telematics_readings: held org read-only insert" on public."telematics_readings";
drop policy if exists "telematics_readings: held org read-only update" on public."telematics_readings";
drop policy if exists "tenant_attachments: held org read-only delete" on public."tenant_attachments";
drop policy if exists "tenant_attachments: held org read-only insert" on public."tenant_attachments";
drop policy if exists "tenant_attachments: held org read-only update" on public."tenant_attachments";
drop policy if exists "tenant_search_documents: held org read-only delete" on public."tenant_search_documents";
drop policy if exists "tenant_search_documents: held org read-only insert" on public."tenant_search_documents";
drop policy if exists "tenant_search_documents: held org read-only update" on public."tenant_search_documents";
drop policy if exists "time_entries: held org read-only delete" on public."time_entries";
drop policy if exists "time_entries: held org read-only insert" on public."time_entries";
drop policy if exists "time_entries: held org read-only update" on public."time_entries";
drop policy if exists "toolbox_talks: held org read-only delete" on public."toolbox_talks";
drop policy if exists "toolbox_talks: held org read-only insert" on public."toolbox_talks";
drop policy if exists "toolbox_talks: held org read-only update" on public."toolbox_talks";
drop policy if exists "variation_requests: held org read-only delete" on public."variation_requests";
drop policy if exists "variation_requests: held org read-only insert" on public."variation_requests";
drop policy if exists "variation_requests: held org read-only update" on public."variation_requests";
drop policy if exists "voice_notes: held org read-only delete" on public."voice_notes";
drop policy if exists "voice_notes: held org read-only insert" on public."voice_notes";
drop policy if exists "voice_notes: held org read-only update" on public."voice_notes";
drop policy if exists "weather_watches: held org read-only delete" on public."weather_watches";
drop policy if exists "weather_watches: held org read-only insert" on public."weather_watches";
drop policy if exists "weather_watches: held org read-only update" on public."weather_watches";
drop policy if exists "webhook_endpoints: held org read-only delete" on public."webhook_endpoints";
drop policy if exists "webhook_endpoints: held org read-only insert" on public."webhook_endpoints";
drop policy if exists "webhook_endpoints: held org read-only update" on public."webhook_endpoints";
drop policy if exists "whatsapp_assistant_actions: held org read-only delete" on public."whatsapp_assistant_actions";
drop policy if exists "whatsapp_assistant_actions: held org read-only insert" on public."whatsapp_assistant_actions";
drop policy if exists "whatsapp_assistant_actions: held org read-only update" on public."whatsapp_assistant_actions";
drop policy if exists "whatsapp_inbound_media: held org read-only delete" on public."whatsapp_inbound_media";
drop policy if exists "whatsapp_inbound_media: held org read-only insert" on public."whatsapp_inbound_media";
drop policy if exists "whatsapp_inbound_media: held org read-only update" on public."whatsapp_inbound_media";
drop policy if exists "whatsapp_number_routes: held org read-only delete" on public."whatsapp_number_routes";
drop policy if exists "whatsapp_number_routes: held org read-only insert" on public."whatsapp_number_routes";
drop policy if exists "whatsapp_number_routes: held org read-only update" on public."whatsapp_number_routes";
drop policy if exists "whatsapp_optouts: held org read-only delete" on public."whatsapp_optouts";
drop policy if exists "whatsapp_optouts: held org read-only insert" on public."whatsapp_optouts";
drop policy if exists "whatsapp_optouts: held org read-only update" on public."whatsapp_optouts";
drop policy if exists "worker_acknowledgements: held org read-only delete" on public."worker_acknowledgements";
drop policy if exists "worker_acknowledgements: held org read-only insert" on public."worker_acknowledgements";
drop policy if exists "worker_acknowledgements: held org read-only update" on public."worker_acknowledgements";
drop policy if exists "worker_signoff_tokens: held org read-only delete" on public."worker_signoff_tokens";
drop policy if exists "worker_signoff_tokens: held org read-only insert" on public."worker_signoff_tokens";
drop policy if exists "worker_signoff_tokens: held org read-only update" on public."worker_signoff_tokens";
drop policy if exists "Users can read organizations they belong to" on public."organizations";
create policy "Users can read organizations they belong to" on public."organizations" as permissive for select to authenticated using ((id IN ( SELECT current_org_ids() AS current_org_ids)));

-- 3. functions changed by D-17 → restore the previous body
CREATE OR REPLACE FUNCTION public.can_read_compensation(target_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    target_user = auth.uid()
    or exists (
      select 1
      from public.memberships mt
      join public.memberships me on me.org_id = mt.org_id
      where mt.user_id = target_user
        and me.user_id = auth.uid()
        and me.role in ('owner', 'admin')
    );
$function$;
CREATE OR REPLACE FUNCTION public.can_write_compensation(target_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.memberships mt
    join public.memberships me on me.org_id = mt.org_id
    where mt.user_id = target_user
      and me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
  );
$function$;
CREATE OR REPLACE FUNCTION public.current_org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 1. Active impersonation: the operator sees ONLY the target org(s).
  --    The 24h cap matches the cookie maxAge so the SQL side cannot
  --    outlive the cookie side.
  select target_org_id
    from public.impersonation_sessions
   where admin_user_id = auth.uid()
     and ended_at is null
     and started_at > now() - interval '24 hours'

  union all

  -- 2. No active session: the caller sees the orgs they belong to. The
  --    NOT EXISTS guard makes the two branches mutually exclusive, so a
  --    normal customer's visible set is byte-identical to before — and
  --    an impersonating operator's own memberships are fully excluded.
  select org_id
    from public.memberships
   where user_id = auth.uid()
     and not exists (
       select 1
         from public.impersonation_sessions
        where admin_user_id = auth.uid()
          and ended_at is null
          and started_at > now() - interval '24 hours'
     );
$function$;
CREATE OR REPLACE FUNCTION public.is_org_admin(target_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when exists (
      select 1
        from public.impersonation_sessions
       where admin_user_id = auth.uid()
         and ended_at is null
         and started_at > now() - interval '24 hours'
    )
    then
      -- During impersonation: admin ONLY in the impersonated org(s).
      -- Real owner/admin membership in the operator's own org is
      -- deliberately ignored for the duration of the session.
      exists (
        select 1
          from public.impersonation_sessions
         where admin_user_id = auth.uid()
           and target_org_id = target_org
           and ended_at is null
           and started_at > now() - interval '24 hours'
      )
    else
      -- Normal: real owner/admin membership (unchanged behaviour).
      exists (
        select 1
          from public.memberships
         where user_id = auth.uid()
           and org_id = target_org
           and role in ('owner', 'admin')
      )
  end;
$function$;
CREATE OR REPLACE FUNCTION public.is_org_member(target_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and org_id = target_org
  );
$function$;

-- 4. functions added by D-17 (after the policies / triggers that used them are gone)
drop function if exists has_org_capability(uuid,text,text);
drop function if exists org_is_writable(uuid);
drop function if exists org_status_admits(text,text);
drop function if exists tg_client_audit_columns_guard();
drop function if exists tg_held_org_write_guard();
drop function if exists tg_stock_movements_admin_writer();

-- 5. table / column privileges changed by the column ACL migrations (20261341–43)
revoke select ("asset_ref", "category", "created_at", "created_by", "hire_end", "hire_start", "id", "manufacturer", "model", "name", "notes", "org_id", "ownership", "purchase_date", "registration", "serial_number", "status", "supplier_id", "updated_at", "warranty_expires_at") on public."assets" from anon;
grant select on public."assets" to anon;
revoke select ("asset_ref", "category", "created_at", "created_by", "hire_end", "hire_start", "id", "manufacturer", "model", "name", "notes", "org_id", "ownership", "purchase_date", "registration", "serial_number", "status", "supplier_id", "updated_at", "warranty_expires_at") on public."assets" from authenticated;
grant select on public."assets" to authenticated;
revoke select ("created_at", "created_by", "customer_id", "email", "id", "name", "notes", "org_id", "phone", "portal_access_enabled", "portal_token_expires_at", "portal_token_last_used_at", "role", "updated_at") on public."customer_contacts" from anon;
grant select on public."customer_contacts" to anon;
revoke select ("created_at", "created_by", "customer_id", "email", "id", "name", "notes", "org_id", "phone", "portal_access_enabled", "portal_token_expires_at", "portal_token_last_used_at", "role", "updated_at") on public."customer_contacts" from authenticated;
grant select on public."customer_contacts" to authenticated;
revoke select ("address_line1", "address_line2", "city", "company_number", "country", "county", "created_at", "customer_type", "email", "id", "name", "notes", "org_id", "parent_customer_id", "phone", "phone_normalized", "phone_sig", "portal_token_expires_at", "portal_token_last_used_at", "postcode", "postcode_normalized", "updated_at", "vat_number") on public."customers" from anon;
grant select on public."customers" to anon;
revoke select ("address_line1", "address_line2", "city", "company_number", "country", "county", "created_at", "customer_type", "email", "id", "name", "notes", "org_id", "parent_customer_id", "phone", "phone_normalized", "phone_sig", "portal_token_expires_at", "portal_token_last_used_at", "postcode", "postcode_normalized", "updated_at", "vat_number") on public."customers" from authenticated;
grant select on public."customers" to authenticated;
revoke select ("asset_id", "created_at", "created_by", "first_registered_on", "fuel_type", "gross_weight_kg", "home_depot", "home_site_id", "mot_exempt", "odometer_miles", "odometer_recorded_at", "operational_status", "org_id", "updated_at", "variant", "vehicle_class", "vin", "year_of_manufacture") on public."fleet_vehicles" from anon;
grant select on public."fleet_vehicles" to anon;
revoke select ("asset_id", "created_at", "created_by", "first_registered_on", "fuel_type", "gross_weight_kg", "home_depot", "home_site_id", "mot_exempt", "odometer_miles", "odometer_recorded_at", "operational_status", "org_id", "updated_at", "variant", "vehicle_class", "vin", "year_of_manufacture") on public."fleet_vehicles" from authenticated;
grant select on public."fleet_vehicles" to authenticated;
revoke select ("avatar_url", "created_at", "email", "full_name", "id", "updated_at") on public."users" from anon;
grant select on public."users" to anon;
revoke select ("avatar_url", "created_at", "email", "full_name", "id", "updated_at") on public."users" from authenticated;
grant select on public."users" to authenticated;

commit;
