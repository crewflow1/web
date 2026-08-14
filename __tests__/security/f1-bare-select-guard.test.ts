import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * F-1 BARE-SELECT GUARD (repo-wide) — a read on a HIGH-VALUE (money / ledger /
 * reconciliation / cross-tenant-producer) table must be paginated or bounded.
 *
 * WHY: PostgREST clamps every response to max_rows=1000 (supabase/config.toml).
 * A BARE `.from(TABLE).select(...)` that materialises a set for aggregation /
 * export / scoring / reconciliation silently returns AT MOST 1000 rows with NO
 * error — the F-1 truncation class. The sibling `.limit`-clamp guard
 * (f1-limit-clamp-guard.test.ts) cannot see this: a bare select carries no
 * `.limit(`/`.range(` for it to inspect.
 *
 * RULE: for every `.from("<HIGH_VALUE_TABLE>")` read, the same statement MUST
 * contain one of:
 *   - `.single(` / `.maybeSingle(`  → a single-row read (bounded)
 *   - `.range(`                     → paged (fetchAllRows) — the complete-read fix
 *   - `.limit(N)` with N < 1000     → an HONEST bounded sample (you asked for
 *                                     fewer than the cap, so there is no
 *                                     ambiguity with truncation; its size is
 *                                     also policed by the sibling clamp guard)
 * Anything else is a BARE unpaginated read → FAIL (silent 1000-row truncation).
 *
 * THE .limit(1000) BOUNDARY (the trap this wave closes). An exactly-at-boundary
 * `.limit(1000)` — the PostgREST max_rows value itself, whether written as a
 * literal or a same-file const that resolves to 1000 — is INDISTINGUISHABLE from
 * silent truncation: you cannot tell a genuine top-1000 sample from a 5000-row
 * set clamped to 1000. So `.limit(1000)` on a high-value / producer read that
 * materialises a set does NOT satisfy this guard. It must page via fetchAllRows
 * (COMPLETE) or, if it is a genuinely-bounded top-1000 display sample, carry an
 * ALLOWLIST entry with a written reason. This is exactly how the LIVE
 * invoice.overdue producer scan (lib/invoices/overdue-scheduler.ts) starved once
 * the standing overdue backlog crossed 1000: `.limit(1000)` sat on the boundary
 * and slipped past BOTH F-1 guards.
 *
 * A genuinely-bounded read that the analyser cannot see (rare) may be added to
 * ALLOWLIST with a written justification — prefer fetchAllRows or an honest
 * `.limit(<1000)` instead.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];
const CLAMP = 1000; // PostgREST max_rows (supabase/config.toml)

// Tables whose completeness matters: money, ledgers, reconciliation, exports,
// and cross-tenant producers/aggregators. A read of one of these that is not a
// single-row lookup MUST page.
const HIGH_VALUE_TABLES = new Set<string>([
  "finances",
  "invoices",
  "invoice_payments",
  "invoice_line_items",
  "quotes",
  "supplier_payments",
  "supplier_payment_allocations",
  "purchase_orders",
  "purchase_order_line_items",
  "goods_received_notes",
  "goods_received_lines",
  "payroll_lines",
  // Hours source for payroll: a clamped read UNDERSTATES gross/PAYE/NI/net pay
  // for a >1000-entry month (createPayrollRun), and cross-tenant (RLS admits
  // every org the caller belongs to).
  "time_entries",
  // Quote line items: a clamped read serves a quote PDF / builder / portal view
  // with totals but only the first 1000 lines — and the builder re-save would
  // then wipe the dropped lines.
  "quote_line_items",
  "stock_movements",
  "bank_statement_lines",
  "telematics_connections",
  "telematics_readings",
  "fleet_vehicles",
  "weather_watches",
  "weather_readings",
  // CRM core: high-value, cross-tenant (RLS admits every org the caller belongs
  // to) tables that feed calendars, pickers, pipelines and exports. A clamped
  // read silently drops jobs from the schedule grid, nulls out-of-cap customer
  // links on an edit, or under-counts the sales pipeline. (F-1 CRM wave.)
  "jobs",
  "leads",
  "customers",
  // Sites/addresses: high-value, cross-tenant (RLS admits every org the caller
  // belongs to), and a quote/job reference picker. A clamped read silently drops
  // sites from the builder and — on an edit — nulls an out-of-cap property_id.
  // (F-1 picker-class wave.)
  "properties",
  // Support OS: CROSS-TENANT service-role reads (createAdminClient, no org pin)
  // whose FULL row set is mapped + counted in JS into figures the pure layers
  // label "fact" — the live /admin/support board + KPI tiles, the /admin/support-ai
  // triage board, and hq-product's CEO demand aggregation. A clamped read silently
  // truncated all three at 1000 cross-tenant rows. (F-1 support wave; the fix paged
  // every set read in server/services/hq-support-snapshot.ts via fetchAllRows.)
  // support_messages: the batched per-ticket thread reads (list preview +
  // internal-notes flag, and the full HQ detail thread) — a clamp drops the
  // newest replies and corrupts the derived flags.
  //
  // KNOWN DETECTION LIMITATION (reported for a scoped follow-up, NOT closed here):
  // every real support read uses either a `.from("support_tickets" as never)` CAST
  // (the idiom for tables that post-date the generated types) or a
  // `function adminTable(name){ return admin.from(name as never) }` /
  // `function table(name){…}` DECLARATION-wrapper called with a single literal arg
  // — and BOTH forms are invisible to the direct/arrow-wrapper matchers below. So
  // listing these tables makes the guard bite the STANDARD literal shape (proved by
  // the delete-the-fix test) and any future literal read, but does NOT yet police
  // the existing cast/decl-wrapper reads. Teaching the matchers those two forms
  // surfaces 11 offenders across 6+ tables (6 pre-existing bounded money-table
  // reads hidden by the cast, plus support reads in hq-health-deep-dive.ts /
  // customer-support-service.ts / customer-portal) — over the wave's 10-offender
  // stop line, so it is deferred to its own wave rather than mass-edited here.
  "support_tickets",
  "support_messages",
  // ── HQ estate / cross-tenant completeness audit (the .from(as never) cast wave).
  // These post-date the generated types and are read almost exclusively via the
  // `.from("x" as never)` cast or the untypedAdminTable(...) wrapper — invisible to
  // the guard until the cast-form matcher was taught. Each has a CROSS-TENANT,
  // estate-wide set read that is mapped/summed in JS into an HQ figure:
  //   organizations       — the estate roster (hq-snapshot, hq-analytics, hq-alerts,
  //                         retention/health snapshots): every org mapped into KPIs.
  //   billing_invoices    — every billing invoice across the estate, folded into
  //                         MRR / outstanding_gbp / failed_90d money (hq-analytics,
  //                         hq-alerts, hq-billing, health-deep-dive).
  //   notifications       — per-org and cross-tenant (HQ bell) recency reads; the
  //                         .limit(Math.min(limit,1000)) sits on the PostgREST cap.
  //   health_score_events — per-org health timeline; same .limit(1000) boundary.
  "organizations",
  "billing_invoices",
  "notifications",
  "health_score_events",
  // ── Job billing schedule / retention (F-1 portal-schedule residual wave). All
  // cross-tenant (RLS admits every org the caller belongs to) and read org-wide
  // over a fully-paged jobId set on the RLS-bypassing portal admin client. A
  // clamped read is a CUSTOMER-FACING money/correctness defect:
  //   retention_releases  — a clamped read UNDER-counts released retention, so
  //                         held = max(0, accrued − released) OVER-states the
  //                         retention held shown to the customer (portal-schedule).
  //   job_billing_plans   — a clamped read drops planIds, so stages of later
  //                         plans vanish from the customer's schedule.
  //   job_billing_stages  — a clamped read silently drops schedule rows.
  "job_billing_plans",
  "job_billing_stages",
  "retention_releases",
  // ── Portal completeness + payroll total-omission (C65 wave). All feed a
  //    completeness surface, so a clamped/bare read silently drops rows:
  //   site_reports          — the customer-portal report list (listPortalReports)
  //                           AND one of the four contributors to the documents-
  //                           library `{documents.length} total` count and the
  //                           "Download all (zip)" X-Bulk-Total header; a bare
  //                           select clamped at 1000 dropped the oldest reports.
  //   completion_certificates — the customer-portal certificate list
  //                           (listPortalCertificates), same documents-library
  //                           count + ZIP total contributor; the read was BARE
  //                           (no limit/range) → clamped at 1000.
  //   memberships           — drives the WHOLE payroll run (createPayrollRun): one
  //                           payroll_line per member, so a clamped read gives
  //                           overflow workers NO pay while the run reports success.
  "site_reports",
  "completion_certificates",
  "memberships",
  // ── C65 COVERAGE-BLIND-SPOT WAVE — two cross-tenant estate tables the new
  //    coverage meta-guard (below) surfaced as GENUINELY completeness-sensitive
  //    (not rubber-stampable into COVERAGE_REVIEWED). Both were live silent
  //    truncations of the exact C63/C64/C65 class, now PAGED:
  //   demo_requests      — the estate-wide demo funnel: read bare and SUMMED by
  //                        status into the HQ snapshot / marketing / customer-
  //                        success figures and listed on the /admin/demos +
  //                        /admin/organizations boards. A clamp under-counted the
  //                        funnel and dropped the oldest demos past 1000.
  //   hq_sales_companies — the estate sales pipeline mapped/reduced into the sales
  //                        orchestrator counts; the old `.limit(1000)` sat on the
  //                        max_rows boundary (indistinguishable from truncation).
  "demo_requests",
  "hq_sales_companies",
  // ── staff_secrets (C66 cast-form de-vacuum). Per-user NI numbers read by
  //    fetchNiNumbersForOrg (lib/staff/secrets.ts) and folded into the statutory
  //    RTI/bureau payroll CSV (app/api/payroll/[id]/csv/route.ts) + payslips. It
  //    was FALSELY listed PER-ORG in COVERAGE_REVIEWED ("bounded by the org's
  //    headcount") — but the read was a BARE `.eq('org_id')` select, clamped at
  //    max_rows=1000, so an org with >1000 staff silently dropped NI numbers from
  //    the CSV (a compliance defect that fails with no error). Now PAGED via
  //    fetchAllRows (order by the unique user_id); policed here so a re-bared read
  //    fails CI.
  "staff_secrets",
  // ── C66 cast-form de-vacuum — three tables whose completeness-sensitive reads
  //    were surfaced by the depth-aware `;`-windowing and are now PAGED (moved
  //    here from the coverage blind spot, not COVERAGE_REVIEWED):
  //   review_requests    — the CROSS-ORG cron scan (runReviewRequestSends) reads
  //                        every DUE scheduled request and sends each; a bare read
  //                        clamped at 1000 left the overflow unsent. Now paged.
  //   portal_uploads     — the portal invoices page reads payment proofs
  //                        `.in('target_id', <fully-paged invoice ids>)` (id set can
  //                        exceed the cap, several proofs per invoice); now chunked
  //                        + paged. (The per-invoice `.limit(50)` panel read is an
  //                        honest bounded sample.)
  //   hq_sales_timeline_events — the orchestrator cadence read counts distinct
  //                        touched companies over `.in(<fully-paged activeIds>)`;
  //                        the old `.limit(1000)` inflated "overdue". Now chunked
  //                        + paged. (Its per-company `.limit(200)` relationship-
  //                        score read is an honest bounded sample.)
  "review_requests",
  "portal_uploads",
  "hq_sales_timeline_events",
]);

