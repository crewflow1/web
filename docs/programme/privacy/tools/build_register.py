#!/usr/bin/env python3
"""
Build the column-level personal-data register (data-register.csv).

EVIDENCE SOURCES (all re-derived on every run — nothing is copied from old docs):
  1. LOCAL Postgres catalogue (information_schema.columns, pg_policies, pg_class)
     for schemas public / auth / storage.            -> what columns exist, who RLS admits
  2. Static scan of app/ lib/ server/ components/     -> which files read / write each table
  3. supabase/migrations/*.sql                        -> SQL-side writers (triggers / functions)
  4. lib/gdpr/org-tables.json, lib/retention/policy.ts -> export / erasure / purge disposition
  5. docs/programme/privacy/prod-row-counts.json      -> exact production COUNT(*) per table
                                                        (aggregate-only; no values)

The CLASSIFICATION (category / data subject / CrewFlow's role) is hand-curated in
this file: generic column-name rules + explicit per-table entries. It is the
reviewable part — read TABLES, EXPLICIT and RULES below.

Usage (from the repo root, local Supabase running):
    source /Users/moetalibi/Code/cf-wt/_shared/local-env.sh
    python3 docs/programme/privacy/tools/build_register.py

Limits, stated honestly:
  * The read/write file lists are a STATIC scan for `.from("<table>")` (or the
    quoted table name) followed by insert/update/upsert/delete. It over- and
    under-matches at the margins and is truncated to a few paths per cell.
  * "access" is summarised from RLS policy text; it is a reading aid, not a proof.
    The integration RLS suites are the proof.
  * A column absent from this register was judged not to hold personal data. A new
    column is NOT classified until this script is re-run and reviewed.
  * The shared local DB also holds tables from PENDING PRs. Those listed in PENDING are
    registered with status "PENDING — PR #…" and the disposition their PR declares; any
    other table this branch's migrations do not create is reported and skipped.
  * prod_rows_table comes from prod-row-counts.json, captured 2026-11-13 (aggregate
    COUNT(*) only). It is NOT refreshed by this script; treat it as dated.
"""
import collections
import csv
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT_DIR = os.path.join(ROOT, "docs", "programme", "privacy")
DB = os.environ.get("DATABASE_URL") or os.environ.get("DB_URL") or \
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def psql(sql):
    return subprocess.check_output(["psql", DB, "-At", "-F", "\t", "-c", sql], text=True)


# ───────────────────────────── 1. catalogue ─────────────────────────────
cols = []  # (schema, table, column, data_type, table_type)
for line in psql("""
  select c.table_schema, c.table_name, c.column_name, c.data_type,
         (select t.table_type from information_schema.tables t
           where t.table_schema=c.table_schema and t.table_name=c.table_name)
    from information_schema.columns c
   where c.table_schema in ('public','auth','storage')
   order by 1,2,c.ordinal_position""").splitlines():
    parts = line.split("\t")
    if len(parts) == 5:
        cols.append(tuple(parts))

access_raw = json.loads(psql("""
  select jsonb_object_agg(t.relname, jsonb_build_object(
    'rls', t.relrowsecurity,
    'policies', (select coalesce(jsonb_agg(jsonb_build_object('cmd',p.cmd,
        'q', coalesce(p.qual,'')||' || '||coalesce(p.with_check,''))),'[]'::jsonb)
      from pg_policies p where p.schemaname='public' and p.tablename=t.relname)))
  from pg_class t join pg_namespace n on n.oid=t.relnamespace
  where n.nspname='public' and t.relkind in ('r','p')"""))

public_tables = sorted({t for s, t, *_ in cols if s == "public"})


def access_summary(table, is_view):
    if is_view:
        return "view (inherits the underlying tables' RLS / grants)"
    a = access_raw.get(table)
    if not a:
        return "unknown"
    if not a["rls"]:
        return "RLS OFF"
    pols = a["policies"]
    if not pols:
        return "service-role only (RLS on, no policies)"
    read = [p for p in pols if p["cmd"] in ("SELECT", "ALL")]
    write = [p for p in pols if p["cmd"] in ("INSERT", "UPDATE", "DELETE", "ALL")]

    def scope(ps):
        q = " ".join(p["q"] for p in ps)
        bits = []
        if "can_read_compensation" in q or "can_write_compensation" in q:
            bits.append("compensation-permission holders")
        if "is_org_admin" in q:
            bits.append("org owner/admin")
        if "my_assigned" in q:
            bits.append("staff on assigned jobs/customers")
        if "auth.uid()" in q:
            bits.append("the user themself")
        if not bits and ("current_org_ids" in q or "is_org_member" in q):
            bits.append("all org members")
        elif ("current_org_ids" in q or "is_org_member" in q) and "is_org_admin" not in q \
                and "my_assigned" not in q and "auth.uid()" not in q:
            bits.append("all org members")
        return " + ".join(bits) if bits else "policy-defined"

    r = scope(read) if read else "no client read"
    w = scope(write) if write else "no client write (service role / definer functions)"
    return f"read: {r}; write: {w}"


# ───────────────────────────── 2. code scan ─────────────────────────────
src = {}
for top in ("app", "lib", "server", "components"):
    for dp, _dn, fns in os.walk(os.path.join(ROOT, top)):
        if "__tests__" in dp:
            continue
        for fn in fns:
            if fn.endswith((".ts", ".tsx")) and not (fn == "types.ts" and dp.endswith("supabase")):
                p = os.path.join(dp, fn)
                try:
                    src[os.path.relpath(p, ROOT)] = open(p).read()
                except OSError:
                    pass

refs = {}
WRITE_RX = re.compile(r"\.(insert|update|upsert|delete)\(")
for t in public_tables:
    exact = re.compile(r"\.from\(\s*[\"'`]" + re.escape(t) + r"[\"'`]")
    loose = re.compile(r"[\"'`]" + re.escape(t) + r"[\"'`]")
    r, w, heur = set(), set(), False
    for p, s in src.items():
        for m in exact.finditer(s):
            tail = s[m.end():m.end() + 700]
            nxt = tail.find(".from(")
            if nxt > 0:
                tail = tail[:nxt]
            wm, sm = WRITE_RX.search(tail), re.search(r"\.select\(", tail)
            (w if wm and (not sm or wm.start() < sm.start()) else r).add(p)
    if not r and not w:
        heur = True
        for p, s in src.items():
            for m in loose.finditer(s):
                (w if WRITE_RX.search(s[m.end():m.end() + 600]) else r).add(p)
    refs[t] = {"r": sorted(r - w), "w": sorted(w), "heur": heur}

sqlw = collections.defaultdict(set)
SQL_RX = re.compile(r"(insert\s+into|update|delete\s+from)\s+(?:only\s+)?(?:public\.)?\"?([a-z_0-9]+)\"?", re.I)
mig_dir = os.path.join(ROOT, "supabase", "migrations")
for fn in sorted(os.listdir(mig_dir)):
    body = re.sub(r"--[^\n]*", "", open(os.path.join(mig_dir, fn)).read())
    for m in SQL_RX.finditer(body):
        if m.group(2) in public_tables:
            sqlw[m.group(2)].add(fn[:14])


