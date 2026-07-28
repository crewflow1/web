import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261051000000_cis_deduction.sql";
const M2_MIGRATION = "supabase/migrations/20261047000000_supplier_payments.sql";
/** The follow-up that freezes a part-paid bill's VALUE, not just its split. */
const FREEZE_MIGRATION = "supabase/migrations/20261053000000_cis_bill_value_freeze.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

/**
 * H2-CIS M3 — trust-boundary pins for the CIS deduction engine.
 *
 * Hermetic: filesystem + source contracts, no database. The live-Postgres proofs
 * (RLS denial, forged rates, snapshot immutability, partial-payment arithmetic)
 * are in __tests__/integration/rls/cis-deduction.test.ts.
 *
 * What THIS tier stops is the controls being quietly loosened later: the rate
 * becoming client-supplied, the snapshot becoming editable, `finances` being
 * written by a tax feature, the reverse charge collapsing back into `vat = 0`,
 * or the admin-only policy being relaxed to the member-read norm.
 */

/** Strip SQL line comments so negative assertions test EXECUTABLE statements. */
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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** The follow-up that extends the same guard with a non-CIS settlement floor. */
const FLOOR_MIGRATION = "supabase/migrations/20261054000000_supplier_bill_settlement_floor.sql";

const sql = sqlOnly(read(MIGRATION));
const freezeSql = sqlOnly(read(FREEZE_MIGRATION));
const floorSql = sqlOnly(read(FLOOR_MIGRATION));

// ---------------------------------------------------------------------------
// 1. Migration hygiene
// ---------------------------------------------------------------------------