// "file:line" → reason. Keep tight; every entry is a documented smell.
const ALLOWLIST: Record<string, string> = {
  // Surfaced only once the guard learned to see the `table()` `.from`-wrapper
  // indirection (below). The read is GENUINELY BOUNDED, just not in a way the
  // static analyser can see: `.in("id", idsChunk)` where `idsChunk` is
  // `paymentIds.slice(i, i + JOIN_CHUNK)` with JOIN_CHUNK=500, and
  // supplier_payments.id is unique — so each call returns ≤500 rows, below the
  // 1000 cap. The snapshot set it joins is itself fully paged (listMonthSnapshots
  // above). Prefer fetchAllRows/.limit only if this ever stops being chunked.
  "server/services/cis-statements.ts:169":
    "bounded: chunked .in('id', slice(≤500 unique PKs)) — ≤500 rows, analyser can't see the slice bound",
  // The VAT-authority read layer (server/services/vat-quarter-inputs.ts). Both
  // lines are CHUNKED id-keyed lookups whose parent set is itself fully PAGED via
  // fetchAllRows in the same file, so each `.in(...)` returns ≤ IN_CHUNK=500 rows
  // (< the 1000 cap) — the analyser cannot see the slice bound. Same class as
  // cis-statements.ts:169.
  "server/services/vat-quarter-inputs.ts:131":
    "bounded: chunked .in('id', slice(≤IN_CHUNK=500 unique invoice PKs)) — parent invoice_payments read is fully paged; ≤500 rows per call",
  "server/services/vat-quarter-inputs.ts:194":
    "bounded: chunked .in('payment_id', slice(≤IN_CHUNK=500 unique payment PKs)) — parent supplier_payments read is fully paged; supplier_payments.id is unique so ≤500 rows per call",
  // Surfaced only once quote_line_items joined HIGH_VALUE_TABLES. This line is an
  // INSERT (`.from('quote_line_items').insert(rows)`), NOT a read — it cannot
  // truncate. It trips solely as a region artifact: the AFTER window bleeds into
  // the adjacent, fully-bounded `leads` `.select('status')…maybeSingle()`, whose
  // `.maybeSingle()`/`.eq('id')` bound markers fall just past the 1100-char cap.
  "app/(app)/quotes/actions.ts:192":
    "not a read: `.from('quote_line_items').insert(rows)` — flagged only because the region bleeds into an adjacent bounded leads .select whose bound falls outside the window. (Line moved 178→192 when verifyQuoteReferences was added to createQuote in 20261113000000.)",
  // The .limit(1000) BOUNDARY entries (surfaced when this guard learned that an
  // exactly-at-clamp .limit is not an honest bound). Each is a GENUINELY-bounded
  // sample, not a standing-backlog producer like the overdue scan (which was
  // PAGED, not allowlisted). Mirrors f1-limit-clamp-guard's BOUNDARY_ALLOWLIST.
  // material-fulfilment: REMOVED (false narrower-than-use entries). "ONE
  // material request … request-sized" was untrue — the two real callers pass
  // multi-request / org-wide line sets, so both reads are now PAGED in full via
  // fetchAllRows + chunked .in() and carry a .range() that bounds them here.
  "server/services/sites.ts:187":
    "bounded: per-org fleet_vehicles count sample (.eq(org_id)) — an org's fleet is tens of vehicles. (Moved 159→187 when listSitesForOrg was split into a bounded + paged (fetchAllRows) picker read for the F-1 picker-completion wave.)",
  "server/services/van-stock.ts:105":
    "bounded: per-org fleet_vehicles picker (.eq(org_id)) — an org's fleet is tens of vehicles",
  // CRM wave (jobs/leads/customers joined HIGH_VALUE_TABLES). Each is either a
  // hard-bounded id-batch name lookup or a genuinely paged read the static
  // analyser cannot see through a long builder chain.
  "app/(app)/diary/page.tsx:83":
    "bounded: jobs name lookup .in('id', jobIds) where jobIds is a Set drawn from the diary register (.limit(500)) — ≤500 unique PKs, analyser can't see .in's slice bound",
  "app/(app)/site-reports/page.tsx:111":
    "bounded: jobs name lookup CHUNKED .in('id', idsChunk) where each chunk is ≤JOB_IN_CHUNK=500 unique PKs — jobs.id is unique so a chunk yields ≤500 rows. (C66: the reports register above is now fully PAGED, so jobIds can exceed 500; the lookup is chunked to stay below the cap, and the line moved 99→111.)",
  "app/(app)/snags/page.tsx:134":
    "bounded: jobs name lookup .in('id', jobIds) where jobIds is a Set drawn from the snags register (.limit(500)) — ≤500 unique PKs",
  "app/(app)/toolbox/page.tsx:89":
    "bounded: jobs name lookup .in('id', jobIds) where jobIds is a Set drawn from the toolbox register (.limit(500)) — ≤500 unique PKs",
  "app/(app)/jobs/page.tsx:133":
    "bounded: the 'Today's jobs' panel query — one org × one calendar day (.eq('scheduled_date', todayIso)), a handful of rows, never near the cap. The paginated list query above it is windowed via .range().",
  "app/(app)/leads/page.tsx:51":
    "paged: the pipeline read IS complete — executed via fetchAllRows((from,to) => query.range(from,to)) at the bottom of the fn; the builder pattern places the .range terminator beyond the static region window, so the analyser can't see it",

  // ── .from(as never) CAST-FORM WAVE — genuinely-bounded per-parent-row reads
  //    surfaced only once the cast-form matcher was taught. Each is a single
  //    parent entity's child set (a job's / a PO's), never a cross-tenant scan:
  //    cardinality is bounded by the parent and cannot approach the 1000 cap.
  "app/(app)/jobs/[id]/commercial/page.tsx:176":
    "bounded: ONE job's retention releases (.eq('job_id').eq('org_id')) — feeds the committed/forecast retention figure for a single job; retention is released in 1-2 tranches per job, never near 1000. (Surfaced once C66-B de-vacuumed the cast-form windowing; the read is org-pinned per C66-A's cross-org money-injection fix.)",
  "app/(app)/jobs/[id]/commercial/page.tsx:181":
    "bounded: ONE job's purchase orders (.eq('job_id')) — feeds the committed-costs tile for a single job; a job has a handful to dozens of POs, never near 1000",
  "app/(app)/jobs/[id]/page.tsx:315":
    "bounded: ONE job's purchase orders (.eq('job_id')) — the committed-costs tile on the job detail page; per-job POs, far below the cap",
  "app/(app)/jobs/retention-actions.ts:163":
    "bounded: ONE job's invoices (.eq('job_id')) — folded into the retention position for a single job; a job's invoices are a handful",
  "app/(app)/purchase-orders/[id]/page.tsx:149":
    "bounded: ONE purchase order's supplier bills (.eq('purchase_order_id')) — a single PO has a handful of finance entries, never near 1000",
  // Two enrichment lookups keyed by a ≤500-row parent's distinct org ids: the
  // parent read is capped (.limit(500)), so the distinct-org id set handed to
  // `.in('id', …)` is ≤500 — well below the cap. Not a cross-tenant estate scan.
  "app/admin/ai-receptionist/deliveries/page.tsx:76":
    "bounded: org-name enrichment (.in('id', distinct orgs)) for the newest-500 lifecycle rows — ≤500 distinct orgs, analyser can't see the .limit(500) parent bound",
  "app/admin/ai-receptionist/review/page.tsx:57":
    "bounded: org-name enrichment (.in('id', distinct orgs)) for listReviewQueue({limit:500}) — ≤500 distinct orgs, analyser can't see the parent bound",
  // Single-row read whose bound markers fall outside the region window: the long
  // select list + the active-org comment push `.eq('id')`/`.maybeSingle()` past
  // the 1100-char AFTER window, so the region-scan can't see the bound.
  "server/services/customer-support-service.ts:143":
    "bounded: ONE ticket (.eq('org_id').eq('id').maybeSingle()) — a single-row read; the long select list + active-org comment push the .eq('id')/.maybeSingle bound markers past the region window",
  // Per-org billing invoices for the /admin/billing expand-row: an org's billing
  // invoices are monthly-cadence (≈12/yr), so ≤1000 would take ~83 years.
  "server/services/hq-billing-snapshot.ts:267":
    "bounded: ONE org's billing invoices (.eq('org_id')) for the /admin/billing inline expand-row — monthly cadence, structurally far below 1000. (Moved 258→267 when the owner-enrichment read above it was paged for the C65 memberships wave.)",
  // Recent-N estate health events: the read is ordered `recomputed_at desc` and
  // the caller (admin/analytics) slices the newest `limit` (15) in JS. Because it
  // is ordered DESC, the PostgREST 1000-clamp can only ever drop rows OLDER than
  // the top-N, so the sliced result is identical whether the table has 100 or
  // 100k events — a genuinely-bounded recent-N display, not a set read.
  "server/services/hq-health-recompute.ts:308":
    "bounded: recent-N estate health events — ordered recomputed_at DESC then .slice(0, limit) (caller passes 15) in JS; the desc order means the 1000-clamp can only drop rows past the top-N, so the result is complete",
  // NOT A READ: `.from('notifications').insert(payload).select(ALL_COLS)` — an
  // INSERT…RETURNING. The returned set is bounded by the payload it just wrote,
  // so it cannot truncate; it trips only because the region carries `.select(`.
  "server/services/notifications-service.ts:140":
    "not a read: `.from('notifications').insert(payload).select(ALL_COLS)` — INSERT…RETURNING, bounded by the inserted payload, cannot truncate a read",

  // ── Job-billing schedule / retention wave — genuinely-bounded SINGLE-SCOPE
  //    reads surfaced once job_billing_plans/job_billing_stages/retention_releases
  //    joined HIGH_VALUE_TABLES. Each is scoped to ONE job or ONE plan, never an
  //    org-wide estate scan; cardinality is bounded by the single parent, far
  //    below the 1000 cap. (The org-wide portal-schedule reads that motivated the
  //    wave are PAGED via fetchAllRows in app/customer-portal/[token]/_schedule.ts,
  //    not allowlisted — the delete-the-fix probe proves the guard bites them.)
  "app/(app)/jobs/retention-actions.ts:178":
    "bounded: ONE job's retention releases (.eq('job_id', jobId)) — folded into the retention position for a single job; a job's releases are a handful, never near 1000. (Surfaced via the .from(as never) cast form; sibling to the already-allowlisted :163 invoices read in the same fn.)",
  "server/services/billing.ts:163":
    "bounded: ONE plan's stages (.eq('org_id').eq('plan_id', plan.id)) — the stages of a single active billing plan; a plan has a handful of stages, never near 1000",

  // ── VACUOUSNESS-HARDENING WAVE (statement-scoped regionAround) ──────────────
  // regionAround was tightened from a fixed BEFORE=300/AFTER=1100 CHARACTER window
  // to the ENCLOSING STATEMENT, because the old window bled a paged NEIGHBOUR's
  // fetchAllRows/.range markers into a bare read's window and VACUOUSLY greened it
  // (the exact bug the portal-schedule delete-the-fix probe exposed). Tightening
  // surfaced these pre-existing reads that were ALSO only green via neighbour
  // bleed. Each is verified GENUINELY bounded / paged / not-a-read — none is a
  // truncation bug (none needed paging), so each carries an honest reason:
  "app/(app)/delays/_data.ts:92":
    "bounded: jobs label lookup .in('id', ids) where ids is a de-duped Set drawn from the delays register (a bounded parent set) — batched name/date labels, ≤ parent rows, never near 1000. Same class as diary/page.tsx:83.",
  "app/(app)/quality/_data.ts:241":
    "bounded: jobs label lookup .in('id', ids) where ids is a de-duped Set drawn from the quality register (a bounded parent set) — batched name/date labels, ≤ parent rows. Same class as diary/page.tsx:83.",
  "app/(app)/jobs/[id]/billing/actions.ts:81":
    "bounded: ONE plan's stages (.eq('org_id').eq('plan_id', planId)) — the stages of a single billing plan; a plan has a handful of stages, never near 1000",
  "lib/schedule/calendar-data.ts:92":
    "paged: the jobs read IS complete — .from('jobs') lives in a `scoped()` builder-closure and is paged via fetchAllRows((from,to) => scoped()…range(from,to)) at the two call sites (nonRecurring + recurring) in a SEPARATE statement, beyond the statement-scoped window. Same builder class as leads/page.tsx:51.",
  "app/(app)/invoices/[id]/page.tsx:110":
    "bounded: ONE invoice's payments (.eq('invoice_id', id)) — the payment ledger for a single invoice folded into paidTotal; a single invoice has a handful of payments, never near 1000",
  "app/admin/billing/actions.ts:160":
    "not a read: `untypedAdminTable('billing_invoices').insert(insert).select('id')` — INSERT…RETURNING, bounded by the inserted row, cannot truncate a read; flagged only because the statement carries `.select(`. Same class as notifications-service.ts:140.",
  "server/services/bank-sync.ts:699":
    "bounded: chunked dedupe read .in('provider_tx_id', batch) where batch = providerTxIds.slice(i, i+DEDUPE_IN_CHUNK) — each call returns ≤ DEDUPE_IN_CHUNK rows, well below the 1000 cap. Same class as cis-statements.ts:169.",

  // ── C65 MEMBERSHIPS / COMPLETION_CERTIFICATES WAVE — surfaced once memberships
  //    + completion_certificates joined HIGH_VALUE_TABLES. The one genuine
  //    cross-tenant truncation this wave found — the FOUR HQ owner-enrichment
  //    reads (.in(<full-estate roster>).eq('role','owner')) whose orgId set is a
  //    fetchAllRows-paged estate roster — were PAGED (admin/organizations,
  //    hq-alerts/hq-billing/hq-customer snapshots), not allowlisted; the
  //    delete-the-fix probe proves the guard bites the unpaged shape. The reads
  //    below are all SINGLE-SCOPE: either .eq('org_id', ONE org) (bounded by that
  //    org's headcount — tens, low-hundreds; a single org never approaches 1000
  //    members) or .eq('user_id', ONE user) / .in(<bounded parent set>). None is
  //    a cross-tenant estate scan; each is bounded by a single parent well below
  //    the cap. Same class as the already-allowlisted per-org fleet_vehicles reads.
  "app/(app)/health-safety/_data.ts:113":
    "bounded: ONE org's members (.eq('org_id')) — the assessor picker (listAssessors); an org's headcount is tens/low-hundreds, never near 1000",
  "app/(app)/health-safety/_signoff-data.ts:117":
    "bounded: name lookup .in('user_id', ids) where ids is a de-duped Set of sign-off user_ids from a bounded parent set — ≤ parent rows, never near 1000",
  "app/(app)/settings/page.tsx:72":
    "bounded: ONE org's members (.eq('org_id')) — the settings team panel; bounded by the org's headcount, never near 1000",
  "app/(app)/staff/leave/page.tsx:96":
    "bounded: ONE org's members (.eq('org_id')) — the leave-page name lookup; bounded by the org's headcount",
  "app/(app)/staff/page.tsx:56":
    "bounded: ONE org's members (.eq('org_id')) — the staff register; bounded by the org's headcount",
  "app/(app)/staff/rota/page.tsx:112":
    "bounded: ONE org's members (.eq('org_id')) — the rota staff list + assign-form labels; bounded by the org's headcount",
  "app/customer-portal/_warranties.ts:133":
    "bounded: completion_certificates for the customer's OWN warranty job set (.eq('org_id').eq('status','issued').in('job_id', <de-duped set from the customer's visible warranties>)) — one issued cert per job, bounded by the customer's warranties, not a cross-tenant scan",
  "server/auth/session.ts:104":
    "bounded: ONE user's memberships (.eq('user_id')) — org resolution / active-org fallback; a user belongs to a handful of orgs, never near 1000",
  "server/auth/session.ts:182":
    "bounded: ONE user's memberships (.eq('user_id')) — the header org switcher (listOrgsForUser); a user belongs to a handful of orgs",
  "lib/email/send-leave.ts:60":
    "bounded: ONE org's owner/admin recipients (.eq('org_id').in('role', ['owner','admin'])) — a handful of privileged users per org, far below 1000",
  "lib/email/send-material-request.ts:110":
    "bounded: ONE org's owner/admin recipients (.eq('org_id').in('role', ['owner','admin'])) — a handful of privileged users per org",
  "lib/profitability/labour-rates.ts:34":
    "bounded: ONE org's member ids (.eq('org_id')) — folded into an hourly-pay map (loadOrgHourlyPay); bounded by the org's headcount, and the sibling users read is a chunk-safe .in(memberIds)",

  // ── C66 cast-form de-vacuum: hq_sales_companies NAME-ENRICHMENT lookups
  //    surfaced once the depth-aware windowing saw these cast-form reads. Each is
  //    loadCompanyNames(admin, ids).in('id', unique) where `ids` is drawn from the
  //    caller's recent-runs read, itself capped at .limit(Math.min(max(limit,1),50))
  //    (listRecent{Outreach,Qualification,Research}Runs) — so `unique` is ≤50 ids,
  //    far below the 1000 cap. Not a cross-tenant estate scan; the estate reads in
  //    these files are the paged pipeline / count reads, not these lookups.
  "server/services/hq-outreach.ts:757":
    "bounded: hq_sales_companies name lookup .in('id', ≤50 unique ids) — ids from listRecentOutreachRuns (.limit(≤50)); ≤50 rows, analyser can't see the parent cap",
  "server/services/hq-qualification.ts:830":
    "bounded: hq_sales_companies name lookup .in('id', ≤50 unique ids) — ids from listRecentQualificationRuns (.limit(≤50)); ≤50 rows, analyser can't see the parent cap",
  "server/services/hq-research.ts:1517":
    "bounded: hq_sales_companies name lookup .in('id', ≤50 unique ids) — ids from listRecentResearchRuns (.limit(≤50)); ≤50 rows, analyser can't see the parent cap",
};

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes("__tests__")) {
      out.push(p);
    }
  }
}

