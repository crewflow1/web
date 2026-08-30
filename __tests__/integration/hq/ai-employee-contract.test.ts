import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI EMPLOYEE CONTRACT FIELDS + ROSTER COMPLETION — against REAL Postgres.
 * (L10: migrations 20261222000000 + 20261225000000)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What only this tier can prove:
 *
 *   1. RETIREMENT IS TERMINAL — a TRIGGER's law, not a convention. Only
 *      disabled → retired is admitted; a retired row refuses every UPDATE and
 *      DELETE. A mocked client would pass whether or not the trigger existed.
 *   2. KPI PERSISTENCE IS SERVICE-ROLE ONLY — ai_employee_kpis has RLS enabled
 *      with NO policies, so the anon/user JWT client must see and touch nothing.
 *   3. COST ATTRIBUTION SURVIVES THE SQL SETTLE PATH — the governed
 *      reserve → settle flow writes the ledger row INSIDE ai_settle_reservation,
 *      so p_ai_employee_id must land on the ai_invocations row it inserts, and
 *      an un-attributed settle (the pre-existing call shape) must still work.
 *   4. THE ROSTER IS COMPLETE — the eleven product-mapped identities exist,
 *      DARK (disabled), with the documented management line; the org chart's
 *      not-self CHECK holds.
 *
 * NOTE ON CLEANUP: a retired probe row CANNOT be deleted — that is the very
 * property under test — so each run leaves exactly one clearly-labelled probe
 * row (unique slug, sort_order 9990) in the local disposable database. CI
 * recreates the database per run.
 */

type Row = Record<string, unknown>;
type Db = {
  from(t: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
        single(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
      } & PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
      in(col: string, vals: unknown[]): PromiseLike<{
        data: Row[] | null;
        error: { message: string } | null;
      }>;
    };
    insert(rows: Row | Row[]): PromiseLike<{ error: { message: string; code?: string } | null }> & {
      select(cols: string): {
        single(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    upsert(
      rows: Row | Row[],
      opts?: Record<string, unknown>,
    ): PromiseLike<{ error: { message: string } | null }>;
    update(row: Row): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string; code?: string } | null }>;
    };
    delete(): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message: string; code?: string } | null }>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};
const db = (c: unknown) => c as unknown as Db;

const RAND = Math.random().toString(36).slice(2, 8);
const TOKEN = `it-l10-${Date.now()}-${RAND}`;
// ai_employees.slug CHECK: ^[a-z0-9-]{1,60}$ (no uppercase, no dots).
const PROBE_SLUG = `it-l10-retire-${RAND}`;
const WORKER_SLUG = `it-l10-worker-${RAND}`;

const ROSTER_SLUGS = [
  "whatsapp-ai",
  "email-ai",
  "scheduler-ai",
  "quote-writer-ai",
  "cashflow-ai",
  "payroll-ai",
  "business-coach-ai",
  "site-manager-ai",
  "blueprint-ai",
  "procurement-ai",
  "intelligence-ai",
] as const;

const EXPECTED_MANAGERS: Record<string, string> = {
  "whatsapp-ai": "support-ai",
  "email-ai": "support-ai",
  "scheduler-ai": "operations-ai",
  "quote-writer-ai": "finance-ai",
  "cashflow-ai": "finance-ai",
  "payroll-ai": "finance-ai",
  "business-coach-ai": "coo-ai",
  "site-manager-ai": "operations-ai",
  "blueprint-ai": "site-manager-ai",
  "procurement-ai": "operations-ai",
  "intelligence-ai": "cto-ai",
};

