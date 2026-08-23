import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * F-1 CLASS GUARD (repo-wide, FAIL-CLOSED) — no Supabase read may carry a
 * `.limit(<arg>)` that is not STATICALLY PROVABLE as <= 1000, nor a
 * `.range(from, to)` whose literal window exceeds 1000 rows.
 *
 * WHY: PostgREST clamps every response to `max_rows` (supabase/config.toml =
 * 1000). So `.limit(50000)` / `.limit(MOVEMENT_LIMIT=5000)` silently returns AT
 * MOST 1000 rows — the stated cap is a lie and any aggregate / export / ledger /
 * balance-fold / sweep over it under-reports with NO error. This is the F-1
 * defect class that recurred across audit waves C28→C35. The durable fix is this
 * guard. The only two HONEST read shapes are:
 *   - COMPLETE read  → `fetchAllRows(...)` (pages under the cap), NO `.limit`.
 *   - BOUNDED sample → `.limit(N<=1000)` (honest — you can't get more anyway).
 *
 * FAIL-CLOSED (the C35 hardening). The earlier version only flagged a `.limit`
 * arg it could PROVE was > 1000 (a literal, or a same-file numeric const). That
 * left three silent holes, each of which had shipped a live truncation:
 *   - coalescing / expression args — `.limit(opts.limit ?? CONST)`,
 *     `.limit(x ?? 500)`, `.limit(a || N)`: the dynamic side can be > 1000, so
 *     the read can silently truncate. (This is exactly how the pre-C35 stock
 *     balance-fold hid `.limit(opts.limit ?? STOCK_MOVEMENT_LIMIT)`, 5000.)
 *   - imported / cross-file consts — the arg resolves to nothing in THIS file,
 *     so its size is unknown here.
 *   - `.range(from, to)` windows > 1000 — a paging window that itself exceeds
 *     the clamp.
 * So the rule is inverted: an arg is allowed ONLY when a PROVABLE UPPER BOUND
 * <= 1000 can be computed from literals + same-file consts + `Math.min(...)`
 * (which is <= any one of its args). Everything else FAILS unless ALLOWLISTed
 * with a written justification.
 *
 * DELIBERATELY STILL GREEN (provably bounded, not traps):
 *   - `.limit(1)`, `.limit(500)`, `.limit(STOCK_ITEM_LIMIT)` (const = 1000)
 *   - `.limit(Math.min(x, 50))`, `.limit(Math.min(Math.max(limit, 1), 200))`
 *     — a min with a literal/const <= 1000 can never exceed it
 *   - a same-file `const capped = Math.min(Math.max(limit, 1), 50)` then
 *     `.limit(capped)` — the local is resolved to its Math.min bound
 *   - `.limit(CONST - 1)` / `.limit(CONST + 1)` when the result is <= 1000
 *
 * This complements the accounting-subsystem guard (f1-pagination-guard.test.ts)
 * with a mechanical, whole-repo net, plus a targeted high-value paging assertion
 * below (payroll / stock / money-ledger reads must page, never read bare).
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "server", "lib"];
const CLAMP = 1000; // PostgREST max_rows

/**
 * file (repo-relative) → written justification. Keep as SMALL as possible;
 * every entry is a documented smell that is STILL clamped to 1000 at runtime.
 * An entry here means "this `.limit`/`.range` is unprovable statically but has
 * been human-verified safe". Prefer fetchAllRows or a provable `.limit(<=1000)`.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * THE PRODUCER-.limit net (companion to the bare-select guard). A `.limit(N)` is
 * "honest" to the clamp sweep above whenever N <= 1000 — but on a HIGH-VALUE /
 * PRODUCER table that is NOT enough. Two ways an honest-looking `.limit` still
 * hides a bug:
 *   - the .limit(1000) BOUNDARY: a `.limit` resolving to EXACTLY 1000 is
 *     indistinguishable from silent truncation (a genuine top-1000 sample and a
 *     5000-row set clamped to 1000 look identical). This is how the LIVE
 *     invoice.overdue scan starved — `.limit(1000)` passed both F-1 guards.
 *   - the SUB-cap producer cap: a `.limit(500)`/`.limit(200)` on a set a picker
 *     or aggregation is supposed to see COMPLETELY still drops rows past the cap.
 *     This is how the quote property (`.limit(1000)`) and lead (`.limit(500)`)
 *     pickers silently nulled an out-of-cap reference on an unrelated edit save.
 *
 * So the rule is tightened: a PRODUCER-table read that materialises a SET may
 * carry NO `.limit(N)` at all (N >= 2) — it must page via fetchAllRows (COMPLETE)
 * or carry a BOUNDARY_ALLOWLIST reason declaring it a genuinely-bounded sample (a
 * top-N display, a per-scope batch). A `.limit(1)` is exempt: a single-row read
 * is not a truncatable set.
 *
 * Mirrors the bare-select guard's HIGH_VALUE_TABLES: money / ledger /
 * reconciliation / export / cross-tenant producer tables whose completeness
 * matters.
 */
const PRODUCER_TABLES = new Set<string>([
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
  "time_entries",
  "quote_line_items",
  "stock_movements",
  "bank_statement_lines",
  "telematics_connections",
  "telematics_readings",
  "fleet_vehicles",
  "weather_watches",
  "weather_readings",
  // CRM core (F-1 CRM wave) — mirrors the bare-select guard's HIGH_VALUE_TABLES.
  "jobs",
  "leads",
  "customers",
  // Sites/addresses — a quote/job reference picker; a capped read nulls an
  // out-of-cap property_id on edit. (F-1 picker-class wave.)
  "properties",
  // Support OS — CROSS-TENANT service-role reads mapped + counted in JS into the
  // /admin/support board, the /admin/support-ai triage board, and hq-product's CEO
  // demand aggregation; mirrors the bare-select guard's HIGH_VALUE_TABLES. A
  // `.limit(1000)`-on-the-boundary clamp here is the same silent-truncation trap.
  // (F-1 support wave; see the detection-limitation note in the bare-select guard.)
  "support_tickets",
  "support_messages",
  // HQ estate / cross-tenant completeness audit (the .from(as never) cast wave) —
  // mirrors the bare-select guard's HIGH_VALUE_TABLES. organizations (estate
  // roster), billing_invoices (estate MRR/outstanding money), notifications and
  // health_score_events (the .limit(Math.min(limit,1000)) boundary reads).
  "organizations",
  "billing_invoices",
  "notifications",
  "health_score_events",
  // Job billing schedule / retention (F-1 portal-schedule residual wave) —
  // mirrors the bare-select guard's HIGH_VALUE_TABLES. Cross-tenant, org-wide
  // reads feeding the customer-facing portal schedule + retention held total; a
  // sub-1000 cap silently drops schedule rows / under-counts released retention.
  "job_billing_plans",
  "job_billing_stages",
  "retention_releases",
  // Portal completeness + payroll total-omission (C65 wave) — mirrors the
  // bare-select guard's HIGH_VALUE_TABLES. site_reports / completion_certificates
  // feed the customer-portal document list + the `{documents.length} total` count
  // + the "Download all (zip)" X-Bulk-Total header (a sub-1000 cap under-reports
  // the total and drops the customer's own docs); memberships drives the whole
  // payroll run (one payroll_line per member — a cap gives overflow workers NO pay).
  "site_reports",
  "completion_certificates",
  "memberships",
  // C65 coverage-blind-spot wave — mirrors the bare-select guard's HIGH_VALUE_TABLES.
  // demo_requests (estate funnel summed into HQ figures + admin boards) and
  // hq_sales_companies (estate pipeline; old .limit(1000) sat on the boundary)
  // were genuine cross-tenant truncations surfaced by the coverage meta-guard and
  // are now PAGED, not capped.
  "demo_requests",
  "hq_sales_companies",
  // staff_secrets (C66 cast-form de-vacuum) — per-user NI numbers feeding the
  // statutory RTI/bureau payroll CSV + payslips. Was FALSELY marked PER-ORG in
  // COVERAGE_REVIEWED ("bounded by headcount"); an org with >1000 staff silently
  // dropped NI numbers from the CSV. The fetchNiNumbersForOrg read is now PAGED
  // (fetchAllRows, order user_id asc), so a re-bared read must fail here.
  "staff_secrets",
]);