function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

/**
 * DEPTH-AWARE statement-boundary finders — the DE-VACUUM of the cast-form
 * windowing. The dominant Supabase read idiom carries an INLINE CAST TYPE-OBJECT
 * annotation whose `;` are TypeScript member separators, NOT statement boundaries:
 *   admin.from("t" as never) as unknown as { select:(c:string)=>Q; eq:...; }
 *       .select(...).limit(20);
 * The old `src.lastIndexOf(";", …)` / `src.indexOf(";", …)` windowing (regionAround
 * + tablesWithSetReads) latched onto those in-type `;` and TRUNCATED the window
 * before the real `.select()`, so the read looked bare-less / limit-less and the
 * guard was blind to every cast-form read. A `;` only terminates a statement at
 * brace/paren/bracket DEPTH 0; the type-object separators sit at depth >= 1 and
 * are correctly skipped. (Mirrors stripComments neutralising comment `;`.)
 */
function prevTopLevelSemi(src: string, idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") depth--;
    else if (c === ";" && depth <= 0) return i;
  }
  return -1;
}
function nextTopLevelSemi(src: string, idx: number): number {
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return i;
  }
  return src.length;
}

/**
 * The enclosing region around a `.from("TABLE")` read, used to look for the
 * paged/single-row bound markers. STATEMENT-SCOPED (the anti-vacuous fix).
 *
 * Earlier this was a fixed BEFORE=300 / AFTER=1100 CHARACTER window, and that
 * window BLED across `;` boundaries into an ADJACENT read: a bare
 * `.from("retention_releases")` sitting one statement above a PAGED
 * `job_billing_stages` read had the neighbour's `fetchAllRows`/`.range()` fall
 * inside its window, so the bare read was VACUOUSLY greened — a guard that
 * protected nothing (proved by the delete-the-fix probe on _schedule.ts: reverting
 * the retention fix to a bare read left the suite GREEN).
 *
 * The fix: clamp the window to the ENCLOSING STATEMENT (delimited by `;`). A
 * genuinely paged read keeps ALL its markers in ONE statement — the
 * `const { … } = await fetchAllRows((from,to) => admin.from(…).select(…).range(
 * from,to));` shape has `fetchAllRows`, the select chain AND the `.range`
 * terminator between the same pair of `;` — so paged reads stay correctly
 * bounded, while a bare read's own statement carries no bound marker and is
 * flagged. The BEFORE/AFTER char caps remain as performance/precision limits but
 * they may only SHRINK the slice — they can never extend it PAST a `;` into a
 * neighbouring read. (The rare two-statement builder `let q = from(…); … q.range()`
 * shape is handled by ALLOWLIST, e.g. leads/page.tsx.)
 */