def paths(lst, n=3):
    if not lst:
        return ""
    more = f" (+{len(lst) - n} more)" if len(lst) > n else ""
    return "; ".join(lst[:n]) + more


# ───────────────────── 3. gdpr / retention dispositions ─────────────────────
org_tables = json.load(open(os.path.join(ROOT, "lib", "gdpr", "org-tables.json")))
KNOWN = set(org_tables["known"])
EXCLUDED = set(org_tables["excluded"])
SERVICE_SIDE = set(org_tables["service_side_export"])
ANON = set(org_tables["erasure_anonymise"])
RETAIN = set(org_tables["erasure_retain"])
policy_src = open(os.path.join(ROOT, "lib", "retention", "policy.ts")).read()
purge_block = policy_src[policy_src.index("export const RETENTION_PURGEABLE"):policy_src.index("export const RETENTION_PURGEABLE_TABLES")]
PURGEABLE = set(re.findall(r"^\s{4}([a-z_]+): \{", purge_block, re.M))

prod_counts = json.load(open(os.path.join(OUT_DIR, "prod-row-counts.json")))["counts"]

# ───────────────────────── 4. curated classification ─────────────────────────
# Data-subject vocabulary
STAFF = "tenant staff / workspace user"
OWNER = "tenant owner / account holder"
CUST = "tenant's customer (end-customer)"
LEADP = "tenant's lead / enquirer"
SUPP = "tenant's supplier / subcontractor"
EXTW = "external worker / site visitor / witness"
CALLER = "member of the public contacting a tenant"
PROSPECT = "CrewFlow lead / prospect"
CFADMIN = "CrewFlow operator (HQ staff)"
MIXED = "mixed (whoever the tenant writes about)"

P = "processor (tenant is controller)"
C = "controller (CrewFlow's own purposes)"
CP = "controller for account/auth; processor for tenant-entered staff data"

ACTIVE = "ACTIVE"
HQ = "ACTIVE (CrewFlow-internal HQ surface)"


def dark(switch):
    return f"DORMANT ({switch})"


# table -> (subject, role, status, note)
TABLES = {}


def reg(names, subject, role, status=ACTIVE, note=""):
    for n in names.split():
        TABLES[n] = (subject, role, status, note)


# — account / tenancy (CrewFlow is controller) —
reg("users memberships", STAFF, CP)
reg("membership_permissions permission_audit", STAFF, P, note="authorisation metadata")
reg("organizations org_settings", OWNER, C, note="business record; personal where the tenant is a sole trader/partnership")
reg("org_subscriptions billing_events billing_invoices", OWNER, C, note="CrewFlow's own SaaS billing (Stripe)")
reg("mfa_recovery_codes", STAFF, C, note="hashed MFA recovery codes")
reg("impersonation_sessions", CFADMIN, C, note="support-access audit trail; target_user_id is a tenant user")
reg("support_tickets support_messages", CUST, P, note="tenant-side warranty/aftercare tickets raised via the customer portal")
reg("notifications notification_preferences notification_digest_cursors briefing_dismissals", STAFF, P)
reg("notification_email_queue", STAFF, P, note="outbound email queue -> Resend; pruned at 90 days (sent/skipped)")
reg("push_subscriptions push_deliveries", STAFF, P, dark("Web Push: VAPID keys; 0 subscriptions in prod"))
reg("sms_deliveries", STAFF, P, dark("Twilio credentials absent"))
reg("org_sso_config org_scim_config sso_consumed_assertions sso_provisioning_audit", STAFF, P, dark("FEATURE_ENTERPRISE_SSO"))
reg("api_keys api_request_log", OWNER, P, dark("public API: 0 keys issued in prod"))
reg("activity_log", MIXED, P, note="append-only audit feed; trigger metadata copies names/emails/phones")
reg("gdpr_export_log gdpr_erasure_log retention_policies retention_purge_log", OWNER, P, note="accountability logs (counts only)")

# — tenant staff / HR / payroll —
reg("time_entries rota_entries leave_requests holiday_entitlements job_assignments", STAFF, P)
reg("payroll_runs payroll_lines payroll_line_adjustments payroll_tax_profiles pension_enrolments", STAFF, P, note="payroll is an ESTIMATE tool (no RTI filing)")
reg("staff_compensation staff_secrets staff_qualifications", STAFF, P)

# — tenant CRM / commercial —
reg("customers customer_contacts customer_portal_preferences properties", CUST, P)
reg("leads lead_followup_state", LEADP, P)
reg("quotes quote_line_items quote_versions ai_quote_drafts", CUST, P)
reg("invoices invoice_line_items invoice_payments invoice_reminders payments", CUST, P)
reg("invoice_payment_intents org_payment_connections", CUST, P, dark("NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS + Stripe Connect"))
reg("jobs job_checklists job_documents job_document_versions job_budgets job_billing_plans job_billing_stages "
    "job_valuations job_valuation_variations job_warranties job_milestones job_milestone_dependencies "
    "job_programme_baselines job_progress_observations retention_releases delay_events variation_requests "
    "snags site_diary_entries site_reports completion_certificates review_requests service_bookings "
    "service_booking_slots maintenance_reminder_log", CUST, P)
reg("signatures", CUST, P, note="e-signature evidence for quote acceptance")
reg("portal_uploads tenant_attachments blueprints blueprint_versions blueprint_markup blueprint_pins "
    "blueprint_pin_comments compliance_documents", MIXED, P, note="files + file metadata")
reg("tenant_search_documents", MIXED, P, note="derived search index (copy of tenant text); embeddings DORMANT (DB flag, 0 embedded in prod)")
reg("imports import_files import_rows import_audit form_import_drafts", MIXED, P, note="data-import staging; raw rows/files persist after commit (form-imports: 7-day purge)")
reg("voice_notes", STAFF, P, dark("no capture surface: microphone denied by Permissions-Policy; 0 rows"))

# — suppliers / subcontractors / CIS / finance —
reg("suppliers purchase_orders purchase_order_line_items goods_received_notes goods_received_lines "
    "supplier_payments supplier_payment_allocations finances expense_drafts expense_budgets "
    "material_requests material_request_lines", SUPP, P)
reg("cis_subcontractors cis_contractor_profiles cis_statements cis_statement_payments cis_payment_snapshots "
    "cis_monthly_returns cis_monthly_return_lines cis_bill_details", SUPP, P, note="CIS records: prepared/exported only, no HMRC filing")
reg("bank_statements bank_statement_lines", MIXED, P, note="manually uploaded statements (counterparty names in descriptions)")

# — health & safety / site —
reg("site_visitors site_inductions worker_signoff_tokens worker_acknowledgements inspection_witness_invitations "
    "inspection_signoffs", EXTW, P)
reg("safety_acknowledgements toolbox_talks risk_assessments risk_assessment_hazards permits_to_work permit_conditions "
    "non_conformance_reports ncr_corrective_actions inspection_test_plans inspection_plan_items sites", STAFF, P)