/** "file:line" → reason. Only GENUINELY-bounded top-1000 samples belong here.
 * The overdue producer scan is DELIBERATELY absent: it is the real offender and
 * was fixed by paging (fetchAllRows), not allowlisted. */
const BOUNDARY_ALLOWLIST: Record<string, string> = {
  // P3 notifications digest — a per-(user, cadence) batch read of a user's
  // digest-eligible notifications, capped at .limit(MAX_NOTIFS_PER_DIGEST=200)
  // and ordered created_at ASC. This is a GENUINELY-bounded, self-draining
  // per-pass batch, NOT a completeness-sensitive set read: the cursor advances
  // ONLY to the created_at of the LAST notification actually included in the
  // email, so any overflow beyond 200 is not dropped — it rolls into the next
  // digest pass. A single digest email deliberately must not enumerate thousands
  // of notifications; 200 is the display bound. (Sibling class to the queue-drain
  // worker's bounded .limit(DRAIN_BATCH_SIZE).)
  "server/services/notification-preferences-service.ts:392":
    "bounded batch: ONE user's digest-eligible notifications (.eq('org_id') for that user, category-filtered) capped at 200 and ordered created_at ASC; the digest cursor advances only to the last INCLUDED row, so overflow rolls to the next pass rather than being dropped — a self-draining per-pass batch, not a completeness read.",
  // countPostedReceipts: REMOVED (C66). The PO register above it is now fully
  // PAGED, so purchaseOrderIds can exceed the cap and the old bounded reason
  // ("ONE list page's POs") is no longer true. The read is now CHUNKED + PAGED
  // (fetchAllRows over each 200-id chunk), so it carries a .range() not a .limit
  // and needs no entry. (The sibling listPurchaseOrderReceipts per-PO .limit(200)
  // read stays bounded — see its entry below, now at :60.)
  // material-fulfilment: REMOVED (false narrower-than-use entry). The reason
  // claimed "for ONE material request … request-sized, well below 1000", but the
  // two real callers pass MULTI-request / org-wide line sets in ONE call
  // (intelligence.gatherMaterialDemand → ALL open demand requests org-wide;
  // material-requests.deriveFulfilment → a whole list page's lines, up to 500
  // requests). Both reads are now PAGED in full via fetchAllRows + chunked .in(),
  // so they carry a .range() (not a .limit) and no longer need an entry.
  // sites/van-stock: per-ORG fleet_vehicles scans (.eq(org_id)) for site-usage
  // counts / a van picker. An SME org's fleet is tens of vehicles, not thousands.
  "server/services/sites.ts:187":
    "bounded: per-org fleet_vehicles count sample (.eq(org_id)) — an org's fleet is tens of vehicles. (Moved 159→187 when listSitesForOrg was split into a bounded + paged (fetchAllRows) picker read for the F-1 picker-completion wave.)",
  "server/services/van-stock.ts:105":
    "bounded: per-org fleet_vehicles picker (.eq(org_id)) — an org's fleet is tens of vehicles",

  // ── PRODUCER-.limit sweep (the ANY-.limit tightening) ─────────────────────
  // Every entry below is a GENUINELY-bounded sample the static analyser can't
  // recognise: a top-N display, a per-scope (per-customer / per-job / per-GRN)
  // read, a global-search result cap, or a NEW-form recency picker whose EDIT
  // counterpart re-shows the saved reference some OTHER way (a single .eq('id')
  // lookup, or a preserve-injected <option>). None is a complete-set read whose
  // truncation would drop rows a picker/aggregation must see — those were PAGED.

  // Detail-page display lists (recent-N, read-only, no write-back).
  "app/(app)/assets/[id]/page.tsx:232":
    "bounded: recent-200 jobs referencing this asset — detail-page display list, not a write-back picker",
  "app/(app)/delays/_data.ts:111":
    "bounded: recent-200 jobs sample for the delays report display",
  // diary/_data.ts:21 and quality/_data.ts:260 were HERE as "recent-200 jobs
  // sample" picker reads. Both are now PAGED via fetchAllRows (the C72
  // picker-completion class fix — they feed REQUIRED writable job pickers on
  // create AND draft-edit, so an out-of-cap saved job was silently mis-attributed),
  // so neither carries a producer .limit and neither needs an entry. Same
  // treatment as reviews/new, snags/new and site-reports/new below.
  "app/(app)/dashboard/page.tsx:230":
    "bounded: dashboard 'recent 5 leads' widget — an intentional top-5 display. (Moved to 230 in the security closeout when the payroll-tile read switched to loadOrgHourlyPay + a comment was added above; same intentional top-5 semantics inside the merged `coreWave` Promise.all.)",
  "app/(app)/leads/[id]/page.tsx:142":
    "bounded: this lead's related quotes — top-5 display on the lead detail page. (Line moved 132→136 when the lead→customer conversion imports were added; then 136→142 when the lead-score imports + panel were added above this read; reason unchanged.)",
  "app/(app)/me/page.tsx:145":
    "bounded: 'my recent 20 jobs' widget on the profile page — a top-N display. (Line moved to 145 in the security closeout when the own-pay read was split out to staff_compensation above this read; reason unchanged.)",
  "server/services/fleet-snapshot.ts:568":
    "bounded: last-50 telematics readings for a vehicle track display (recent-N sample)",
  "server/services/hq-customer-snapshot.ts:216":
    "bounded: last-10 payments for an HQ customer snapshot display (top-N). (Moved 215→216 when a fetchAllRows import was added for the .from(as never) cast-form wave.)",

  // NEW-form recency pickers — no saved reference is re-rendered through the list
  // (the EDIT counterpart resolves it separately), so no picker silent-null.
  //
  // reviews/new:54 and snags/new:38 were HERE as "recent-200 jobs sample" — both
  // are now PAGED via fetchAllRows (the picker-completion class fix), so neither
  // carries a producer .limit and neither needs an entry. (site-reports/new was
  // paged by the same class fix in #721; its stale key was likewise dropped.)
  "app/(app)/toolbox/_form-options.ts:41":
    "bounded: recent-200 jobs sample for the toolbox-talk picker; the EDIT form (_talk-form.tsx) preserve-injects the saved job_id so an out-of-sample link can never be dropped",
  "server/services/rota.ts:81":
    "bounded: recent-50 jobs for the assign-shift picker; assigning is a create action, not an edit re-render of a saved reference",

  // In-page link picker with preserve-option + explicit onChange write.
  "app/(app)/invoices/[id]/page.tsx:102":
    "bounded: recent-50 link-to-job picker; a controlled per-control select whose write fires only on explicit onChange (no shared-form save), and the linked job is preserve-injected in page.tsx so it always displays",

  // Global-search result caps — the command-palette (/api/search). Each is an
  // org-pinned (.eq('org_id', ctx.org.id)) top-N DISPLAY hit list, capped by the
  // same-file const named; results are mapped into `hits` for display (and the
  // customer/job/quote ids are chained into dependent `.in()` reads, themselves
  // bounded by that cap). NONE is fed into a count/sum/completeness surface — a
  // dropped hit past the cap is by-design "refine your query", not a wrong number.
  "app/api/search/route.ts:188":
    "bounded: search customers — .limit(CHAIN_LIMIT=50) DISPLAY hits, org-pinned; ids chained into ≤50 .in() lookups, NOT counted/summed",
  "app/api/search/route.ts:243":
    "bounded: search jobs — .limit(CHAIN_LIMIT=50) DISPLAY hits, org-pinned; ids chained into ≤50 .in() lookups, NOT counted/summed",
  "app/api/search/route.ts:252":
    "bounded: search quotes — .limit(CHAIN_LIMIT=50) DISPLAY hits, org-pinned; ids chained into ≤50 .in() lookups, NOT counted/summed",
  "app/api/search/route.ts:258":
    "bounded: search leads — .limit(PER_TYPE=8) DISPLAY hits, org-pinned, NOT fed to any count/sum",
  "app/api/search/route.ts:348":
    "bounded: search invoices — .limit(PER_TYPE=8) DISPLAY hits, org-pinned, NOT fed to any count/sum",
  // Documents-search wave (new entities in the command palette). Each is an
  // org-pinned (.eq('org_id', ctx.org.id)) top-N DISPLAY hit list capped at
  // PER_TYPE=8, mapped straight into `hits` for display — never counted/summed.
  "app/api/search/route.ts:366":
    "bounded: search purchase_orders — .limit(PER_TYPE=8) DISPLAY hits, org-pinned, NOT fed to any count/sum",
  "app/api/search/route.ts:372":
    "bounded: search site_reports — .limit(PER_TYPE=8) DISPLAY hits, org-pinned, NOT fed to any count/sum",
  // /documents home — the HIGH-VALUE jobs read is a CHUNKED name lookup:
  // `.in('id', idsChunk)` where each chunk is ≤JOB_IN_CHUNK=500 unique job ids
  // (jobs.id is unique, so a chunk yields ≤500 rows), used only to label the
  // aggregated documents with their job/customer name — never counted/summed.
  "app/(app)/documents/page.tsx:183":
    "bounded: /documents job-name lookup — CHUNKED .in('id', idsChunk) capped at .limit(JOB_IN_CHUNK=500) per chunk (jobs.id unique ⇒ ≤500 rows); a display-label lookup over a fully-read doc set, NOT counted/summed",
  "app/(app)/jobs/page.tsx:93":
    "bounded: search-match helper — collects up to 200 matching customer ids to fold into the .range()-paged jobs query; a name-search sub-sample, not a materialised set",

  // Customer-portal reads.
  //
  // REMOVED (false narrower-than-use entries surfaced by the C64 audit): the
  // documents-library quotes (:48) + invoices (:60) reads and the jobs-tab (:152)
  // read were justified as "top-N display" but each is the customer's COMPLETE
  // set: the documents `{documents.length} total` count AND the "Download all
  // (zip)" bundle derive from :48/:60 (a cap dropped docs from the count and the
  // customer's own ZIP), and the jobs read was ASC-ordered so :152's cap dropped
  // the NEWEST jobs. All three are now PAGED via fetchAllRows (.range), so none
  // needs an entry.  The q/[token] sibling-variation read (was :199) fed a MONEY
  // SUM into a legally-signed contract total — "practically small" ≠ "provably
  // complete" — and is likewise PAGED, not allowlisted.
  //
  // The portal HOME + quotes-tab quotes reads were ALSO false ("counted, never
  // summed"/"top-200 display") — allQuotes feeds COUNT KPIs + the live action
  // centre, and the quotes tab is a set the customer must see in full — both now
  // PAGED. The portal invoices reads (home + invoices tab) are DELIBERATELY
  // absent for the same reason: they feed a MONEY aggregate (computePortalPayments)
  // and are PAGED, with the aggregate-fed-cap net below refusing any re-silencing.
  //
  // The portal ZIP bulk-download reads (was :153 invoices / :168 quotes) were
  // ALSO removed: the ZIP caps at MAX_BULK_DOCS newest docs, but `plan.total`
  // (a .length count of these reads) is surfaced to the customer as the
  // X-Bulk-Total truncation-note header, so a .limit(200) under-reported it.
  // Both are now PAGED via fetchAllRows (.range) — the selection is unchanged,
  // the surfaced total is now exact.

  // All GRNs on ONE purchase order — bounded by the single-PO scope. (Line moved
  // 58→60 when a fetchAllRows import + a .range on the Chain type were added for
  // the countPostedReceipts paging in the same file.)
  "app/(app)/purchase-orders/_receiving-data.ts:60":
    "bounded: every goods-received note for ONE purchase order (.eq('purchase_order_id')) — a PO has a handful of deliveries, top-200",

  // Per-request id-set lookup. (Line shifted +1 by the additive `barcode` column
  // on StockItemRow / STOCK_ITEM_COLUMNS, 20261144000000; shifted again by the
  // additive loadStockValuationReport + cost columns, W1 stock COGS, 20261180000000.)
  "server/services/stock.ts:303":
    "bounded: receipt movements for a specific GRN's line-id set (.in('grn_line_id', grnLineIds)) — request-sized lookup; the balance-fold read (listStockMovements) is separately paged via fetchAllRows. (Moved 272→303 when the stock-COGS wave added the loadStockCogsCostRows helper + import above this read.)",

  // ── .from(as never) CAST-FORM WAVE — genuinely-bounded recency / per-scope
  //    reads surfaced once notifications / health_score_events joined
  //    PRODUCER_TABLES. Each is a recent-N display or a single-scope read, never
  //    a complete-set aggregation, so the sub-cap .limit is honest.
  "app/(app)/layout.tsx:38":
    "bounded: the top nav notification bell — recent-30 notifications for ONE user in the active org (.eq('org_id').eq('user_id').limit(30)), a per-user top-N display. (Moved 32→34 when the offline read-cache + photo-outbox client components were imported into the app layout; moved 34→38 when the i18n-wave request helper + its comment replaced the bare requireOrgContext call.)",
  "app/customer-portal/_future-work.ts:57":
    "bounded: ONE customer's own portal future-work requests (.eq('org_id').eq('customer_id').eq('source','portal').limit(50)) — token-scoped to a single customer, a recent-50 display",
  "server/services/hq-health-deep-dive.ts:298":
    "bounded: ONE org's health-score timeline (.eq('org_id').limit(Math.min(limit,1000))) — listHealthHistoryForOrg, a per-org recent-N display (caller passes 50), not a cross-tenant set",
  // notifications-service getLatest{ForCustomer,ForHq}: REMOVED (false
  // narrower-than-use — the C64 audit found BOTH the customer unread badge and
  // the HQ urgent/high/24h tiles + org-filter dropdown derive .length/distinct
  // from these capped reads, so a cap under-counted every one). Both are now
  // PAGED via fetchAllRows (.range), so neither carries a .limit or needs entry.

  // ── C65 MEMBERSHIPS / SITE_REPORTS wave — capped reads surfaced once
  //    memberships + site_reports joined PRODUCER_TABLES. Each is a genuinely
  //    bounded DISPLAY sample, not a completeness/count/ZIP contributor (those —
  //    listPortalReports/listPortalCertificates and createPayrollRun's members
  //    read — were PAGED, not capped).
  "app/api/search/route.ts:196":
    "bounded: search members — .limit(40) command-palette DISPLAY hits, org-pinned (.eq('org_id')); a top-N result list, NOT fed to any count/sum. Same class as the other /api/search reads.",
  "app/customer-portal/_photos.ts:107":
    "bounded: recent-50 published reports for the portal PHOTO GALLERY (.eq('customer_id').eq('org_id')...order('portal_published_at' desc).limit(50)), further capped at MAX_PORTAL_PHOTOS extracted photos — a display gallery, NOT the documents-library count/ZIP (those use listPortalReports, now PAGED)",
  "server/services/receptionist-operators.ts:42":
    "bounded: ONE org's operators picker (.eq('org_id').limit(500)) — reassignment target list; bounded by the org's headcount (tens), never near the cap",
  "server/services/hq-sales.ts:1006":
    "bounded: recent-8 sales companies (.order('created_at' desc).limit(8)) — a top-N DISPLAY facet on the HQ sales dashboard, NOT summed/counted (the estate FACET reads that ARE summed — pipelineValue/aggregateSalesFacets — were PAGED in the C66 de-vacuum). (Line moved 995→1006 when the two FacetRow facet reads above it were paged.)",
};