function regionAround(src: string, fromIdx: number): string {
  const BEFORE = 400;
  const AFTER = 1100; // wide enough to see the terminator past a long multi-line select list
  const semiBefore = prevTopLevelSemi(src, fromIdx);
  const start = Math.max(semiBefore + 1, fromIdx - BEFORE, 0);
  const semiAfter = nextTopLevelSemi(src, fromIdx);
  const end = Math.min(semiAfter, fromIdx + AFTER);
  return src.slice(start, end);
}

/** A `.from`-wrapping local helper defeats a literal `.from("TABLE")` scan.
 *
 * weather-fetch.ts hid its F-1 truncation exactly this way: a local
 *   `const table = (c, name) => c.from(name)`
 * turned every read into `table(admin, "weather_watches")`, which the literal
 * `.from("...")` regex never matched — the guard was structurally blind to it.
 *
 * So we ALSO find such wrappers in each file and treat `wrapper(<x>, "TABLE")`
 * as if it were `.from("TABLE")`: an arrow (or function) whose body calls
 * `<something>.from(<param>)` is a `.from` wrapper, and its call sites are
 * indirect reads that must satisfy the same paged/single-row/count rule.
 *
 * TWO wrapper SHAPES are recognised. The DECLARATION form (below) was added by
 * the F-1 support wave: server/services/hq-support-snapshot.ts and
 * hq-health-deep-dive.ts BOTH hid their cross-tenant reads behind a
 *   `function adminTable(name){ return admin.from(name as never) }`
 *   `function table(name){ return c.from(name as never) }`
 * DECLARATION, called with the table literal as its ONLY arg
 * (`adminTable("support_tickets")`). The arrow-only regex never matched it, so
 * adding support_tickets/support_messages to HIGH_VALUE_TABLES was VACUOUS for
 * the live reads — a green guard that protected nothing (the C57 trap). A
 * delete-the-fix probe on the LIVE listSupportTicketRowsForHq now proves the
 * guard bites the real read, not just a fixture.
 *
 * NOTE — the OTHER blind spot (the direct `.from("x" as never)` CAST used by
 * customer-support-service.ts / customer-portal, and by 6 pre-existing bounded
 * money-table reads) is deliberately NOT taught here: doing so turns the suite
 * red across tables out of this wave's scope. It is deferred to the reported
 * detection follow-up. This wave teaches ONLY the declaration-wrapper form, which
 * covers the support reads this PR fixed without surfacing those other offenders.
 */
const WRAPPER_DEF_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=;]*?)?=>\s*[^;{}]*?\.from\(/g;

/**
 * Function-DECLARATION `.from` wrapper: `function NAME(param, …){ … return
 * <client>.from(param … ) … }`. The captured first PARAM must be the value
 * passed to `.from(` (the `\2` backreference) — that is what distinguishes a real
 * table wrapper from an incidental `.from(` (e.g. `Array.from(x)`, further
 * excluded by the negative lookahead). Bounded 300-char body look-ahead so a
 * large function that merely touches `.from` far below isn't misread.
 */
const WRAPPER_FN_DECL_RE =
  /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)[^{]*\{[\s\S]{0,300}?\breturn\s+(?!Array\b|Object\b)[A-Za-z_$][\w$]*\.from\(\s*\2\b/g;

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Same-file numeric consts (`const NAME = 1000`) so `.limit(SCAN_LIMIT)` where
 * SCAN_LIMIT === 1000 is resolved to the boundary just like a literal. */
function numericConsts(src: string): Map<string, number> {
  const m = new Map<string, number>();
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9][0-9_]*)\b(?!\s*[.eE])/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    if (mm[1] && mm[2]) m.set(mm[1], Number(mm[2].replace(/_/g, "")));
  }
  return m;
}

/** Provable bound of the FIRST `.limit(...)` in a region: a numeric literal or a
 * same-file numeric const. Returns null when the arg is dynamic/unprovable
 * (that case is the sibling clamp guard's fail-closed job, not ours). */
function regionLimitBound(region: string, env: Map<string, number>): number | null {
  const i = region.indexOf(".limit(");
  if (i === -1) return null;
  const arg = region.slice(i + ".limit(".length, region.indexOf(")", i)).trim();
  if (/^[0-9][0-9_]*$/.test(arg)) return Number(arg.replace(/_/g, ""));
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) return env.has(arg) ? env.get(arg)! : null;
  return null;
}

