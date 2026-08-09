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
  "server/services/material-fulfilment.ts:125":
    "bounded: stock issue movements for ONE material request (.in(lineIds)) — request-sized, well below 1000",
  "server/services/material-fulfilment.ts:150":
    "bounded: correction movements for ONE request's issued set (.in(rows.map(id))) — request-sized, well below 1000",
  "server/services/sites.ts:187":
    "bounded: per-org fleet_vehicles count sample (.eq(org_id)) — an org's fleet is tens of vehicles. (Moved 159→187 when listSitesForOrg was split into a bounded + paged (fetchAllRows) picker read for the F-1 picker-completion wave.)",
  "server/services/van-stock.ts:105":
    "bounded: per-org fleet_vehicles picker (.eq(org_id)) — an org's fleet is tens of vehicles",
  // CRM wave (jobs/leads/customers joined HIGH_VALUE_TABLES). Each is either a
  // hard-bounded id-batch name lookup or a genuinely paged read the static
  // analyser cannot see through a long builder chain.
  "app/(app)/diary/page.tsx:83":
    "bounded: jobs name lookup .in('id', jobIds) where jobIds is a Set drawn from the diary register (.limit(500)) — ≤500 unique PKs, analyser can't see .in's slice bound",
  "app/(app)/site-reports/page.tsx:99":
    "bounded: jobs name lookup .in('id', jobIds) where jobIds is a Set drawn from the reports register (.limit(500)) — ≤500 unique PKs",
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
  "app/(app)/jobs/[id]/commercial/page.tsx:168":
    "bounded: ONE job's purchase orders (.eq('job_id')) — feeds the committed-costs tile for a single job; a job has a handful to dozens of POs, never near 1000",
  "app/(app)/jobs/[id]/page.tsx:307":
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
  "server/services/hq-billing-snapshot.ts:258":
    "bounded: ONE org's billing invoices (.eq('org_id')) for the /admin/billing inline expand-row — monthly cadence, structurally far below 1000",
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
 * Look at the enclosing region around a `.from("TABLE")` read: a window BEFORE
 * (to catch a `fetchAllRows(...)` wrapper, incl. the common multi-statement
 * `let q = supabase.from(...)…; return q.range(lo,hi)` shape) and AFTER (to catch
 * the chain's terminator methods across one `let q = …;` statement boundary).
 * Trades a little precision for not false-positiving paged reads.
 */
function regionAround(src: string, fromIdx: number): string {
  const BEFORE = 300;
  const AFTER = 1100; // wide enough to see the terminator past a long multi-line select list
  return src.slice(Math.max(0, fromIdx - BEFORE), fromIdx + AFTER);
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