# — assets / fleet / stock (mostly non-personal; user links + drivers) —
reg("assets asset_assignments asset_fuel_logs asset_inspections asset_maintenance_cases asset_calibration_certificates "
    "asset_inspection_overrides asset_qr_identities fleet_vehicles stock_movements stocktake_sessions stocktake_lines", STAFF, P)
reg("telematics_connections telematics_readings", STAFF, P, dark("NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT"))

reg("asset_depreciation_settings asset_inspection_schedules asset_inspection_templates asset_maintenance_case_costs "
    "asset_service_schedules automation_rules automation_schedules automation_workflow_versions inspection_plan_templates "
    "job_templates price_book_items quote_templates stock_items stock_movements_operational weather_watches",
    STAFF, P, note="operational configuration; personal data limited to the acting user's id / free text")

# — comms channels (processor; dormant) —
VOICE = "NEXT_PUBLIC_FEATURE_VOICE_INBOUND + Twilio/voice provider credentials"
reg("calls call_events missed_call_textbacks phone_numbers", CALLER, P, dark(VOICE))
reg("ai_receptionist_setups", OWNER, P, note="tenant's receptionist settings (business numbers, staff numbers); the channels they configure are dormant")
reg("conversations messages inbound_enquiries", CALLER, P, dark("no inbound channel live: voice/SMS/inbound-email dormant; WhatsApp armed but no traffic"))
reg("whatsapp_webhook_events whatsapp_inbound_media whatsapp_optouts whatsapp_number_routes whatsapp_assistant_actions",
    CALLER, P, "ARMED (NEXT_PUBLIC_FEATURE_WHATSAPP=true + Meta credentials present in prod per /api/health; 1 route, 1 event, no customer traffic)")
reg("email_webhook_events email_inbound_routes", CALLER, P, dark("NEXT_PUBLIC_FEATURE_INBOUND_EMAIL + INBOUND_EMAIL_WEBHOOK_SECRET"))
reg("comm_events", MIXED, P, note="email delivery events from the Resend webhook (recipient address + provider payload); 16 rows in prod")
for t in public_tables:
    if t.startswith("receptionist_") or t.startswith("ai_reply_"):
        TABLES.setdefault(t, (CALLER, P, dark("no inbound channel live"), "AI receptionist conversation state"))

# — integrations (dormant credential stores) —
reg("accounting_connections accounting_export_log accounting_pushed_entities", OWNER, P, dark("FEATURE_ACCOUNTING_CONNECT; CSV export is active"))
reg("bank_connections", OWNER, P, dark("NEXT_PUBLIC_FEATURE_BANKING_CONNECT"))
reg("calendar_connections calendar_event_links calendar_pulled_events calendar_watch_channels", STAFF, P, dark("FEATURE_CALENDAR_CONNECT"))
reg("hmrc_connections hmrc_submissions", OWNER, P, dark("NEXT_PUBLIC_FEATURE_HMRC_CONNECT"))
reg("merchant_connections merchant_po_submissions", OWNER, P, dark("NEXT_PUBLIC_FEATURE_MERCHANTS"))
reg("webhook_endpoints webhook_deliveries", OWNER, P, dark("NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS"))
reg("marketplace_partners marketplace_listings marketplace_installs", OWNER, P, dark("FEATURE_MARKETPLACE"))
reg("automation_approvals automation_runs automation_custom_rules", MIXED, P, note="automation payload snapshots")
reg("report_subscriptions", STAFF, P, note="scheduled report recipients (email addresses)")

# — CrewFlow's own sales / marketing / HQ (controller) —
reg("demo_requests", PROSPECT, C, note="public 'book a demo' form")
reg("waitlist", PROSPECT, C, "ORPHAN (no route writes it; 0 rows in prod)")
for t in public_tables:
    if t.startswith("hq_sales_"):
        TABLES.setdefault(t, (PROSPECT, C, HQ, "CrewFlow sales CRM (0 company/contact rows in prod)"))
reg("hq_communications hq_comms_suppressions", PROSPECT, C, HQ, "approval-gated outreach sends + suppression list (0 rows in prod)")
reg("admin_activity_log internal_notes admin_alert_state", CFADMIN, C, HQ)
reg("ai_invocations ai_cost_reservations ai_budget_control_audit ai_employee_budget_limits ai_org_budget_ceilings", STAFF, C,
    note="AI usage ledger: user id + hashes/tokens/cost; no prompt or response text")
reg("cron_runs ops_backup_runs rate_limit_counters health_score_events dead_events", MIXED, C, note="platform telemetry")

# — pending PRs (registered ahead of merge; status/disposition come from PENDING below) —
reg("subscription_cancellations", OWNER, C,
    note="cancellation ledger: claim + tombstone + refund-review flag; service-role only (RLS on, no policy)")
reg("privacy_deletion_requests", STAFF, C,
    note="deletion ledger / tombstone: opaque ids, step state, per-table counts; no names or emails; work set cleared on completion")
reg("privacy_retained_billing_records", OWNER, C,
    note="minimised archive of a deleted company's CrewFlow billing (Stripe handles, amounts, dates); no name/address/email")
reg("ai_platform_budget ai_platform_budget_audit", CFADMIN, C, HQ,
    "CrewFlow-wide monthly AI ceiling + its change audit (HQ super-admin id/email)")
for t in public_tables:
    if t.startswith("hq_") or t.startswith("ai_employee"):
        TABLES.setdefault(t, (CFADMIN, C, HQ, "HQ operating system (AI boardroom, event spine, memory)"))

