import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Retention release-reminder scheduler — hermetic contract.
 *
 * A fake admin client mimics the exact query chains the service drives (the jobs
 * candidate scan, the batched invoices/releases reads, and the CAS marker claim)
 * so the emit + once-ever-idempotency logic is proven without a database. The
 * live-Postgres tenant-isolation proof belongs in the integration tier.
 */

const emitted: Array<Record<string, unknown>> = [];
vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: vi.fn(async (list: Array<Record<string, unknown>>) => {
    for (const n of list) emitted.push(n);
  }),
}));

type Job = {
  id: string;
  org_id: string;
  retention_percent: number;
  practical_completion_date: string | null;
  defects_liability_months: number;
  retention_first_release_pct: number;
  retention_first_reminded_at: string | null;
  retention_second_reminded_at: string | null;
};
type Invoice = { job_id: string; status: string; amount: number };
type Release = { job_id: string; amount: number };

let tables: { jobs: Job[]; invoices: Invoice[]; retention_releases: Release[] };

function makeAdmin() {
  function from(table: string) {
    const state: {
      op: "select" | "update";
      updateRow: Record<string, unknown> | null;
      jobId: string | null;
      casCol: string | null;
      inArr: string[] | null;
    } = { op: "select", updateRow: null, jobId: null, casCol: null, inArr: null };

    const chain: Record<string, unknown> = {
      select(_cols: string) {
        // The update CAS terminates in `.select("id")` — return a promise there;
        // a read `.select(cols)` continues the chain.
        if (state.op === "update") {
          const job = tables.jobs.find((j) => j.id === state.jobId);
          if (!job || state.casCol == null) return Promise.resolve({ data: [], error: null });
          const current = (job as unknown as Record<string, unknown>)[state.casCol];
          if (current != null) return Promise.resolve({ data: [], error: null });
          (job as unknown as Record<string, unknown>)[state.casCol] =
            (state.updateRow ?? {})[state.casCol] ?? new Date().toISOString();
          return Promise.resolve({ data: [{ id: job.id }], error: null });
        }
        return chain;
      },
      gt: () => chain,
      not: () => chain,
      or: () => chain,
      in: (_k: string, arr: string[]) => {
        state.inArr = arr;
        return chain;
      },
      order: () => chain,
      update: (row: Record<string, unknown>) => {
        state.op = "update";
        state.updateRow = row;
        return chain;
      },
      eq: (k: string, v: unknown) => {
        if (k === "id") state.jobId = String(v);
        return chain;
      },
      is: (k: string) => {
        state.casCol = k;
        return chain;
      },
      range: (fromRow: number) => {
        // One page suffices for the fixtures; a non-zero offset returns empty so
        // fetchAllRows terminates.
        if (fromRow > 0) return Promise.resolve({ data: [], error: null });
        if (table === "jobs") return Promise.resolve({ data: tables.jobs, error: null });
        if (table === "invoices") {
          const rows = tables.invoices.filter((r) => state.inArr?.includes(r.job_id));
          return Promise.resolve({ data: rows, error: null });
        }
        if (table === "retention_releases") {
          const rows = tables.retention_releases.filter((r) => state.inArr?.includes(r.job_id));
          return Promise.resolve({ data: rows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
    };
    return chain;
  }
  return { from };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeAdmin(),
}));

import { runRetentionReminders } from "@/server/services/retention-reminders";

const NOW = new Date("2026-08-15T09:00:00.000Z");

function seed(): typeof tables {
  return {
    jobs: [
      // A — first moiety due (PC past), second still upcoming.
      {
        id: "job-a",
        org_id: "org-1",
        retention_percent: 5,
        practical_completion_date: "2026-06-01",
        defects_liability_months: 12,
        retention_first_release_pct: 50,
        retention_first_reminded_at: null,
        retention_second_reminded_at: null,
      },
      // B — BOTH moieties due (PC + DLP both in the past).
      {
        id: "job-b",
        org_id: "org-2",
        retention_percent: 5,
        practical_completion_date: "2024-01-01",
        defects_liability_months: 12,
        retention_first_release_pct: 50,
        retention_first_reminded_at: null,
        retention_second_reminded_at: null,
      },
      // C — first moiety due but ALREADY reminded; second upcoming.
      {
        id: "job-c",
        org_id: "org-3",
        retention_percent: 5,
        practical_completion_date: "2026-06-01",
        defects_liability_months: 12,
        retention_first_release_pct: 50,
        retention_first_reminded_at: "2026-06-02T00:00:00.000Z",
        retention_second_reminded_at: null,
      },
    ],
    invoices: [
      { job_id: "job-a", status: "sent", amount: 100000 },
      { job_id: "job-b", status: "sent", amount: 100000 },
      { job_id: "job-c", status: "sent", amount: 100000 },
    ],
    retention_releases: [],
  };
}

beforeEach(() => {
  tables = seed();
  emitted.length = 0;
});

describe("runRetentionReminders", () => {
  it("fires each DUE, unreleased, un-reminded moiety exactly once", async () => {
    const summary = await runRetentionReminders(NOW);

    expect(summary.jobs_scanned).toBe(3);
    // A: first. B: first + second. C: first already reminded → skipped.
    expect(summary.fired_first).toBe(2); // job-a, job-b
    expect(summary.fired_second).toBe(1); // job-b
    expect(summary.skipped_already).toBe(1); // job-c first
    expect(summary.errors).toBe(0);
    expect(emitted).toHaveLength(3);
  });

  it("emits well-formed, org-scoped notifications naming the amount and moiety", async () => {
    await runRetentionReminders(NOW);

    const a = emitted.find((n) => n.source_id === "job-a")!;
    expect(a.org_id).toBe("org-1");
    expect(a.audience).toBe("customer");
    expect(a.type).toBe("retention.release_due_first");
    expect(a.source_module).toBe("retention");
    expect(a.action_url).toBe("/jobs/job-a");
    // 5% of £100,000 net = £5,000 accrued; first moiety 50% = £2,500.
    expect(String(a.title)).toContain("£2,500");
    expect((a.metadata as Record<string, unknown>).moiety).toBe("first");

    const bSecond = emitted.find(
      (n) => n.source_id === "job-b" && n.type === "retention.release_due_second",
    )!;
    expect(bSecond.org_id).toBe("org-2");
    expect(String(bSecond.title)).toContain("£2,500");
  });

  it("stamps the CAS markers so a second run is a no-op (idempotent)", async () => {
    await runRetentionReminders(NOW);
    expect(tables.jobs.find((j) => j.id === "job-a")!.retention_first_reminded_at).not.toBeNull();
    expect(tables.jobs.find((j) => j.id === "job-b")!.retention_second_reminded_at).not.toBeNull();

    emitted.length = 0;
    const second = await runRetentionReminders(NOW);
    expect(second.fired_first).toBe(0);
    expect(second.fired_second).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it("does not fire when accrued retention has been fully released", async () => {
    // Release the whole £5,000 on job-a → nothing left to remind about.
    tables.retention_releases.push({ job_id: "job-a", amount: 5000 });
    // Isolate job-a.
    tables.jobs = tables.jobs.filter((j) => j.id === "job-a");
    tables.invoices = tables.invoices.filter((i) => i.job_id === "job-a");

    const summary = await runRetentionReminders(NOW);
    expect(summary.fired_first).toBe(0);
    expect(summary.fired_second).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