/** Strip block + line comments so historical `.limit(...)` mentions in prose
 * don't count. Replaces comment bodies with same-length blanks to keep line
 * numbers accurate. */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return out;
}

/**
 * True iff `s` contains a statement-terminating `;` at brace/paren/bracket DEPTH
 * 0 (outside every ()/[]/{}). This is the DE-VACUUM of the cast-form windowing.
 *
 * The dominant Supabase read idiom carries an INLINE CAST TYPE-OBJECT annotation:
 *   admin.from("t" as never) as unknown as { select:(c:string)=>Q; eq:...; }
 *       .select(...).eq(...).limit(20);
 * The `;` characters between `.from` and `.limit` are TypeScript member
 * separators INSIDE the `{ … }` type object — NOT statement boundaries. The
 * previous `between.includes(";")` check treated them as a statement boundary and
 * skipped the read BEFORE the PRODUCER_TABLES / .select() checks ran, so EVERY
 * cast-form producer read (e.g. support_tickets in the customer portal) slipped
 * past the clamp/aggregate nets with a green suite. A `;` only terminates a
 * statement at depth <= 0; the type-object separators sit at depth >= 1 and are
 * correctly ignored here. (stripComments already neutralises comment `;`; this
 * mirrors it for type-annotation `;`.)
 */