# explicit per-table columns: column -> (category, likelihood)
D, I, N = "direct", "indirect", "incidental"
EXPLICIT = {
    "users": {"email": ("contact", D), "full_name": ("identity", D), "phone": ("contact", D),
              "avatar_url": ("image (profile photo URL)", D), "employment_type": ("employment", D),
              "start_date": ("employment", D)},
    "memberships": {"role": ("employment (role in organisation)", D)},
    "organizations": {"name": ("identity (business; personal if sole trader)", D), "slug": ("identity (business)", I),
                      "vat_number": ("tax identifier (business)", D), "address": ("contact (business address)", D),
                      "phone": ("contact", D), "email": ("contact", D), "bank_details": ("financial (bank details shown on invoices)", D),
                      "billing_email": ("contact", D), "stripe_customer_id": ("financial (payment-provider reference)", I),
                      "stripe_subscription_id": ("financial (payment-provider reference)", I),
                      "admin_org_notes": ("free text", N), "last_login_at": ("usage metadata", I),
                      "tos_accepted_at": ("contract acceptance record", I), "tos_version": ("contract acceptance record", I)},
    "customers": {"name": ("identity", D), "customer_type": ("identity (individual vs business)", I),
                  "company_number": ("business identifier", D), "vat_number": ("tax identifier (business)", D),
                  "phone_normalized": ("contact", D), "phone_sig": ("contact (keyed hash of phone)", I),
                  "postcode_normalized": ("contact", D), "country": ("contact", D), "portal_token": ("credential (portal access link)", I),
                  "portal_token_last_used_at": ("usage metadata", I)},
    "customer_contacts": {"name": ("identity", D), "role": ("identity (job role)", D), "portal_token": ("credential (portal access link)", I),
                          "portal_token_last_used_at": ("usage metadata", I)},
    "customer_portal_preferences": {"preferred_channel": ("contact preference", D), "contact_notes": ("free text", D)},
    "leads": {"service": ("enquiry content", D), "urgency": ("enquiry content", I), "estimated_value": ("financial", I),
              "preferred_callback_at": ("contact preference", D), "contact_phone_sig": ("contact (keyed hash of phone)", I),
              "lead_score": ("profiling (rule-based score)", I), "lead_score_band": ("profiling (rule-based score)", I),
              "lead_score_factors": ("profiling (rule-based score)", I), "source": ("marketing source", I)},
    "suppliers": {"name": ("identity (business; personal if sole trader)", D), "payment_terms_days": ("financial", I)},
    "cis_subcontractors": {"utr": ("tax identifier (UTR)", D), "legal_name": ("identity", D), "trading_name": ("identity", D),
                           "company_number": ("business identifier", D), "vat_number": ("tax identifier (business)", D),
                           "subcontractor_type": ("identity (sole trader/partnership/company)", D), "cis_status": ("tax status", D),
                           "deduction_rate": ("tax status", D), "verification_reference": ("tax identifier (HMRC verification)", D)},
    "cis_contractor_profiles": {"legal_name": ("identity (business)", D), "employer_paye_reference": ("tax identifier", D),
                                "accounts_office_reference": ("tax identifier", D), "contractor_utr": ("tax identifier (UTR)", D)},
    "cis_statements": {"subcontractor_name": ("identity", D), "subcontractor_utr_masked": ("tax identifier (masked UTR)", D),
                       "verification_number": ("tax identifier (HMRC verification)", D), "contractor_name": ("identity (business)", D),
                       "contractor_paye_reference": ("tax identifier", D), "gross_amount": ("financial (payments to a subcontractor)", D),
                       "deduction_amount": ("financial (tax deducted)", D)},
    "cis_monthly_return_lines": {"subcontractor_name": ("identity", D), "subcontractor_utr_masked": ("tax identifier (masked UTR)", D),
                                 "verification_number": ("tax identifier (HMRC verification)", D),
                                 "gross_amount": ("financial (payments to a subcontractor)", D), "deduction_amount": ("financial (tax deducted)", D)},
    "cis_monthly_returns": {"contractor_name": ("identity (business)", D), "contractor_paye_reference": ("tax identifier", D),
                            "accounts_office_reference": ("tax identifier", D)},
    "cis_payment_snapshots": {"legal_name": ("identity", D), "utr_masked": ("tax identifier (masked UTR)", D),
                              "verification_reference": ("tax identifier (HMRC verification)", D), "cis_gross_payment": ("financial", D),
                              "cis_deduction": ("financial (tax deducted)", D)},
    "staff_secrets": {"ni_number": ("government identifier (National Insurance number)", D)},
    "staff_compensation": {"hourly_pay": ("employment / pay", D), "emergency_contact": ("contact (third party: next of kin)", D)},
    "payroll_tax_profiles": {"date_of_birth": ("identity (date of birth)", D), "tax_region": ("employment / tax", D),
                             "student_loan_plan": ("financial (student-loan status)", D), "salary_sacrifice_annual_pence": ("employment / pay", D),
                             "ni_category": ("employment / tax (reveals age band)", D), "standard_hours_per_day": ("employment", D)},
    "payroll_lines": {c: ("employment / pay", D) for c in
                      "hours hourly_pay gross_pay paye_estimate ni_estimate net_pay overtime_hours overtime_multiplier overtime_pay leave_hours leave_pay".split()},
    "payroll_line_adjustments": {c: ("employment / pay", D) for c in
                                 "old_overtime_hours new_overtime_hours old_gross_pay new_gross_pay".split()},
    "pension_enrolments": {c: ("employment / pension", D) for c in
                           "status employee_contribution_rate employer_contribution_rate scheme_name assessment_date enrolment_date opt_out_date postponement_end_date".split()},
    "holiday_entitlements": {"annual_allowance_days": ("employment (leave)", D), "accrual_method": ("employment (leave)", I)},
    "leave_requests": {"type": ("employment (leave type — may reveal sickness)", D), "starts_at": ("employment (leave)", D),
                       "ends_at": ("employment (leave)", D), "status": ("employment (leave)", I)},
    "time_entries": {"started_at": ("employment (working time)", D), "ended_at": ("employment (working time)", D),
                     "breaks": ("employment (working time)", D), "gps_lat": ("location (precise) — LEGACY, no longer written", D),
                     "gps_lng": ("location (precise) — LEGACY, no longer written", D)},
    "rota_entries": {"starts_at": ("employment (schedule)", D), "ends_at": ("employment (schedule)", D)},
    "staff_qualifications": {"qualification_type": ("employment (qualification / card)", D), "title": ("employment (qualification / card)", D),
                             "reference_no": ("identifier (card / certificate number)", D), "issued_on": ("employment (qualification)", D),
                             "expires_on": ("employment (qualification)", D), "document_bucket": ("file reference", I),
                             "document_path": ("file reference (scan/photo of card — may show a face)", D)},
    "signatures": {"signer_name": ("identity", D), "signer_email": ("contact", D), "signature_text": ("identity (typed signature)", D),
                   "ip_address": ("device / technical (stores a keyed HASH of the IP, despite the name)", D),
                   "signature_image_path": ("image (drawn signature)", D), "signature_image_bucket": ("file reference", I)},
    "quotes": {"public_token": ("credential (public quote link)", I), "accept_signature": ("identity (typed name + hashed IP + time)", D),
               "customer_comment": ("free text", D), "viewed_at": ("usage metadata (link opened)", I)},
    "jobs": {"photos": ("images (site photos; people may appear incidentally)", N), "site_address_line1": ("contact (site address — often a home)", D),
             "site_address_line2": ("contact", D), "site_city": ("contact", D), "site_county": ("contact", D),
             "site_postcode": ("contact", D), "site_country": ("contact", D), "cancel_reason": ("free text", N)},
    "properties": {"address": ("contact (property address — often a home)", D)},
    "demo_requests": {"name": ("identity", D), "company": ("identity (business)", D), "employees": ("business profile", I),
                      "turnover_range": ("business profile", I), "current_systems": ("free text", N),
                      "preferred_demo_time": ("contact preference", I), "user_agent": ("device / technical — never written", D),
                      "stripe_checkout_session_id": ("financial (payment-provider reference)", I),
                      "stripe_checkout_url": ("financial (payment-provider reference)", I)},
    "waitlist": {"company_name": ("identity (business)", D), "trade": ("business profile", I), "employees": ("business profile", I)},
    "site_visitors": {"visitor_name": ("identity", D), "company": ("identity (employer)", D), "purpose": ("free text", N),
                      "vehicle_registration": ("identifier (vehicle registration)", D),
                      "signed_in_at": ("location / presence (on site at a time)", D), "signed_out_at": ("location / presence", D)},
    "site_inductions": {"person_name": ("identity", D), "person_company": ("identity (employer)", D), "inducted_at": ("health & safety record", D),
                        "signed_name": ("identity (typed signature)", D), "signature_image_path": ("image (drawn signature)", D)},
    "safety_acknowledgements": {"signed_name": ("identity (typed signature)", D), "signature_image_path": ("image (drawn signature)", D),
                                "acknowledged_at": ("health & safety record", D)},
    "worker_acknowledgements": {"signed_name": ("identity (typed signature)", D), "signature_image_path": ("image (drawn signature)", D),
                                "acknowledged_at": ("health & safety record", D)},
    "worker_signoff_tokens": {"worker_name": ("identity", D), "worker_company": ("identity (employer)", D), "token_hash": ("credential (hashed)", I)},
    "inspection_signoffs": {"signed_name": ("identity (typed signature)", D), "witness_name": ("identity", D),
                            "witness_organisation": ("identity (employer)", D)},
    "inspection_witness_invitations": {"witness_name": ("identity", D), "witness_organisation": ("identity (employer)", D)},
    "toolbox_talks": {"presenter": ("identity", D), "attendees": ("identity (attendee list) / health & safety record", D)},
    "permits_to_work": {"responsible_person": ("identity", D)},
    "risk_assessment_hazards": {"who_at_risk": ("health & safety (groups at risk; free text)", N)},
    "non_conformance_reports": {"responsible_subcontractor": ("identity (business)", D)},
    "asset_fuel_logs": {"station": ("location (fuel station)", I)},
    "fleet_vehicles": {"vin": ("identifier (vehicle)", I)},
    "assets": {"registration": ("identifier (vehicle registration)", I)},
    "telematics_readings": {"latitude": ("location (precise vehicle position — tracks the driver)", D),
                            "longitude": ("location (precise vehicle position — tracks the driver)", D),
                            "recorded_at": ("location history (time)", D)},
    "calls": {"caller_number": ("contact", D), "receiver_number": ("contact", D), "recording_url": ("communications content (call recording)", D),
              "transcript": ("communications content", D), "transcript_json": ("communications content", D), "ai_extracted": ("communications content", D)},
    "messages": {"from_addr": ("contact", D), "to_addr": ("contact", D), "media_urls": ("communications content (media)", D)},
    "conversations": {"contact_name": ("identity", D), "external_id": ("identifier (provider thread)", I)},
    "inbound_enquiries": {"caller": ("contact", D), "raw_text": ("communications content", D), "job_type": ("enquiry content", I),
                          "budget_gbp": ("financial", I)},
    "whatsapp_optouts": {"wa_id": ("contact (WhatsApp number)", D)},
    "whatsapp_inbound_media": {"caption": ("communications content", D), "transcript": ("communications content", D)},
    "whatsapp_number_routes": {"display_phone_number": ("contact (tenant business number)", I)},
    "phone_numbers": {"e164": ("contact (tenant business number)", I), "forwarding_from": ("contact", I)},
    "ai_receptionist_setups": {"business_phone": ("contact", D), "whatsapp_number": ("contact", D), "staff_numbers": ("contact (staff mobile numbers)", D),
                               "fallback_number": ("contact", D), "urgent_escalation_number": ("contact", D), "notify_email": ("contact", D),
                               "notify_sms": ("contact", D), "facebook_page": ("identity (business)", I), "instagram_handle": ("identity (business)", I)},
    "push_subscriptions": {"endpoint": ("device identifier (browser push endpoint)", D), "p256dh": ("device key", I), "auth": ("device key", I)},
    "sms_deliveries": {"to_phone": ("contact", D)},
    "notification_email_queue": {"to_email": ("contact", D), "reply_to_email": ("contact", D), "body_text": ("communications content", D),
                                 "body_html": ("communications content", D)},
    "report_subscriptions": {"recipients": ("contact (email addresses)", D)},
    "invoice_reminders": {"recipient": ("contact", D)},
    "impersonation_sessions": {"ip_address": ("device / technical (RAW IP of the CrewFlow operator)", D)},
    "rate_limit_counters": {"key": ("device / technical — route + keyed digest of IP / email / portal token (raw before this branch)", D)},
    "bank_statement_lines": {"description": ("financial (transaction narrative; counterparty names)", D), "reference": ("financial", D)},
    "payments": {"reference": ("financial", I), "method": ("financial", I)},
    "supplier_payments": {"reference": ("financial", I), "gross_amount": ("financial (payments to a supplier)", I), "cis_withheld": ("financial (tax deducted)", I)},
    "ai_invocations": {"content_hash": ("pseudonymous (hash of prompt)", I)},
    "import_rows": {"raw": ("structured blob (the imported row verbatim: names, emails, phones)", D), "mapped": ("structured blob", D)},
    "tenant_search_documents": {"content": ("free text (denormalised copy of tenant records)", D), "embedding": ("derived vector of that text", I)},
    "hq_sales_companies": {"name": ("identity (business)", D), "primary_email": ("contact", D), "primary_phone": ("contact", D),
                           "linkedin_url": ("online identifier", D), "website": ("online identifier (business)", I),
                           "companies_house_number": ("business identifier", I), "assigned_to_email": ("contact (CrewFlow operator)", D),
                           "enrichment": ("structured blob", N)},
    "hq_sales_contacts": {"full_name": ("identity", D), "title": ("identity (job title)", D), "seniority": ("identity (job seniority)", D),
                          "linkedin_url": ("online identifier", D), "is_decision_maker": ("profiling (sales qualification)", I)},
    "hq_sales_channels": {"value": ("contact (channel value: phone/email/handle)", D)},
    "hq_sales_locations": {"latitude": ("location (business premises)", I), "longitude": ("location (business premises)", I)},
    "hq_sales_calls": {"recording_url": ("communications content (call recording)", D), "transcript": ("communications content", D),
                       "sentiment": ("profiling (sentiment)", I), "sentiment_score": ("profiling (sentiment)", I)},
    "hq_sales_timeline_events": {"subject": ("communications content", D)},
    "hq_sales_sourcing_pool": {"name": ("identity (business; Companies House register)", I), "company_number": ("business identifier", I)},
    "hq_comms_suppressions": {"address": ("contact (suppressed address)", D)},
    "hq_communications": {"to_address": ("contact", D)},
    "hq_memories": {"organisation_name": ("identity (business)", I), "title": ("free text", N)},
    "marketplace_partners": {"contact_email": ("contact", D)},
    "calendar_pulled_events": {"summary": ("free text (calendar event title)", D), "location": ("location (event)", D),
                               "starts_at": ("schedule", D), "ends_at": ("schedule", D)},
    "calendar_connections": {"external_account_id": ("online identifier (calendar account)", D)},
    "hmrc_connections": {"hmrc_vrn": ("tax identifier (VAT number)", D), "gov_client_ids": ("device identifier (HMRC fraud-prevention client ids)", D)},
    "org_payment_connections": {"stripe_account_id": ("financial (payment-provider reference)", I), "account_name": ("identity (business)", I)},
    "billing_invoices": {"stripe_invoice_id": ("financial (payment-provider reference)", I), "amount_gbp": ("financial", I)},
    "org_subscriptions": {"stripe_customer_id": ("financial (payment-provider reference)", I)},
    "service_bookings": {"contact_name": ("identity", D)},
    "variation_requests": {"requester_name": ("identity", D)},
    "completion_certificates": {"content": ("structured blob (snapshot incl. customer + site)", D), "snapshot": ("structured blob", D)},
    "site_reports": {"content": ("structured blob (snapshot incl. customer + site)", D), "snapshot": ("structured blob", D)},
    "job_document_versions": {"form_data": ("structured blob (completed form)", D)},
    "voice_notes": {"audio_url": ("communications content (voice recording)", D)},
    "expense_drafts": {"supplier_name": ("identity (business)", I)},
    "accounting_connections": {"external_tenant_id": ("online identifier (accounting tenant)", I)},
    "sso_provisioning_audit": {"subject": ("identity (SSO subject / email)", D)},
    "mfa_recovery_codes": {"code_hash": ("credential (hashed)", I)},
    # pending PRs
    "subscription_cancellations": {"stripe_subscription_id": ("financial (payment-provider reference)", I),
                                   "details": ("structured blob (Stripe period bounds + pro-rata estimate; HQ-only)", I)},
    "privacy_deletion_requests": {"target_org_id": ("subject link (company being deleted)", I),
                                  "actor_user_id": ("user identifier (who requested the deletion)", I),
                                  "work": ("structured blob (transient: member ids + Stripe handles; cleared on completion)", I)},
    "privacy_retained_billing_records": {"former_org_id": ("subject link (deleted company)", I),
                                         "stripe_customer_id": ("financial (payment-provider reference)", I),
                                         "stripe_subscription_id": ("financial (payment-provider reference)", I),
                                         "stripe_invoice_id": ("financial (payment-provider reference)", I),
                                         "stripe_payment_intent_id": ("financial (payment-provider reference)", I),
                                         "amount_gbp": ("financial (what the company paid CrewFlow)", I)},
}

