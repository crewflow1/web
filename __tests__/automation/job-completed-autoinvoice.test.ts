import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOMATION_RULES, correlationIdFor } from "@/lib/automation/rules";
import { AUTOMATION_ACTION_TYPES } from "@/lib/automation/events";
import {
  CUSTOM_ACTION_REGISTRY,
  isCustomAvailableAction,
} from "@/lib/automation/action-registry";

/**
 * `job.completed` → auto-draft final invoice (Master Plan invoice-autogen).
 *
 * Today job completion only *suggests* an invoice. This wave adds a DRAFT-only
 * auto-generation path: the new `job_completed_autoinvoice` rule (dark by default)
 * fires the `generate_completion_invoice` action, which reuses the guarded
 * billing-plan stage-invoice authority (RPC automation_invoice_job_completion,
 * migration 20261153000000) to draft the remaining stages of a completed job's
 * plan. Never sends; humans keep final approval.
 *
 * Four behaviour proofs (the mandate):
 *   (a) a DRAFT is created ONCE on completion,
 *   (b) it is NEVER double-created on a re-fired event,
 *   (c) it is NEVER auto-sent (drafts only),
 *   (d) an ambiguous basis (no billing plan) falls back to the existing suggest.
 *
 * Plus catalogue/registry/migration-shape guards. The live-Postgres proof of the
 * RPC's invoice math + CAS idempotency lives in the integration tier by design;
 * here the RPC is modelled in-memory so the ACTION mapping + the dispatcher's
 * claim idempotency + the fallback wiring are proven hermetically.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// =====================================================================
// 1. Catalogue + registry — the opt-in, draft-only, dark-by-default rule
// =====================================================================

describe("catalogue — job_completed_autoinvoice", () => {
  const rule = AUTOMATION_RULES.find((r) => r.id === "job_completed_autoinvoice");

  it("exists and triggers on job.completed", () => {
    expect(rule, "job_completed_autoinvoice must exist").toBeTruthy();
    expect(rule?.trigger).toBe("job.completed");
  });

  it("runs the generate_completion_invoice action", () => {
    expect(rule?.actions).toEqual(["generate_completion_invoice"]);
  });

  it("ships DARK (enabled:false) — safe-by-default, opt-in per org", () => {
    // Dark-safe: no live impact until an org opts in via a per-org override, so
    // the live path is byte-for-byte unchanged for every existing org.
    expect(rule?.enabled).toBe(false);
  });

  it("the existing suggest rule is UNTOUCHED (fallback stays live)", () => {
    const suggest = AUTOMATION_RULES.find(
      (r) => r.id === "job_completed_suggest_invoice",
    );
    expect(suggest?.trigger).toBe("job.completed");
    expect(suggest?.enabled).toBe(true);
    expect(suggest?.actions).toContain("create_notification");
  });
});

describe("action registry — generate_completion_invoice is NOT custom-available", () => {
  it("is a known action type", () => {
    expect(AUTOMATION_ACTION_TYPES).toContain("generate_completion_invoice");
  });

  it("is registered but explicitly withheld from custom rules (injection boundary)", () => {
    const spec = CUSTOM_ACTION_REGISTRY.find(
      (s) => s.type === "generate_completion_invoice",
    );
    expect(spec, "must be catalogued for completeness").toBeTruthy();
    expect(spec?.availableToCustom).toBe(false);
    expect(spec?.params).toEqual([]);
    expect(isCustomAvailableAction("generate_completion_invoice")).toBe(false);
  });
});

// =====================================================================
// 2. Migration shape — reuse, draft-only, service-role, idempotent
// =====================================================================

describe("migration 20261153000000 — invoice autogen from completion", () => {
  const sql = read(
    "supabase/migrations/20261153000000_invoice_autogen_from_completion.sql",
  );

  it("adds the service-role completion RPC granted ONLY to service_role", () => {
    expect(sql).toMatch(
      /create or replace function public\.automation_invoice_job_completion\(p_job_id uuid, p_org_id uuid\)/,
    );
    expect(sql).toMatch(
      /grant execute on function public\.automation_invoice_job_completion\(uuid, uuid\) to service_role/,
    );
    // Never exposed to anon/authenticated (least privilege).
    expect(sql).not.toMatch(
      /grant execute on function public\.automation_invoice_job_completion\([^)]*\) to (authenticated|anon)/,
    );
  });

  it("reuses ONE invoice-math core — no forked math (helper + delegating RPC)", () => {
    expect(sql).toMatch(
      /create or replace function public\._generate_stage_invoice_row\(/,
    );
    // The public manual RPC delegates to the shared core (identity checks kept).
    expect(sql).toMatch(/return public\._generate_stage_invoice_row\(p_stage_id, p_due_date\)/);
    // The automation RPC also delegates to the SAME core.
    expect(sql).toMatch(/v_inv := public\._generate_stage_invoice_row\(v_stage\.id, null\)/);
    // The core is internal-only: revoked from public, granted to nobody.
    expect(sql).toMatch(
      /revoke all on function public\._generate_stage_invoice_row\(uuid, date\) from public/,
    );
  });

  it("generates DRAFT invoices only — never 'sent'/'paid' (no auto-send, no money posted)", () => {
    // The core inserts status 'draft'.
    expect(sql).toMatch(/status,[^)]*\)\s*values[\s\S]*'draft'/);
    expect(sql).not.toMatch(/'sent'/);
    expect(sql).not.toMatch(/status\s*=\s*'paid'/);
  });

  it("preserves generate_stage_invoice's identity contract (auth.uid + is_org_admin)", () => {
    expect(sql).toMatch(/if auth\.uid\(\) is null then raise exception 'authentication required'/);
    expect(sql).toMatch(/is_org_admin\(v_org\)/);
  });

  it("is org-pinned + idempotent (only un-invoiced stages, org filter on every hop)", () => {
    expect(sql).toMatch(/where id = p_job_id and org_id = p_org_id/);
    expect(sql).toMatch(/and org_id = p_org_id and status = 'active'/);
    // Only stages not yet invoiced are (re)billed → a re-fire never double-bills.
    expect(sql).toMatch(/invoice_id is null and amount > 0/);
  });

  it("falls back honestly — returns statuses that mean 'suggest', never invents a value", () => {
    expect(sql).toMatch(/'no_plan'/);
    expect(sql).toMatch(/'no_customer'/);
    expect(sql).toMatch(/'no_job'/);
    expect(sql).toMatch(/'nothing_remaining'/);
  });
});

// =====================================================================
// 3. Behaviour — real dispatcher, in-memory automation_runs + RPC model
// =====================================================================

/**
 * In-memory model. `automation_runs` reproduces the two facts the claim depends
 * on (unique (rule_id, correlation_id); a completed run can never be reclaimed).
 * The completion RPC is modelled against billing fixtures: org-pinned resolution,
 * draft creation for the remaining un-invoiced stages, and stage→invoice binding
 * (so a second call would report nothing_remaining — RPC-level idempotency).
 */
