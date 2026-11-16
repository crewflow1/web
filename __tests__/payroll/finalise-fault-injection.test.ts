import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * finalisePayrollRun / deletePayrollRun — FAULT INJECTION at the Supabase boundary.
 *
 * Finalising a payroll run is IRREVERSIBLE and is N+1 separate statements (one
 * timesheet lock per payroll line, then the status flip). supabase-js cannot
 * wrap them in a transaction, and PostgREST errors are RETURNED, not thrown — so
 * every result has to be read. They were all discarded:
 *
 *   • a failed timesheet lock was skipped and the run finalised anyway (that
 *     worker's shifts stayed editable under a "locked" payroll);
 *   • a failed status flip left a draft that the page announced as finalised;
 *   • a failed delete was announced as deleted.
 *
 * The contract proved here: FAIL-STOP (the run is stamped finalised only after
 * every lock succeeded), HONEST (a failure is an error, never a success
 * banner), and IDEMPOTENTLY REPAIRABLE (pressing Finalise again completes
 * exactly what is missing and locks nothing twice).
 */

const RUN = "88888888-8888-4888-8888-888888888888";

type Entry = { id: string; user_id: string; payroll_line_id: string | null };
const model = {
  run: { id: RUN, period_start: "2026-10-01", period_end: "2026-10-31", status: "draft" as string },
  lines: [
    { id: "line-a", user_id: "worker-a" },
    { id: "line-b", user_id: "worker-b" },
    { id: "line-c", user_id: "worker-c" },
  ],
  entries: [] as Entry[],
  lockCalls: 0,
  faults: {
    /** fail the Nth timesheet-lock statement (1-based); 0 = never */
    lockOnCall: 0,
    statusFlip: false,
    /** the flip returns zero rows with NO error (RLS refusal / lost race) */
    statusFlipZeroRows: false,
    delete: false,
    /** a CONCURRENT request finalises the run while our Nth lock runs; 0 = never */
    concurrentFinaliseOnLockCall: 0,
  },
};

function table(name: string) {
  let op: "select" | "update" | "delete" = "select";
  let payload: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  let wantsRows = false;
  const exec = async (): Promise<{ data: unknown; error: unknown }> => {
    if (name === "payroll_runs") {
      if (op === "update") {
        if (model.faults.statusFlip) return { data: null, error: { code: "57014", message: "statement timeout" } };
        if (model.faults.statusFlipZeroRows) return { data: [], error: null };
        if (filters.status && model.run.status !== filters.status) return { data: [], error: null };
        Object.assign(model.run, payload);
        return { data: wantsRows ? [{ id: RUN }] : null, error: null };
      }
      if (op === "delete") {
        if (model.faults.delete) return { data: null, error: { code: "53300", message: "too many connections" } };
        model.run.status = "DELETED";
        return { data: null, error: null };
      }
      return { data: model.run.status === "DELETED" ? null : { ...model.run }, error: null };
    }
    if (name === "payroll_lines") return { data: model.lines, error: null };
    if (name === "time_entries" && op === "update") {
      model.lockCalls += 1;
      if (model.faults.concurrentFinaliseOnLockCall === model.lockCalls) model.run.status = "finalised";
      if (model.faults.lockOnCall === model.lockCalls) {
        return { data: null, error: { code: "08006", message: "connection failure" } };
      }
      for (const e of model.entries) {
        if (e.user_id === filters.user_id && e.payroll_line_id === null) {
          e.payroll_line_id = String(payload.payroll_line_id);
        }
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  for (const m of ["order", "range", "gte", "lte", "not", "is"]) c[m] = () => c;
  c.select = () => {
    if (op !== "select") wantsRows = true;
    return c;
  };
  c.eq = (k: string, v: unknown) => {
    filters[k] = v;
    return c;
  };
  c.update = (p: Record<string, unknown>) => {
    op = "update";
    payload = p;
    return c;
  };
  c.delete = () => {
    op = "delete";
    return c;
  };
  c.maybeSingle = exec;
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: (t: string) => table(t) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((u: string) => {
    throw new Error(`REDIRECT:${u}`);
  }),
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: "owner" } },
    user: { id: "u-1" },
  })),
}));

const { finalisePayrollRun, deletePayrollRun } = await import("@/app/(app)/payroll/actions");

const destination = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.startsWith("REDIRECT:")) return decodeURIComponent(m.slice("REDIRECT:".length));
    throw e;
  }
  throw new Error("action returned without redirecting");
};
const lockedTo = (user: string) => model.entries.filter((e) => e.user_id === user).map((e) => e.payroll_line_id);