function boundedRegion(region: string, env: Map<string, number>): boolean {
  // A `.limit(` only bounds the read if it is an HONEST sample: strictly below
  // the PostgREST clamp. A provable `.limit(>=1000)` (the exact-1000 boundary,
  // or an over-cap that also truncates) is NOT a bound — it is the truncation
  // trap. An unprovable `.limit(x)` is left to the clamp guard's fail-closed net.
  const limitBound = regionLimitBound(region, env);
  const hasHonestLimit =
    /\.limit\(/.test(region) && !(limitBound !== null && limitBound >= CLAMP);
  return (
    /\.single\(/.test(region) ||
    /\.maybeSingle\(/.test(region) ||
    /\.range\(/.test(region) ||
    hasHonestLimit ||
    /fetchAllRows/.test(region) || // paged via the helper
    /\.eq\(\s*["'`]id["'`]\s*,/.test(region) || // single-entity read by PK (<=1 row)
    /head:\s*true/.test(region) || // count/head read — returns a count, no rows to truncate
    /count:\s*["'`]exact["'`]/.test(region)
  );
}

/**
 * Every bare-select F-1 offender in one file's (raw) source, covering BOTH the
 * literal `.from("TABLE")` form and the `.from`-wrapper indirection form. Shared
 * by the repo-wide scan and the "would have caught the pre-fix weather-fetch"
 * regression proof, so both exercise identical detection.
 */
function offendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".from(")) return [];
  const src = stripComments(raw);
  const env = numericConsts(src);
  const offenders: string[] = [];

  const consider = (table: string | undefined, index: number, shape: string): void => {
    if (!table || !HIGH_VALUE_TABLES.has(table)) return;
    const region = regionAround(src, index);
    // Must be a select (writes/upserts/rpc are not truncation-prone reads).
    if (!/\.select\(/.test(region)) return;
    if (boundedRegion(region, env)) return;
    const line = src.slice(0, index).split("\n").length;
    const key = `${rel}:${line}`;
    if (ALLOWLIST[key]) return;
    const atBoundary = regionLimitBound(region, env) === CLAMP;
    offenders.push(
      atBoundary
        ? `${key} → ${shape} capped at exactly .limit(${CLAMP}) — boundary trap, page it or allowlist`
        : `${key} → bare ${shape} with no .range/.limit(<${CLAMP})/.single`,
    );
  };

  // 1. The direct form: `.from("high_value_table").select(...)`, INCLUDING the
  //    `.from("table" as never)` / `.from("table" as any)` CAST idiom used for
  //    tables that post-date the generated Supabase types. The optional
  //    `(?:as\s+(?:never|any))?` after the backreferenced table literal makes the
  //    cast form detected EXACTLY like a plain `.from("table")` — it still only
  //    fires when the captured name is a tracked HIGH_VALUE_TABLE (via consider()).
  //    Without this, a cross-tenant read written as `admin.from("organizations" as
  //    never).select(...)` was structurally invisible to the guard.
  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*(?:as\s+(?:never|any)\s*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) consider(m[1], m.index, `.from("${m[1]}").select(...)`);

  // 2. The indirection form: a local `.from` wrapper (arrow const OR function
  //    declaration) + `wrapper([client, ] "table")` — the table literal may be
  //    the ONLY arg (`adminTable("support_tickets")`) or the LAST of several
  //    (`table(admin, "weather_watches")`).
  const wrapperNames = new Set<string>();
  let wm: RegExpExecArray | null;
  WRAPPER_DEF_RE.lastIndex = 0;
  while ((wm = WRAPPER_DEF_RE.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  WRAPPER_FN_DECL_RE.lastIndex = 0;
  while ((wm = WRAPPER_FN_DECL_RE.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  for (const name of wrapperNames) {
    const callRe = new RegExp(
      escapeReg(name) + `\\(\\s*(?:[^,()]+,\\s*)?["'\`]([a-z_]+)["'\`]\\s*\\)`,
      "g",
    );
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(src))) {
      consider(cm[1], cm.index, `${name}(…"${cm[1]}") [.from wrapper].select(...)`);
    }
  }

  return offenders;
}

// ═══════════════════════════════════════════════════════════════════════════
// F-1 .rpc() AGGREGATE BLIND SPOT
// ═══════════════════════════════════════════════════════════════════════════
// The scan above is STRUCTURALLY BLIND to `.rpc()`: it only inspects `.from(`
// reads, and its region gate (`if (!/\.select\(/…) return`) treats `.rpc` as
// "not a truncation-prone read". But a SET-RETURNING RPC (a `RETURNS TABLE`
// rollup called with `p_org_id = null`, one row per org) is clamped at
// PostgREST `max_rows = 1000` EXACTLY like a bare select — there is no GUC
// override — and if its rows are then summed/reduced/iterated, the estate total
// SILENTLY UNDER-REPORTS once >1000 orgs have spend. That is the live defect on
// `ai_invocations_month_totals` / `ai_reservations_month_totals` this wave fixed.
//
// RULE: a `.rpc(fn, …)` whose result is consumed as a SET — materialised into a
// collection (`new Map(rows.map(…))`, spread), or fed to `.reduce`/`.map`/a
// `for…of`/aggregate — MUST be paged (`fetchAllRows` / `.range(`) UNLESS it
// returns a single pre-aggregated row (`data[0]` / `rows[0]` / `.single(`) or a
// scalar, or is allowlisted as genuinely bounded (a CLOSED grouping set).

// "file:line" → reason. Genuinely bounded / self-healing set-returning RPCs only.
const RPC_ALLOWLIST: Record<string, string> = {
  // Groups by `feature`, a CLOSED registry set (lib/ai/governor/registry.ts) —
  // tens of rows at most, structurally incapable of crossing 1000. The per-ORG
  // sibling rollups (grouped by org_id, unbounded) ARE paged; this one is not,
  // and correctly so.
  "server/services/ai-cost-snapshot.ts:475":
    "bounded: ai_invocations_month_by_feature groups by the CLOSED feature registry (tens of rows), never near the 1000 cap",
};

// `.range(` / `fetchAllRows` anywhere around the call = it IS paged (the fix).
const RPC_BOUND: RegExp[] = [/\.range\(/, /fetchAllRows/];

/** Set-consumption of a specific result variable `v`: mapped, reduced, iterated,
 * or spread into a collection. These are what SUM/aggregate the whole set. */
function setMarkersFor(v: string): RegExp[] {
  const e = escapeReg(v);
  return [
    new RegExp(`\\b${e}\\s*\\.\\s*(?:map|reduce|forEach|flatMap|filter)\\(`),
    new RegExp(`new Map\\(\\s*${e}\\b`),
    new RegExp(`for\\s*\\(\\s*const\\s+[^;)]*\\bof\\s+${e}\\b`),
    new RegExp(`\\[\\s*\\.\\.\\.\\s*${e}\\b`),
    new RegExp(`\\b${e}\\s*\\.\\s*length\\b`),
  ];
}
/** Single-row consumption of `v`: only element [0] is ever read → bounded. */
function singleRowMarkersFor(v: string): RegExp[] {
  const e = escapeReg(v);
  return [
    new RegExp(`\\b${e}\\s*\\?\\.\\s*\\[\\s*0\\s*\\]`),
    new RegExp(`\\b${e}\\s*\\[\\s*0\\s*\\]`),
  ];
}

/** The variable that holds the RPC's returned ROWS, read from the assignment
 * immediately preceding `.rpc(`. Returns the array of aliases to track (the
 * `data` binding plus any local `const rows = data ?? [] / Array.isArray(data)…`
 * re-binding), or [] when the result is unbound / `{ error }`-only. */
function rpcResultVars(pre: string, after: string): string[] {
  // `const { data: X, error } = await …rpc(`  — destructured result.
  let base: string | null = null;
  const dest = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?[^;{}]*$/.exec(pre);
  if (dest) {
    const dm = /\bdata\b(?:\s*:\s*([A-Za-z_$][\w$]*))?/.exec(dest[1]!);
    if (!dm) return []; // destructured but no `data` (e.g. `{ error }`) → no rows read
    base = dm[1] ?? "data";
  } else {
    // `const R = (await …rpc(` — rows live on `R.data`.
    const named = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;{}=]*$/.exec(pre);
    if (named) base = `${named[1]}.data`;
  }
  if (!base) return [];
  const vars = [base];
  // Track one hop of re-binding: `const rows = <base> ?? [] | Array.isArray(<base>)… | <base> as …[]`.
  const bre = new RegExp(
    `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\b${escapeReg(base)}\\b`,
    "g",
  );
  let bm: RegExpExecArray | null;
  while ((bm = bre.exec(after))) if (bm[1]) vars.push(bm[1]);
  return vars;
}

/** End index of the `.rpc(` argument list, so consumption is scanned AFTER the
 * args (a `.map(` inside the RPC's own arguments is not result consumption). */
function callEnd(src: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Every set-consuming, un-paged `.rpc()` offender in one file's (raw) source. */
function rpcOffendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".rpc(")) return [];
  const src = stripComments(raw);
  const offenders: string[] = [];
  const re = /\.rpc\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const openParen = m.index + ".rpc".length; // the "(" of the call
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    if (RPC_BOUND.some((r) => r.test(before))) continue; // paged wrapper — the fix
    const vars = rpcResultVars(before, src.slice(callEnd(src, openParen), m.index + 900));
    if (vars.length === 0) continue; // rows never bound → can't materialise a set
    const after = src.slice(callEnd(src, openParen), m.index + 900);
    if (RPC_BOUND.some((r) => r.test(after))) continue; // `.range(` on the call chain
    // Bounded if any tracked var is read only at [0] (single pre-aggregated row).
    if (vars.some((v) => singleRowMarkersFor(v).some((r) => r.test(after)))) continue;
    // Dangerous only if a tracked var is consumed as a whole set.
    const consumed = vars.some((v) => setMarkersFor(v).some((r) => r.test(after)));
    if (!consumed) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const key = `${rel}:${line}`;
    if (RPC_ALLOWLIST[key]) continue;
    const fnMatch = /\.rpc\(\s*(["'`][^"'`]+["'`]|[A-Za-z_$][\w$]*)/.exec(src.slice(m.index));
    const fn = fnMatch?.[1] ?? "?";
    offenders.push(
      `${key} → set-returning .rpc(${fn}) feeds an aggregate/collection with no ` +
        `.range/fetchAllRows paging (silent max_rows=1000 truncation)`,
    );
  }
  return offenders;
}

describe("F-1 bare-select guard — high-value table reads must page or be single-row", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no bare unpaginated read on a money/ledger/producer table (direct OR .from-wrapper)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...offendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 bare-select truncation: a high-value-table read materialises a set but is silently ` +
        `capped at PostgREST max_rows (1000). Page it via fetchAllRows (COMPLETE) or make it a ` +
        `single-row read / honest .limit(<=1000):\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("has TEETH: catches the pre-fix weather-fetch reads through the table() wrapper", () => {
    // The exact shape weather-fetch.ts shipped before this fix: a `.from` wrapper
    // plus two bare, unpaginated reads. The literal `.from("...")` scan alone was
    // blind to it; the hardened guard must flag BOTH reads.
    const preFix = [
      `const table = (c, name) => c.from(name);`,
      `const watches = await table(admin, "weather_watches")`,
      `  .select("postcode_district")`,
      `  .eq("active", true);`,
      `const recent = await table(admin, "weather_readings")`,
      `  .select("postcode_district, kind, fetched_at")`,
      `  .in("postcode_district", districts);`,
    ].join("\n");
    const flagged = offendersIn("server/services/weather-fetch.ts", preFix);
    expect(flagged.some((o) => o.includes("weather_watches"))).toBe(true);
    expect(flagged.some((o) => o.includes("weather_readings"))).toBe(true);
  });

  it("does not false-positive a PAGED .from-wrapper read (the post-fix shape)", () => {
    const postFix = [
      `const table = (c, name) => c.from(name);`,
      `const watchesRes = await fetchAllRows((from, to) =>`,
      `  table(admin, "weather_watches")`,
      `    .select("postcode_district")`,
      `    .eq("active", true)`,
      `    .order("id", { ascending: true })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(offendersIn("server/services/weather-fetch.ts", postFix)).toEqual([]);
  });

  // ── SUPPORT OS teeth (delete-the-fix) ───────────────────────────────────────
  // The F-1 defect that motivated adding support_tickets/support_messages: HQ
  // cross-tenant reads (server/services/hq-support-snapshot.ts) mapped + counted
  // the FULL row set into "fact" figures on the live /admin/support board and
  // hq-product's CEO demand aggregation, but read with a bare `.select().order()`
  // that PostgREST silently clamps to max_rows=1000. If someone deletes the paging
  // fix (page → unpage), the guard MUST flag it again — proved here for both
  // tables, in the standard literal read shape.
  it("has TEETH: flags UNPAGED support_tickets / support_messages set reads (delete-the-fix)", () => {
    // support_tickets — the triage-board / demand read, unpaged (the pre-fix shape).
    const ticketsUnpaged = [
      `const res = await admin`,
      `  .from("support_tickets")`,
      `  .select("id, category, status, created_at")`,
      `  .order("created_at", { ascending: false });`,
      `return (res.data ?? []);`,
    ].join("\n");
    const tFlagged = offendersIn("server/services/hq-support-snapshot.ts", ticketsUnpaged);
    expect(
      tFlagged.some((o) => o.includes("support_tickets")),
      "unpaged support_tickets set read must be flagged",
    ).toBe(true);

    // support_messages — the batched per-ticket thread read, unpaged.
    const messagesUnpaged = [
      `const msgRes = await admin`,
      `  .from("support_messages")`,
      `  .select("id, ticket_id, body, internal, created_at")`,
      `  .in("ticket_id", ticketIds)`,
      `  .order("created_at", { ascending: false });`,
      `return (msgRes.data ?? []);`,
    ].join("\n");
    const mFlagged = offendersIn("server/services/hq-support-snapshot.ts", messagesUnpaged);
    expect(
      mFlagged.some((o) => o.includes("support_messages")),
      "unpaged support_messages set read must be flagged",
    ).toBe(true);
  });

  it("does not flag the PAGED support reads (the shipped fetchAllRows fix)", () => {
    const ticketsPaged = [
      `const { data, error } = await fetchAllRows((from, to) =>`,
      `  admin`,
      `    .from("support_tickets")`,
      `    .select("id, category, status, created_at")`,
      `    .order("created_at", { ascending: false })`,
      `    .order("id", { ascending: false })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(offendersIn("server/services/hq-support-snapshot.ts", ticketsPaged)).toEqual([]);

    const messagesPaged = [
      `const { data, error } = await fetchAllRows((from, to) =>`,
      `  admin`,
      `    .from("support_messages")`,
      `    .select("id, ticket_id, body, internal, created_at")`,
      `    .in("ticket_id", chunk)`,
      `    .order("created_at", { ascending: false })`,
      `    .order("id", { ascending: false })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(offendersIn("server/services/hq-support-snapshot.ts", messagesPaged)).toEqual([]);
  });

  // The .limit(1000) BOUNDARY teeth: the exact shape the live invoice.overdue
  // producer scan shipped — `.limit(SCAN_LIMIT)` where SCAN_LIMIT === 1000 sitting
  // ON the PostgREST clamp — must be flagged, and the paged fix must pass.
  it("has TEETH: flags a producer scan capped at exactly .limit(1000) (literal or same-file const)", () => {
    const litFix = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(1000);`,
    ].join("\n");
    const litFlagged = offendersIn("lib/invoices/overdue-scheduler.ts", litFix);
    expect(litFlagged.some((o) => o.includes("boundary trap"))).toBe(true);

    // The exact pre-fix form: a same-file const that RESOLVES to 1000.
    const constFix = [
      `const SCAN_LIMIT = 1000;`,
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(SCAN_LIMIT);`,
    ].join("\n");
    expect(offendersIn("lib/invoices/overdue-scheduler.ts", constFix).length).toBeGreaterThan(0);
  });

  it("does not flag an HONEST bounded sample (.limit < 1000) or the paged fix", () => {
    // Honest top-N sample below the cap: no truncation ambiguity.
    const honest = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(999);`,
    ].join("\n");
    expect(offendersIn("lib/invoices/overdue-scheduler.ts", honest)).toEqual([]);

    // The COMPLETE-read fix that shipped.
    const paged = [
      `const { data, error } = await fetchAllRows((from, to) =>`,
      `  admin`,
      `    .from("invoices")`,
      `    .select("id, org_id")`,
      `    .lt("due_date", todayIso)`,
      `    .order("due_date", { ascending: true })`,
      `    .order("id", { ascending: true })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(offendersIn("lib/invoices/overdue-scheduler.ts", paged)).toEqual([]);
  });

  // ── the .rpc() aggregate blind spot ─────────────────────────────────────────
  it("no set-consuming .rpc() feeds an aggregate without paging (repo-wide)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...rpcOffendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 .rpc() truncation: a set-returning RPC (a RETURNS TABLE rollup called ` +
        `estate-wide) is materialised/summed but silently capped at PostgREST ` +
        `max_rows=1000. Page it via fetchAllRows/.range with a deterministic ORDER BY, ` +
        `return a single pre-aggregated row, or allowlist it if the grouping set is ` +
        `genuinely bounded:\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("has TEETH: flags the pre-fix estate rollup .rpc() reads (orgTotalsFor / orgReservationsFor)", () => {
    // The exact shape ai-cost-snapshot.ts shipped before this fix: an estate
    // rollup (p_org_id: null) whose EVERY row is spread into a Map, with no
    // paging. The estate total summed over that Map truncates at 1000 orgs.
    const preFixTotals = [
      `const { data, error } = await db(createAdminClient()).rpc("ai_invocations_month_totals", {`,
      `  p_org_id: null,`,
      `  p_month: probe,`,
      `});`,
      `const rows = Array.isArray(data) ? (data as Row[]) : [];`,
      `return new Map(rows.map((r) => [String(r.org_id), r]));`,
    ].join("\n");
    expect(rpcOffendersIn("server/services/ai-cost-snapshot.ts", preFixTotals).length).toBeGreaterThan(0);

    const preFixReservations = [
      `const { data, error } = await db(createAdminClient()).rpc("ai_reservations_month_totals", {`,
      `  p_org_id: null,`,
      `  p_month: probe,`,
      `});`,
      `const rows = Array.isArray(data) ? (data as Row[]) : [];`,
      `return new Map(rows.map((r) => [String(r.org_id), r]));`,
    ].join("\n");
    expect(
      rpcOffendersIn("server/services/ai-cost-snapshot.ts", preFixReservations).length,
    ).toBeGreaterThan(0);
  });

  it("does not flag the PAGED estate rollup fix (fetchAllRows + .range + .order)", () => {
    const paged = [
      `const { data, error } = await fetchAllRows<Row>(`,
      `  (from, to) =>`,
      `    db(admin)`,
      `      .rpc(fn, { p_org_id: null, p_month: probe })`,
      `      .order("org_id", { ascending: true })`,
      `      .range(from, to) as PromiseLike<PageResult<Row>>,`,
      `);`,
      `if (error) throw error;`,
      `return new Map(data.map((r) => [String(r.org_id), r]));`,
    ].join("\n");
    expect(rpcOffendersIn("server/services/ai-cost-snapshot.ts", paged)).toEqual([]);
  });

  it("does not false-positive a single-row or scalar .rpc()", () => {
    // Single pre-aggregated row (the governor's per-org budget read).
    const singleRow = [
      `const { data, error } = await db(createAdminClient()).rpc("ai_invocations_month_totals", {`,
      `  p_org_id: orgId,`,
      `  p_month: probe,`,
      `});`,
      `const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];`,
      `const total = rows[0]?.total_cost_pence;`,
    ].join("\n");
    expect(rpcOffendersIn("lib/ai/governor.ts", singleRow)).toEqual([]);

    // Scalar return (a next-number / write RPC).
    const scalar = [
      `const { data, error } = await db.rpc("advance_material_request_fulfilment", {`,
      `  p_request_id: requestId,`,
      `});`,
      `return typeof data === "string" ? data : null;`,
    ].join("\n");
    expect(rpcOffendersIn("server/services/material-fulfilment.ts", scalar)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F-1 COVERAGE-COMPLETENESS META-GUARD (the structural blind-spot elimination)
// ═══════════════════════════════════════════════════════════════════════════
// ROOT CAUSE this closes: the two F-1 guards above only POLICE reads on a table
// that appears in HIGH_VALUE_TABLES / PRODUCER_TABLES (~38 tables). The repo
// reads ~100 distinct tables via `.from("<table>")`, so a completeness-sensitive
// SET read on ANY of the ~70 UNLISTED tables was structurally INVISIBLE — the
// guards' `offendersIn` early-returns unless the table is listed. This is exactly
// how the C63 schedule tables, the C64 portal/material tables, and the C65
// reports/certs/memberships gaps all escaped: the table simply wasn't on a list.
//
// We MEASURED the alternative first. Temporarily flipping the bare-select guard to
// scan ALL tables surfaced 91 distinct unbounded reads across ~50 unlisted tables
// — far past the point where each can be individually paged/allowlisted with rigor
// in one pass. So instead of broadening the per-READ guards to every table (which
// would need 91 verified per-read decisions), we install this per-TABLE coverage
// contract: EVERY table that has a set-read anywhere in app/server/lib MUST be
// either (a) POLICED by the F-1 guards (HIGH_VALUE_TABLES) — where its reads are
// mechanically forced to page/bound — or (b) listed in COVERAGE_REVIEWED with a
// written, human-verified reason WHY that table's set-reads are structurally never
// a silent-truncation risk. A NEW table with a set-read that is neither policed nor
// reviewed FAILS CI (proved by the teeth test) — so no unlisted table can ever
// again silently host an F-1 truncation. When a reviewed table later grows a
// completeness-sensitive read, the honest fix is to MOVE it into the policed lists
// (as demo_requests / hq_sales_companies were in this very wave), not to leave a
// stale "bounded" reason — a wrong reason here is the vacuous-allowlist anti-pattern.
//
// DETECTION SCOPE: literal `.from("t")` and the `.from("t" as never|any)` CAST
// idiom (the dominant post-generated-types form). A table read ONLY through a
// `.from`-wrapper declaration is covered for the policed tables by the wrapper
// matcher above; the coverage contract is stated in terms of the literal/cast form
// that every audited read actually uses.

/**
 * table → written reason WHY every set-read on it is structurally not an F-1
 * silent-truncation risk. Each was verified by reading ALL of the table's set
 * reads (see the classification in the C65 coverage wave). Categories used:
 *   PAGED      — every set-read pages via fetchAllRows (.range) → complete.
 *   PER-PARENT — every set-read is scoped to ONE parent row (.eq('<fk>')), so
 *                cardinality is bounded by that single parent, never near 1000.
 *   ID-BATCH   — every set-read is .in(<a bounded/chunked id set>) — a name/detail
 *                lookup bounded by the (bounded) parent set that produced the ids.
 *   PER-ORG    — a single org's config / register (.eq('org_id')); bounded by the
 *                org's own volume (headcount / closed config), far below the cap.
 *   RECENT-N   — a bounded top-N display (.limit(<1000)) NOT fed to a count/sum.
 *   CLOSED     — a fixed, closed registry/lookup set (tens of rows by construction).
 *   SINGLE     — only ever an existence / single-row probe (.limit(1)).
 */
const COVERAGE_REVIEWED: Record<string, string> = {
  // ---- PAGED (always fetchAllRows) ----
  accounting_pushed_entities: "PAGED: fetchAllRows (accounting-export ledger reconcile read)",
  activity_log: "PAGED: fetchAllRows on every read (activity feed, dashboard tile, AI aggregates)",
  asset_fuel_logs: "PAGED: fetchAllRows (fleet fuel rollup)",
  bank_statements: "PAGED: fetchAllRows (payments page statements list)",
  briefing_dismissals: "PAGED: fetchAllRows (daily briefing)",
  cis_subcontractors: "PAGED: fetchAllRows (CIS subcontractor roster)",
  compliance_documents: "PAGED: fetchAllRows (daily briefing compliance)",
  delay_events: "PAGED: fetchAllRows (EOT pack + intelligence delay analysis)",
  job_milestones: "PAGED: fetchAllRows (intelligence programme + job-progress)",
  job_programme_baselines: "PAGED: fetchAllRows (intelligence + job-progress baselines)",
  job_progress_observations: "PAGED: fetchAllRows (job-progress observations)",
  site_diary_entries: "PAGED: fetchAllRows (EOT pack diary; .in(ids) paged)",
  notification_email_queue:
    "PAGED/SINGLE: the CIS dedupe read is fetchAllRows-paged; the queue-drain read is a bounded worker .limit(DRAIN_BATCH<1000)",

  // ---- PER-PARENT (bounded by ONE parent row) ----
  blueprint_markup: "PER-PARENT: .eq('blueprint_version_id') — one drawing version's markup shapes",
  blueprint_pins: "PER-PARENT: .eq('blueprint_version_id')/.eq('job_id') — one drawing's/job's pins",
  blueprint_versions: "PER-PARENT: .eq('blueprint_id') — one blueprint's version history",
  blueprints: "PER-PARENT: .eq('job_id') — one job's drawings register",
  permit_conditions: "PER-PARENT: .eq('permit_id') — one permit's condition checklist",
  job_document_versions: "PER-PARENT/ID-BATCH: .eq('document_id')/.in(doc ids) — one document's versions",
  job_documents: "PER-PARENT: .eq('job_id') — one job's document register",
  job_budgets: "PER-PARENT: .eq('job_id') budget history; the CVR rollup read is fetchAllRows-paged",
  calls:
    "PER-PARENT/PER-ORG/RECENT-N: leads/[id] reads one lead's log (.eq('lead_id').limit(20)); the admin voice-panel reads a per-org recent-20 (.eq('org_id').order.limit(20)) — both author-capped displays below the 1000 cap, not summed. (C66: reason widened to cover the voice-panel per-org read the pre-de-vacuum scanner didn't fully window.)",
  // lead_followup_state: REMOVED (no set-read any more). The only read is a
  // single-row `.eq('lead_id').maybeSingle()` (leads/[id]/page.tsx); the other
  // two .from() sites are writes. The stale entry existed ONLY because the
  // pre-C66 `;`-windowing truncated the statement before `.maybeSingle()` and
  // mis-classified it as a set-read — the de-vacuum corrected that.
  risk_assessment_hazards: "PER-PARENT: .eq('risk_assessment_id') hazards; the H&S snapshot read is fetchAllRows-paged",

  // ---- ID-BATCH (bounded/chunked .in lookups) ----
  users: "ID-BATCH/PAGED: every read is .in(memberIds) — fetchAllRows-paged or a chunk-bounded name/pay lookup",
  import_files: "PER-PARENT/ID-BATCH: .eq('import_id')/.in(import ids) — one import's files",
  import_rows: "PER-PARENT: .eq('import_id') (+ status filter) — one import's staged rows",
  import_audit: "PER-PARENT: .eq('import_id') — one import's audit trail",
  tenant_attachments: "PER-PARENT/ID-BATCH: .eq('target_id') per entity or .in(<verified id set>) — one entity's attachments",
  job_warranties: "PER-PARENT/ID-BATCH: .eq('job_id') or .eq('org_id').in(<customer's job set>) — bounded by the parent job(s)",
  safety_acknowledgements: "PER-PARENT/ID-BATCH: .eq('subject_id')/.in(rev ids)/.in(job ids) — bounded by the subject set",
  invoice_reminders: "ID-BATCH: .in(candidateIds) — dedupe lookup bounded by the candidate invoice set",
  material_request_lines: "PAGED/ID-BATCH: fetchAllRows or .in(requestIds); the single read is .eq('id').limit(1)",

  // ---- PER-ORG (a single org's config / register) ----
  accounting_connections: "PER-ORG: .eq('org_id') accounting connection config — one/few provider rows",
  bank_connections: "PER-ORG/PAGED: .eq('org_id') config; the estate lister is fetchAllRows-paged",
  calendar_connections: "PER-ORG: .eq('org_id') calendar connection config",
  hmrc_submissions: "PER-ORG/SINGLE: .eq('org_id') submission list + a .limit(1) period-key existence probe",
  automation_rules: "PER-ORG/CLOSED: .eq('org_id') rule overrides — a closed automation-rule registry",
  automation_schedules: "PER-ORG/CLOSED: .eq('org_id') schedules — a closed schedule set",
  expense_budgets: "PER-ORG/CLOSED: .eq('org_id') budgets — a closed budget-category set",
  api_keys: "PER-ORG: .eq('org_id') API keys — a handful per org",
  // staff_secrets: REMOVED (false PER-ORG entry). "bounded by the org's
  // headcount" was wrong — the read was a BARE `.eq('org_id')` select clamped at
  // max_rows=1000, dropping NI numbers from the RTI/bureau payroll CSV for orgs
  // >1000 staff. Now POLICED in HIGH_VALUE_TABLES and PAGED via fetchAllRows.
  internal_notes: "PER-ORG: .eq('org_id') notes list + a .limit(Math.min(limit,500)) HQ variant — one org's notes",
  leave_requests:
    "PER-ORG/PER-USER: .eq('org_id') register + .eq('user_id') overlap reads — bounded by headcount; the me-page consumer is fetchAllRows-paged",
  imports: "PER-ORG: .eq('org_id') recent-ordered import list — one org's imports",
  payroll_runs: "PER-ORG: .eq('org_id') payroll run list — one org's runs",
  permits_to_work: "PER-ORG/PER-JOB: .eq('org_id') list or .eq('job_id') recent-N — one org's/job's permits",
  risk_assessments: "PER-ORG/PER-JOB/PAGED: .eq('org_id') list, .eq('job_id') display, or fetchAllRows snapshot",
  sites: "PER-ORG/PAGED: fetchAllRows-paged picker + a .limit(Math.min(opts.limit,SITE_LIST_LIMIT)) bounded sample",
  stock_items: "PER-ORG/SINGLE: .eq('org_id') with a Math.min-bounded .limit, or a .limit(1) in-org existence probe",
  material_requests: "PAGED/SINGLE: fetchAllRows demand read, a bounded list .limit, or .eq('id').limit(1)",
  suppliers: "PER-ORG/PAGED/ID-BATCH: fetchAllRows-paged list, a Math.min-bounded .limit sample, or .in(supplierIds) lookup",
  snags: "PER-PARENT/PAGED: .eq('job_id')/.in(snagIds) or fetchAllRows-paged (intelligence patterns)",
  rota_entries: "PER-PARENT/PER-ORG/PAGED: .eq('job_id')/.eq('user_id')+date-window, or fetchAllRows-paged",

  // ---- RECENT-N / bounded display (HQ or per-scope; not summed) ----
  ai_employee_memory: "RECENT-N: .eq('ai_employee_id').order.limit(N) per-employee memory display (HQ, dark)",
  ai_employee_tasks: "RECENT-N: .eq('ai_employee_id').order.limit(N) per-employee task display (HQ, dark)",
  ai_employees: "CLOSED: the fixed AI-employee roster (~11 rows) — a closed set (HQ, dark)",
  ai_receptionist_setups: "RECENT-N: .limit(500) admin board of receptionist setups — a bounded display, not summed",
  ai_reply_audits: "RECENT-N: .order.limit(REPLY_WINDOW) — HQ QA verdict window display",
  ai_reply_lifecycle: "PER-PARENT/RECENT-N: .eq('audit_id') per audit or a .limit(500) deliveries board display",
  hq_ai_tasks: "RECENT-N: .order.limit(TASK_WINDOW) reliability window / per-employee — HQ display, not a complete-set count",
  hq_ai_schedules: "CLOSED/RECENT-N: the cadence-schedule registry — .order or .limit(Math.min(limit,1000)) due-run picker",
  receptionist_conversation_outcomes: "RECENT-N: .order.limit(OUTCOME_WINDOW) — HQ QA window display",
  impersonation_sessions: "RECENT-N: .order.limit(Math.min(limit,1000)) audit list (caller passes 100) — admin display",
  toolbox_talks: "PER-PARENT/RECENT-N: .eq('job_id') / .limit recent / per-root revision series — bounded display",

  // ---- CLOSED registry / SINGLE existence ----
  hq_capabilities: "CLOSED: .in('token', <the closed capability registry>) — a fixed lookup set",
  hq_capability_grants: "CLOSED: .or(<clauses from the closed capability registry>) — bounded by the registry",
  billing_events: "SINGLE: .limit(1) existence probe (stripe verify) — not a set read",
  payments: "SINGLE: .select('id').eq(scoped...).limit(1) duplicate-payment existence probe",
  asset_assignments: "PER-ORG: .eq(scoped).limit(SITE_USAGE_SCAN_LIMIT) site-usage count sample — bounded",
  assets: "PER-ORG: .eq('org_id').limit(VAN_SCAN_LIMIT) assets picker — bounded by the org's fleet",

  // ── C66 CAST-FORM DE-VACUUM WAVE. The depth-aware `;`-windowing made these
  //    tables' cast-form set-reads visible. Each was traced end-to-end (read shape
  //    + consumer) and is genuinely bounded — NOT a silent-1000-cap risk. The
  //    three completeness-sensitive tables surfaced in the same wave
  //    (review_requests / portal_uploads / hq_sales_timeline_events) are POLICED +
  //    PAGED, not reviewed here.
  asset_inspections:
    "PER-ORG/PER-PARENT/SINGLE: the inspections dashboard reads are author-capped per-org windows (.eq('org_id').limit(100)/.limit(400), below the 1000 cap); the asset-detail read is per-parent (.eq('asset_id') — one asset's inspections); the rest are .maybeSingle() lookups. No cross-tenant/estate scan; the generator writes/claims, not reads.",
  asset_inspection_templates:
    "PER-ORG/PER-FAMILY/SINGLE: an org's inspection-template library — list/picker reads are per-org (.eq('org_id')) or per-family version history (.eq('family_id')); templates are org-authored config (families × versions is tens), never near the cap; resolves are .maybeSingle().",
  asset_inspection_schedules:
    "PER-PARENT/BATCH: per-asset standing schedules (.eq('asset_id')) display + a cross-org generator scan capped at .limit(BATCH=50); no estate set read (the writeback + CAS advance are updates).",
  asset_inspection_overrides:
    "PER-ORG/PER-PARENT: safety-override reads are an author-capped per-org .limit(200) window + per-asset (.eq('asset_id')) history; bounded well below the cap.",
  asset_service_schedules:
    "PER-PARENT/BATCH: per-asset service schedules (.eq('asset_id')) display + a cross-org generator scan capped at .limit(BATCH=50); the rest are writes/CAS advances.",
  asset_maintenance_cases:
    "PER-PARENT/SINGLE: per-asset maintenance cases (.eq('asset_id')) display + .maybeSingle() case lookups; bounded by one asset (the upsert claim returns only the won row).",
  asset_qr_identities:
    "PER-PARENT/SINGLE: per-asset QR lifecycle — a .limit(15) history display + .maybeSingle() active-token / scan-resolve lookups; bounded by one asset.",
  automation_runs:
    "PAGED: the cross-org health read (readAutomationHealth) pages via fetchAllRows over a 7-day window on a stable (created_at desc, id asc) order; every other .from site is a write / claim-update, not a set read.",
  call_events:
    "PER-ORG/PER-CALL/RECENT-N/PAGED: an admin .eq('org_id').order.limit(30) event display; a per-call bounded turn-memory read (loadRecentSpokenTurns) capped at .limit(Math.min(limit,1000)) (caller passes 20, for prompt memory); AND the per-call COMPLETE-transcript read (loadAllSpokenTurns) which pages EVERY turn via fetchAllRows on a stable (occurred_at asc, id asc) order — so the full-call transcript / governed lead re-extraction never truncate. Bounded display / per-call / fully paged, never a cross-tenant or silently-1000-capped set.",
  expense_drafts:
    "PER-ORG/SINGLE: an author-capped .eq('org_id').limit(200) queue display + .maybeSingle() draft lookups/guards; the service writes/stamps, not reads.",
  hq_sales_contacts:
    "PER-PARENT: every read is .eq('company_id') — one company's contacts (a handful/dozens), never near the cap (dedupe-name set + qualification rubric signals).",
  inbound_enquiries:
    "PER-ORG/RECENT-N/SINGLE: an author-capped .eq('org_id').limit(200) inbox display (not summed) + .eq('provider_message_id').maybeSingle() dedupe lookups; the rest are inserts/updates.",
  phone_numbers:
    "PER-ORG/SINGLE: an org's provisioned numbers (.eq('org_id')) — a handful per org (status badge + admin list); the dial-router resolve is .eq('e164').maybeSingle().",
  signatures:
    "PER-PARENT: .eq('target_table','quotes').eq('target_id', id) — one quote's e-sign audit trail (a handful); the other .from sites are inserts.",
  webhook_deliveries:
    "PER-ORG/RECENT-N: an author-capped .eq('org_id').order.limit(25) recent-deliveries display, joined to endpoints by id; not summed.",
  webhook_endpoints:
    "PER-ORG/SINGLE: an org's webhook endpoints (.eq('org_id')) — config-scale (a handful), list + urlById join; the resume read is .eq('id').maybeSingle().",
};

/** Tables with at least one SET read in ONE file's (raw) source — the per-source
 * core of the coverage scan, shared by the repo walk AND the cast-form teeth test
 * so both exercise the IDENTICAL windowing (the C66 de-vacuum). A SET read is a
 * `.select(...)` that is not a single-row read, not a write's RETURNING, and not
 * a head/count read, via a literal `.from("t")` or the `.from("t" as never|any)`
 * cast form. The statement window is DEPTH-AWARE (prev/nextTopLevelSemi), so the
 * inline `as unknown as { …; }` cast type-object no longer truncates the window
 * before the real `.select()` — the exact vacuity this wave closes. */
function setReadTablesInSource(rel: string, raw: string, into: Map<string, string[]>): void {
  if (!raw.includes(".from(")) return;
  const src = stripComments(raw);
  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*(?:as\s+(?:never|any)\s*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) {
    const table = m[1]!;
    const semiBefore = prevTopLevelSemi(src, m.index);
    const semiAfter = nextTopLevelSemi(src, m.index);
    const stmt = src.slice(semiBefore + 1, semiAfter);
    if (!/\.select\(/.test(stmt)) continue; // not a read
    if (/\.(insert|update|delete|upsert)\(/.test(stmt)) continue; // write RETURNING
    if (/\.single\(/.test(stmt) || /\.maybeSingle\(/.test(stmt)) continue; // single-row
    if (/head:\s*true/.test(stmt)) continue; // count/head — no rows to truncate
    const line = src.slice(0, m.index).split("\n").length;
    if (!into.has(table)) into.set(table, []);
    into.get(table)!.push(`${rel}:${line}`);
  }
}

function tablesWithSetReads(files: string[]): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  for (const file of files) {
    setReadTablesInSource(file.slice(ROOT.length + 1), readFileSync(file, "utf8"), byTable);
  }
  return byTable;
}

/** Tables with a set-read that are neither POLICED nor COVERAGE_REVIEWED. */
function coverageOffenders(byTable: Map<string, string[]>): string[] {
  const offenders: string[] = [];
  for (const [table, sites] of byTable) {
    if (HIGH_VALUE_TABLES.has(table)) continue; // policed by the F-1 guards
    if (COVERAGE_REVIEWED[table]) continue; // reviewed with a written reason
    offenders.push(`${table} (set-read at ${sites[0]}${sites.length > 1 ? ` +${sites.length - 1} more` : ""})`);
  }
  return offenders.sort();
}

describe("F-1 coverage-completeness meta-guard — every table with a set-read is policed OR reviewed", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no table has a set-read that is neither F-1-policed nor COVERAGE_REVIEWED", () => {
    const offenders = coverageOffenders(tablesWithSetReads(files));
    expect(
      offenders,
      `F-1 COVERAGE GAP: the table(s) below have a .from("<table>").select(...) SET read in ` +
        `app/server/lib but are NEITHER in the F-1 policed lists (HIGH_VALUE_TABLES / ` +
        `PRODUCER_TABLES) NOR in COVERAGE_REVIEWED. This is the structural blind spot that let ` +
        `C63/C64/C65 truncations hide. Decide, per table: if any of its set-reads is ` +
        `completeness-sensitive (a cross-tenant/estate scan, an aggregate, a count/sum, or a ` +
        `picker that must see the full set), add it to the F-1 policed lists and PAGE the read; ` +
        `otherwise add a COVERAGE_REVIEWED entry with a written, verified reason why every one of ` +
        `its set-reads is structurally bounded (per-parent, per-org config, id-batch, recent-N ` +
        `display, closed lookup, or always paged). Do NOT rubber-stamp:\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("COVERAGE_REVIEWED has no stale entries (every reviewed table still has a set-read and is not policed)", () => {
    const byTable = tablesWithSetReads(files);
    const stale: string[] = [];
    for (const table of Object.keys(COVERAGE_REVIEWED)) {
      if (HIGH_VALUE_TABLES.has(table)) {
        stale.push(`${table} — now POLICED; remove its COVERAGE_REVIEWED entry (a table must be in exactly one)`);
      } else if (!byTable.has(table)) {
        stale.push(`${table} — no set-read found any more; remove its stale COVERAGE_REVIEWED entry`);
      }
    }
    expect(stale, `COVERAGE_REVIEWED drift:\n${stale.join("\n")}`).toEqual([]);
  });

  // NON-VACUOUS PROOF: a NEW unpaged completeness-sensitive read on a previously
  // unlisted table MUST fail this meta-guard. We synthesise that exact situation —
  // a fresh table name that is neither policed nor reviewed — and assert the
  // coverage check flags it. Delete the guard's gate and this goes green, so the
  // teeth are real, not decorative.
  it("has TEETH: a set-read on a brand-new UNLISTED table is flagged", () => {
    const synthetic = new Map<string, string[]>([
      ["a_brand_new_ledger_2099", ["server/services/new-thing.ts:42"]],
    ]);
    const flagged = coverageOffenders(synthetic);
    expect(flagged.some((o) => o.includes("a_brand_new_ledger_2099"))).toBe(true);
  });

  // NON-VACUOUS PROOF on the CAST FORM (the C66 de-vacuum): the meta-guard's set-
  // read detector (tablesWithSetReads / setReadTablesInSource) must SEE a read
  // written in the dominant `.from("t" as never) as unknown as { …; }` cast idiom.
  // Before the depth-aware windowing, the inline type-object `;` truncated the
  // statement so `hasSelect` was false and the read was invisible — an unlisted
  // table hosting a cast-form set-read escaped the coverage net silently. Feed the
  // REAL cast-form source through the ACTUAL scanner and assert (a) the read is
  // detected and (b) an unlisted table carrying it is flagged.
  it("has TEETH on the CAST FORM: a cast-form set-read on an UNLISTED table is detected + flagged", () => {
    const castSource = [
      `const { data } = await (`,
      `  admin.from("a_brand_new_cast_ledger" as never) as unknown as {`,
      `    select: (cols: string) => {`,
      `      eq: (k: string, v: unknown) => LedgerQuery;`,
      `      order: (k: string, o: { ascending: boolean }) => LedgerQuery;`,
      `    };`,
      `  }`,
      `)`,
      `  .select("id, org_id, amount")`,
      `  .eq("org_id", orgId)`,
      `  .order("created_at", { ascending: false });`,
    ].join("\n");
    const byTable = new Map<string, string[]>();
    setReadTablesInSource("server/services/new-cast-thing.ts", castSource, byTable);
    // (a) The cast-form read is SEEN as a set-read (was invisible pre-de-vacuum).
    expect(byTable.has("a_brand_new_cast_ledger")).toBe(true);
    // (b) An unlisted table carrying it is flagged by the coverage net.
    expect(
      coverageOffenders(byTable).some((o) => o.includes("a_brand_new_cast_ledger")),
    ).toBe(true);

    // Control: the SAME cast-form read, but a single-row `.maybeSingle()`, is
    // correctly NOT a set-read (proves the detector reads past the type-object to
    // the real terminal call — the exact fix that reclassified lead_followup_state).
    const castSingle = [
      `const { data } = await (`,
      `  admin.from("a_brand_new_cast_ledger" as never) as unknown as {`,
      `    select: (cols: string) => { eq: (k: string, v: unknown) => LedgerQuery };`,
      `  }`,
      `)`,
      `  .select("id")`,
      `  .eq("id", rowId)`,
      `  .maybeSingle();`,
    ].join("\n");
    const single = new Map<string, string[]>();
    setReadTablesInSource("server/services/new-cast-thing.ts", castSingle, single);
    expect(single.has("a_brand_new_cast_ledger")).toBe(false);
  });

  it("does NOT flag a policed table or a reviewed table", () => {
    const ok = new Map<string, string[]>([
      ["invoices", ["x.ts:1"]], // policed
      ["blueprints", ["y.ts:1"]], // reviewed (PER-PARENT)
    ]);
    expect(coverageOffenders(ok)).toEqual([]);
  });
});
