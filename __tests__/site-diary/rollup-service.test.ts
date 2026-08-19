import { describe, it, expect } from "vitest";
import { runSiteDiaryRollup, rollupTargetDate } from "@/server/services/site-diary-rollup";

/**
 * Automatic Site Diary roll-up — the SERVICE behaviour, driven through an
 * injected in-memory database.
 *
 * The three load-bearing invariants are proven here against a real run of
 * `runSiteDiaryRollup`, not a source scan:
 *
 *   - IDEMPOTENT: two runs of the same day produce ONE auto entry (the second
 *     refreshes in place), never a duplicate.
 *   - HUMAN-SAFE: a day that already has a MANUAL entry is skipped entirely.
 *   - SCOPED + HONEST: only ACTIVE jobs with real activity get an entry; a GRN
 *     is resolved to its job through its PO; only image attachments count as
 *     photos; and with no weather provider bound the weather field stays absent.
 */

// ── A tiny query-shape-faithful fake of the service-role client ──────────────

type Row = Record<string, unknown>;
type Filter = ["eq" | "gte" | "lt", string, unknown] | ["in", string, readonly unknown[]];

function match(row: Row, filters: Filter[]): boolean {
  for (const fl of filters) {
    const [op, key] = fl;
    const cell = row[key];
    if (op === "eq") {
      if (cell !== fl[2]) return false;
    } else if (op === "in") {
      if (!fl[2].includes(cell as never)) return false;
    } else if (op === "gte") {
      if (cell == null || String(cell) < String(fl[2])) return false;
    } else if (op === "lt") {
      if (cell == null || String(cell) >= String(fl[2])) return false;
    }
  }
  return true;
}

function makeDb(store: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Filter[] = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => (filters.push(["eq", k, v]), builder),
      gte: (k: string, v: unknown) => (filters.push(["gte", k, v]), builder),
      lt: (k: string, v: unknown) => (filters.push(["lt", k, v]), builder),
      in: (k: string, v: readonly unknown[]) => (filters.push(["in", k, v]), builder),
      order: () => builder,
      range: () =>
        Promise.resolve({ data: (store[table] ?? []).filter((r) => match(r, filters)), error: null }),
      insert: (row: Row) => {
        (store[table] ??= []).push({ id: `auto-${(store[table]?.length ?? 0) + 1}`, ...row });
        return Promise.resolve({ error: null });
      },
      update: (patch: Row) => ({
        eq: (k1: string, v1: unknown) => ({
          eq: (k2: string, v2: unknown) => {
            let count = 0;
            for (const r of store[table] ?? []) {
              if (r[k1] === v1 && r[k2] === v2) {
                Object.assign(r, patch);
                count++;
              }
            }
            return Promise.resolve({ error: null, count });
          },
        }),
      }),
    };
    return builder;
  };
  return { from } as never;
}

const ORG = "org-1";
const JOB_A = "job-a";
const JOB_DONE = "job-done";
const NOW = new Date("2026-07-19T05:00:00Z"); // UK day 2026-07-19 (BST) ⇒ target 2026-07-18
const TARGET = "2026-07-18";
const IN_DAY = "2026-07-18T09:00:00Z"; // inside the UK 2026-07-18 window