# auth / storage (Supabase-managed schemas)
AUTH_EXPLICIT = {
    "auth.users": {"email": ("contact", D), "phone": ("contact", D), "encrypted_password": ("credential (bcrypt hash)", D),
                   "raw_user_meta_data": ("structured blob (OAuth profile: name, picture URL, email)", D),
                   "raw_app_meta_data": ("structured blob (provider list)", I), "last_sign_in_at": ("usage metadata", I),
                   "email_change": ("contact", D), "phone_change": ("contact", D), "confirmation_token": ("credential (hashed)", I),
                   "recovery_token": ("credential (hashed)", I), "banned_until": ("account status", I), "id": ("user identifier", I)},
    "auth.identities": {"identity_data": ("structured blob (OAuth profile: name, picture URL, email)", D), "email": ("contact", D),
                        "provider": ("authentication (provider)", I), "provider_id": ("online identifier (provider subject id)", D),
                        "user_id": ("user identifier", I), "last_sign_in_at": ("usage metadata", I)},
    "auth.sessions": {"ip": ("device / technical (RAW IP address)", D), "user_agent": ("device / technical", D), "user_id": ("user identifier", I),
                      "refreshed_at": ("usage metadata", I)},
    "auth.audit_log_entries": {"payload": ("structured blob (auth event: actor email, action)", D), "ip_address": ("device / technical (RAW IP address)", D)},
    "auth.mfa_factors": {"secret": ("credential (TOTP secret)", D), "phone": ("contact", D), "friendly_name": ("free text", N), "user_id": ("user identifier", I)},
    "auth.mfa_challenges": {"ip_address": ("device / technical (RAW IP address)", D)},
    "auth.refresh_tokens": {"token": ("credential", D), "user_id": ("user identifier", I)},
    "auth.one_time_tokens": {"token_hash": ("credential (hashed)", I), "relates_to": ("contact (email the token was sent to)", D), "user_id": ("user identifier", I)},
    "auth.flow_state": {"provider_access_token": ("credential (OAuth provider token)", D), "provider_refresh_token": ("credential (OAuth provider token)", D),
                        "user_id": ("user identifier", I)},
    "auth.saml_relay_states": {"for_email": ("contact", D)},
    "auth.webauthn_credentials": {"public_key": ("credential (passkey public key)", I), "user_id": ("user identifier", I)},
    "storage.objects": {"name": ("file reference (path: <org_id>/…/filename — filenames can name people)", D), "owner": ("user identifier (uploader)", I),
                        "owner_id": ("user identifier (uploader)", I), "metadata": ("structured blob (size, mimetype)", I),
                        "user_metadata": ("structured blob", N)},
}
AUTH_META = {
    "auth.users": ("Supabase Auth: sign-up / sign-in (email+password, magic link, Google OAuth)", "app/(auth)/actions.ts; app/auth/callback/route.ts"),
    "auth.identities": ("Supabase Auth on OAuth / email identity creation", "app/(app)/settings/security (linked identities)"),
    "auth.sessions": ("Supabase Auth on every sign-in / refresh", "not read by app code"),
    "auth.audit_log_entries": ("Supabase Auth (0 rows in prod — auth audit rows are not being persisted to the DB)", "not read by app code"),
    "auth.mfa_factors": ("Supabase Auth MFA enrol (app/(app)/settings/security/actions.ts)", "settings/security"),
}