function containsTopLevelSemicolon(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return true;
  }
  return false;
}

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

/**
 * Extract the balanced-paren argument string for every `<method>(` call, so a
 * nested `Math.min(Math.max(a, 1), 50)` is captured WHOLE rather than truncated
 * at the first `)`. Returns [{ arg, index }] where index points at the method.
 */
function extractCalls(src: string, method: string): Array<{ arg: string; index: number }> {
  const out: Array<{ arg: string; index: number }> = [];
  const marker = `.${method}(`;
  let i = 0;
  while ((i = src.indexOf(marker, i)) !== -1) {
    // Ensure it's a real method call (`.limit(`) and not a substring like
    // `.delimit(` — require the char before `.` to not be an identifier char.
    const before = src[i - 1] ?? " ";
    if (/[A-Za-z0-9_$]/.test(before)) {
      i += marker.length;
      continue;
    }
    let depth = 0;
    let j = i + marker.length - 1; // at the '('
    const start = j + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ arg: src.slice(start, j).trim(), index: i });
    i = j + 1;
  }
  return out;
}

/** Split a call-argument list on TOP-LEVEL commas (respecting nested parens). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Same-file numeric consts/lets: `const NAME = 12345` (underscores allowed). */
function numericConsts(src: string): Map<string, number> {
  const m = new Map<string, number>();
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9][0-9_]*)\b(?!\s*[.eE])/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    if (mm[1] && mm[2]) m.set(mm[1], Number(mm[2].replace(/_/g, "")));
  }
  return m;
}

/**
 * Compute a PROVABLE UPPER BOUND for an expression using the env of resolved
 * numeric identifiers, or return null when no static upper bound is knowable.
 *
 *   - numeric literal            → its value
 *   - identifier in env          → its bound
 *   - Math.min(a, b, ...)        → the SMALLEST finite bound among the args
 *                                  (min <= any single arg; one bounded arg is
 *                                  enough to bound the whole call)
 *   - Math.max(a, b, ...)        → max of bounds, but ALL args must be bounded
 *   - `A + k` / `A - k` / `A * k` (k a literal int) → arithmetic on bound(A)
 *   - everything else (`x ?? N`, `a || b`, `input.limit`, a bare dynamic
 *     identifier, a call) → null (UNPROVABLE)
 */
