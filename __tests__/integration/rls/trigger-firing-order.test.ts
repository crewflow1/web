import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { describeIntegration } from "../_harness";

/**
 * A FINANCIAL-CORRECTNESS ORDERING CONSTRAINT, ENFORCED.
 * ---------------------------------------------------------------------------
 * Two BEFORE INSERT ROW triggers on `supplier_payment_allocations` both read the
 * bill in `finances`, and only ONE of them locks it:
 *
 *   * `tg_supplier_payment_allocation_guard` (20261047000000) does
 *     `select … from public.finances where id = new.finance_id FOR UPDATE`
 *     before it sums. That lock is what makes a concurrent bill edit block, and
 *     what makes this trigger's read the CURRENT COMMITTED value.
 *   * `tg_supplier_payment_allocation_cis` (20261051000000) reads the same bill
 *     WITHOUT a lock, to derive the CIS basis and check it against the
 *     `cis_bill_net` / `cis_bill_gross` the caller declared.
 *
 * PostgreSQL fires triggers of the same timing and event in ALPHABETICAL ORDER
 * OF TRIGGER NAME. Today the locking guard happens to sort first — but only
 * because `supplier_payment_allocation_guard` and `supplier_payment_allocations_cis`
 * differ at the character where `_` (0x5F) meets `s` (0x73), and `_` sorts lower.
 * That is an accident of naming carrying a correctness guarantee.
 *
 * WHAT BREAKS IF THE ORDER INVERTS. The CIS trigger would read the bill first,
 * with no lock, so under READ COMMITTED it would see the value as it stood
 * BEFORE a concurrent uncommitted bill edit. The guard would then block on that
 * edit, wake, and re-read the NEW value — and validate the allocation against a
 * bill the CIS snapshot was NOT derived from. The allocation would commit
 * carrying `cis_bill_net` from the old bill while the bill itself held the new
 * one: a deduction reported to HMRC that its own bill no longer explains, and
 * the exact dead end 20261053000000's freeze exists to prevent, reached through
 * a race instead of an edit. The next CIS payment on that bill would then be
 * refused with "has changed since it was part-paid", against a bill nobody
 * knowingly touched.
 *
 * So this is not a naming preference. Renaming either trigger — which looks like
 * a harmless tidy-up — silently reintroduces a financial-correctness bug that no
 * sequential test can observe. Hence this test.
 *
 * It deliberately identifies the two triggers BY WHAT THEY DO (does the function
 * body take `for update` on the bill?) rather than by name, so a rename does not
 * make the test vacuous — it makes it fail, which is the point.
 *
 * WHY execFileSync AND NOT supabase-js: `pg_trigger` is a catalog table and is
 * not exposed through PostgREST, and the repo has no raw Postgres client. The
 * Supabase local stack always runs Postgres in a container named from
 * `supabase/config.toml`'s project_id, in CI as well as locally, so psql inside
 * that container is the available route. Skips locally when the container is not
 * running; fails loudly under CI, matching describeIntegration's contract.
 */

const PROJECT_ID =
  /^\s*project_id\s*=\s*"([^"]+)"/m.exec(
    readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8"),
  )?.[1] ?? "crewflow";
const CONTAINER = `supabase_db_${PROJECT_ID}`;

/**
 * Classify every BEFORE INSERT ROW trigger on the allocations table by what its
 * function actually does, in the order PostgreSQL will fire them.
 *
 * tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT.
 */
const QUERY = `
select t.tgname
       || '|' || ((regexp_replace(p.prosrc, '\\s+', ' ', 'g'))
                  ilike '%from public.finances where id = new.finance_id for update%')::text
       || '|' || ((regexp_replace(p.prosrc, '\\s+', ' ', 'g')) ilike '%from public.finances%'
                  and p.prosrc ilike '%cis_bill_net%')::text
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.supplier_payment_allocations'::regclass
   and not t.tgisinternal
   and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4
 order by t.tgname;`;

type Row = { name: string; locksBill: boolean; readsBillForCis: boolean };

function readTriggers(): Row[] | null {
  let out: string;
  try {
    out = execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAq", "-c", QUERY],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    return null; // container absent — caller decides whether that is fatal
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      // `(bool)::text` renders as "true"/"false", not psql's bare "t"/"f".
      const [name, locks, cis] = l.split("|");
      return { name: name!, locksBill: locks === "true", readsBillForCis: cis === "true" };
    });
}

describeIntegration("BEFORE INSERT trigger firing order on supplier_payment_allocations", () => {
  it("fires the trigger that LOCKS the bill before the one that reads it for CIS", () => {
    const rows = readTriggers();
    if (!rows) {
      // Same contract as describeIntegration: never silently green in CI.
      if (process.env.CI) {
        throw new Error(
          `Could not reach Postgres in container "${CONTAINER}" to read pg_trigger. ` +
            "This test guards a financial-correctness ordering constraint and must " +
            "not be skipped in CI. Did `supabase start` run before this suite?",
        );
      }
      console.warn(`[trigger-order] container ${CONTAINER} not running — skipping`);
      return;
    }

    const order = rows.map((r) => r.name);
    const lockers = rows.filter((r) => r.locksBill);
    const cisReaders = rows.filter((r) => r.readsBillForCis && !r.locksBill);

    // If either side stops being identifiable the invariant is unverifiable, and
    // an unverifiable invariant must fail rather than quietly pass.
    expect(
      lockers,
      "Expected exactly ONE before-insert trigger on supplier_payment_allocations to " +
        "lock the bill with `select … from public.finances where id = new.finance_id " +
        "for update` (CAP 2, 20261047000000). Found: " +
        JSON.stringify(rows) +
        ". If CAP 2's lock was removed or reworded, the ordering guarantee this test " +
        "protects no longer exists — see the header of this file.",
    ).toHaveLength(1);
    expect(
      cisReaders,
      "Expected exactly ONE before-insert trigger to read the bill UNLOCKED to derive " +
        "the CIS basis (tg_supplier_payment_allocation_cis, 20261051000000). Found: " +
        JSON.stringify(rows),
    ).toHaveLength(1);

    const lockerAt = order.indexOf(lockers[0]!.name);
    const cisAt = order.indexOf(cisReaders[0]!.name);

    expect(
      lockerAt,
      `TRIGGER FIRING ORDER REGRESSION — this is a financial-correctness constraint, ` +
        `not a naming preference.\n\n` +
        `PostgreSQL fires same-timing triggers in alphabetical order of trigger name. ` +
        `Current order on supplier_payment_allocations:\n  ${order.join("\n  ")}\n\n` +
        `"${lockers[0]!.name}" takes FOR UPDATE on the bill and so always reads the ` +
        `current committed value. "${cisReaders[0]!.name}" reads the same bill WITHOUT ` +
        `a lock to derive the CIS basis.\n\n` +
        `The locking trigger MUST fire first. If it does not, the CIS trigger reads the ` +
        `bill before any lock is taken, so under READ COMMITTED it can snapshot a bill ` +
        `value that a concurrent uncommitted edit is about to change. The guard then ` +
        `blocks, wakes, re-reads the NEW value, and lets the allocation commit — storing ` +
        `cis_bill_net from the OLD bill against a bill that now says something else. ` +
        `That is a deduction reported to HMRC that its own bill no longer explains, and ` +
        `every later CIS payment on that bill is refused with "has changed since it was ` +
        `part-paid".\n\n` +
        `If you renamed a trigger, rename it back, or give the locking trigger a name ` +
        `that still sorts first — and say so in 20261053000000, which documents this ` +
        `dependency at both trigger definitions.`,
    ).toBeLessThan(cisAt);
  });
});
