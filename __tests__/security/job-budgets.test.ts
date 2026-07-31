import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Job cost baseline (20261072) — trust-boundary proofs.
 *
 * Section 1 EXTENDS the D1 accounting-boundary sweep that
 * __tests__/security/operational-stock.test.ts established for stock, to the
 * new plan surfaces. Same argument, one step stronger: a budget is not even a
 * claim that money moved, so a planned figure reaching `finances` would be
 * double-counted against the real supplier bill the moment it arrived and would
 * silently inflate the job's cost with no way to tell plan from money.
 *
 * The rest pins the properties a later edit could quietly drop: composite-FK
 * tenancy, write-once history, cascade-safe deletes, DB-enforced authorisation,
 * loud reads, the marginBand fallback, and the deep-swap navigation pattern.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261072000000_job_cost_baseline.sql";
const LIB = "lib/jobs/budget.ts";
const SERVICE = "server/services/job-budget.ts";
const ACTIONS = "app/(app)/jobs/[id]/commercial/actions.ts";
const PAGE = "app/(app)/jobs/[id]/commercial/page.tsx";
const FORM = "app/(app)/jobs/[id]/commercial/_budget-form.tsx";
const QUOTES = "app/(app)/quotes/actions.ts";
const COMMITTED = "lib/purchase-orders/committed.ts";
const PROFITABILITY = "lib/profitability/compute.ts";