# generic column-name rules (first match wins): (regex, category, likelihood, uuid_only)
RULES = [
    (r"^(ip|ip_address|ip_hash)$", "device / technical (IP address or keyed hash)", D, False),
    (r"^user_agent$", "device / technical (browser user agent)", D, False),
    (r"(^|_)(email|to_email|from_address|to_address)($|_)", "contact (email address)", D, False),
    (r"(^|_)(phone|mobile|e164|caller_number|receiver_number|phone_number|to_phone)($|_)", "contact (phone number)", D, False),
    (r"^(address|address_line1|address_line2|city|county|postcode|site_postcode)$", "contact (postal address)", D, False),
    (r"^(contact_ref|customer_ref|to_ref|recipient|contact_name|contact_email|contact_phone)$", "contact / identity", D, False),
    (r"^(latitude|longitude)$", "location (coordinates)", D, False),
    (r"^(signed_name|signer_name|signature_text)$", "identity (typed signature)", D, False),
    (r"signature_image_path$", "image (drawn signature)", D, False),
    (r"^(actor_name|author_email|actor_email|operator_email|.*_by_email|.*operator_email|admin_email|reviewer_email|approver_email|authored_by_email)$",
     "identity / contact (actor)", D, False),
    (r"^(user_id|actor_id|author_id|author_user_id|assigned_to|assignee_id|driver_id|host_user_id|reviewer_id|approver_id|operator_id|"
     r"from_operator_id|to_operator_id|responsible_user_id|assessor_id|target_user_id|admin_user_id|onboarding_owner_id|"
     r"delegate_to|presenter_id|created_by_id|.*_by)$", "user identifier (link to a person's account)", I, True),
    (r"^(customer_id|lead_id|contact_id|supplier_id|target_membership_id|membership_id|parent_customer_id)$",
     "subject link (record is about this person / business)", I, True),
    (r"^(portal_token|public_token|token|token_hash|access_token|refresh_token|secret|key_hash|provider_auth_secret|account_secret|"
     r"verification_token|oidc_client_secret_ciphertext)$", "credential / access token", I, False),
    (r"^(transcript|transcript_json|raw_text|recording_url|audio_url|body|body_text|body_html|inbound_text|draft|safe_text|outbound_draft)$",
     "communications content", D, False),
    (r"^(storage_path|filename|file_name|source_filename|receipt_url|document_path)$", "file reference (document / image)", N, False),
    (r"^(notes?|description|message|comments?|reason|review_note|note|.*_notes|.*_note|ai_summary|summary|work_summary|delays|"
     r"key_points|statement|closure_comment|completion_comment|decision_reason|rejection_reason|void_reason|cancel_reason|"
     r"cancellation_reason|withdraw_reason|revoke_reason|revocation_reason|resolution_note|hq_notes|contact_notes|"
     r"text_content|detail|caption|approval_comment|customer_comment)$", "free text (may contain personal data)", N, False),
    (r"^(payload|metadata|raw|extracted|ai_extracted|form_data|proposed_payload|edited_payload|information|result|"
     r"execution_result|pending_actions|content|snapshot|line_items)$", "structured blob (may contain personal data)", N, False),
]
RULES = [(re.compile(rx), cat, lik, uo) for rx, cat, lik, uo in RULES]

