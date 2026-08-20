import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * PostgREST embed ambiguity — the PGRST201 tripwire.
 *
 * The incident this pins: `asset_assignments` carries TWO foreign keys to
 * `assets` (`asset_id` + `vehicle_asset_id`), so a bare `assets(...)` embed
 * gives PostgREST two candidate relationships and it rejects the WHOLE query
 * with PGRST201. Both /assets/holdings and the job hub's assets panel
 * destructured `const { data } = await ...` and rendered `data ?? []` — so a
 * hard query failure showed as "Nothing is checked out" in production for
 * weeks. Empty-on-error is indistinguishable from healthy (the e2e axe
 * canary's candidacy-floor argument, e2e/_axe-canary.ts).
 *
 * Two invariants, derived from the SCHEMA and the SOURCE so the next
 * migration that grows a second FK to an embedded table fails CI here, at
 * birth, instead of shipping weeks of silent empty states:
 *
 *  1. The set of (source → target) table pairs with ≥2 FK relationships,
 *     parsed from supabase/migrations/*.sql, must equal the REVIEWED list
 *     below. A new ambiguous pair fails until every embed of that pair is
 *     FK-hinted and the pair is added here.
 *
 *  2. No `.from(X).select("...")` in app/, server/, lib/, components/ may
 *     embed across an ambiguous pair — in either direction, at any nesting
 *     depth — without an explicit FK-name hint. `!inner` / `!left` are JOIN
 *     modifiers, NOT disambiguation: `assets!inner(...)` still PGRST201s.
 *
 * Parser scope (kept deliberately simple, tightened only when the schema
 * actually uses a form): CREATE TABLE inline `references`, table-level
 * `constraint ... foreign key`, and `add constraint ... foreign key` (incl.
 * inside do-blocks; quoted identifiers tolerated). Select strings are read
 * from literal args and same-file `const NAME = "..."` constants.
 *
 * KNOWN BLIND SPOT (deliberate, not yet closed): the source sweep keys off a
 * literal `.from("table")`, so the `tbl(client)("table").select(...)` helper
 * idiom used by the H&S / permits / toolbox services is invisible to it. Those
 * call sites are NOT swept for ambiguous embeds. Closing it means resolving the
 * helper's table argument through one more indirection; until then the FK-graph
 * invariant above (which is schema-derived and therefore complete) is what
 * catches a newly-ambiguous pair, and the coverage floor below stops the
 * literal-`.from` sweep from quietly shrinking further.
 */

const ROOT = resolve(__dirname, "..", "..");

// ── 1. FK graph from migrations ──────────────────────────────────────────────

type FkEdge = { name: string; source: string; cols: string[]; target: string };

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

function parseMigrationFks(sql: string): { edges: FkEdge[]; dropped: Array<[string, string]> } {
  const src = stripSqlComments(sql);
  const edges: FkEdge[] = [];
  const dropped: Array<[string, string]> = [];

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_]+)"?\s*\(/gi;
  const tableFkRe =
    /(?:constraint\s+"?([a-z_0-9]+)"?\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+(?:public\.)?"?([a-z_]+)"?/i;
  const inlineFkRe = /^\s*"?([a-z_]+)"?\s+[a-z]+[^,]*?\breferences\s+(?:public\.)?"?([a-z_]+)"?/i;
  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_]+)"?/gi;
  const addConRe =
    /add\s+constraint\s+"?([a-z_0-9]+)"?\s+foreign\s+key\s*\(([^)]*)\)\s*references\s+(?:public\.)?"?([a-z_]+)"?/gis;
  const dropConRe = /drop\s+constraint\s+(?:if\s+exists\s+)?"?([a-z_0-9]+)"?/gi;

  const cleanCols = (raw: string) => raw.split(",").map((c) => c.trim().replace(/"/g, ""));

  // CREATE TABLE bodies — walk to the matching close paren.
  for (const m of src.matchAll(createRe)) {
    const table = m[1]!;
    let i = m.index! + m[0].length;
    let depth = 1;
    const bodyStart = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    for (const part of splitTopLevel(src.slice(bodyStart, i - 1))) {
      const tf = tableFkRe.exec(part);
      if (tf) {
        const cols = cleanCols(tf[2]!);
        edges.push({ name: tf[1] ?? `${table}_${cols[0]}_fkey`, source: table, cols, target: tf[3]! });
        continue;
      }
      if (!/foreign\s+key/i.test(part)) {
        const inf = inlineFkRe.exec(part);
        if (inf) edges.push({ name: `${table}_${inf[1]!}_fkey`, source: table, cols: [inf[1]!], target: inf[2]! });
      }
    }
  }

  // ADD CONSTRAINT ... FOREIGN KEY anywhere — pair with nearest preceding ALTER TABLE.
  const alters: Array<{ pos: number; table: string }> = [];
  for (const am of src.matchAll(alterRe)) alters.push({ pos: am.index!, table: am[1]! });
  for (const addm of src.matchAll(addConRe)) {
    const prior = alters.filter((a) => a.pos < addm.index!);
    if (prior.length === 0) continue;
    edges.push({
      name: addm[1]!,
      source: prior[prior.length - 1]!.table,
      cols: cleanCols(addm[2]!),
      target: addm[3]!,
    });
  }
  for (const am of src.matchAll(alterRe)) {
    const tail = src.slice(am.index! + am[0].length, am.index! + am[0].length + 200);
    for (const dm of tail.matchAll(dropConRe)) dropped.push([am[1]!, dm[1]!]);
  }

  return { edges, dropped };
}

function buildFkGraph(): Map<string, FkEdge[]> {
  const dir = resolve(ROOT, "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const all: FkEdge[] = [];
  const droppedSet = new Set<string>();
  for (const f of files) {
    const { edges, dropped } = parseMigrationFks(readFileSync(join(dir, f), "utf8"));
    all.push(...edges);
    for (const [t, c] of dropped) droppedSet.add(`${t}\u0000${c}`);
  }
  const seen = new Set<string>();
  const byPair = new Map<string, FkEdge[]>();
  for (const e of all) {
    const key = `${e.source}\u0000${e.name}`;
    if (droppedSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    const pair = `${e.source}\u0000${e.target}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), e]);
  }
  return byPair;
}

/**
 * THE REVIEWED LIST. Every pair here has been checked against the codebase:
 * all embeds crossing these pairs carry explicit FK-name hints (test 2 proves
 * it stays that way). If your migration adds a second FK and lands a NEW pair
 * here, hint every embed of that pair FIRST, then extend this list.
 */
const REVIEWED_AMBIGUOUS_PAIRS = [
  "admin_alert_state → users",
  // AI budget control audit (20261147000000): target_user_id (the employee a
  // limit applied to) + changed_by (the super-admin who made the change) both →
  // users. Reviewed 2026-08-16: server/services/ai-budget-controls.ts resolves
  // names via a separate namesFor("users", ...) lookup keyed on id, never a
  // users(...) embed, so no read is ambiguous. Two FKs is inherent — who was
  // limited vs who changed it — and a future embed must FK-hint (test 2 enforces).
  "ai_budget_control_audit → users",
  // AI per-employee limits (20261147000000): user_id (the employee capped) +
  // set_by (the super-admin who set it) both → users. Reviewed 2026-08-16:
  // ai-budget-controls.ts resolves the employee's name via the same separate
  // users lookup, never an embed, so no read is ambiguous.
  "ai_employee_budget_limits → users",
  // AI quote drafts (20261068): created_by + applied_by + discarded_by all → users.
  // Reviewed 2026-07-29: server/services/ai-quote-writer.ts is the only reader and
  // it selects scalar columns only ("id, status", "id, content, degraded,
  // created_at", "id") — there is no users(...) embed anywhere on this table, so
  // no bare embed can hit PGRST201 today. Three FKs is inherent to the row's
  // purpose: it records who ASKED for a draft, who APPLIED it and who DISCARDED
  // it, and collapsing them would destroy the audit trail. Any future embed must
  // name its FK constraint.
  "ai_quote_drafts → users",
  "asset_assignments → assets",
  "asset_assignments → users",
  // Depreciation settings (P3W2, 20261145000000): created_by + updated_by both
  // → users. Reviewed 2026-08-16: the only reader is app/(app)/assets/[id]/
  // page.tsx, which selects scalar policy columns only ("method, cost,
  // salvage_value, start_date, useful_life_months, annual_rate_pct") — there is
  // no users(...) embed. Two FKs are inherent to the audit trail (who set the
  // policy vs who last changed it). Any future embed must name its FK constraint.
  "asset_depreciation_settings → users",
  "asset_fuel_logs → users",
  "asset_inspection_overrides → users",
  "asset_inspection_templates → users",
  "asset_inspections → users",
  "asset_maintenance_cases → users",
  "asset_qr_identities → users",
  // Custom automation rules (20261133): created_by + updated_by both → users.
  // Reviewed 2026-08-15: the only readers are server/services/automation-custom-
  // rules.ts (selects scalar columns via RULE_COLS — "id, org_id, name,
  // description, trigger_event, definition, enabled, created_by, updated_by, ..."
  // — no users(...) embed) and the settings page, which renders those scalars.
  // Two FKs are inherent to the audit trail (who created vs who last edited the
  // rule); collapsing them would lose that. Any future embed must name its FK.
  "automation_custom_rules → users",
  "blueprint_markup → users",
  "blueprints → users",
  "cis_bill_details → users",
  "cis_contractor_profiles → users",
  "cis_monthly_returns → users",
  "cis_statements → users",
  "cis_subcontractors → users",
  "completion_certificates → users",
  // Delay events (20261084, Train 8): created_by + recorded_by + withdrawn_by
  // all → users. Reviewed 2026-08-01: no read of this table embeds users(...) —
  // app/(app)/delays/_data.ts and server/services/eot-pack.ts select scalar
  // columns only (DELAY_COLS / DELAY_EVENT_COLS), and the pack/PDF render ids,
  // never joined names. Three FKs is inherent to the row: who WROTE UP the
  // stoppage, who formally RECORDED it as evidence and who later WITHDREW it
  // are three separate accountable acts on a record built for disputes, and
  // collapsing them would destroy exactly the provenance an EoT assessor
  // tests. Any future embed must name its FK constraint; test 2 enforces it.
  "delay_events → users",
  // GRNs (20261059, Train 24): received_by + created_by + voided_by all → users.
  // Reviewed 2026-07-29: no PostgREST embed of users(...) exists on any
  // goods_received_notes read (all GRN surfaces resolve names via explicit
  // second queries), so no bare embed can hit PGRST201 today. Any future embed
  // must name its FK constraint.
  "goods_received_notes → users",
  // HQ Decision Centre (20261091): decided_by + delegate_to → users. Reviewed
  // 2026-08-01: server/services/hq-decisions.ts (ROW_COLUMNS) is scalar-only and
  // is the ONLY reader — the decision surfaces render decided_by / delegate_to as
  // ids and resolve identities elsewhere; there is no users(...) embed anywhere on
  // this table, so no bare embed can hit PGRST201 today. Two FKs is inherent to the
  // row: who DECIDED it and who it was DELEGATED to are distinct accountable facts.
  // Any future embed must name its FK constraint; test 2 enforces it.
  "hq_decisions → users",
  "impersonation_sessions → users",
  // Works quality M2 (20261081): created_by + published_by → users. Reviewed
  // 2026-08-01: TEMPLATE_COLUMNS in app/(app)/quality/templates/_data.ts is
  // scalar-only and no other reader of this table exists; author/publisher
  // names are never rendered from an embed. Two FKs is the controlled-document
  // provenance pair (who DRAFTED the version / who PUBLISHED it), the same
  // shape inspection_test_plans carries. Any future embed must name its FK
  // constraint; test 2 enforces it.
  "inspection_plan_templates → users",
  // Works quality ITP (20261076): inspected_by + voided_by → users. Reviewed
  // 2026-07-30: no read of this table embeds users(...) — app/(app)/quality/
  // _data.ts selects scalar columns only (SIGNOFF_COLUMNS) and resolves signer /
  // voider names through a separate batched read of `users` (loadUserNames), the
  // same shape goods_received_notes and ai_quote_drafts use. Two FKs is inherent
  // to the row: it records who ATTESTED and who later VOIDED, and collapsing
  // them would destroy the audit trail the record exists for. Any future embed
  // must name its FK constraint.
  "inspection_signoffs → users",
  // Works quality ITP (20261076): prepared_by + issued_by + created_by → users.
  // Reviewed 2026-07-30: ITP_COLUMNS in app/(app)/quality/_data.ts is scalar-only
  // and app/(app)/jobs/[id]/_job-quality.tsx selects scalar columns too; names
  // come from loadUserNames. Three FKs is the controlled-document provenance
  // (who wrote it / who issued it / who created the row) and is the same triple
  // risk_assessments and permits_to_work already carry. Any future embed must
  // name its FK constraint.
  "inspection_test_plans → users",
  // Works quality M2 (20261081): invited_by + attendance_recorded_by → users.
  // Reviewed 2026-08-01: WITNESS_COLUMNS in app/(app)/quality/_data.ts is
  // scalar-only (the only reader); recorder names come from loadUserNames.
  // Two FKs is inherent to the record: who INVITED the witness and who later
  // RECORDED the attendance outcome are separate accountable acts. Any future
  // embed must name its FK constraint; test 2 enforces it.
  "inspection_witness_invitations → users",
  "invoice_payments → invoices",
  // Job checklists (P3, 20261132000000): created_by + done_by → users. Reviewed
  // 2026-08-15: the only reader (app/(app)/jobs/[id]/_job-checklist.tsx) selects
  // scalar columns only and never embeds users(...). Two FKs is inherent — who
  // ADDED the step and who TICKED it are separate accountable acts. Any future
  // embed must name its FK constraint; test 2 enforces it.
  "job_checklists → users",
  "job_documents → users",
  // Milestone dependencies (P3, 20261132000002): milestone_id +
  // depends_on_milestone_id both → job_milestones. Reviewed 2026-08-15: the only
  // reader (_job-programme.tsx) selects the two scalar id columns and joins them
  // to titles in memory — it never embeds job_milestones(...). Two FKs is the
  // whole point of an edge (successor + predecessor). Any future embed must name
  // its FK constraint; test 2 enforces it.
  "job_milestone_dependencies → job_milestones",
  // Job warranties (20261079): created_by + portal_published_by + voided_by all
  // → users. Reviewed 2026-07-31: no read of this table embeds users(...) — the
  // operator page and actions select scalar columns only, and the customer
  // portal loader (app/customer-portal/_warranties.ts) never selects an
  // identity column at all, so there is nothing to embed. Three FKs is inherent
  // to the row: who RECORDED the warranty, who PUBLISHED it to the customer and
  // who WITHDREW it are three separate accountable acts on a contractual
  // promise. Any future embed must name its FK constraint; test 2 enforces it.
  "job_warranties → users",
  "leave_requests → users",
  // Marketplace listings (Phase 14, 20261195000000): created_by + reviewed_by
  // both → users. Reviewed 2026-08-20: readers (app/(app)/marketplace/page.tsx,
  // app/(app)/settings/marketplace/page.tsx) select scalar columns only — no
  // users(...) embed. Two FKs is inherent (author vs platform reviewer). Any
  // future embed must name its FK constraint.
  "marketplace_listings → users",
  // Material requests (20261066, M4): requested_by + decided_by + created_by
  // all → users. Reviewed 2026-07-29: the ONE embed of this pair
  // (server/services/material-requests.ts, REQUEST_COLS) names both FK
  // constraints explicitly — `users!material_requests_requested_by_fkey` and
  // `users!material_requests_decided_by_fkey`. Any future embed must do the
  // same; test 2 below enforces it.
  "material_requests → users",
  // Works quality M2 (20261081): assigned_to + proposed_by + decided_by all
  // → users. Reviewed 2026-08-01: ACTION_COLUMNS in
  // app/(app)/quality/ncrs/_data.ts is scalar-only (the only reader); names
  // resolve through loadUserNames. Three FKs is the corrective-action audit
  // triple — who is DOING the fix, who PROPOSED it, who DECIDED on it — and
  // collapsing them would destroy the write-once decision provenance. Any
  // future embed must name its FK constraint; test 2 enforces it.
  "ncr_corrective_actions → users",
  // Works quality M2 (20261081): responsible_user_id + raised_by +
  // verified_by all → users. Reviewed 2026-08-01: NCR_COLUMNS in
  // app/(app)/quality/ncrs/_data.ts and in app/(app)/quality/_data.ts
  // (listPlanNcrs) are both scalar-only; the PDF route and pages resolve
  // names via loadUserNames. Three FKs is the NCR accountability triple —
  // who must FIX it, who RAISED it, who VERIFIED the closure. Any future
  // embed must name its FK constraint; test 2 enforces it.
  "non_conformance_reports → users",
  "permits_to_work → users",
  "risk_assessments → users",
  "rota_entries → users",
  // site_inductions: user_id (the inductee) + created_by (the supervisor who
  // recorded the gate) both → users (20261140000000). The _data.ts reads resolve
  // worker names via a separate listStaffForOrg lookup, never a users() embed, so
  // no query is ambiguous; a future embed must FK-hint (test 2 enforces it).
  "site_inductions → users",
  "site_reports → users",
  // site_visitors: host_user_id + signed_in_by + signed_out_by all → users
  // (20261140000001). Host/recorder names are resolved via a separate lookup, not
  // an embed, so no query is ambiguous.
  "site_visitors → users",
  "snags → users",
  "staff_secrets → users",
  // stocktake_sessions: opened_by + posted_by + cancelled_by all → users. The
  // stocktake service resolves actor names by explicit reads, never a users(...)
  // embed, so no query on this table is ambiguous (asserted in stocktake.test.ts).
  "stocktake_sessions → users",
  "supplier_payments → users",
  "support_tickets → users",
  // worker_signoff_tokens (20261185000000): created_by (staff who issued the
  // link) + revoked_by (staff who revoked it) both → users. Reviewed
  // 2026-08-19: neither _data.ts reader nor the portal loader embeds users(...)
  // on this table — the staff list renders no issuer/revoker name via embed, so
  // no query is ambiguous. Two FKs is inherent (who issued vs who revoked); a
  // future users embed must FK-hint (test 2 enforces).
  "worker_signoff_tokens → users",
] as const;

const graph = buildFkGraph();
const ambiguousPairs = new Set(
  [...graph.entries()].filter(([, edges]) => edges.length >= 2).map(([k]) => k),
);
const ambiguous = (a: string, b: string) =>
  ambiguousPairs.has(`${a}\u0000${b}`) || ambiguousPairs.has(`${b}\u0000${a}`);

describe("schema tripwire — multi-FK pairs are a reviewed, closed set", () => {
  it("parses a sane FK graph at all (parser self-check)", () => {
    // If migration formatting drifts past the parser, this fails first with a
    // clear signal instead of test 2 silently checking nothing.
    expect(graph.size).toBeGreaterThan(50);
    expect(graph.get("asset_assignments\u0000assets")?.map((e) => e.name).sort()).toEqual([
      "asset_assignments_asset_id_fkey",
      "asset_assignments_vehicle_asset_id_fkey",
    ]);
    expect(
      graph.get("invoice_payments\u0000invoices")?.some((e) => e.cols.length === 2),
      "the composite tenant-integrity FK must be visible to the parser",
    ).toBe(true);
  });

  it("every ≥2-FK pair is in the reviewed list (new pair ⇒ hint its embeds, then add it)", () => {
    const actual = [...ambiguousPairs].map((k) => k.replace("\u0000", " → ")).sort();
    expect(actual).toEqual([...REVIEWED_AMBIGUOUS_PAIRS].sort());
  });
});

// ── 2. embeds in source must hint ambiguous pairs ────────────────────────────

type BareEmbed = { file: string; line: number; from: string; embed: string };

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) yield p;
  }
}

/** Read the string literal starting at src[i] (supports ' " `). */
function readStringLiteral(src: string, i: number): string | null {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (c === quote) return out;
    out += c;
    i++;
  }
  return null;
}

/** Resolve `.select(ARG)` → the select string, via literal or same-file const. */
function resolveSelectString(src: string, argStart: number): string | null {
  const rest = src.slice(argStart);
  const lit = readStringLiteral(rest, 0);
  if (lit !== null) return lit.includes("${") ? null : lit;
  const idm = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest);
  if (!idm) return null;
  const defRe = new RegExp(`const\\s+${idm[1]}\\s*=\\s*`);
  const dm = defRe.exec(src);
  if (!dm) return null;
  const val = readStringLiteral(src, dm.index + dm[0].length);
  if (val === null || val.includes("${")) return null;
  return val;
}

/** Parse embeds out of a select string; report bare ones crossing ambiguous pairs. */
function findBareAmbiguousEmbeds(sel: string, fromTable: string): Array<{ from: string; embed: string }> {
  const out: Array<{ from: string; embed: string }> = [];
  const stack: string[] = [fromTable];
  const embedRe = /([A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)((?:!\w+)*)\s*\(/y;
  let i = 0;
  while (i < sel.length) {
    embedRe.lastIndex = i;
    const m = embedRe.exec(sel);
    if (m) {
      const table = m[2]!;
      const hints = (m[3] ?? "").split("!").filter((h) => h && h !== "inner" && h !== "left");
      const parent = stack[stack.length - 1]!;
      if (table !== "count" && hints.length === 0 && ambiguous(parent, table)) {
        out.push({ from: parent, embed: table });
      }
      stack.push(table);
      i = m.index + m[0].length;
      continue;
    }
    const c = sel[i];
    if (c === "(") stack.push(stack[stack.length - 1]!);
    else if (c === ")" && stack.length > 1) stack.pop();
    i++;
  }
  return out;
}

/** How much of the source the sweep actually SAW (see the coverage floor below). */
type SweepStats = { chains: number; resolved: number; withEmbeds: number };
const sweepStats: SweepStats = { chains: 0, resolved: 0, withEmbeds: 0 };

function sweepSource(): BareEmbed[] {
  const findings: BareEmbed[] = [];
  sweepStats.chains = 0;
  sweepStats.resolved = 0;
  sweepStats.withEmbeds = 0;
  const fromRe = /\.from\(\s*["']([a-z_]+)["']/g;
  for (const dir of ["app", "server", "lib", "components"]) {
    for (const file of walk(resolve(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes(".select(")) continue;
      for (const fm of src.matchAll(fromRe)) {
        const window = src.slice(fm.index!, fm.index! + 2500);
        // Bind to THIS chain only: stop at the next .from( if one comes first.
        const selRel = window.slice(fm[0].length).search(/\.select\(\s*/);
        if (selRel === -1) continue;
        const nextFrom = window.slice(fm[0].length, fm[0].length + selRel).search(/\.from\(/);
        if (nextFrom !== -1) continue;
        const selAbs =
          fm.index! + fm[0].length + selRel + window.slice(fm[0].length + selRel).match(/\.select\(\s*/)![0].length;
        sweepStats.chains++;
        const sel = resolveSelectString(src, selAbs);
        if (sel !== null) sweepStats.resolved++;
        if (!sel || !sel.includes("(")) continue;
        sweepStats.withEmbeds++;
        for (const hit of findBareAmbiguousEmbeds(sel, fm[1]!)) {
          findings.push({
            file: file.slice(ROOT.length + 1),
            line: src.slice(0, fm.index!).split("\n").length,
            ...hit,
          });
        }
      }
    }
  }
  return findings;
}

describe("source sweep — no bare embed across an ambiguous pair", () => {
  /**
   * COVERAGE FLOOR. The sweep is only as good as `resolveSelectString`: a
   * select it cannot resolve (template interpolation, a const it can't follow,
   * a chain shape it doesn't recognise) is silently skipped, and a skipped
   * select is an unchecked embed. Without a floor, a refactor that moves
   * selects into interpolated template literals would shrink coverage to
   * nothing while this file stayed green — the same "absence reads as health"
   * failure the whole PR is about, one level up. Same instinct as the
   * `graph.size > 50` assertion on the FK side.
   */
  it("resolves enough of the source's selects to be a real sweep", () => {
    sweepSource();
    // At the time of writing: 682 chains, 658 resolved (96.5%), 106 with embeds.
    expect(
      sweepStats.chains,
      "found almost no `.from(\"tbl\").select(` chains — the chain matcher broke",
    ).toBeGreaterThan(500);
    expect(
      sweepStats.resolved,
      `only resolved ${sweepStats.resolved} select strings — resolveSelectString ` +
        `has lost coverage. Unresolved selects are NOT swept, so this is a silent ` +
        `hole in the PGRST201 tripwire, not a cosmetic regression.`,
    ).toBeGreaterThan(500);
    // The RATIO is the drift detector: template-interpolated selects
    // (`\`... ${COLS} ...\``) resolve to null and are skipped silently, so a
    // refactor that interpolates a few dozen selects would gut the sweep while
    // every absolute count still looked healthy.
    expect(
      sweepStats.resolved / sweepStats.chains,
      `resolved only ${sweepStats.resolved}/${sweepStats.chains} (` +
        `${((sweepStats.resolved / sweepStats.chains) * 100).toFixed(1)}%) of select ` +
        `args — template-interpolation drift. Either resolve the new form in ` +
        `resolveSelectString or FK-hint those embeds by hand and lower this floor ` +
        `deliberately.`,
    ).toBeGreaterThan(0.9);
    expect(
      sweepStats.withEmbeds,
      "resolved selects but almost none contained an embed — the embed parser broke",
    ).toBeGreaterThan(80);
  });

  it("every embed crossing a ≥2-FK pair carries an explicit FK-name hint", () => {
    const bare = sweepSource();
    expect(
      bare,
      bare
        .map(
          (b) =>
            `${b.file}:${b.line} embeds ${b.embed} from ${b.from} without a FK hint — ` +
            `PostgREST rejects the whole query (PGRST201). Use ${b.embed}!<fk_constraint_name>(...).`,
        )
        .join("\n"),
    ).toEqual([]);
  });
});

// ── 3. the incident sites stay fixed ─────────────────────────────────────────

describe("incident pins — the two pages that shipped weeks of empty states", () => {
  const holdings = readFileSync(resolve(ROOT, "app/(app)/assets/holdings/page.tsx"), "utf8");
  const jobAssets = readFileSync(resolve(ROOT, "app/(app)/jobs/[id]/_job-assets.tsx"), "utf8");

  it("/assets/holdings hints the assets embed AND throws on read failure", () => {
    expect(holdings).toMatch(/assets!asset_assignments_asset_id_fkey\(/);
    expect(holdings).toMatch(/const \{ data, error \} = await/);
    expect(holdings).toMatch(/if \(error\) throw readFailure\(/);
  });

  it("job hub assets panel hints the embed AND renders an explicit error state", () => {
    expect(jobAssets).toMatch(/assets!asset_assignments_asset_id_fkey\(/);
    expect(jobAssets).toMatch(/const \{ data, error \} = await/);
    expect(jobAssets).toMatch(/reportReadFailure\(/);
    expect(
      jobAssets,
      "the error branch must render a visible block, not the empty-state null",
    ).toMatch(/if \(error\) \{[\s\S]*?<section[\s\S]*?Couldn/);
  });
});