describe("CIS M3 migration hygiene", () => {
  it("uses its reserved slots, with nothing back-dated beneath them", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();

    // The hazard is a file added LATER with a LOWER number: Supabase keys
    // migration identity on the numeric prefix, so such a file replays out of
    // order from scratch while looking fine on an already-migrated database
    // (SLOT-ORDER NOTE in the roadmap status — hit twice already).
    //
    // Two DIFFERENT invariants matter here and both are asserted. They were
    // authored by separate lanes and are complementary, not alternatives.

    // (1) CIS M3's dependency window. Production has already applied both CIS M2
    // (20261047) and CIS M3 (20261051), so a file back-dated BETWEEN them would
    // replay in the wrong order from a fresh database while looking fine on an
    // already-migrated one. Note this is deliberately NOT "M3 is the highest
    // migration in the directory" — that earlier form fails the moment any
    // later migration is authored, which is normal and correct.
    expect(versions).toContain("20261051000000");
    expect(versions.filter((v) => v > "20261047000000" && v < "20261051000000")).toEqual([]);

    // (2) This lane's own slots. An earlier revision pinned the EXHAUSTIVE set
    // of slots above the tip, which is the wrong shape for a repo where several
    // lanes claim slots concurrently: it turns another lane's correct,
    // well-numbered migration into a red build here, and the pressure is then to
    // delete the assertion rather than fix a real problem. Assert only what this
    // lane owns — its slots exist, are unique, and sit above everything already
    // applied in production.
    //
    // PRODUCTION_TIP is the applied tip when this lane was authored, used as a
    // FLOOR, not a live reading of production. It cannot go stale into a false
    // red: as production advances the comparison stays true, it just states
    // less. Duplicate-prefix collisions are caught by the test below.
    const PRODUCTION_TIP = "20261052000000";
    const OURS = ["20261053000000", "20261054000000"];
    for (const slot of OURS) {
      expect(versions.filter((v) => v === slot)).toHaveLength(1);
      expect(slot > PRODUCTION_TIP).toBe(true);
    }
    // And they stay in the order their dependency requires: 20261054000000
    // `create or replace`s the function 20261053000000 defines.
    expect([...OURS].sort()).toEqual(OURS);
  });

  it("has no duplicate migration numbers anywhere in the directory", () => {
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("is idempotent — every create is guarded", () => {
    for (const src of [sql, freezeSql, floorSql]) {
      const creates = src.match(/create\s+table\s+(?!if not exists)/gi) ?? [];
      expect(creates).toEqual([]);
      const indexes = src.match(/create\s+index\s+(?!if not exists)/gi) ?? [];
      expect(indexes).toEqual([]);
      const cols = src.match(/add column\s+(?!if not exists)/gi) ?? [];
      expect(cols).toEqual([]);
    }
    // Both replay cleanly: every function is CREATE OR REPLACE and every trigger
    // is dropped first.
    for (const src of [sql, freezeSql, floorSql]) {
      const fns = src.match(/create\s+(or replace\s+)?function/gi) ?? [];
      for (const f of fns) expect(f.toLowerCase()).toContain("or replace");
      const trgs = src.match(/create\s+(constraint\s+)?trigger\s+(\S+)/gi) ?? [];
      for (const t of trgs) {
        const name = t.split(/\s+/).pop()!;
        expect(src).toMatch(new RegExp(`drop trigger if exists ${name}\\b`, "i"));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE COST INVARIANT — a tax feature must not be able to move a cost
// ---------------------------------------------------------------------------

describe("CIS M3 cannot move job cost or existing VAT reporting", () => {
  it("never inserts, updates or deletes a `finances` row", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.finances/i);
    expect(sql).not.toMatch(/update\s+public\.finances/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.finances/i);
  });

  it("never alters the `finances` table itself", () => {
    // Reading it (select … from public.finances) is fine and necessary.
    // Changing its shape is not: `amount` is the cost figure profitability sums,
    // and `vat_total` is the generated column computeVatQuarter reads.
    expect(sql).not.toMatch(/alter table public\.finances/i);
  });

  it("does not touch finances.vat_rate or the generated vat_total", () => {
    expect(sql).not.toMatch(/vat_total\s*=/i);
    expect(sql).not.toMatch(/set\s+vat_rate/i);
  });

  it("puts the deduction basis in its OWN table, not on finances", () => {
    expect(sql).toMatch(/create table if not exists public\.cis_bill_details/i);
  });

  it("leaves computeVatQuarter untouched — it still sums finances.vat_total only", () => {
    const compute = codeOf(read("lib/tax/compute.ts"));
    expect(compute).toMatch(/inputVat\s*\+=\s*Number\(f\.vat_total\s*\?\?\s*0\)/);
    // No CIS/reverse-charge concept has leaked into the VAT report.
    expect(compute).not.toMatch(/reverse_charge/i);
    expect(compute).not.toMatch(/cis_/i);
  });

  it("does not fork VAT reporting into a second quarterly calculator", () => {
    const files = walk(resolve(ROOT, "lib")).concat(walk(resolve(ROOT, "server")));
    const forks = files.filter(
      (f) => /computeVatQuarter/.test(read(f.slice(ROOT.length + 1))) && !f.endsWith("lib/tax/compute.ts"),
    );
    for (const f of forks) {
      // Consumers may CALL it; nothing may redefine it.
      expect(codeOf(read(f.slice(ROOT.length + 1)))).not.toMatch(/function\s+computeVatQuarter/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. THE BILL VALUE GUARD (20261053 + 20261054) — a bill's value cannot move
//     out from under a deduction already reported from it, nor below money
//     already paid against it.
// ---------------------------------------------------------------------------
//
// ASSERTED AGAINST THE FINAL BODY, deliberately. 20261054000000 is a
// `create or replace` of the function 20261053000000 defines, so the LIVE policy
// is whatever 20261054000000 says. Pinning the earlier revision's text would be
// testing a body that no database ever runs, and would go green while the thing
// actually installed had drifted.
//
// Behaviour under CONCURRENCY is not assertable from source and is not asserted
// here: it is proven separately, with two real overlapping psql sessions, by
// scripts/verify-bill-value-guard-races.sh. This file pins shape; that harness
// pins the race.

describe("a part-paid bill's value is guarded in the database", () => {
  const guard = floorSql.slice(
    floorSql.indexOf("function public.tg_finances_bill_value_guard()"),
    floorSql.indexOf("comment on function public.tg_finances_bill_value_guard()"),
  );

  it("guards finances with a BEFORE UPDATE trigger, never INSERT or DELETE", () => {
    for (const src of [freezeSql, floorSql]) {
      expect(src).toMatch(
        /create trigger finances_bill_value_guard\s+before update on public\.finances/i,
      );
      // An INSERT guard would block recording ordinary expenses; a DELETE guard is
      // unnecessary — the composite bill FK already refuses that.
      expect(src).not.toMatch(/before insert[\s\S]{0,40}on public\.finances/i);
      expect(src).not.toMatch(/before delete[\s\S]{0,40}on public\.finances/i);
    }
  });

  it("is ONE policy — a single trigger on finances, not two fighting guards", () => {
    // Two triggers would mean two scans of the allocation ledger on every bill
    // edit and a precedence expressed by nothing but alphabetical trigger name.
    // The floor was therefore added to the SAME function behind the SAME trigger.
    const created = [...floorSql.matchAll(/create trigger (\w+)\s+[\s\S]{0,60}?on public\.finances/gi)]
      .map((m) => m[1]);
    expect(created).toEqual(["finances_bill_value_guard"]);
    // And the extension must not have forked the function under a new name.
    expect(floorSql).not.toMatch(/tg_finances_cis_basis_freeze/i);
    expect(freezeSql).not.toMatch(/tg_finances_cis_basis_freeze/i);
  });

  it("runs SECURITY DEFINER so it binds service_role and RLS-blind callers alike", () => {
    // Invoker rights would make `exists(...)` return false for anyone who cannot
    // read the payment ledger — the guard would silently pass for exactly the
    // users most likely to be editing an expense.
    expect(guard).toMatch(/security definer/i);
    expect(guard).toMatch(/set search_path = public/i);
  });

  it("PROTECTS finances without ever writing it — the cost invariant still holds", () => {
    for (const src of [freezeSql, floorSql]) {
      expect(src).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(src).not.toMatch(/update\s+public\.finances/i);
      expect(src).not.toMatch(/delete\s+from\s+public\.finances/i);
      expect(src).not.toMatch(/alter table public\.finances/i);
    }
    // A BEFORE UPDATE trigger that assigned to NEW would be a tax feature moving
    // a commercial cost. The only permitted outcomes are raise, or return NEW.
    expect(guard).not.toMatch(/new\.(amount|vat_rate|vat_total)\s*:?=/i);
  });

  it("is scoped to the two columns that feed the bill's value, and no others", () => {
    // Short-circuits when neither moved, so recategorising, annotating, job
    // re-tagging and receipt stamping on a part-paid bill still work.
    expect(guard).toMatch(
      /new\.amount is not distinct from old\.amount\s+and new\.vat_rate is not distinct from old\.vat_rate/i,
    );
    for (const col of ["category", "notes", "job_id", "reference", "receipt_url"]) {
      expect(guard).not.toMatch(new RegExp(`new\\.${col}`, "i"));
    }
  });

  it("only fires for LIVE CIS allocations — voids release the bill", () => {
    expect(guard).toMatch(/a\.cis_deduction is not null/i);
    expect(guard).toMatch(/p\.voided_at is null/i);
  });

  it("names the recovery path in the error rather than just refusing", () => {
    expect(guard).toMatch(/using errcode = 'check_violation'/i);
    expect(guard).toMatch(/void the cis payments/i);
  });

  it("refuses a reduction below what is already settled — CAP 2's missing half", () => {
    // 20261047's CAP 2 is BEFORE INSERT on the allocation, so it only runs when
    // MONEY ARRIVES. Nothing re-checked it when the BILL moved underneath
    // payments already recorded against it, and a real repro found five bills
    // over-settled, the worst at nine times its own value.
    expect(guard).toMatch(/v_settled/);
    // Gross must be computed exactly as CAP 2 computes it or the two guards can
    // disagree by a penny and a bill can pass one while failing the other.
    // It cannot be read from NEW: vat_total is generated AFTER before-triggers run.
    expect(guard).toMatch(
      /v_new_gross\s*:=\s*round\(new\.amount \+ round\(new\.amount \* new\.vat_rate \/ 100, 2\), 2\)/i,
    );
    expect(guard).not.toMatch(/new\.vat_total/i);
  });

  it("lets an already-broken row move TOWARD validity — the guard is not a trap", () => {
    // THE most important line in the migration to not lose. The naive rule
    // ("refuse whenever the result is below what is settled") would trap every
    // row this defect has already broken in production: correcting a £100 bill
    // carrying £900 of payments UP to £500 would be refused for still being
    // short, so the only rows needing repair would be the only rows unrepairable.
    // The second clause is what makes the refusal "you are making it worse"
    // rather than "you are still wrong".
    expect(guard).toMatch(
      /v_new_gross < v_settled - 0\.005\s+and v_new_gross < v_old_gross - 0\.005/i,
    );
    expect(guard).toMatch(/v_old_gross\s*:=/);
  });

  it("keeps the CIS refusal and the floor refusal saying DIFFERENT things", () => {
    // Same trigger, same errcode — the message is the ONLY thing distinguishing
    // them, and they have different exits. Sending someone through the CIS
    // void-and-re-post ceremony when they only had to re-cut the bill is a bug.
    const cisAt = guard.indexOf("part-paid under CIS");
    const floorAt = guard.indexOf("already settled against it");
    expect(cisAt).toBeGreaterThan(-1);
    expect(floorAt).toBeGreaterThan(-1);
    // CIS is checked FIRST: it is the stricter rule, and it must claim an
    // increase that the floor below would happily allow.
    expect(cisAt).toBeLessThan(floorAt);
    expect(guard).toMatch(/bill it for at least what has been paid/i);
  });

  it("keeps the bill-LOCKING allocation trigger sorting before the CIS one", () => {
    // A financial-correctness ordering constraint, not a naming preference.
    // PostgreSQL fires same-timing triggers alphabetically by trigger name.
    // `supplier_payment_allocation_guard` takes FOR UPDATE on the bill;
    // `supplier_payment_allocations_cis` reads that same bill UNLOCKED to derive
    // the deduction. If the CIS one ran first it would snapshot a bill value a
    // concurrent uncommitted edit was about to change, and the allocation would
    // commit carrying a cis_bill_net the bill no longer agrees with. Verified by
    // inverting the order against real Postgres — see 20261053000000 section 3.
    //
    // The authoritative check reads pg_trigger against a live database
    // (__tests__/integration/rls/trigger-firing-order.test.ts). This one is the
    // backstop: it needs no database, so it runs on every CI job, and it catches
    // a rename in the migration source even if the integration tier is skipped.
    //
    // Both names are EXTRACTED, never hard-coded on both sides — a rename moves
    // the extracted value, so the comparison re-evaluates and fails rather than
    // silently continuing to compare two constants.
    const nameOf = (src: string, fn: string) =>
      new RegExp(
        `create trigger (\\w+)\\s+before insert[\\s\\S]{0,120}?execute function public\\.${fn}\\(\\)`,
        "i",
      ).exec(src)?.[1];

    const guard = nameOf(sqlOnly(read(M2_MIGRATION)), "tg_supplier_payment_allocation_guard");
    const cis = nameOf(sql, "tg_supplier_payment_allocation_cis");
    expect(guard, "could not find the CAP 1/CAP 2 guard trigger in 20261047000000").toBeTruthy();
    expect(cis, "could not find the CIS engine trigger in 20261051000000").toBeTruthy();

    expect(
      [guard!, cis!].sort()[0],
      `TRIGGER FIRING ORDER: "${guard}" takes FOR UPDATE on the bill and MUST fire ` +
        `before "${cis}", which reads the same bill unlocked to derive the CIS ` +
        `deduction. PostgreSQL fires same-timing triggers in alphabetical order, so ` +
        `the names carry the guarantee. If you renamed one, rename it back or pick a ` +
        `name that still sorts first — see 20261053000000 section 3 for what breaks.`,
    ).toBe(guard);
  });

  it("treats an unpaid bill as unguarded, so ordinary cost editing is untouched", () => {
    // Required, not an optimisation: allocation amounts are `check (amount > 0)`,
    // so v_settled is 0 exactly when the bill is unpaid. Without this exit a
    // credit note taken negative — legitimate on an unallocated row — would read
    // as falling below a floor of zero and be refused.
    expect(guard).toMatch(/if v_settled = 0 then\s+return new;/i);
  });

  it("closes the INSERT door on the labour/materials split too", () => {
    // 20261051 froze cis_bill_details on UPDATE only, and a bill may be part-paid
    // with no details row at all — so the row could be created afterwards and move
    // the basis. Both branches must now be present.
    const dGuard = freezeSql.slice(freezeSql.indexOf("function public.tg_cis_bill_details_guard()"));
    expect(dGuard).toMatch(/if v_paid and tg_op = 'INSERT' then/i);
    expect(dGuard).toMatch(/if tg_op = 'UPDATE' and v_paid and \(/i);
  });

  it("surfaces the refusal to the API as an actionable conflict, not a 500", () => {
    const errors = codeOf(read("lib/finances/errors.ts"));
    expect(errors).toMatch(/23514|check_violation/);
    expect(errors).toMatch(/status:\s*409/);
    const route = codeOf(read("app/api/finances/[id]/route.ts"));
    // The mapping must be CALLED, and called BEFORE the generic 500, or it is
    // dead code. Assert both offsets are real so a removed call cannot pass on -1.
    const call = route.indexOf("financeWriteRefusal(");
    const generic = route.indexOf('"Failed to update"');
    expect(call).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(call).toBeLessThan(generic);
  });
});

// ---------------------------------------------------------------------------
// 3. RATE AUTHORITY — server-derived, never client-trusted
// ---------------------------------------------------------------------------

describe("CIS rate authority is enforced in the database", () => {
  it("validates the applied rate against cis_subcontractors in a trigger", () => {
    expect(sql).toMatch(/tg_supplier_payment_allocation_cis\(\)/);
    expect(sql).toMatch(/from public\.cis_subcontractors/i);
    expect(sql).toMatch(/new\.cis_rate_applied is distinct from v_rate/i);
  });

  it("runs that trigger as SECURITY DEFINER so it binds service_role too", () => {
    const fn = sql.slice(
      sql.indexOf("function public.tg_supplier_payment_allocation_cis()"),
      sql.indexOf("drop trigger if exists supplier_payment_allocations_cis "),
    );
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = public/i);
  });

  it("refuses a pre-outcome status instead of defaulting to 20 or 30", () => {
    expect(sql).toMatch(/not in \('gross', 'standard_20', 'higher_30', 'failed'\)/);
    expect(sql).toMatch(/is not verified for CIS/i);
  });

  it("independently recomputes the basis and deduction, and refuses a mismatch", () => {
    expect(sql).toMatch(/new\.cis_basis is distinct from v_basis/i);
    expect(sql).toMatch(/new\.cis_deduction is distinct from v_ded/i);
    expect(sql).toMatch(/derived from the bill, not supplied/i);
  });

  it("derives the withheld total from the allocations rather than accepting one", () => {
    expect(sql).toMatch(/the withholding is derived, not declared/i);
    expect(sql).toMatch(/v_withheld is distinct from v_alloc_ded/i);
  });

  it("does NOT accept a rate parameter that is used as the rate", () => {
    // p_expected_rate exists, but only ever as an assertion to REJECT on.
    const rpc = sql.slice(sql.indexOf("function public.record_cis_supplier_payment"));
    expect(rpc).toMatch(/p_expected_rate is not null and round\(p_expected_rate, 2\) <> v_rate/);
    // The rate actually written comes from the profile, never the parameter.
    expect(rpc).not.toMatch(/cis_rate_applied.*p_expected_rate/);
  });

  it("keeps the posting RPC SECURITY INVOKER and admin-gated", () => {
    const rpc = sql.slice(sql.indexOf("function public.record_cis_supplier_payment"));
    expect(rpc).toMatch(/security invoker/i);
    expect(rpc).not.toMatch(/security definer/i);
    expect(rpc).toMatch(/not public\.is_org_admin\(p_org_id\)/);
  });

  it("does not let the app pick the rate either", () => {
    const service = codeOf(read("server/services/cis-deduction.ts"));
    // The service passes no rate; the RPC derives it.
    expect(service).not.toMatch(/p_rate\s*:/);
    expect(service).toMatch(/p_expected_rate/);
    const schema = codeOf(read("lib/cis/schema.ts"));
    // The client form has no field that becomes the applied rate.
    expect(schema).not.toMatch(/cis_rate:/);
    expect(schema).not.toMatch(/cis_withheld/);
  });
});

// ---------------------------------------------------------------------------
// 4. IMMUTABILITY — posted tax facts never move
// ---------------------------------------------------------------------------

describe("posted CIS tax facts are immutable", () => {
  it("relies on M2's allocation freeze, which refuses every UPDATE", () => {
    const m2 = sqlOnly(read(M2_MIGRATION));
    expect(m2).toMatch(/tg_supplier_payment_allocations_frozen/);
    expect(m2).toMatch(/create trigger supplier_payment_allocations_frozen\s+before update/i);
  });

  it("freezes the payment-level snapshot outright — no UPDATE at all", () => {
    expect(sql).toMatch(/tg_cis_payment_snapshots_frozen/);
    expect(sql).toMatch(/create trigger cis_payment_snapshots_frozen\s+before update/i);
    expect(sql).toMatch(/is immutable — void the payment/i);
  });

  it("refuses a targeted delete of a snapshot but allows org teardown", () => {
    expect(sql).toMatch(/tg_cis_payment_snapshots_no_delete/);
    expect(sql).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/);
  });

  it("freezes a bill's labour/materials split once it has been part-paid", () => {
    expect(sql).toMatch(/has already been part-paid under CIS/i);
    expect(sql).toMatch(/p\.voided_at is null/);
  });

  it("detects a bill edited between two CIS payments rather than mis-apportioning", () => {
    expect(sql).toMatch(/has changed since it was part-paid under CIS/i);
  });

  it("stores the verification state as COPIES, not a live join", () => {
    const table = sql.slice(
      sql.indexOf("create table if not exists public.cis_payment_snapshots"),
      sql.indexOf("comment on table public.cis_payment_snapshots"),
    );
    for (const col of [
      "cis_status", "deduction_rate", "verification_reference", "verified_at",
      "legal_name", "utr_masked", "tax_month_start", "tax_month_end",
    ]) {
      expect(table).toContain(col);
    }
  });

  it("never stores an unmasked UTR in the snapshot", () => {
    expect(sql).toMatch(/utr_masked/);
    expect(sql).not.toMatch(/^\s*utr\s+text/m);
    // The masking happens in SQL, so the raw UTR never leaves the admin-only table.
    expect(sql).toMatch(/repeat\('•'/);
  });
});

// ---------------------------------------------------------------------------
// 5. REVERSE CHARGE is a treatment, not vat = 0
// ---------------------------------------------------------------------------

describe("reverse charge preserves the VAT facts", () => {
  it("stores the treatment AND the rate the customer accounts for", () => {
    expect(sql).toMatch(/vat_treatment text not null default 'standard'/i);
    expect(sql).toMatch(/vat_treatment in \('standard', 'reverse_charge'\)/);
    expect(sql).toMatch(/reverse_charge_vat_rate\s+numeric\(5, 2\)/);
  });

  it("requires a rate when the treatment is reverse charge, and forbids one otherwise", () => {
    expect(sql).toMatch(/cis_bill_details_rc_rate_present/);
    expect(sql).toMatch(/when 'reverse_charge' then reverse_charge_vat_rate is not null/);
  });

  it("refuses a reverse-charge bill that still charges VAT", () => {
    expect(sql).toMatch(/the supplier charges no VAT/i);
  });

  it("constrains the rate to the same domain as finances.vat_rate", () => {
    expect(sql).toMatch(/reverse_charge_vat_rate in \(0, 5, 20\)/);
    const finances = sqlOnly(read("supabase/migrations/20260515180000_finances_and_receipts.sql"));
    expect(finances).toMatch(/check \(vat_rate in \(0, 5, 20\)\)/);
  });

  it("carries the statutory legend HMRC requires", () => {
    const lib = read("lib/cis/deduction.ts");
    expect(lib).toMatch(/VAT Act 1994 Section 55A applies/);
    expect(lib).toMatch(/Customer to pay the VAT to HMRC/);
  });

  it("keeps the notional VAT on the FULL supply while CIS excludes materials", () => {
    // The executable proof: the reverse-charge VAT is apportioned on v_net (the
    // whole supply), while the CIS basis subtracts v_materials. If someone ever
    // "tidied" these into one expression the two axes would be conflated.
    expect(sql).toMatch(/v_rc_vat\s*:=\s*round\(round\(v_net \* v_cum \/ v_gross/);
    expect(sql).toMatch(/v_cum_basis\s*:=\s*round\(greatest\(v_net - v_citb - v_materials, 0\)/);
    expect(sql).toMatch(/new\.cis_reverse_charge_vat is distinct from v_rc_vat/);
  });
});

// ---------------------------------------------------------------------------
// 6. RLS + no service-role escape hatch
// ---------------------------------------------------------------------------

describe("CIS M3 RLS is admin-only", () => {
  it("enables RLS on both new tables", () => {
    expect(sql).toMatch(/alter table public\.cis_bill_details enable row level security/i);
    expect(sql).toMatch(/alter table public\.cis_payment_snapshots enable row level security/i);
  });

  it("gates every policy on is_org_admin for both using and with check", () => {
    const policies = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBe(2);
    for (const p of policies) {
      expect(p).toMatch(/for all to authenticated/i);
      expect(p).toMatch(/using \(public\.is_org_admin\(org_id\)\)/);
      expect(p).toMatch(/with check \(public\.is_org_admin\(org_id\)\)/);
    }
  });

  it("never grants anything to anon or public", () => {
    expect(sql).not.toMatch(/to anon/i);
    expect(sql).not.toMatch(/grant .* to public/i);
  });

  it("does not introduce a service-role client into the CIS write path", () => {
    for (const f of [
      "server/services/cis-deduction.ts",
      "app/(app)/suppliers/[id]/payments/actions.ts",
    ]) {
      const src = codeOf(read(f));
      expect(src).not.toMatch(/createAdminClient/);
      expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    }
    expect(codeOf(read("server/services/cis-deduction.ts"))).toMatch(/import "server-only"/);
  });

  it("re-checks the role in the server actions so a non-admin gets a sentence", () => {
    const actions = codeOf(read("app/(app)/suppliers/[id]/payments/actions.ts"));
    expect(actions).toMatch(/recordCisPaymentAction/);
    expect(actions).toMatch(/saveBillDetails/);
    // Both new actions gate on isManager before touching anything.
    const cisAction = actions.slice(actions.indexOf("export async function recordCisPaymentAction"));
    expect(cisAction.slice(0, 500)).toMatch(/if \(!isManager\(ctx\.membership\.role\)\)/);
    const billAction = actions.slice(actions.indexOf("export async function saveBillDetails"));
    expect(billAction.slice(0, 500)).toMatch(/if \(!isManager\(ctx\.membership\.role\)\)/);
  });

  it("only the CIS service names the two new tables", () => {
    // Mirrors M2's pin. Any other module reaching these tables would bypass the
    // service's tenant-client discipline and its error translation.
    const sources = [
      ...walk(resolve(ROOT, "app")),
      ...walk(resolve(ROOT, "lib")),
      ...walk(resolve(ROOT, "server")),
    ];
    expect(sources.length).toBeGreaterThan(50);
    const readers = sources
      .filter((f) =>
        /["']cis_bill_details["']|["']cis_payment_snapshots["']/.test(
          codeOf(readFileSync(f, "utf8")),
        ),
      )
      .map((f) => f.replace(`${ROOT}/`, ""))
      .sort();
    // The actions file names cis_bill_details too, but ONLY as the audit
    // `targetTable` — asserted below to be a label, never a query.
    //
    // `cis-statements.ts` (M4, 20261055000000) is the second legitimate reader:
    // it READS `cis_payment_snapshots` to build statements and the monthly
    // return dataset, and never writes to either table. It keeps the same
    // discipline this pin exists to protect — tenant client only, never
    // service_role — which its own tier asserts in
    // __tests__/security/cis-statements.test.ts.
    expect(readers).toEqual([
      "app/(app)/suppliers/[id]/payments/actions.ts",
      "server/services/cis-deduction.ts",
      "server/services/cis-statements.ts",
    ]);
  });

  it("the actions file names cis_bill_details only as an audit label, never as a query", () => {
    const actions = codeOf(read("app/(app)/suppliers/[id]/payments/actions.ts"));
    expect(actions).toMatch(/targetTable:\s*"cis_bill_details"/);
    // No direct table access from the actions layer — the service owns the writes.
    expect(actions).not.toMatch(/from\(\s*"cis_bill_details"/);
    expect(actions).not.toMatch(/from\(\s*"cis_payment_snapshots"/);
  });

  it("leaves M2's ledger tables to M2's own service", () => {
    // The CIS service reads allocations through supplier-payments.ts rather than
    // naming the table itself, so M2's single-owner pin still holds unchanged.
    const cisService = codeOf(read("server/services/cis-deduction.ts"));
    expect(cisService).not.toMatch(/["']supplier_payment_allocations["']/);
    expect(cisService).not.toMatch(/["']supplier_payments["']/);
    expect(codeOf(read("server/services/supplier-payments.ts"))).toMatch(
      /export async function getCisAllocations/,
    );
  });

  it("guards against duplicate submission — a doubled CIS payment doubles a return", () => {
    const actions = codeOf(read("app/(app)/suppliers/[id]/payments/actions.ts"));
    const cisAction = actions.slice(actions.indexOf("export async function recordCisPaymentAction"));
    expect(cisAction).toMatch(/duplicate submit suppressed/);
  });
});

// ---------------------------------------------------------------------------
// 7. Tenant binding
// ---------------------------------------------------------------------------

describe("CIS M3 tenant and supplier binding is declarative", () => {
  it("binds bill details to org AND supplier with one composite FK", () => {
    expect(sql).toMatch(
      /foreign key \(finance_id, org_id, supplier_id\)\s*references public\.finances \(id, org_id, supplier_id\)/i,
    );
  });

  it("binds the snapshot to org AND supplier via the payment", () => {
    expect(sql).toMatch(
      /foreign key \(payment_id, org_id, supplier_id\)\s*references public\.supplier_payments \(id, org_id, supplier_id\)/i,
    );
  });

  it("scopes every subcontractor lookup by org_id", () => {
    const lookups = sql.match(/from public\.cis_subcontractors[\s\S]{0,180}/gi) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) expect(l).toMatch(/org_id/);
  });
});

// ---------------------------------------------------------------------------
// 8. The tax rules are documented and sourced
// ---------------------------------------------------------------------------

describe("the tax rules are written down with sources", () => {
  const doc = read("docs/cis-domain.md");

  it("cites gov.uk / HMRC for every rule area", () => {
    expect(doc).toMatch(/gov\.uk\/what-you-must-do-as-a-cis-contractor\/make-deductions/);
    expect(doc).toMatch(/construction-industry-scheme-cis-340/);
    expect(doc).toMatch(/cisr15110/);
    expect(doc).toMatch(/vat-domestic-reverse-charge-for-building-and-construction-services/);
    expect(doc).toMatch(/vat-reverse-charge-technical-guide/);
  });

  it("records the retrieval date", () => {
    expect(doc).toMatch(/retrieved:? 27 July 2026|retrieved 2026-07-27/i);
  });

  it("states the rates, the exclusions and the tax month rule", () => {
    expect(doc).toMatch(/20% for registered subcontractors/);
    expect(doc).toMatch(/30% for unregistered subcontractors/);
    // The HMRC quote is a wrapped blockquote, so tolerate the "\n> " join.
    expect(doc).toMatch(/0% if the\s+(?:>\s+)?subcontractor has 'gross payment' status/);
    expect(doc).toMatch(/fuel used, except for travelling/i);
    expect(doc).toMatch(/A tax month runs from the sixth of one month to the fifth of the next/);
  });

  it("has an explicit 'what we did NOT implement' section", () => {
    expect(doc).toMatch(/## 8\. What we deliberately did NOT implement/);
    expect(doc).toMatch(/CIS300|monthly return/i);
  });

  it("names what could NOT be verified rather than glossing over it", () => {
    expect(doc).toMatch(/\*\*Unverified:\*\*/);
    expect(doc).toMatch(/box numbers/i);
  });

  it("records the conservative interpretations", () => {
    expect(doc).toMatch(/## 7\. Conservative interpretations/);
  });
});

// ---------------------------------------------------------------------------
// 9. No floating-point money
// ---------------------------------------------------------------------------

describe("money handling", () => {
  it("routes every figure in the deduction engine through lib/money", () => {
    const lib = codeOf(read("lib/cis/deduction.ts"));
    expect(lib).toMatch(/from "@\/lib\/money"/);
    expect(lib).toMatch(/round2/);
    // No bare toFixed-based arithmetic pretending to be rounding.
    expect(lib).not.toMatch(/parseFloat\(/);
  });

  it("uses numeric(12, 2) for every money column in the migration", () => {
    const moneyCols =
      sql.match(/^\s*(cis_\w+|materials_\w+|citb_\w+)\s+numeric\([^)]*\)/gm) ?? [];
    expect(moneyCols.length).toBeGreaterThan(0);
    for (const c of moneyCols) {
      expect(c).toMatch(/numeric\((12, 2|5, 2)\)/);
    }
    expect(sql).not.toMatch(/\b(float|double precision|real)\b/i);
  });
});