const hoisted = vi.hoisted(() => {
  type Run = { status: string; completed_at: string | null };
  const store = new Map<string, Run>();
  const key = (ruleId: unknown, corr: unknown) => `${ruleId}::${corr}`;

  type Job = { org_id: string; customer_id: string | null };
  type Plan = { id: string; job_id: string; org_id: string; status: string };
  type Stage = {
    id: string;
    plan_id: string;
    job_id: string;
    org_id: string;
    invoice_id: string | null;
    amount: number;
    sequence: number;
  };
  const billing = {
    jobs: new Map<string, Job>(),
    plans: [] as Plan[],
    stages: new Map<string, Stage>(),
  };

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function completionRpc(args: Record<string, unknown>) {
    const jobId = String(args.p_job_id);
    const orgId = String(args.p_org_id);
    const job = billing.jobs.get(jobId);
    if (!job || job.org_id !== orgId) return { status: "no_job" };
    const plan = billing.plans.find(
      (p) => p.job_id === jobId && p.org_id === orgId && p.status === "active",
    );
    if (!plan) return { status: "no_plan" };
    if (job.customer_id == null) return { status: "no_customer" };
    const remaining = [...billing.stages.values()]
      .filter(
        (s) =>
          s.plan_id === plan.id &&
          s.org_id === orgId &&
          s.job_id === jobId &&
          s.invoice_id == null &&
          s.amount > 0,
      )
      .sort((a, b) => a.sequence - b.sequence);
    if (remaining.length === 0) return { status: "nothing_remaining" };
    const invoices = remaining.map((s) => {
      const invoice_id = `inv-${s.id}`;
      s.invoice_id = invoice_id; // draft binding — RPC-level idempotency
      return { stage_id: s.id, invoice_id };
    });
    return { status: "created", count: invoices.length, invoices };
  }

  function runsFrom() {
    let op: "insert" | "update" | null = null;
    let row: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      insert(r: Record<string, unknown>) {
        op = "insert";
        row = r;
        return builder;
      },
      update(r: Record<string, unknown>) {
        op = "update";
        row = r;
        return builder;
      },
      eq(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      is(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      or() {
        return builder;
      },
      select() {
        if (op === "insert") {
          const k = key(row.rule_id, row.correlation_id);
          if (store.has(k)) return Promise.resolve({ data: [], error: null });
          store.set(k, {
            status: String(row.status),
            completed_at: (row.completed_at as string | null) ?? null,
          });
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        const k = key(filters.rule_id, filters.correlation_id);
        const existing = store.get(k);
        if (existing && existing.completed_at == null && existing.status === "failed") {
          existing.status = "running";
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      then(resolveFn: (v: { error: null }) => void) {
        const k = key(filters.rule_id, filters.correlation_id);
        const existing = store.get(k);
        if (existing && op === "update") {
          if (typeof row.status === "string") existing.status = row.status;
          if ("completed_at" in row) {
            existing.completed_at = (row.completed_at as string | null) ?? null;
          }
        }
        resolveFn({ error: null });
        return Promise.resolve();
      },
    };
    return builder;
  }

  // Empty best-effort read for custom rules (this event has none in-test).
  function emptyCustomRules() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve({ data: [], error: null }),
    };
    return builder;
  }

  function makeAdmin() {
    return {
      from(table: string) {
        if (table === "automation_runs") return runsFrom();
        if (table === "automation_custom_rules") return emptyCustomRules();
        throw new Error(`unexpected admin table in test: ${table}`);
      },
      rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        if (fn === "automation_invoice_job_completion") {
          return Promise.resolve({ data: completionRpc(args), error: null });
        }
        throw new Error(`unexpected rpc in test: ${fn}`);
      },
    };
  }

  return { store, billing, rpcCalls, makeAdmin };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => hoisted.makeAdmin(),
}));

vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: vi.fn(async () => {}),
}));

// Per-org rule overrides — mutable so each test opts the relevant rules in.
const overrideState = { map: new Map<string, boolean>() };
vi.mock("@/server/services/automation-rules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/services/automation-rules")>();
  return {
    ...actual,
    loadRuleOverridesBestEffort: vi.fn(async () => new Map(overrideState.map)),
  };
});

describe("dispatchAutomation(job.completed) — auto-draft invoice behaviour", () => {
  const ORG_A = "11111111-1111-1111-1111-111111111111";
  const ORG_B = "22222222-2222-2222-2222-222222222222";
  const CUST_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  let dispatchAutomation: typeof import("@/server/services/automation-dispatcher").dispatchAutomation;
  let emitNotifications: ReturnType<typeof vi.fn>;

  const jobEvent = (orgId: string, jobId: string) => ({
    type: "job.completed" as const,
    org_id: orgId,
    source_table: "jobs",
    source_id: jobId,
    payload: { to: "completed" },
  });

  /** A job with an active plan + one remaining un-invoiced stage. */
  function seedPlannedJob(jobId: string, orgId: string, customerId: string | null) {
    hoisted.billing.jobs.set(jobId, { org_id: orgId, customer_id: customerId });
    const planId = `plan-${jobId}`;
    hoisted.billing.plans.push({ id: planId, job_id: jobId, org_id: orgId, status: "active" });
    hoisted.billing.stages.set(`stage-${jobId}`, {
      id: `stage-${jobId}`,
      plan_id: planId,
      job_id: jobId,
      org_id: orgId,
      invoice_id: null,
      amount: 1000,
      sequence: 0,
    });
  }

  beforeEach(async () => {
    hoisted.store.clear();
    hoisted.billing.jobs.clear();
    hoisted.billing.plans.length = 0;
    hoisted.billing.stages.clear();
    hoisted.rpcCalls.length = 0;
    overrideState.map = new Map<string, boolean>();

    const disp = await import("@/server/services/automation-dispatcher");
    dispatchAutomation = disp.dispatchAutomation;
    const notif = await import("@/server/services/notifications-service");
    emitNotifications = notif.emitNotifications as unknown as ReturnType<typeof vi.fn>;
    emitNotifications.mockClear();
  });

  const autoInvoiceRun = (res: { ran: ReadonlyArray<{ rule_id: string; status: string }> }) =>
    res.ran.find((r) => r.rule_id === "job_completed_autoinvoice");

  // (a) a draft is created once on completion
  it("(a) creates a draft invoice ONCE when the job has an active billing plan", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", false); // isolate autoinvoice
    seedPlannedJob("job-1", ORG_A, CUST_A);

    const res = await dispatchAutomation(jobEvent(ORG_A, "job-1"));

    expect(autoInvoiceRun(res)?.status).toBe("ok");
    // Exactly one completion RPC, org-pinned to THIS org's job.
    const calls = hoisted.rpcCalls.filter((c) => c.fn === "automation_invoice_job_completion");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ p_job_id: "job-1", p_org_id: ORG_A });
    // The stage now carries a draft invoice binding.
    expect(hoisted.billing.stages.get("stage-job-1")?.invoice_id).toBe("inv-stage-job-1");
  });

  // (b) never double-created
  it("(b) NEVER double-creates on a re-fired job.completed (claim is idempotent)", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", false);
    seedPlannedJob("job-1", ORG_A, CUST_A);

    const first = await dispatchAutomation(jobEvent(ORG_A, "job-1"));
    expect(autoInvoiceRun(first)?.status).toBe("ok");

    const second = await dispatchAutomation(jobEvent(ORG_A, "job-1"));
    // A completed claim can't be reclaimed → skipped, and the RPC is NOT re-run.
    expect(autoInvoiceRun(second)?.status).toBe("skipped");

    const calls = hoisted.rpcCalls.filter((c) => c.fn === "automation_invoice_job_completion");
    expect(calls).toHaveLength(1);

    expect(correlationIdFor("job.completed", "jobs", "job-1")).toBe(
      "job.completed:jobs:job-1",
    );
  });

  // (c) never auto-sent
  it("(c) NEVER auto-sends — no email/notification is queued by the invoice action", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", false); // no suggest either
    seedPlannedJob("job-1", ORG_A, CUST_A);

    await dispatchAutomation(jobEvent(ORG_A, "job-1"));

    // The autoinvoice action creates a DRAFT and emits nothing — a human sends.
    expect(emitNotifications).not.toHaveBeenCalled();
    // And the rule carries NO send action.
    const rule = AUTOMATION_RULES.find((r) => r.id === "job_completed_autoinvoice");
    expect(rule?.actions).not.toContain("send_email_queue");
  });

  // (d) ambiguous basis falls back to suggest
  it("(d) with NO billing plan, falls back to the existing suggest notification", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", true); // both live
    // Job exists but has NO billing plan → ambiguous basis.
    hoisted.billing.jobs.set("job-noplan", { org_id: ORG_A, customer_id: CUST_A });

    const res = await dispatchAutomation(jobEvent(ORG_A, "job-noplan"));

    // The autoinvoice action skips-with-ok (no fabricated invoice)…
    expect(autoInvoiceRun(res)?.status).toBe("ok");
    // …and the suggest rule still fires its "send the invoice?" notification.
    const suggestRun = res.ran.find((r) => r.rule_id === "job_completed_suggest_invoice");
    expect(suggestRun?.status).toBe("ok");
    expect(emitNotifications).toHaveBeenCalledTimes(1);
    const note = (emitNotifications.mock.calls as Array<[Array<Record<string, unknown>>]>)[0]![0][0]!;
    expect(note.type).toBe("automation.job.completed");
    expect(note.org_id).toBe(ORG_A);
  });

  it("is org-scoped — a foreign job_id in another org creates nothing (suggest fallback)", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", false);
    // Plan+stage belong to ORG_A; the event claims ORG_B → the RPC must not bill.
    seedPlannedJob("job-x", ORG_A, CUST_A);

    const res = await dispatchAutomation(jobEvent(ORG_B, "job-x"));

    expect(autoInvoiceRun(res)?.status).toBe("ok");
    // The ORG_A stage was NOT invoiced by an ORG_B event.
    expect(hoisted.billing.stages.get("stage-job-x")?.invoice_id).toBeNull();
  });

  it("a plan with all stages already invoiced does nothing (no duplicate, no suggest needed)", async () => {
    overrideState.map.set("job_completed_autoinvoice", true);
    overrideState.map.set("job_completed_suggest_invoice", false);
    seedPlannedJob("job-done", ORG_A, CUST_A);
    // Pre-mark the only stage as already invoiced.
    hoisted.billing.stages.get("stage-job-done")!.invoice_id = "inv-existing";

    const res = await dispatchAutomation(jobEvent(ORG_A, "job-done"));

    expect(autoInvoiceRun(res)?.status).toBe("ok");
    // Binding unchanged — no second invoice.
    expect(hoisted.billing.stages.get("stage-job-done")?.invoice_id).toBe("inv-existing");
  });
});