describeIntegration("AI employee contract fields + roster completion 2", () => {
  let orgId = "";
  let probeId = ""; // the retire probe (becomes permanent — see file header)
  let workerId = ""; // attribution probe (deleted in afterAll; never retired)

  async function insertEmployee(slug: string, status: string): Promise<string> {
    const res = await db(serviceClient())
      .from("ai_employees")
      .insert({
        name: `Integration probe ${slug}`,
        slug,
        role: "Integration test probe — safe to ignore",
        department: "operations",
        description: "Probe row created by ai-employee-contract.test.ts.",
        status,
        sort_order: 9990,
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return String(res.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "AI employee contract org", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");

    probeId = await insertEmployee(PROBE_SLUG, "idle");
    workerId = await insertEmployee(WORKER_SLUG, "disabled");
  }, 60_000);

  afterAll(async () => {
    const svc = db(serviceClient());
    // Reservations first (invocation_id FKs the ledger), then the ledger.
    if (orgId) {
      await svc.from("ai_cost_reservations").delete().eq("org_id", orgId);
      await svc.from("ai_invocations").delete().eq("org_id", orgId);
      await svc.from("organizations").delete().eq("id", orgId);
    }
    // The worker probe was never retired, so it deletes cleanly (kpis cascade).
    if (workerId) {
      await svc.from("ai_employee_kpis").delete().eq("employee_slug", WORKER_SLUG);
      await svc.from("ai_employees").delete().eq("id", workerId);
    }
    // PROBE_SLUG is retired by the tests and is therefore PERMANENT by design.
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // (a) Retirement is terminal — the trigger's law.
  // ═══════════════════════════════════════════════════════════════════════

  describe("retirement lifecycle (trigger-enforced)", () => {
    it("refuses idle → retired: only a disabled employee can retire", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .update({ status: "retired" })
        .eq("id", probeId);
      expect(res.error).not.toBeNull();
      expect(String(res.error?.message)).toMatch(/must be disabled/i);
    });

    it("admits disabled → retired and stamps retired_at itself", async () => {
      const disable = await db(serviceClient())
        .from("ai_employees")
        .update({ status: "disabled" })
        .eq("id", probeId);
      expect(disable.error, disable.error?.message).toBeNull();

      const retire = await db(serviceClient())
        .from("ai_employees")
        .update({ status: "retired" })
        .eq("id", probeId);
      expect(retire.error, retire.error?.message).toBeNull();

      const row = await db(serviceClient())
        .from("ai_employees")
        .select("status, retired_at")
        .eq("id", probeId)
        .maybeSingle();
      expect(row.error, row.error?.message).toBeNull();
      expect(row.data?.status).toBe("retired");
      expect(row.data?.retired_at).toBeTruthy();
    });

    it("refuses retired → anything (even back to disabled)", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .update({ status: "disabled" })
        .eq("id", probeId);
      expect(res.error).not.toBeNull();
      expect(String(res.error?.message)).toMatch(/retirement is terminal/i);
    });

    it("refuses ANY update to a retired row — it is immutable", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .update({ role: "rewritten history" })
        .eq("id", probeId);
      expect(res.error).not.toBeNull();
      expect(String(res.error?.message)).toMatch(/retirement is terminal/i);
    });

    it("refuses DELETE of a retired row — retirement is a permanent record", async () => {
      const res = await db(serviceClient()).from("ai_employees").delete().eq("id", probeId);
      expect(res.error).not.toBeNull();
      expect(String(res.error?.message)).toMatch(/cannot be deleted/i);
    });

    it("refuses a self-managing employee (not-self CHECK)", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .update({ manager_slug: WORKER_SLUG })
        .eq("id", workerId);
      expect(res.error).not.toBeNull();
      expect(String(res.error?.message)).toMatch(/manager_not_self|check/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (b) KPI persistence — service-role only, idempotent upsert.
  // ═══════════════════════════════════════════════════════════════════════

  describe("ai_employee_kpis", () => {
    const PERIOD = "2026-08-01";

    it("anon client can neither read nor write (RLS, no policies)", async () => {
      const write = await db(anonClient())
        .from("ai_employee_kpis")
        .insert({ employee_slug: WORKER_SLUG, period_start: PERIOD });
      expect(write.error).not.toBeNull();

      const read = await db(anonClient())
        .from("ai_employee_kpis")
        .select("id")
        .eq("employee_slug", WORKER_SLUG);
      // RLS-no-policy reads return an empty set, never rows.
      expect(read.data ?? []).toHaveLength(0);
    });

    it("service role upserts the period row idempotently (one row per employee+period)", async () => {
      const svc = db(serviceClient());
      const first = await svc.from("ai_employee_kpis").upsert(
        {
          employee_slug: WORKER_SLUG,
          period_start: PERIOD,
          tasks_completed: 2,
          tasks_failed: 1,
          approvals_requested: 1,
          cost_pence: 40,
        },
        { onConflict: "employee_slug,period_start" },
      );
      expect(first.error, first.error?.message).toBeNull();

      const second = await svc.from("ai_employee_kpis").upsert(
        {
          employee_slug: WORKER_SLUG,
          period_start: PERIOD,
          tasks_completed: 5,
          tasks_failed: 1,
          approvals_requested: 2,
          cost_pence: 90,
        },
        { onConflict: "employee_slug,period_start" },
      );
      expect(second.error, second.error?.message).toBeNull();

      const rows = await svc
        .from("ai_employee_kpis")
        .select("tasks_completed, cost_pence")
        .eq("employee_slug", WORKER_SLUG);
      expect(rows.error, rows.error?.message).toBeNull();
      expect(rows.data).toHaveLength(1);
      expect(rows.data?.[0]?.tasks_completed).toBe(5);
      expect(Number(rows.data?.[0]?.cost_pence)).toBe(90);
    });

    it("refuses negative figures (CHECKs) ", async () => {
      const res = await db(serviceClient())
        .from("ai_employee_kpis")
        .insert({ employee_slug: WORKER_SLUG, period_start: "2026-07-01", cost_pence: -1 });
      expect(res.error).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (c) Cost attribution — through the LIVE settle RPC and the direct insert.
  // ═══════════════════════════════════════════════════════════════════════

  describe("ai_invocations.ai_employee_id attribution", () => {
    async function reserve(hash: string | null) {
      const res = await db(serviceClient()).rpc("ai_reserve_invocation", {
        p_org_id: orgId,
        p_feature: "quote.writer_draft",
        p_task_class: "drafting",
        p_estimate_pence: 50,
        p_user_id: null,
        p_content_hash: hash,
        p_ceiling_pence: 10_000,
        p_ttl_seconds: 600,
        p_dedupe_window_seconds: 0,
      });
      expect(res.error, res.error?.message).toBeNull();
      const row = (Array.isArray(res.data) ? (res.data[0] as Row | undefined) : undefined) ?? {};
      expect(row.outcome).toBe("reserved");
      return String(row.reservation_id ?? "");
    }

    it("settle with p_ai_employee_id writes an ATTRIBUTED ledger row", async () => {
      const reservationId = await reserve(null);
      const res = await db(serviceClient()).rpc("ai_settle_reservation", {
        p_reservation_id: reservationId,
        p_success: true,
        p_cost_pence: 7,
        p_provider: "anthropic",
        p_model: "attribution-probe",
        p_input_tokens: 10,
        p_output_tokens: 10,
        p_latency_ms: 5,
        p_error_code: null,
        p_ai_employee_id: workerId,
      });
      expect(res.error, res.error?.message).toBeNull();
      const row = (Array.isArray(res.data) ? (res.data[0] as Row | undefined) : undefined) ?? {};
      expect(row.outcome).toBe("settled");

      const ledger = await db(serviceClient())
        .from("ai_invocations")
        .select("ai_employee_id, estimated_cost_pence")
        .eq("id", String(row.invocation_id))
        .maybeSingle();
      expect(ledger.error, ledger.error?.message).toBeNull();
      expect(ledger.data?.ai_employee_id).toBe(workerId);
      expect(Number(ledger.data?.estimated_cost_pence)).toBe(7);
    });

    it("settle WITHOUT the parameter still works (default null — the pre-existing call shape)", async () => {
      const reservationId = await reserve(null);
      const res = await db(serviceClient()).rpc("ai_settle_reservation", {
        p_reservation_id: reservationId,
        p_success: true,
        p_cost_pence: 3,
        p_provider: "anthropic",
        p_model: "attribution-probe",
        p_input_tokens: 1,
        p_output_tokens: 1,
        p_latency_ms: 5,
        p_error_code: null,
      });
      expect(res.error, res.error?.message).toBeNull();
      const row = (Array.isArray(res.data) ? (res.data[0] as Row | undefined) : undefined) ?? {};
      expect(row.outcome).toBe("settled");

      const ledger = await db(serviceClient())
        .from("ai_invocations")
        .select("ai_employee_id")
        .eq("id", String(row.invocation_id))
        .maybeSingle();
      expect(ledger.error, ledger.error?.message).toBeNull();
      expect(ledger.data?.ai_employee_id).toBeNull();
    });

    it("the direct recordInvocation shape (plain insert) carries the attribution column", async () => {
      const ins = await db(serviceClient())
        .from("ai_invocations")
        .insert({
          org_id: orgId,
          feature: "quote.writer_draft",
          task_class: "drafting",
          provider: "anthropic",
          model: "attribution-probe",
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost_pence: 2,
          latency_ms: 1,
          success: true,
          ai_employee_id: workerId,
        })
        .select("ai_employee_id")
        .single();
      expect(ins.error, ins.error?.message).toBeNull();
      expect(ins.data?.ai_employee_id).toBe(workerId);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // (d) Roster completion 2 — the product-mapped cohort, dark, with managers.
  // ═══════════════════════════════════════════════════════════════════════

  describe("roster completion (migration 20261225000000)", () => {
    it("seeds all eleven product-mapped identities DARK, each honestly describing its engine", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .select("slug, status, manager_slug, description, model_provider")
        .in("slug", [...ROSTER_SLUGS]);
      expect(res.error, res.error?.message).toBeNull();
      const rows = res.data ?? [];
      expect(rows.map((r) => r.slug).sort()).toEqual([...ROSTER_SLUGS].sort());
      for (const r of rows) {
        expect(r.status, `${r.slug} must be dark`).toBe("disabled");
        expect(r.model_provider, `${r.slug} must not be wired`).toBeNull();
        expect(String(r.description), `${r.slug} must map to its engine`).toMatch(/maps to/i);
        expect(r.manager_slug, `${r.slug} management line`).toBe(
          EXPECTED_MANAGERS[String(r.slug)],
        );
      }
    });

    it("the org chart is complete: exactly the CEO reports to the human board", async () => {
      const res = await db(serviceClient())
        .from("ai_employees")
        .select("slug, manager_slug")
        .in("slug", [
          "ceo-ai",
          "coo-ai",
          "cto-ai",
          "cfo-ai",
          "orchestrator-ai",
          "eng-manager-ai",
          "sales-ai",
        ]);
      expect(res.error, res.error?.message).toBeNull();
      const bySlug = new Map((res.data ?? []).map((r) => [r.slug, r.manager_slug]));
      expect(bySlug.get("ceo-ai")).toBeNull();
      expect(bySlug.get("coo-ai")).toBe("ceo-ai");
      expect(bySlug.get("cto-ai")).toBe("ceo-ai");
      expect(bySlug.get("cfo-ai")).toBe("ceo-ai");
      expect(bySlug.get("orchestrator-ai")).toBe("ceo-ai");
      expect(bySlug.get("eng-manager-ai")).toBe("cto-ai");
      expect(bySlug.get("sales-ai")).toBe("coo-ai");
    });
  });
});