function provableUpperBound(expr: string, env: Map<string, number>): number | null {
  let a = expr.trim();
  // Peel a single fully-enclosing paren pair: `(Math.min(...))`.
  while (a.startsWith("(") && a.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let k = 0; k < a.length; k++) {
      if (a[k] === "(") depth++;
      else if (a[k] === ")") {
        depth--;
        if (depth === 0 && k < a.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (wraps) a = a.slice(1, -1).trim();
    else break;
  }

  if (/^[0-9][0-9_]*$/.test(a)) return Number(a.replace(/_/g, ""));
  if (/^[A-Za-z_$][\w$]*$/.test(a)) return env.has(a) ? env.get(a)! : null;

  const minM = /^Math\.min\((.*)\)$/s.exec(a);
  if (minM) {
    const bounds = splitArgs(minM[1]!).map((x) => provableUpperBound(x, env));
    const finite = bounds.filter((b): b is number => b !== null);
    return finite.length ? Math.min(...finite) : null;
  }
  const maxM = /^Math\.max\((.*)\)$/s.exec(a);
  if (maxM) {
    const bounds = splitArgs(maxM[1]!).map((x) => provableUpperBound(x, env));
    return bounds.every((b) => b !== null) ? Math.max(...(bounds as number[])) : null;
  }

  // `A <op> k` with k a trailing literal (e.g. `MAX_ROWS_PER_TABLE + 1`).
  const bin = /^(.+?)\s*([+\-*])\s*([0-9][0-9_]*)$/s.exec(a);
  if (bin) {
    const base = provableUpperBound(bin[1]!, env);
    if (base === null) return null;
    const k = Number(bin[3]!.replace(/_/g, ""));
    return bin[2] === "+" ? base + k : bin[2] === "-" ? base - k : base * k;
  }
  return null; // `??`, `||`, member access, calls, etc. — unprovable
}

/** Build the identifier env: numeric consts, then `const X = Math.min(...)`. */
function buildEnv(src: string): Map<string, number> {
  const env = numericConsts(src);
  // Resolve `const/let NAME = <expr>` where <expr> has a provable bound and is
  // NOT already a bare numeric literal (those are in numericConsts). This greens
  // the `const capped = Math.min(Math.max(limit, 1), 50)` idiom.
  const re = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) {
    const name = mm[1]!;
    const rhs = mm[2]!.trim();
    if (env.has(name)) continue;
    if (/^[0-9]/.test(rhs)) continue;
    const b = provableUpperBound(rhs, env);
    if (b !== null) env.set(name, b);
  }
  return env;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every high-value read in a file, covering the literal `.from("table")` form
 * AND the `.from`-wrapper indirection (arrow OR function-declaration wrapper —
 * e.g. `function table<T>(c, name) { return c.from(name) }` then
 * `table<...>(client, "table")`), which the literal scan is blind to. Returns
 * [{ table, index }] where index anchors the read for line reporting + region.
 */
function producerReadIndices(src: string): Array<{ table: string; index: number }> {
  const out: Array<{ table: string; index: number }> = [];

  // Includes the `.from("table" as never)` / `.from("table" as any)` CAST idiom
  // (tables that post-date the generated types), detected identically to a plain
  // `.from("table")` — the optional `(?:as\s+(?:never|any))?` after the
  // backreferenced literal. Table membership is still gated by PRODUCER_TABLES.
  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*(?:as\s+(?:never|any)\s*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) out.push({ table: m[1]!, index: m.index });

  const wrapperNames = new Set<string>();
  const arrowRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=;]*?)?=>\s*[^;{}]*?\.from\(/g;
  const fnRe =
    /function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{[\s\S]{0,400}?\.from\(/g;
  let wm: RegExpExecArray | null;
  while ((wm = arrowRe.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  while ((wm = fnRe.exec(src))) if (wm[1]) wrapperNames.add(wm[1]);
  for (const name of wrapperNames) {
    // `table<...>(client, "table")` — allow an optional generic before the call —
    // OR the single-arg form `adminTable("table")` where the literal is the ONLY
    // arg (the declaration-wrapper shape hq-support-snapshot / hq-health-deep-dive
    // use; without the optional first arg this guard shared the bare-select guard's
    // single-arg blind spot).
    const callRe = new RegExp(
      escapeReg(name) + `(?:<[^()]*?>)?\\s*\\(\\s*(?:[^,()]+,\\s*)?["'\`]([a-z_]+)["'\`]\\s*\\)`,
      "g",
    );
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(src))) out.push({ table: cm[1]!, index: cm.index });
  }
  return out;
}

/** Producer-.limit offenders in one file: a PRODUCER-table read materialising a
 * SET that carries ANY `.limit(N)` with N >= 2 (a bounded cap where the picker /
 * aggregation is supposed to see the COMPLETE set), that neither pages
 * (.range/fetchAllRows) nor is allowlisted. A `.limit(1)` is a single-row read
 * and is exempt. An unprovable `.limit(x)` is also flagged here (fail-closed) —
 * it is separately caught by the clamp sweep, but a producer read must resolve
 * to paged-or-allowlisted regardless.
 *
 * LIMIT-ANCHORED (not region-scanned): each `.limit()` is bound to the NEAREST
 * PRECEDING `.from`/wrapper read in the SAME statement (no intervening `;`). A
 * pure region window bled a `.limit()` onto an adjacent read and misreported the
 * line — anchoring on the limit is exact. */
function boundaryOffendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".limit(")) return [];
  const src = stripComments(raw);
  const env = buildEnv(src);
  // Producer reads sorted by position so we can find the nearest preceding one.
  const reads = producerReadIndices(src).sort((a, b) => a.index - b.index);
  const offenders = new Set<string>();

  for (const { arg, index: limIdx } of extractCalls(src, "limit")) {
    // A `.limit(1)` is a single-row read, not a truncatable set — exempt it.
    // Everything else (a provable N in 2..1000, the 1000 boundary, over-cap, or
    // an unprovable/dynamic arg) is a producer cap that must page or be justified.
    if (provableUpperBound(arg, env) === 1) continue;
    // Nearest producer read whose `.from`/wrapper starts before this `.limit`.
    let pRead: { table: string; index: number } | undefined;
    for (const r of reads) {
      if (r.index < limIdx) pRead = r;
      else break;
    }
    if (!pRead) continue;
    const between = src.slice(pRead.index, limIdx);
    if (containsTopLevelSemicolon(between)) continue; // the limit is a DIFFERENT statement
    if (!PRODUCER_TABLES.has(pRead.table)) continue;
    if (!/\.select\(/.test(between)) continue; // reads only
    if (/\.range\(/.test(between)) continue; // windowed, not a flat cap
    const line = src.slice(0, pRead.index).split("\n").length;
    const key = `${rel}:${line}`;
    if (BOUNDARY_ALLOWLIST[key]) continue;
    offenders.add(
      `${key} → .from("${pRead.table}") producer read capped at .limit(${arg}) — a set a ` +
        `picker/aggregation must see COMPLETE: page via fetchAllRows or add a BOUNDARY_ALLOWLIST reason`,
    );
  }
  return [...offenders];
}

// ── The AGGREGATE-FED capped-money-read net (the subclass this wave closes) ──
//
// The producer-.limit net above lets a capped producer read be silenced with a
// BOUNDARY_ALLOWLIST entry claiming it is a "genuinely-bounded display sample".
// That escape hatch is exactly what let the LIVE customer portal ship a truncated
// money surface: the home `.limit(50)` and invoices-tab `.limit(200)` reads were
// allowlisted as "top-N display", but they FED A MONEY AGGREGATE
// (computePortalPayments / a .reduce over invoice totals) that computes the
// customer-facing "Outstanding"/"Due now" balance. A cap <1000 looked honest to
// the clamp guard, bare-select saw an honest `.limit(<1000)`, and the producer
// net was satisfied by the allowlist — so it slipped past all three.
//
// RULE: a capped, UNPAGED read of a money/ledger (PRODUCER) table whose rows flow
// into a money aggregate (a `.reduce` fold, or a known money-aggregate helper)
// must PAGE via fetchAllRows. Unlike the producer net, this net does NOT honour
// BOUNDARY_ALLOWLIST — an aggregate over a money table can never be justified as a
// bounded display, because the aggregate's whole job is to see EVERY row.

/** Known money-aggregate consumers: passing a set to one of these = a money fold.
 * (computePortalPayments nets paid/dueNow/overdue over the customer's invoices.) */
const AGGREGATE_HELPERS = new Set<string>(["computePortalPayments"]);

/** file:line → reason. A capped money read that genuinely feeds an aggregate yet
 * is human-verified safe (e.g. hard-bounded by an `.in(<tiny id set>)`). Prefer
 * paging; keep this EMPTY unless there is a written, verified reason. */
const AGGREGATE_FED_ALLOWLIST: Record<string, string> = {};

/** The `data:` alias a read's rows bind to: the nearest `const { data: X } = await`
 * (or bare `const { data } = ...`) whose `= await` precedes the read. */
function readDataAlias(src: string, readIdx: number): string | null {
  const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\b/g;
  let m: RegExpExecArray | null;
  let best: RegExpExecArray | null = null;
  while ((m = re.exec(src))) {
    if (m.index > readIdx) break;
    best = m;
  }
  if (!best) return null;
  const inner = best[1]!;
  const dm = /(?:^|,)\s*data\s*:\s*([A-Za-z_$][\w$]*)/.exec(inner);
  if (dm) return dm[1]!;
  if (/(?:^|,)\s*data\s*(?:,|$)/.test(inner)) return "data";
  return null;
}

/** Transitive closure of variables that alias a root read var: `const X = root`,
 * `const X = root ?? []`, `const X: T = root.filter(...)`, `const X = root.map(...)`. */
function aliasClosure(src: string, root: string): Set<string> {
  const set = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of [...set]) {
      const re = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*${escapeReg(a)}\\b`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (!set.has(m[1]!)) {
          set.add(m[1]!);
          grew = true;
        }
      }
    }
  }
  return set;
}

/** Walk the method chain starting at each (receiver) occurrence of `alias`,
 * honouring balanced parens, returning true if a `.reduce(` is reached — catches
 * both `alias.reduce(` and `alias.filter(...).reduce(`. */
function chainReducesFrom(src: string, alias: string): boolean {
  const re = new RegExp(`\\b${escapeReg(alias)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if ((src[m.index - 1] ?? " ") === ".") continue; // a property, not the receiver
    let i = m.index + alias.length;
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] !== ".") break;
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      const name = src.slice(i + 1, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k]!)) k++;
      if (name === "reduce") return true;
      if (src[k] !== "(") break; // property access, not a call — chain ends
      let depth = 0;
      for (; k < src.length; k++) {
        if (src[k] === "(") depth++;
        else if (src[k] === ")") {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
      }
      i = k;
    }
  }
  return false;
}

/** True when any alias flows into a money aggregate: a `.reduce(` fold, or a
 * known money-aggregate helper with the alias as its leading argument token. */
function feedsMoneyAggregate(src: string, aliases: Set<string>): boolean {
  for (const a of aliases) {
    if (chainReducesFrom(src, a)) return true;
    for (const fn of AGGREGATE_HELPERS) {
      if (new RegExp(`\\b${escapeReg(fn)}\\(\\s*${escapeReg(a)}\\b`).test(src)) return true;
    }
  }
  return false;
}

/** Aggregate-fed capped-money-read offenders in one file: a PRODUCER-table read
 * carrying a flat `.limit(N>=2)` (unpaged) whose rows flow into a money aggregate.
 * Deliberately does NOT consult BOUNDARY_ALLOWLIST. */
function aggregateFedCapOffendersIn(rel: string, raw: string): string[] {
  if (!raw.includes(".limit(")) return [];
  const src = stripComments(raw);
  const env = buildEnv(src);
  const reads = producerReadIndices(src).sort((a, b) => a.index - b.index);
  const offenders = new Set<string>();

  for (const { arg, index: limIdx } of extractCalls(src, "limit")) {
    if (provableUpperBound(arg, env) === 1) continue; // single-row read, not a set
    let pRead: { table: string; index: number } | undefined;
    for (const r of reads) {
      if (r.index < limIdx) pRead = r;
      else break;
    }
    if (!pRead) continue;
    const between = src.slice(pRead.index, limIdx);
    if (containsTopLevelSemicolon(between)) continue; // .limit is a DIFFERENT statement
    if (!PRODUCER_TABLES.has(pRead.table)) continue;
    if (!/\.select\(/.test(between)) continue; // reads only
    if (/\.range\(/.test(between) || /fetchAllRows/.test(between)) continue; // paged
    const alias = readDataAlias(src, pRead.index);
    if (!alias) continue;
    const aliases = aliasClosure(src, alias);
    if (!feedsMoneyAggregate(src, aliases)) continue;
    const line = src.slice(0, pRead.index).split("\n").length;
    const key = `${rel}:${line}`;
    if (AGGREGATE_FED_ALLOWLIST[key]) continue;
    offenders.add(
      `${key} → .from("${pRead.table}") capped at .limit(${arg}) FEEDS A MONEY AGGREGATE ` +
        `(.reduce / ${[...AGGREGATE_HELPERS].join("/")}) — an aggregate over a money/ledger table ` +
        `must PAGE via fetchAllRows; a sub-1000 cap silently truncates the customer-facing total. ` +
        `This subclass is NOT allowlistable as a bounded display.`,
    );
  }
  return [...offenders];
}

describe("F-1 guard — every .limit / .range is provably <= 1000", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(resolve(ROOT, d), files);

  it(`scans a non-trivial number of source files`, () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no .limit(<arg>) unless a provable upper bound <= 1000", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".limit(")) continue;
      const src = stripComments(raw);
      const env = buildEnv(src);
      for (const { arg, index } of extractCalls(src, "limit")) {
        if (!arg) continue;
        const bound = provableUpperBound(arg, env);
        if (bound !== null && bound <= CLAMP) continue; // provably honest
        if (ALLOWLIST[rel]) continue;
        const line = src.slice(0, index).split("\n").length;
        const why =
          bound === null
            ? `NOT statically provable <= ${CLAMP} (dynamic / coalescing / imported)`
            : `= ${bound} (> ${CLAMP})`;
        offenders.push(`${rel}:${line} → .limit(${arg}) ${why}`);
      }
    }
    expect(
      offenders,
      `F-1 clamp trap. A .limit() is silently capped to ${CLAMP} by PostgREST, so ` +
        `an arg that can exceed ${CLAMP} — or that can't be PROVEN <= ${CLAMP} here — ` +
        `can silently truncate. Use fetchAllRows for a COMPLETE read, or a provable ` +
        `.limit(<=${CLAMP}) (e.g. Math.min(x, ${CLAMP})) for an honest bounded sample:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("no .range(from, to) with a literal window > 1000", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".range(")) continue;
      const src = stripComments(raw);
      for (const { arg, index } of extractCalls(src, "range")) {
        const parts = splitArgs(arg);
        if (parts.length !== 2) continue;
        const from = parts[0]!.trim();
        const to = parts[1]!.trim();
        if (!/^[0-9][0-9_]*$/.test(from) || !/^[0-9][0-9_]*$/.test(to)) continue; // dynamic (fetchAllRows) — fine
        const window = Number(to.replace(/_/g, "")) - Number(from.replace(/_/g, "")) + 1;
        if (window <= CLAMP) continue;
        if (ALLOWLIST[rel]) continue;
        const line = src.slice(0, index).split("\n").length;
        offenders.push(`${rel}:${line} → .range(${from}, ${to}) window = ${window} (> ${CLAMP})`);
      }
    }
    expect(
      offenders,
      `F-1 clamp trap: a .range() window wider than ${CLAMP} rows is truncated by ` +
        `PostgREST. Page it with fetchAllRows (pages of <=${CLAMP}):\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("no producer read carries any .limit(N>=2) (page or allowlist)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...boundaryOffendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 producer .limit trap. A read of a high-value/producer table that ` +
        `materialises a SET must not carry a flat .limit(N>=2): a picker or ` +
        `aggregation is meant to see the COMPLETE set, and any cap (the .limit(1000) ` +
        `boundary OR a sub-cap .limit(500)/.limit(200)) silently drops rows past it — ` +
        `exactly how the quote property/lead pickers nulled an out-of-cap reference on ` +
        `edit, and how the invoice.overdue scan starved. Page it via fetchAllRows for a ` +
        `COMPLETE read, or add a BOUNDARY_ALLOWLIST entry with a written reason if it is ` +
        `a genuinely-bounded sample (top-N display, per-scope batch):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // TEETH: the producer-.limit net must flag the invoice.overdue boundary shape,
  // the SUB-cap producer cap (the quote-picker class), and go green on the paged
  // fix + the single-row .limit(1) exemption.
  it("producer-.limit net has TEETH: flags .limit(1000) boundary AND sub-cap .limit(N), passes when paged", () => {
    const litPreFix = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(1000);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", litPreFix).length).toBeGreaterThan(0);

    const constPreFix = [
      `const SCAN_LIMIT = 1000;`,
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .lt("due_date", todayIso)`,
      `  .limit(SCAN_LIMIT);`,
    ].join("\n");
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", constPreFix).length).toBeGreaterThan(0);

    // NEW: a SUB-cap producer cap is now ALSO flagged — the exact quote-picker
    // class (properties `.limit(1000)`, leads `.limit(500)`). A .limit(500) on a
    // producer set is no longer "honest": it drops rows past the cap.
    const subCapProps = [
      `const { data } = await supabase`,
      `  .from("properties")`,
      `  .select("id, customer_id, address")`,
      `  .eq("org_id", orgId)`,
      `  .limit(1000);`,
    ].join("\n");
    expect(boundaryOffendersIn("app/(app)/quotes/_form-helpers.ts", subCapProps).some((o) => o.includes("properties"))).toBe(true);
    const subCapLeads = [
      `const { data } = await supabase`,
      `  .from("leads")`,
      `  .select("id, customer_id")`,
      `  .eq("org_id", orgId)`,
      `  .limit(500);`,
    ].join("\n");
    expect(boundaryOffendersIn("app/(app)/quotes/_form-helpers.ts", subCapLeads).some((o) => o.includes("leads"))).toBe(true);

    // The COMPLETE-read fix pages via fetchAllRows → clean.
    const pagedFix = [
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
    expect(boundaryOffendersIn("lib/invoices/overdue-scheduler.ts", pagedFix)).toEqual([]);

    // A single-row .limit(1) is a bounded lookup, NOT a truncatable set → exempt.
    const singleRow = [
      `const { data } = await admin`,
      `  .from("invoices")`,
      `  .select("id, org_id")`,
      `  .eq("customer_id", cid)`,
      `  .limit(1);`,
    ].join("\n");
    expect(boundaryOffendersIn("x.ts", singleRow)).toEqual([]);

    // Catches the function-declaration `.from`-wrapper form too (the shape the
    // goods_received_notes reader uses), not just literal `.from`.
    const wrapperPreFix = [
      `function table<T>(supabase, name) { return supabase.from(name); }`,
      `const { data } = await table<{ purchase_order_id: string }>(supabase, "goods_received_notes")`,
      `  .select("purchase_order_id")`,
      `  .eq("status", "posted")`,
      `  .limit(1000);`,
    ].join("\n");
    expect(boundaryOffendersIn("x.ts", wrapperPreFix).some((o) => o.includes("goods_received_notes"))).toBe(true);
  });

  // TEETH (C66 cast-form de-vacuum): the DOMINANT read idiom carries an inline
  // `as unknown as { … }` cast TYPE-OBJECT whose `;` member separators sit between
  // `.from` and `.limit`. The pre-C66 `between.includes(";")` windowing treated
  // those `;` as a statement boundary and SKIPPED the read before the
  // PRODUCER_TABLES / .select() check — so the LIVE support_tickets .limit(20)
  // portal read (and every other cast-form producer read) slipped past this net
  // with a green suite. Feed the REAL cast-form source through the ACTUAL scanner
  // and assert it BITES. A delete-the-fix of the messages page (revert to
  // .limit(20)) makes the repo-wide test above FAIL naming the real file:line.
  it("producer-.limit net has TEETH on the CAST FORM (the C66 de-vacuum)", () => {
    const castForm = [
      `const { data } = await (`,
      `  admin.from("support_tickets" as never) as unknown as {`,
      `    select: (cols: string) => {`,
      `      eq: (k: string, v: unknown) => TicketQuery;`,
      `      order: (k: string, o: { ascending: boolean }) => TicketQuery;`,
      `    };`,
      `  }`,
      `)`,
      `  .select("id, subject, last_reply_kind")`,
      `  .eq("org_id", orgId)`,
      `  .eq("customer_id", customerId)`,
      `  .order("created_at", { ascending: false })`,
      `  .limit(20);`,
    ].join("\n");
    expect(
      boundaryOffendersIn("app/customer-portal/[token]/messages/page.tsx", castForm).some((o) =>
        o.includes("support_tickets"),
      ),
      "the cast-form support_tickets .limit(20) producer read MUST be flagged (it was NOT before the de-vacuum)",
    ).toBe(true);

    // The paged fix (cast form + fetchAllRows/.range, no .limit) → clean.
    const castPaged = [
      `const { data } = await fetchAllRows((from, to) =>`,
      `  (`,
      `    admin.from("support_tickets" as never) as unknown as {`,
      `      select: (cols: string) => TicketQuery;`,
      `    }`,
      `  )`,
      `    .select("id, subject, last_reply_kind")`,
      `    .eq("org_id", orgId)`,
      `    .eq("customer_id", customerId)`,
      `    .order("created_at", { ascending: false })`,
      `    .order("id", { ascending: false })`,
      `    .range(from, to),`,
      `);`,
    ].join("\n");
    expect(boundaryOffendersIn("app/customer-portal/[token]/messages/page.tsx", castPaged)).toEqual([]);
  });

  // ── The aggregate-fed capped-money-read net (subclass this wave closes) ──
  it("no capped money read feeds a money aggregate (must page — not allowlistable)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      offenders.push(...aggregateFedCapOffendersIn(rel, readFileSync(file, "utf8")));
    }
    expect(
      offenders,
      `F-1 aggregate-fed cap. A capped (.limit(N<=1000)), UNPAGED read of a money/ledger ` +
        `table whose rows flow into a money aggregate (a .reduce fold or ${[...AGGREGATE_HELPERS].join("/")}) ` +
        `silently truncates the customer-facing total once the set crosses the 1000-row cap. This is ` +
        `the exact shape that shipped a wrong "Outstanding" on the customer portal — a sub-1000 cap ` +
        `evades the clamp guard, the bare-select guard AND the producer net's allowlist. Page it via ` +
        `fetchAllRows for a COMPLETE read; this subclass may NOT be allowlisted as a bounded display:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("aggregate-fed cap net has TEETH: flags the pre-fix portal reads, passes when paged", () => {
    // Pre-fix portal HOME: capped invoices read feeding a .filter(...).reduce sum.
    const overviewPreFix = [
      `const { data: invoicesData, error: invoicesError } = await admin`,
      `  .from("invoices")`,
      `  .select("id, status, total, due_date")`,
      `  .eq("org_id", customer.org_id)`,
      `  .eq("customer_id", customer.id)`,
      `  .order("created_at", { ascending: false })`,
      `  .limit(50);`,
      `const invoices = invoicesData ?? [];`,
      `const outstandingInvoices = invoices.filter((inv) => inv.status === "sent");`,
      `const outstandingTotal = outstandingInvoices.reduce((s, inv) => s + Number(inv.total), 0);`,
    ].join("\n");
    expect(
      aggregateFedCapOffendersIn("app/customer-portal/[token]/page.tsx", overviewPreFix).length,
    ).toBeGreaterThan(0);

    // Pre-fix invoices TAB: capped invoices read feeding computePortalPayments.
    const invoicesPreFix = [
      `const { data: invoicesData, error: invoicesError } = await admin`,
      `  .from("invoices")`,
      `  .select("id, status, total, due_date")`,
      `  .eq("org_id", customer.org_id)`,
      `  .eq("customer_id", customer.id)`,
      `  .order("created_at", { ascending: false })`,
      `  .limit(200);`,
      `const invoices = invoicesData ?? [];`,
      `const paySummary = computePortalPayments(invoices.map((i) => ({ status: i.status, total: i.total, due_date: i.due_date, paid: 0 })));`,
    ].join("\n");
    expect(
      aggregateFedCapOffendersIn("app/customer-portal/[token]/invoices/page.tsx", invoicesPreFix).length,
    ).toBeGreaterThan(0);

    // The paged fix (fetchAllRows + .range, no .limit on the invoices read) → clean.
    const paged = [
      `const { data: invoicesData, error: invoicesError } = await fetchAllRows((from, to) =>`,
      `  admin`,
      `    .from("invoices")`,
      `    .select("id, status, total, due_date")`,
      `    .eq("org_id", customer.org_id)`,
      `    .eq("customer_id", customer.id)`,
      `    .order("created_at", { ascending: false })`,
      `    .order("id", { ascending: true })`,
      `    .range(from, to),`,
      `);`,
      `const invoices = invoicesData;`,
      `const paySummary = computePortalPayments(invoices.map((i) => ({ status: i.status, total: i.total, due_date: i.due_date, paid: 0 })));`,
      // A sibling capped QUOTES read that is only COUNTED/displayed stays clean.
      `const { data: quotesData } = await admin.from("quotes").select("id, status").eq("org_id", o).limit(50);`,
      `const allQuotes = quotesData ?? [];`,
      `const openQuotes = allQuotes.filter((q) => q.status === "sent").length;`,
    ].join("\n");
    expect(aggregateFedCapOffendersIn("app/customer-portal/[token]/page.tsx", paged)).toEqual([]);

    // A bounded money read that does NOT feed an aggregate (a recent-N timeline
    // display iterated with for..of) is NOT flagged — no false-positive.
    const displayOnly = [
      `const { data: paymentRows } = await admin`,
      `  .from("invoice_payments")`,
      `  .select("id, paid_at, amount")`,
      `  .eq("org_id", orgId)`,
      `  .order("paid_at", { ascending: false })`,
      `  .limit(10);`,
      `const payments = (paymentRows ?? []);`,
      `for (const p of payments) { timeline.push(p.paid_at); }`,
    ].join("\n");
    expect(
      aggregateFedCapOffendersIn("server/services/hq-customer-snapshot.ts", displayOnly),
    ).toEqual([]);
  });

  // Self-test: the hardened resolver must actually catch the shapes the old
  // guard missed — otherwise a green suite proves nothing.
  it("resolver rejects the exact shapes the pre-C35 guard missed", () => {
    const env = new Map<string, number>([
      ["STOCK_MOVEMENT_LIMIT", 5000],
      ["STOCK_ITEM_LIMIT", 1000],
      ["SMALL", 200],
    ]);
    // coalescing (the pre-fix stock balance-fold) — dynamic side unprovable
    expect(provableUpperBound("opts.limit ?? STOCK_MOVEMENT_LIMIT", env)).toBeNull();
    expect(provableUpperBound("opts.limit ?? STOCK_ITEM_LIMIT", env)).toBeNull();
    expect(provableUpperBound("x ?? 500", env)).toBeNull();
    expect(provableUpperBound("a || 250", env)).toBeNull();
    // bare dynamic / member access
    expect(provableUpperBound("limit", env)).toBeNull();
    expect(provableUpperBound("input.limit", env)).toBeNull();
    // same-file const over the clamp
    expect(provableUpperBound("STOCK_MOVEMENT_LIMIT", env)).toBe(5000);
    // provably-safe shapes stay green
    expect(provableUpperBound("1", env)).toBe(1);
    expect(provableUpperBound("STOCK_ITEM_LIMIT", env)).toBe(1000);
    expect(provableUpperBound("Math.min(limit, 1000)", env)).toBe(1000);
    expect(provableUpperBound("Math.min(Math.max(limit, 1), 50)", env)).toBe(50);
    expect(provableUpperBound("Math.min(opts.limit ?? STOCK_MOVEMENT_LIMIT, 1000)", env)).toBe(1000);
    expect(provableUpperBound("MAX + 1", new Map([["MAX", 999]]))).toBe(1000);
  });

  // High-value paging tripwire: the money / balance-ledger reads MUST page via
  // fetchAllRows, never read a single (truncatable) bare page. This catches the
  // "no .limit at all" bare-select F-1 that the .limit sweep above can't see.
  it("known money / balance ledger reads page via fetchAllRows", () => {
    const failures: string[] = [];
    const mustPage: Array<{ file: string; needle: string }> = [
      { file: "app/(app)/payroll/[id]/page.tsx", needle: `.from("payroll_lines")` },
      { file: "app/api/payroll/[id]/csv/route.ts", needle: `.from("payroll_lines")` },
      { file: "app/(app)/payroll/page.tsx", needle: `.from("payroll_lines")` },
      { file: "app/(app)/tax/page.tsx", needle: `.from("payroll_lines")` },
    ];
    for (const { file, needle } of mustPage) {
      const src = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      if (!src.includes(needle)) {
        failures.push(`${file}: expected read ${needle} not found (moved? update this guard)`);
        continue;
      }
      if (!src.includes("fetchAllRows")) {
        failures.push(`${file}: reads ${needle} but does NOT page via fetchAllRows — F-1 bare-read risk`);
      }
    }
    // stock: the BALANCE-FOLD read (listStockMovements) must page; the bounded
    // grn-line lookup in the same file legitimately does not, so scope to the fn.
    const stockSrc = stripComments(
      readFileSync(resolve(ROOT, "server/services/stock.ts"), "utf8"),
    );
    const fnStart = stockSrc.indexOf("export async function listStockMovements");
    const fnBody =
      fnStart === -1
        ? ""
        : stockSrc.slice(fnStart, stockSrc.indexOf("\nexport ", fnStart + 1));
    if (fnStart === -1) {
      failures.push("server/services/stock.ts: listStockMovements not found (renamed?)");
    } else if (!fnBody.includes("fetchAllRows")) {
      failures.push(
        "server/services/stock.ts: listStockMovements (the balance-fold input) must page via fetchAllRows",
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F-1 VARIABLE-.from() EXPORT-LOOP BLIND SPOT
// ═══════════════════════════════════════════════════════════════════════════
// Every F-1 guard above (the clamp sweep, the producer net, the bare-select
// guard) inspects reads through a LITERAL `.from("table")` (plus a few wrapper
// forms). All of them are STRUCTURALLY BLIND to a read that loops over a table
// REGISTRY and reads `.from(<variable>)`:
//   for (const table of ORG_EXPORT_TABLES)
//     await supabase.from(table).select("*").eq("org_id", orgId).limit(999 + 1);
// That is exactly how the LIVE GDPR/DSAR export (server/services/gdpr-export.ts,
// buildOrgExport) truncated EVERY org-scoped table at 999 rows while all three
// F-1 guards stayed green: the literal-table matcher never fired on the variable
// `.from(table)`, the clamp guard saw `999+1 = 1000 <= 1000` and passed it, and
// the bare-select guard needs a literal table name it never had.
//
// RULE: a registry-driven org-scoped read — `.from(<variable>).select().eq(
// "org_id", …)` in a file that drives an export from the org-scoped-table
// registry (ORG_EXPORT_TABLES) — MUST page the table in full via `fetchAllRows`
// (`.range`). It may carry NO `.limit(` (a cap silently truncates a statutory
// export) and may not read bare (a bare select is clamped to max_rows). This is
// the completeness contract for the whole-org DSAR archive.

/** Files that assemble a whole-archive / DSAR export from the org-scoped-table
 * registry. The guard is scoped to these so it is a tight completeness net, not
 * a repo-wide one — a generic `.from(x)` elsewhere is out of scope here. */
const EXPORT_REGISTRY_FILES = ["server/services/gdpr-export.ts"];

/**
 * Every registry-driven org-scoped export read in `raw` that fails the
 * complete-read contract. Detects the VARIABLE `.from(<identifier>)` shape the
 * literal-table matchers miss, scoped to files that drive the export from
 * ORG_EXPORT_TABLES. Shared by the repo-scan and the red→green teeth so both
 * exercise identical detection.
 */
function gdprExportLoopOffenders(rel: string, raw: string): string[] {
  // Scope: only files that read the org-scoped-table registry to build an export.
  if (!raw.includes("ORG_EXPORT_TABLES")) return [];
  const src = stripComments(raw);
  const offenders: string[] = [];
  // `.from(<identifier>)` — a VARIABLE table (the registry loop), NOT a string
  // literal `.from("t")` (which the sibling F-1 guards already cover).
  const re = /\.from\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fromIdx = m.index;
    const semi = src.indexOf(";", fromIdx);
    const stmt = src.slice(fromIdx, semi === -1 ? fromIdx + 500 : semi);
    // Only an org-scoped SET read (the export shape): a `.select` pinned by
    // `.eq("org_id", …)`. An insert/update/other `.from(var)` is not this class.
    if (!/\.select\(/.test(stmt)) continue;
    if (!/\.eq\(\s*["'`]org_id["'`]/.test(stmt)) continue;
    // PAGED? fetchAllRows wraps the builder (appears just before `.from`) or the
    // statement carries the `.range()` terminator — either is the complete-read
    // fix. A `.limit(` anywhere in the statement is a CAP (truncation trap).
    const before = src.slice(Math.max(0, fromIdx - 300), fromIdx);
    const paged =
      /\.range\(/.test(stmt) ||
      /fetchAllRows/.test(before) ||
      /fetchAllRows/.test(stmt);
    const capped = /\.limit\(/.test(stmt);
    if (paged && !capped) continue; // the correct, complete-read shape
    const line = src.slice(0, fromIdx).split("\n").length;
    offenders.push(
      `${rel}:${line} → .from(<variable>).select().eq("org_id", …) ` +
        (capped
          ? "carries a capped .limit() — a registry-driven org-scoped EXPORT read " +
            "silently truncates a statutory DSAR; page it in full via fetchAllRows"
          : "is a bare unpaged read — clamped to max_rows; page it in full via fetchAllRows"),
    );
  }
  return offenders;
}

describe("F-1 export-loop guard — registry-driven org-scoped reads must page in full", () => {
  it("gdpr-export.ts buildOrgExport pages every table (no capped variable-.from read)", () => {
    const offenders: string[] = [];
    for (const rel of EXPORT_REGISTRY_FILES) {
      offenders.push(...gdprExportLoopOffenders(rel, readFileSync(resolve(ROOT, rel), "utf8")));
    }
    expect(
      offenders,
      `F-1 export-loop truncation: a registry-driven org-scoped read loops over ` +
        `ORG_EXPORT_TABLES with a VARIABLE .from(table) — invisible to the literal-` +
        `table F-1 guards — but caps or bares the read, so it silently truncates the ` +
        `statutory DSAR export. Page each table in full via fetchAllRows (.range) on a ` +
        `stable, unique order:\n` + offenders.join("\n"),
    ).toEqual([]);
  });

  it("has TEETH: flags the pre-fix capped read, passes the paged fix", () => {
    // The EXACT pre-fix shape: the registry loop with `.limit(MAX_ROWS_PER_TABLE + 1)`.
    const preFix = [
      `for (const table of ORG_EXPORT_TABLES) {`,
      `  const res = await supabase`,
      `    .from(table)`,
      `    .select("*")`,
      `    .eq("org_id", orgId)`,
      `    .limit(MAX_ROWS_PER_TABLE + 1);`,
      `}`,
    ].join("\n");
    expect(gdprExportLoopOffenders("server/services/gdpr-export.ts", preFix).length).toBeGreaterThan(0);
    expect(
      gdprExportLoopOffenders("server/services/gdpr-export.ts", preFix)[0],
    ).toMatch(/capped \.limit/);

    // A bare unpaged variable read (no .limit, no paging) is ALSO flagged.
    const bare = [
      `for (const table of ORG_EXPORT_TABLES) {`,
      `  const res = await supabase.from(table).select("*").eq("org_id", orgId);`,
      `}`,
    ].join("\n");
    expect(gdprExportLoopOffenders("server/services/gdpr-export.ts", bare).length).toBeGreaterThan(0);

    // The COMPLETE-read fix pages via fetchAllRows + .range → clean.
    const pagedFix = [
      `for (const table of ORG_EXPORT_TABLES) {`,
      `  const { data, error } = await fetchAllRows<Record<string, unknown>>(`,
      `    (from, to) =>`,
      `      supabase`,
      `        .from(table)`,
      `        .select("*")`,
      `        .eq("org_id", orgId)`,
      `        .order(exportOrderKey(table), { ascending: true })`,
      `        .range(from, to) as unknown as PromiseLike<PageResult<Record<string, unknown>>>,`,
      `  );`,
      `}`,
    ].join("\n");
    expect(gdprExportLoopOffenders("server/services/gdpr-export.ts", pagedFix)).toEqual([]);
  });

  it("is SCOPED: does not fire on a variable .from() outside the export registry", () => {
    // The same variable-.from org-scoped shape in a file that does NOT read the
    // ORG_EXPORT_TABLES registry is out of THIS net's scope (it is other guards'
    // job) — no false positive here.
    const unrelated = [
      `const res = await supabase.from(someTable).select("*").eq("org_id", orgId).limit(5);`,
    ].join("\n");
    expect(gdprExportLoopOffenders("server/services/something-else.ts", unrelated)).toEqual([]);
  });
});