# columns the rules would catch but which are NOT personal
NOT_PERSONAL = {
    ("weather_readings", "resolved_lat"), ("weather_readings", "resolved_lon"),
    ("email_inbound_routes", "inbound_address"), ("help_articles", "body"), ("help_articles", "summary"),
    ("ai_employees", "description"), ("hq_memory_types", "description"), ("hq_capabilities", "description"),
    ("marketplace_listings", "description"), ("asset_inspection_templates", "description"),
    ("inspection_plan_templates", "description"), ("job_templates", "description"), ("service_catalog", "description"),
    ("price_book_items", "description"), ("stock_items", "description"), ("quote_template_lines", "description"),
    ("merchant_catalogue_items", "description"), ("automation_custom_rules", "description"), ("hq_ai_schedules", "description"),
    ("webhook_endpoints", "description"), ("ops_backup_runs", "error"), ("hq_sales_call_scripts", "summary"),
    ("hq_sales_call_scripts", "body"), ("hq_sales_learnings", "summary"), ("hq_sales_learnings", "result"),
    ("ai_employee_kpis", "summary"), ("cron_runs", "summary"),
}
# column NAMES the rules would catch that are provider ids / toggles, not personal data
NOT_PERSONAL_COLS = {"email_cadence", "email_enabled", "email_id", "notification_email_id", "phone_number_id",
                     "phone_region", "email_optional"}
SKIP_TABLES = {t for t in public_tables if re.match(r"hq_events_(\d{4}_\d{2}|default)$", t)}
# The local database is SHARED with sibling workstreams, which may have applied
# objects that do not exist on this branch. Anything this worktree's migrations
# do not create is reported and skipped, so the register describes THIS branch.
_all_mig = "".join(open(os.path.join(mig_dir, f)).read().lower() for f in sorted(os.listdir(mig_dir)))
FOREIGN_TABLES = {t for t in public_tables if t not in SKIP_TABLES and not re.search(
    r"(table|view)\s+(if not exists\s+)?(public\.)?\"?" + re.escape(t) + r"\"?[\s(]", _all_mig)}

# Foreign tables that belong to a KNOWN pending PR are registered (marked PENDING) rather than
# skipped, so the inventory is ready the day that PR merges. Their export/erasure disposition is
# the one the owning PR declares (its own lib/gdpr/org-tables.json / design doc), quoted here
# because this branch's org-tables.json does not contain them. Any OTHER foreign table is still
# reported and skipped.  (status, export, erasure)
PENDING = {
    "subscription_cancellations": (
        "PENDING — PR #1090 billing (migration 20261355000000), not on main",
        "EXCLUDED from the export ZIP (per #1090 org-tables.json: platform billing)",
        "anonymise per #1090 org-tables.json (row kept; requested_by_email + reason scrubbed)"),
    "privacy_deletion_requests": (
        "PENDING — PR #1091 deletion (migration 20261359000000), not on main; feature DARK (FEATURE_ACCOUNT_DELETION)",
        "not org-scoped (platform deletion ledger)",
        "this IS the deletion ledger: the completed row is the tombstone (ids + counts, work set cleared)"),
    "privacy_retained_billing_records": (
        "PENDING — PR #1091 deletion (migration 20261359000000), not on main; written only by a company deletion",
        "not org-scoped (archive of a deleted company's CrewFlow billing)",
        "retained until retention_until (6 y after year end per #1091 [LEGAL]); purge SQL staged, approval-only"),
    "ai_platform_budget": (
        "PENDING — AI workstream ai/spend-governance (migration 20261358000000), not on main",
        "not org-scoped", "not org-scoped (platform setting)"),
    "ai_platform_budget_audit": (
        "PENDING — AI workstream ai/spend-governance (migration 20261358000000), not on main",
        "not org-scoped", "not org-scoped (append-only HQ audit)"),
}
SKIP_TABLES |= (FOREIGN_TABLES - set(PENDING))

# where a table's data leaves the system (besides backups, which apply to ALL rows)
BACKUPS = "Supabase managed backups + weekly encrypted off-platform backup (Backblaze B2)"
LEAVES = {
    "users": "Resend (account/notification email to the address); Supabase Auth email (via Resend SMTP)",
    "organizations": "Stripe (name + email on the billing customer); Resend; PDFs/emails sent to the tenant's customers (name, address, VAT no., bank details)",
    "customers": "Resend (quote/invoice/statement emails to the customer); PDFs; GDPR export ZIP; Anthropic only as free text typed into quote notes (names/contact fields are excluded by the disclosure contract)",
    "customer_contacts": "Resend (emails to the contact); GDPR export ZIP",
    "leads": "Anthropic (lead summary — tier armed in prod); Resend (lead notifications to tenant staff); GDPR export ZIP",
    "quotes": "Resend (quote email + PDF to the customer); public /q/<token> page; Anthropic (quote writer, minimised context); GDPR export ZIP",
    "invoices": "Resend (invoice/reminder email + PDF to the customer); customer portal; accounting CSV export; GDPR export ZIP",
    "notification_email_queue": "Resend (the queued email is the payload)",
    "notifications": "Resend (email channel); push/SMS channels dormant",
    "demo_requests": "Resend (confirmation to the prospect + notification to HQ); Stripe Checkout (prospect email, when HQ issues a setup-fee link)",
    "payroll_lines": "Payslip PDF + payroll CSV downloaded by the tenant admin (includes NI number); GDPR export ZIP",
    "staff_secrets": "Payslip PDF + payroll CSV downloaded by the tenant admin. Excluded from the GDPR export ZIP and from search/embeddings",
    "signatures": "shown to tenant staff on the quote page; GDPR export ZIP",
    "imports": "Anthropic vision (imports.ocr) for scanned/PDF/image imports",
    "import_files": "Anthropic vision (imports.ocr) for scanned/PDF/image imports",
    "form_import_drafts": "Anthropic vision (document.form_autofill)",
    "expense_drafts": "Anthropic vision (expense.receipt_extraction)",
    "tenant_search_documents": "OpenAI embeddings ONLY if the tenant-search embed flag is enabled (dormant: 0 rows embedded in prod)",
    "hq_memories": "OpenAI embeddings (memory.embedding_write — active in prod); Anthropic (HQ narratives)",
    "voice_notes": "OpenAI transcription (dormant: no capture surface)",
    "calls": "Twilio / voice provider (dormant)",
    "messages": "Meta WhatsApp Cloud API (armed, no traffic); Twilio SMS (dormant)",
    "comm_events": "inbound from Resend webhook (not sent onward)",
    "billing_invoices": "Stripe",
    "org_subscriptions": "Stripe",
    "billing_events": "inbound from Stripe webhook",
    "push_subscriptions": "browser vendor push services (dormant)",
    "ai_invocations": "none (ledger only; the PROMPT went to the AI provider at call time)",
    "rate_limit_counters": "none",
    "cron_runs": "none",
    "subscription_cancellations": "Stripe (the cancel / schedule call carries the subscription id); HQ notification + owner confirmation email via Resend",
    "privacy_deletion_requests": "none (tombstone export to a separate append-only object beside the off-platform backup — staged, not wired)",
    "privacy_retained_billing_records": "none",
}