/** Strip SQL line comments so NEGATIVE assertions test the EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sql = sqlOnly(read(MIG));

// ---------------------------------------------------------------------------
// 1. THE ACCOUNTING BOUNDARY — a plan must never post a cost
// ---------------------------------------------------------------------------

describe("the cost baseline never posts to `finances`", () => {
  it("the migration contains NO executable reference to finances at all", () => {
    // Not "does not insert one": the schema has no path to it. No trigger, no
    // writer, no reference. The word appears only in the header, explaining why.
    expect(sql).not.toMatch(/\bfinances\b/);
    expect(read(MIG), "the boundary must be stated where a contributor reads it").toMatch(
      /ACCOUNTING BOUNDARY/,
    );
    expect(read(MIG)).toMatch(/double-count|double count/i);
    expect(read(MIG), "must name D1, the undecided decision this rhymes with").toMatch(/D1/);
  });

  it("no surface in the slice writes, updates, deletes or triggers on finances", () => {
    for (const f of [MIG, LIB, SERVICE, ACTIONS, FORM]) {
      const src = f.endsWith(".sql") ? sqlOnly(read(f)) : codeOf(read(f));
      expect(src, `${f} inserts into finances`).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(src, `${f} updates finances`).not.toMatch(/update\s+public\.finances/i);
      expect(src, `${f} deletes from finances`).not.toMatch(/delete\s+from\s+public\.finances/i);
      expect(src, `${f} puts a trigger on finances`).not.toMatch(/on\s+public\.finances/i);
      expect(src, `${f} writes the finances table`).not.toMatch(
        /from\("finances"[^)]*\)\s*[\s\S]{0,40}?\.(insert|update|upsert|delete)\(/,
      );
    }
  });

  it("the PURE module does not even name the ledger — actuals arrive as arguments", () => {
    // The strongest available form: there is no client, no table name and no
    // query in the module that computes the variance, so it cannot post a cost
    // even by accident, and a reviewer does not have to read it to know that.
    const lib = codeOf(read(LIB));
    expect(lib).not.toMatch(/\bfinances\b/);
    expect(lib).not.toMatch(/supabase|createClient|from\(/);
    expect(read(LIB)).toMatch(/ACCOUNTING BOUNDARY/);
    expect(read(LIB)).toMatch(/double-count/i);
    expect(read(LIB)).toMatch(/D1/);
  });

  it("the variation write records a PLAN and says so, right where it does it", () => {
    // The variation's cost basis is a PLAN. A future edit that "helpfully" also
    // books the expense is the whole hazard.
    const src = read(QUOTES);
    const start = src.indexOf("export async function createVariation(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toMatch(/ACCOUNTING BOUNDARY/);
    const code = codeOf(body);
    expect(code, "createVariation must not post a cost").not.toMatch(
      /from\("finances"/,
    );
  });

  it("keeps ONE per-variation cost store — this slice adds no second one", () => {
    // `quotes.cost_labour … cost_misc` + the GENERATED `quotes.cost_total`
    // (20261073) are already live in production. A parallel table here would be
    // two cost bases for one variation, written by the same code path, and the
    // one that went stale would be invisible — the exact "one commercial source
    // of truth" violation this platform must not have. Neither the migration nor
    // any surface may reintroduce it.
    expect(sql, "the migration must define no second cost store").not.toMatch(
      /quote_cost_estimates/,
    );
    for (const f of [SERVICE, ACTIONS, PAGE, QUOTES, LIB]) {
      expect(codeOf(read(f)), `${f} references a second cost store`).not.toMatch(
        /quote_cost_estimates/,
      );
    }
    // …and the budget READS the generated total rather than re-summing the parts.
    expect(codeOf(read(PAGE))).toMatch(/total_cost: q\.cost_total/);
    expect(read(LIB), "the lib must name its single source").toMatch(/cost_total/);
  });

  it("no money column on the table could be mistaken for an incurred cost", () => {
    // Every money column is a PLANNED figure and named as one (`*_cost`), plus
    // the margin target. Nothing shaped like a ledger entry: no vat, no
    // paid/settled/posted flag, no supplier or invoice link.
    for (const col of [
      "vat_rate",
      "vat_total",
      "paid_at",
      "settled_at",
      "posted_at",
      "supplier_id",
      "invoice_id",
      "purchase_order_id",
    ]) {
      expect(sql, `${col} has no business on a plan`).not.toMatch(
        new RegExp(`\\b${col}\\b`, "i"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Tenancy is STRUCTURAL, not merely policy
// ---------------------------------------------------------------------------

describe("tenant binding", () => {
  it("binds the parent by COMPOSITE FK, not by an app-layer filter alone", () => {
    expect(sql, "job_id, org_id must be bound by composite FK").toMatch(
      /foreign key \(job_id, org_id\)\s*\n?\s*references public\.jobs \(id, org_id\)/i,
    );
  });

  it("adds the candidate key that FK needs — additive, and cannot reject a row", () => {
    // `id` is already the PRIMARY KEY of jobs, so (id, org_id) is unique by
    // construction: the constraint validates instantly and no existing row can
    // fail it. Same step 20261046/56/59/63/64 each took for their parents.
    expect(sql).toMatch(/jobs_id_org_key unique \(id, org_id\)/i);
    expect(sql, "guarded so re-application is safe").toMatch(
      /if not exists \(\s*\n?\s*select 1 from pg_constraint where conname = 'jobs_id_org_key'/,
    );
    // …and NO key on `quotes`: its only consumer was the second cost store that
    // this slice no longer defines. An index on a hot table with no reader is a
    // write cost for nothing.
    expect(sql, "no consumerless candidate key on quotes").not.toMatch(
      /quotes_id_org_key/,
    );
  });

  it("uses CASCADE and NEVER `on delete restrict` — the 20261052 teardown lesson", () => {
    // RESTRICT can never be deferred, so a `delete from organizations` that
    // cascades one side before the other aborts tenant teardown outright. That is
    // exactly how the 20261052 org-teardown P1 happened.
    expect(sql).not.toMatch(/on delete restrict/i);
    expect(sql).toMatch(/references public\.jobs \(id, org_id\) on delete cascade/i);
  });

  it("writes NO activity on delete — the other half of the same trap", () => {
    // An AFTER DELETE trigger on a table that cascades from organizations is the
    // exact shape 20261052 had to rescue.
    expect(sql).not.toMatch(/after\s+(insert\s+or\s+)?(update\s+or\s+)?delete\s+on\s+public\.job_budgets/i);
    expect(sql).not.toMatch(/_record_activity/);
  });

  it("enables RLS on the table", () => {
    expect(sql).toMatch(/alter table public\.job_budgets enable row level security/i);
  });

  it("has exactly ONE foreign key to users (no new ambiguous embed pair)", () => {
    // Two FKs to the same target makes a bare `users(...)` embed ambiguous and
    // PostgREST rejects the WHOLE query with PGRST201 — weeks of empty states,
    // the incident pinned by postgrest-embed-ambiguity.test.ts. There is
    // deliberately no `superseded_by`: the superseding revision's `created_by`
    // already records who revised it.
    const refs = sql.match(/references public\.users\(id\)/g) ?? [];
    expect(refs.length, `${refs.length} FKs to users`).toBe(1);
    expect(sql).not.toMatch(/superseded_by/);
    for (const f of [SERVICE, ACTIONS, PAGE]) {
      expect(codeOf(read(f)), `${f} embeds users`).not.toMatch(/users\s*\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The baseline is WRITE-ONCE; history cannot be edited or deleted
// ---------------------------------------------------------------------------

describe("a budget revision is immutable, and the chain is single-headed", () => {
  it("refuses every UPDATE except the supersede stamp, for EVERY role", () => {
    expect(sql).toMatch(/create trigger job_budgets_immutable\s*\n?\s*before update/i);
    expect(sql).toMatch(/a budget revision is immutable — record a new revision instead/);
    expect(sql).toMatch(/is history and cannot be changed/);
    // Every money/identity column is named in the guard — a column left out is a
    // column that can be silently rewritten.
    for (const col of [
      "total_cost",
      "labour_cost",
      "materials_cost",
      "subcontractors_cost",
      "misc_cost",
      "target_margin_pct",
      "note",
      "revision",
      "job_id",
      "org_id",
      "created_at",
      "created_by",
    ]) {
      expect(sql, `${col} is not protected by the immutability guard`).toMatch(
        new RegExp(`new\\.${col} is distinct from old\\.${col}`),
      );
    }
  });

  it("keeps EXACTLY ONE current revision per job, by index not by convention", () => {
    expect(sql).toMatch(
      /create unique index if not exists job_budgets_one_current\s*\n?\s*on public\.job_budgets \(job_id\) where superseded_at is null/i,
    );
    expect(sql).toMatch(/job_budgets_job_revision_uniq\s*\n?\s*on public\.job_budgets \(job_id, revision\)/i);
  });

  it("REQUIRES a reason on every revision after the first, structurally", () => {
    // A CHECK, not form validation: a silent re-baseline is the single thing this
    // design exists to prevent, and a direct PostgREST caller must be refused too.
    expect(sql).toMatch(
      /constraint job_budgets_revision_needs_reason check \(\s*\n?\s*revision = 1 or \(note is not null and length\(trim\(note\)\) > 0\)/,
    );
  });

  it("refuses a TARGETED delete while allowing every cascade", () => {
    // Both existence checks are load-bearing. Asking only about the organisation
    // would block ordinary job deletion, because a job dies while its org lives —
    // the trap 20261052 documents.
    expect(sql).toMatch(/create trigger job_budgets_no_targeted_delete\s*\n?\s*before delete/i);
    expect(sql).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/);
    expect(sql).toMatch(/exists \(select 1 from public\.jobs where id = old\.job_id\)/);
    expect(sql).toMatch(/the baseline history is the audit trail/);
  });

  it("grants NO delete policy — a tenant is refused twice over", () => {
    expect(sql).toMatch(/create policy "job_budgets: members can select"/);
    expect(sql).not.toMatch(/create policy "job_budgets: [^"]*delete"/);
  });

  it("cannot hold a partial breakdown, or one that does not add up", () => {
    expect(sql).toMatch(
      /num_nulls\(labour_cost, materials_cost, subcontractors_cost, misc_cost\) in \(0, 4\)/,
    );
    expect(sql).toMatch(/constraint job_budgets_detail_sums_to_total check/);
    expect(sql, "and a baseline of nothing is not a baseline").toMatch(
      /constraint job_budgets_not_empty check/,
    );
  });

  it("invents NO new cost category — the four buckets are the existing ones", () => {
    const buckets = ["labour_cost", "materials_cost", "subcontractors_cost", "misc_cost"];
    for (const b of buckets) expect(sql).toMatch(new RegExp(`\\b${b}\\b`));
    // Anything else shaped like a cost category would fork the taxonomy that
    // mapToCostBucket() already maps live `finances` rows onto.
    for (const invented of [
      "plant_cost",
      "prelims_cost",
      "overhead_cost",
      "equipment_cost",
      "fuel_cost",
      "contingency_cost",
    ]) {
      expect(sql, `${invented} forks the four-bucket taxonomy`).not.toMatch(
        new RegExp(`\\b${invented}\\b`, "i"),
      );
    }
    expect(codeOf(read(LIB))).toMatch(/COST_BUCKETS/);
  });
});

// ---------------------------------------------------------------------------
// 4. Authorisation lives in the DATABASE, not only in the action
// ---------------------------------------------------------------------------

describe("only an owner or admin can set a baseline", () => {
  it("RLS enforces it, so direct PostgREST is refused too", () => {
    expect(sql).toMatch(
      /create policy "job_budgets: admins can insert" on public\.job_budgets\s*\n?\s*for insert to authenticated with check \(public\.is_org_admin\(org_id\)\)/i,
    );
    expect(sql).toMatch(
      /create policy "job_budgets: admins can supersede" on public\.job_budgets\s*\n?\s*for update to authenticated/i,
    );
    // Members READ it: they already see actual cost and margin on this page.
    expect(sql).toMatch(
      /create policy "job_budgets: members can select" on public\.job_budgets\s*\n?\s*for select to authenticated using \(org_id in \(select public\.current_org_ids\(\)\)\)/i,
    );
  });

  it("the RPC is SECURITY INVOKER, so it is not a back door around those policies", () => {
    const start = sql.indexOf("create or replace function public.set_job_budget(");
    expect(start).toBeGreaterThan(-1);
    const header = sql.slice(start, sql.indexOf("$$", start));
    expect(header).not.toMatch(/security definer/i);
    expect(header).toMatch(/security invoker/i);
    expect(sql).toMatch(/revoke all on function public\.set_job_budget\(/);
    expect(sql).toMatch(/grant execute on function public\.set_job_budget\(/);
  });

  it("does supersede+insert ATOMICALLY, under a per-job lock", () => {
    // Two statements over two round trips cannot be atomic, and either order has
    // a bad failure mode: insert-first is refused by the one-current index,
    // supersede-first leaves the job with NO baseline if the insert fails.
    expect(sql).toMatch(
      /perform pg_advisory_xact_lock\(hashtext\('job_budget'\), hashtext\(p_job_id::text\)\)/,
    );
    const start = sql.indexOf("create or replace function public.set_job_budget(");
    const body = sql.slice(start);
    expect(body).toMatch(/update public\.job_budgets set superseded_at = now\(\)/);
    expect(body).toMatch(/insert into public\.job_budgets \(/);
    expect(body, "the total must be DERIVED when a breakdown is given").toMatch(
      /v_total := round\(\s*\n?\s*p_labour_cost \+ p_materials_cost \+ p_subcontractors_cost \+ p_misc_cost, 2\)/,
    );
  });

  it("the action mirrors the gate so a member sees a sentence, not a raw refusal", () => {
    const actions = codeOf(read(ACTIONS));
    expect(actions).toMatch(/role === "owner" \|\| role === "admin"/);
    expect(actions).toMatch(/Only an owner or admin can set a job's budget\./);
    // …and the page only renders the form for those roles.
    expect(codeOf(read(PAGE))).toMatch(
      /ctx\.membership\.role === "owner" \|\| ctx\.membership\.role === "admin"/,
    );
  });

  it("never echoes raw Postgres text back to the browser", () => {
    // The house rule: raw error text can carry column names, constraint bodies
    // and row values. Mapped refusals only, and the rest logged.
    const actions = codeOf(read(ACTIONS));
    expect(actions).not.toMatch(/error:\s*error\.message/);
    expect(actions).not.toMatch(/formError\(\s*error\.message/);
    expect(actions).not.toMatch(/formError\(\s*raw/);
    expect(actions).toMatch(/console\.error\("\[job-budget\]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Active-org pinning on every read and write
// ---------------------------------------------------------------------------

describe("the baseline surfaces pin the ACTIVE org, not just RLS", () => {
  it("EVERY read in the service filters on org_id AND the narrowing key", () => {
    const service = codeOf(read(SERVICE));
    const selects = service.match(/\.select\(/g) ?? [];
    const pins = service.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    expect(pins.length).toBe(selects.length);
  });

  it("the write resolves its job through the /jobs/[id] chokepoint", () => {
    const actions = codeOf(read(ACTIONS));
    expect(actions).toMatch(/loadJobForOrg<\{ id: string \}>\(supabase, jobId, ctx\.org\.id/);
    // …and p_org_id is ALWAYS the active org, never a value from the request.
    const pinned = actions.match(/p_org_id:\s*ctx\.org\.id/g) ?? [];
    const all = actions.match(/p_org_id:/g) ?? [];
    expect(pinned.length).toBe(1);
    expect(all.length).toBe(pinned.length);
  });

  it("the page pins the active org on its ONE new read", () => {
    const page = codeOf(read(PAGE));
    expect(page).toMatch(
      /loadCurrentJobBudget\(\s*\n?\s*supabase as unknown as JobBudgetClient,\s*\n?\s*ctx\.org\.id,\s*\n?\s*id,?\s*\n?\s*\)/,
    );
  });

  it("takes the variation cost basis from the job's OWN quotes, adding no read", () => {
    // The quotes are already loaded `.eq("job_id", id)` through the tenant client
    // and the job itself came through loadJobForOrg, so the cost side inherits
    // the same scoping as the value side — one filter, one set, no way for the
    // two to disagree about which variations count.
    const page = codeOf(read(PAGE));
    expect(page).toMatch(
      /\.filter\(\(q\) => q\.variation_number != null && q\.status === "accepted"\)/,
    );
    expect(page).toMatch(/labour_cost: q\.cost_labour/);
    expect(page).toMatch(/misc_cost: q\.cost_misc/);
    expect(page, "the cost columns must actually be selected").toMatch(
      /cost_labour, cost_materials, cost_subcontractors, cost_misc, cost_total/,
    );
  });

  it("never reaches for the service-role admin client on this surface", () => {
    for (const f of [SERVICE, ACTIONS, PAGE, FORM]) {
      const src = codeOf(read(f));
      expect(src, `${f} uses the admin client`).not.toMatch(/createAdminClient/);
      expect(src, `${f} names the service-role key`).not.toMatch(/SERVICE_ROLE/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Loud reads — an empty budget panel must never mean a failed query
// ---------------------------------------------------------------------------

describe("baseline reads fail loudly", () => {
  it("every read binds `error` and throws readFailure", () => {
    const service = codeOf(read(SERVICE));
    const selects = (service.match(/\.select\(/g) ?? []).length;
    const throws = (service.match(/throw readFailure\(/g) ?? []).length;
    expect(selects).toBeGreaterThan(0);
    expect(throws).toBe(selects);
  });

  it("uses none of the three error-discarding shapes", () => {
    // A silently-failed read here would tell an owner their job is on plan.
    for (const f of [SERVICE, ACTIONS]) {
      const src = codeOf(read(f));
      expect(src, f).not.toMatch(/const \{ data(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
      expect(src, f).not.toMatch(/const \{ count(?:: [A-Za-z_$][A-Za-z0-9_$]*)? \} = await/);
    }
  });

  it("the variation cost basis rides the quote insert, which is already CHECKED", () => {
    // A silently-missing cost basis under-states the revised budget and makes the
    // job look more profitable than it is — the exact defect class this closes.
    // It cannot go missing independently now: the four columns are written by the
    // SAME insert that creates the variation, whose error already aborts.
    const src = codeOf(read(QUOTES));
    expect(src).toMatch(/cost_labour: computed\.cost_breakdown\.labour/);
    expect(src).toMatch(/cost_misc: computed\.cost_breakdown\.misc/);
    expect(src).toMatch(/if \(qErr \|\| !variation\)/);
  });
});

// ---------------------------------------------------------------------------
// 7. The marginBand fallback, and the VAT basis
// ---------------------------------------------------------------------------

describe("marginBand prefers a per-job target and falls back to the universal bands", () => {
  it("keeps the universal 30 as a named constant, and 15 as target/2", () => {
    const src = read(PROFITABILITY);
    expect(src).toMatch(/export const UNIVERSAL_TARGET_MARGIN_PCT = 30;/);
    const code = codeOf(src);
    expect(code).toMatch(/if \(marginPct > target\) return "green";/);
    expect(code).toMatch(/if \(marginPct >= target \/ 2\) return "amber";/);
    // The fallback must be reachable from BOTH absent forms.
    expect(code).toMatch(/targetPct == null \|\| !Number\.isFinite\(targetPct\) \|\| targetPct < 0/);
  });

  it("the page passes the job's target, and only the job's target", () => {
    const page = codeOf(read(PAGE));
    expect(page).toMatch(/marginBand\(marginPct, budget\.targetMarginPct\)/);
    // computeJobProfitability's own `band` is left on the universal thresholds,
    // so org-wide rollups (the dashboard) are unaffected by one job's target.
    expect(codeOf(read(PROFITABILITY))).toMatch(/band: marginBand\(margin_pct\),/);
  });

  it("COST is reconciled against the EX-VAT contract value, never the gross one", () => {
    // `revised` is VAT-inclusive because cash is what moves through the bank;
    // cost is ex-VAT everywhere. Mixing them reports a ~20% gap on a job that is
    // exactly on plan.
    expect(codeOf(read(PAGE))).toMatch(/revisedValueNet: contract\.revisedNet/);
    expect(codeOf(read("lib/jobs/commercial-position.ts"))).toMatch(
      /revisedNet: round2\(originalNet \+ approvedVariationsNet\)/,
    );
  });

  it("the FORECAST uses the ex-VAT PO subtotal, netted per PO against its bills", () => {
    const committed = codeOf(read(COMMITTED));
    expect(committed).toMatch(/Math\.max\(0, round2\(net - billed\)\)/);
    // Clamped at BOTH ends: an over-billed order must not lend negative headroom
    // to another, and credits exceeding the bills must not push "still to come"
    // above the value ordered.
    expect(committed).toMatch(/Math\.min\(Math\.max\(0, toPounds\(p\.billed\)\), net\)/);
    // The page must actually SELECT the two columns the netting needs — a
    // forgotten column is how the figure silently reverts to gross-or-zero.
    const page = codeOf(read(PAGE));
    expect(page).toMatch(/select\("id, number, subtotal, total, status/);
    expect(page).toMatch(/purchase_order_id/);
    expect(page).toMatch(/subtotal: p\.subtotal/);
    expect(page).toMatch(/billed: billedByPo\.get\(p\.id\) \?\? 0/);
    // …and the forecast is spend + remaining, from committed.ts, not re-derived.
    expect(page).toMatch(/remainingCommitted: committed\.remaining/);
    expect(codeOf(read(LIB))).toMatch(/round2\(actual \+ remainingCommitted\)/);
  });
});

// ---------------------------------------------------------------------------
// 8. Navigation — the deep-swap commit race
// ---------------------------------------------------------------------------

describe("the budget form navigates the only way that works at this depth", () => {
  it("performs NO cache revalidation in the action", () => {
    // Load-bearing, not style. /jobs/[id]/commercial is four segments deep,
    // exactly where Next 15.5 drops the client-side navigation while the server
    // work lands — the save commits, the POST returns 200, and the form sits on
    // "Saving…" for ever, so the operator saves it twice.
    const actions = codeOf(read(ACTIONS));
    expect(actions).not.toMatch(/revalidatePath\(/);
    expect(actions).not.toMatch(/revalidateTag\(/);
    expect(read(ACTIONS), "the reason must survive next to the absence").toMatch(
      /deep-swap commit race/,
    );
  });

  it("hard-navigates on success rather than trusting the client router", () => {
    const form = codeOf(read(FORM));
    expect(form).toMatch(/window\.location\.assign\(state\.redirectTo\)/);
    expect(form).not.toMatch(/router\.push\(/);
    expect(codeOf(read(ACTIONS))).toMatch(/redirectTo: `\/jobs\/\$\{jobId\}\/commercial`/);
  });

  it("is usable on a 375px phone: one column, 16px inputs, decimal keypad", () => {
    const form = read(FORM);
    expect(form).toMatch(/inputMode="decimal"/);
    // text-base is 16px — anything smaller makes iOS zoom the viewport on focus.
    expect(form).toMatch(/px-3 py-2 text-base/);
    expect(form).not.toMatch(/text-sm"[^\n]*type="number"/);
  });
});