function seedStore(): Record<string, Row[]> {
  return {
    jobs: [
      { id: JOB_A, org_id: ORG, status: "in-progress", site_postcode: null, customer: null },
      { id: JOB_DONE, org_id: ORG, status: "completed", site_postcode: null, customer: null },
    ],
    snags: [
      { id: "s1", org_id: ORG, job_id: JOB_A, created_at: IN_DAY, resolved_at: null },
      { id: "s2", org_id: ORG, job_id: JOB_A, created_at: IN_DAY, resolved_at: null },
      { id: "s3", org_id: ORG, job_id: JOB_A, created_at: "2026-07-01T09:00:00Z", resolved_at: IN_DAY },
      // Activity on a COMPLETED job must be ignored.
      { id: "s4", org_id: ORG, job_id: JOB_DONE, created_at: IN_DAY, resolved_at: null },
    ],
    time_entries: [
      { id: "t1", org_id: ORG, job_id: JOB_A, user_id: "alice", started_at: IN_DAY, ended_at: "2026-07-18T11:00:00Z" },
    ],
    goods_received_notes: [
      { id: "g1", org_id: ORG, purchase_order_id: "po1", number: "GRN-1", delivery_note_reference: "DN-9", status: "posted", delivery_date: TARGET },
    ],
    purchase_orders: [{ id: "po1", org_id: ORG, job_id: JOB_A }],
    tenant_attachments: [
      { id: "a1", org_id: ORG, target_table: "jobs", target_id: JOB_A, mime_type: "image/jpeg", created_at: IN_DAY },
      { id: "a2", org_id: ORG, target_table: "jobs", target_id: JOB_A, mime_type: "application/pdf", created_at: IN_DAY },
    ],
    site_diary_entries: [],
  };
}

describe("rollupTargetDate — the day that just ended", () => {
  it("rolls up yesterday's UK calendar day", () => {
    expect(rollupTargetDate(NOW)).toBe(TARGET);
  });
});

describe("runSiteDiaryRollup — composition + scoping", () => {
  it("writes ONE auto entry for the active job, ignoring the completed one", async () => {
    const store = seedStore();
    const summary = await runSiteDiaryRollup({ db: makeDb(store), now: NOW });

    expect(summary.date).toBe(TARGET);
    expect(summary.weather).toBe(false); // no provider bound in tests
    expect(summary.created).toBe(1);
    expect(summary.jobsWithActivity).toBe(1); // JOB_DONE excluded

    const entries = store.site_diary_entries!;
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.org_id).toBe(ORG);
    expect(e.job_id).toBe(JOB_A);
    expect(e.entry_date).toBe(TARGET);
    expect(e.source).toBe("auto_rollup");
    expect(e.labour_count).toBe(1);
    expect(String(e.work_summary)).toContain("1 site photo added"); // only the image, not the pdf
    expect(String(e.work_summary)).toContain("2 snags raised, 1 closed");
    expect(String(e.work_summary)).toContain("1 delivery received (DN-9)");
    expect(String(e.work_summary)).toContain("1 operative on site — 2 hrs logged");
    expect(e.weather).toBeNull(); // dark
  });
});

describe("runSiteDiaryRollup — IDEMPOTENT", () => {
  it("a second run refreshes in place; it never duplicates", async () => {
    const store = seedStore();
    const db = makeDb(store);
    await runSiteDiaryRollup({ db, now: NOW });
    const second = await runSiteDiaryRollup({ db, now: NOW });

    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);
    expect(store.site_diary_entries).toHaveLength(1); // still exactly one
  });
});

describe("runSiteDiaryRollup — never collides with a MANUAL entry", () => {
  it("skips a job/day that already has a human diary entry", async () => {
    const store = seedStore();
    store.site_diary_entries!.push({
      id: "manual-1",
      org_id: ORG,
      job_id: JOB_A,
      entry_date: TARGET,
      source: "manual",
      work_summary: "Poured the slab. All good.",
    });

    const summary = await runSiteDiaryRollup({ db: makeDb(store), now: NOW });

    expect(summary.skippedManual).toBe(1);
    expect(summary.created).toBe(0);
    // The manual entry is untouched and no auto entry was added beside it.
    expect(store.site_diary_entries).toHaveLength(1);
    expect(store.site_diary_entries![0]!.source).toBe("manual");
    expect(store.site_diary_entries![0]!.work_summary).toBe("Poured the slab. All good.");
  });
});

describe("runSiteDiaryRollup — no activity", () => {
  it("writes nothing when the day was idle", async () => {
    const store = seedStore();
    store.snags = [];
    store.time_entries = [];
    store.goods_received_notes = [];
    store.tenant_attachments = [];

    const summary = await runSiteDiaryRollup({ db: makeDb(store), now: NOW });
    expect(summary.jobsWithActivity).toBe(0);
    expect(summary.created).toBe(0);
    expect(store.site_diary_entries).toHaveLength(0);
  });
});
