import { afterAll, expect, it } from "vitest";

import { describeIntegration, serviceClient } from "../_harness";
import { readEligiblePool } from "@/server/services/hq-lead-sourcing-runner";

/**
 * #901 corrective — real-schema read contract for the Companies House sourcing pool.
 *
 * The promotion read `readEligiblePool` selected/ordered by `snapshot_date`, a
 * column `hq_sales_sourcing_pool` does NOT have (the table tracks
 * `first_snapshot_date` / `last_snapshot_date`). The first real promotion would
 * have thrown `column ... snapshot_date does not exist`; a unit test that mocked a
 * fabricated `snapshot_date` hid it. This test runs the REAL query against REAL
 * Postgres, so a selected/ordered column that does not exist fails the suite —
 * a mock can never paper over the schema again.
 *
 * Covers: every selected/ordered column exists · the old `snapshot_date` is gone ·
 * eligible rows read newest-snapshot-first · promoted/inactive excluded · the
 * company_number dedupe invariant. (Promotion cap=10/week, DRAFT-only creation,
 * no outreach and no officer enrichment are proven in __tests__/hq/lead-sourcing.test.ts
 * against the same corrected row shape — they are promotion-writer properties,
 * not read-path ones.)
 */

type Row = Record<string, unknown>;
type Res<T> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  limit(n: number): Sel;
}
type Thenable = PromiseLike<{ error: { message: string } | null }>;
interface DelChain extends Thenable {
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Thenable;
  delete(): DelChain;
}
const db = (): { from(t: string): Table } => serviceClient() as unknown as { from(t: string): Table };

const TBL = "hq_sales_sourcing_pool";
const RUN = `ITPOOL${Date.now()}`;
const nums: string[] = [];
const mk = (suffix: string): string => {
  const n = `${RUN}${suffix}`;
  nums.push(n);
  return n;
};
const poolRow = (company_number: string, name: string, over: Row = {}): Row => ({
  company_number,
  name,
  geography: "northern_ireland",
  matched_sic: ["41202"],
  active: true,
  promoted: false,
  last_snapshot_date: "2026-09-01",
  ...over,
});

describeIntegration("#901 sourcing pool — readEligiblePool real-schema read contract", () => {
  afterAll(async () => {
    if (nums.length) await db().from(TBL).delete().in("company_number", nums);
  });

  it("runs the real query without a missing-column error (every selected/ordered column exists)", async () => {
    // If any selected or ordered column were absent, readEligiblePool would throw
    // (loud read-failure). Reaching an array is itself the column-existence proof.
    const rows = await readEligiblePool(5);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("regression: the pool has NO `snapshot_date` column, but DOES have `last_snapshot_date`", async () => {
    const bad = await db().from(TBL).select("snapshot_date").limit(1);
    expect(bad.error, "selecting snapshot_date must error — the column must not exist").not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/snapshot_date/);

    const good = await db().from(TBL).select("last_snapshot_date").limit(1);
    expect(good.error, good.error?.message).toBeNull();
  });

  it("reads only eligible rows, newest snapshot first; excludes promoted + inactive", async () => {
    const older = mk("OLD");
    const newer = mk("NEW");
    const promoted = mk("PROMOTED");
    const inactive = mk("INACTIVE");
    const ins = await db().from(TBL).insert([
      poolRow(older, "Older NI Co", { last_snapshot_date: "2026-07-01" }),
      poolRow(newer, "Newer NI Co", { last_snapshot_date: "2026-10-01" }),
      poolRow(promoted, "Promoted NI Co", { promoted: true, last_snapshot_date: "2026-10-01" }),
      poolRow(inactive, "Inactive NI Co", { active: false, last_snapshot_date: "2026-10-01" }),
    ]);
    expect(ins.error, ins.error?.message).toBeNull();

    const rows = await readEligiblePool(1000);
    // Scope to this run's rows so a shared pool can't perturb the assertions.
    const mine = rows.filter((r) => r.companyNumber.startsWith(RUN));
    const seen = mine.map((r) => r.companyNumber);

    expect(seen).toContain(newer);
    expect(seen).toContain(older);
    expect(seen).not.toContain(promoted); // promoted=true excluded
    expect(seen).not.toContain(inactive); // active=false excluded

    // Newest last_snapshot_date first (matches the partial index ordering).
    expect(seen.indexOf(newer)).toBeLessThan(seen.indexOf(older));

    // The mapped snapshotDate reflects last_snapshot_date (not a phantom column).
    const newerRow = mine.find((r) => r.companyNumber === newer);
    expect(newerRow?.snapshotDate).toBe("2026-10-01");
  });

  it("enforces the company_number dedupe invariant (unique constraint)", async () => {
    const dup = mk("DUP");
    const first = await db().from(TBL).insert(poolRow(dup, "Dup NI Co"));
    expect(first.error, first.error?.message).toBeNull();
    const second = await db().from(TBL).insert(poolRow(dup, "Dup NI Co again"));
    expect(second.error, "a duplicate company_number must violate the unique constraint").not.toBeNull();
  });
});