beforeEach(() => {
  model.run = { id: RUN, period_start: "2026-10-01", period_end: "2026-10-31", status: "draft" };
  model.entries = [
    { id: "e1", user_id: "worker-a", payroll_line_id: null },
    { id: "e2", user_id: "worker-b", payroll_line_id: null },
    { id: "e3", user_id: "worker-b", payroll_line_id: null },
    { id: "e4", user_id: "worker-c", payroll_line_id: null },
  ];
  model.lockCalls = 0;
  model.faults = {
    lockOnCall: 0,
    statusFlip: false,
    statusFlipZeroRows: false,
    delete: false,
    concurrentFinaliseOnLockCall: 0,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("finalisePayrollRun — fail-stop, honest, repairable", () => {
  it("happy path: every timesheet locked to its line, THEN the run is finalised", async () => {
    const to = await destination(finalisePayrollRun(RUN));
    expect(to).toBe(`/payroll/${RUN}?saved=finalised`);
    expect(model.run.status).toBe("finalised");
    expect(model.entries.every((e) => e.payroll_line_id !== null)).toBe(true);
  });

  it("FAULT: the 2nd timesheet lock fails → the run is NOT finalised and the user is told so", async () => {
    model.faults.lockOnCall = 2;
    const to = await destination(finalisePayrollRun(RUN));

    expect(to).toMatch(/^\/payroll\/[^?]+\?error=/);
    expect(to).toMatch(/Couldn't finalise the run/);
    expect(to).not.toMatch(/saved=finalised/);
    // FAIL-STOP: an irreversible stamp over a half-locked workforce is the defect.
    expect(model.run.status, "must still be a draft").toBe("draft");
    expect(lockedTo("worker-b"), "the failed worker is unlocked — and nothing claims otherwise").toEqual([null, null]);
    // It stopped at the failure rather than ploughing on.
    expect(model.lockCalls).toBe(2);
  });

  it("REPAIR: pressing Finalise again after that failure completes it — nothing locked twice, nothing skipped", async () => {
    model.faults.lockOnCall = 2;
    await destination(finalisePayrollRun(RUN));
    const firstPassLockA = lockedTo("worker-a");

    model.faults.lockOnCall = 0; // database is back
    model.lockCalls = 0;
    const to = await destination(finalisePayrollRun(RUN));

    expect(to).toBe(`/payroll/${RUN}?saved=finalised`);
    expect(model.run.status).toBe("finalised");
    expect(lockedTo("worker-a")).toEqual(firstPassLockA); // unchanged by the retry
    expect(lockedTo("worker-b")).toEqual(["line-b", "line-b"]);
    expect(lockedTo("worker-c")).toEqual(["line-c"]);
  });

  it("FAULT: the status flip fails → error, never the 'finalised' banner; run stays draft", async () => {
    model.faults.statusFlip = true;
    const to = await destination(finalisePayrollRun(RUN));
    expect(to).toMatch(/Couldn't finalise the run/);
    expect(to).not.toMatch(/saved=finalised/);
    expect(model.run.status).toBe("draft");
  });

  it("FAULT: the flip changes zero rows with no error (refused write) → read back the truth, report failure", async () => {
    model.faults.statusFlipZeroRows = true;
    const to = await destination(finalisePayrollRun(RUN));
    expect(to).toMatch(/Couldn't finalise the run/);
    expect(model.run.status).toBe("draft");
  });

  it("RACE: a concurrent admin finalised first (our compare-and-set misses, but it IS finalised) → success, not a false error", async () => {
    // The pre-read saw 'draft'. While our locks were running, the other
    // request's flip landed — modelled as: the run becomes finalised during our
    // LAST lock statement. Our `.eq("status","draft")` flip then matches nothing.
    model.faults.concurrentFinaliseOnLockCall = model.lines.length;
    const to = await destination(finalisePayrollRun(RUN));
    expect(to).toBe(`/payroll/${RUN}?saved=finalised`);
    expect(model.run.status).toBe("finalised");
  });
});

describe("deletePayrollRun — never announces a delete that did not happen", () => {
  it("FAULT: the delete fails → error on the run page; the run is still there", async () => {
    model.faults.delete = true;
    const to = await destination(deletePayrollRun(RUN));
    expect(to).toMatch(new RegExp(`^/payroll/${RUN}\\?error=`));
    expect(to).toMatch(/Couldn't delete the run/);
    expect(model.run.status).toBe("draft");
  });

  it("happy path: deleted → list page with the saved banner", async () => {
    const to = await destination(deletePayrollRun(RUN));
    expect(to).toBe("/payroll?saved=deleted");
    expect(model.run.status).toBe("DELETED");
  });
});