# ───────────────────────────── 5. emit rows ─────────────────────────────
HEADER = ["schema", "table", "column", "data_type", "object", "category", "likelihood", "data_subject", "crewflow_role",
          "feature_status", "written_by", "read_by", "db_side_writers", "access", "leaves_system", "gdpr_export",
          "gdpr_erasure", "retention_purgeable", "prod_rows_table", "notes"]
rows = []
tables_seen = set()


def disposition(table):
    if table not in KNOWN:
        return ("not org-scoped (outside the org export)", "not org-scoped (outside org erasure)")
    if table in SERVICE_SIDE:
        exp = "included (service-role lane)"
    elif table in EXCLUDED:
        exp = "EXCLUDED from the export ZIP"
    else:
        exp = "included"
    era = "anonymise (row kept, PII-named columns scrubbed)" if table in ANON else \
        "retain untouched" if table in RETAIN else "hard delete"
    return exp, era


for schema, table, column, dtype, ttype in cols:
    is_view = ttype == "VIEW"
    if schema == "public":
        if table in SKIP_TABLES:
            continue
        cat = lik = None
        ex = EXPLICIT.get(table, {})
        if column in ex:
            cat, lik = ex[column]
        elif (table, column) in NOT_PERSONAL or column in NOT_PERSONAL_COLS:
            continue
        else:
            for rx, c, l, uuid_only in RULES:
                if rx.search(column):
                    if uuid_only and dtype != "uuid":
                        continue
                    if c.startswith("structured blob") and dtype not in ("jsonb", "json", "ARRAY"):
                        continue
                    cat, lik = c, l
                    break
        if not cat:
            continue
        subject, role, status, note = TABLES.get(table, (MIXED, P, ACTIVE, ""))
        if is_view:
            note = (note + "; " if note else "") + "VIEW over base tables"
        ref = refs.get(table, {"r": [], "w": [], "heur": False})
        exp, era = disposition(table)
        if table in PENDING:
            status, exp, era = PENDING[table]
            if not (ref["r"] or ref["w"]):
                ref = {"r": ["(code is on the owning PR branch)"], "w": [], "heur": False}
        rows.append([schema, table, column, dtype, "view" if is_view else "table", cat, lik, subject, role, status,
                     paths(ref["w"]) or ("" if not sqlw.get(table) else "(no app-code writer found)"),
                     paths(ref["r"]),
                     ("migrations " + ", ".join(sorted(sqlw[table])[:3]) + (" …" if len(sqlw[table]) > 3 else "")) if sqlw.get(table) else "",
                     access_summary(table, is_view), LEAVES.get(table, "") + ("; " if LEAVES.get(table) else "") + BACKUPS,
                     exp, era, "yes (per-org policy; purge flag OFF => dry-run)" if table in PURGEABLE else "no",
                     prod_counts.get(f"public.{table}", ""), note + ("; static-scan match is heuristic" if ref["heur"] and (ref["r"] or ref["w"]) else "")])
        tables_seen.add(table)
    else:
        key = f"{schema}.{table}"
        ex = AUTH_EXPLICIT.get(key)
        if not ex or column not in ex:
            continue
        cat, lik = ex[column]
        w, r = AUTH_META.get(key, ("Supabase-managed", "Supabase-managed"))
        rows.append([schema, table, column, dtype, "table", cat, lik,
                     STAFF if schema == "auth" else MIXED, C if schema == "auth" else P, ACTIVE, w, r, "",
                     "service role / Supabase Auth only (not exposed through the Data API)" if schema == "auth"
                     else "storage RLS: org-prefixed paths; all 13 buckets are PRIVATE (signed URLs)",
                     BACKUPS, "not in the org export ZIP" if schema == "auth" else "files are not in the export ZIP (metadata rows are)",
                     "not touched by org erasure (account deletion is a separate workstream)" if schema == "auth"
                     else "removed by org erasure (Storage API, 13 buckets)",
                     "no", prod_counts.get(key, ""), "Supabase-managed schema"])

with open(os.path.join(OUT_DIR, "data-register.csv"), "w", newline="") as fh:
    wtr = csv.writer(fh)
    wtr.writerow(HEADER)
    wtr.writerows(rows)

# summary for the markdown register
summary = collections.OrderedDict()
for r in rows:
    key = f"{r[0]}.{r[1]}"
    s = summary.setdefault(key, {"columns": 0, "direct": 0, "subject": r[7], "role": r[8], "status": r[9],
                                 "prod_rows": r[18], "export": r[15], "erasure": r[16], "purgeable": r[17], "note": r[19]})
    s["columns"] += 1
    if r[6] == "direct":
        s["direct"] += 1
json.dump({"generated_from": "local catalogue + static code scan", "tables": summary,
           "totals": {"rows": len(rows), "tables": len(summary),
                      "direct_columns": sum(1 for r in rows if r[6] == "direct")}},
          open(os.path.join(OUT_DIR, "data-register-summary.json"), "w"), indent=1)

unclassified = sorted(t for t in public_tables if t not in TABLES and t not in SKIP_TABLES and t in tables_seen)
print(f"rows={len(rows)} tables={len(summary)} direct={sum(1 for r in rows if r[6]=='direct')}")
print("registered as PENDING (in the shared local DB, created by a known pending PR):", " ".join(sorted(FOREIGN_TABLES & set(PENDING))) or "none")
print("skipped (in the shared local DB but not created by this branch's migrations):", " ".join(sorted(FOREIGN_TABLES - set(PENDING))) or "none")
print("tables with personal-data columns but NO curated TABLES entry (defaulted to mixed/processor/ACTIVE):")
print("  " + " ".join(unclassified))
