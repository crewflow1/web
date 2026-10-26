import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  buildStockCogsCostRows,
  type CostedMovementRow,
} from "@/lib/stock/valuation";
import {
  buildJobCostInput,
  buildLabourSlices,
  lifetimeHoursSource,
} from "@/lib/profitability/job-cost-input";
import {
  computeAllJobsProfitability,
  averageMargin,
  type LabourEntry,
} from "@/lib/profitability/compute";
import type { TimeEntry } from "@/lib/time/compute";

/**
 * R8 · Profit report labour + COGS pre-rollup RPCs — snapshot-equality (real PG).
 *
 * THE CLAIM UNDER TEST. The profit report used to read the WHOLE `time_entries`
 * history and the WHOLE `stock_movements` ledger and fold labour hours + COGS in
 * TypeScript. Migration 20261239000000 moves that aggregation into two
 * org-guarded SECURITY DEFINER RPCs (report_profit_labour_hours,
 * report_profit_stock_cogs). This test seeds a realistic org and asserts that the
 * per-job AND overall PROFIT / MARGIN figures derived from the RPC rollups are
 * EXACTLY what the pre-change TypeScript fold produced over the SAME rows — every
 * figure, to the penny — plus that a non-member is denied 42501.
 *
 * Because the profit report's invoices/finances reads and the pure profitability
 * authority (computeAllJobsProfitability) are UNCHANGED, the only moving parts are
 * the labour-hours slices and the COGS-per-job rows. The test therefore computes
 * the cost input BOTH ways over identical seeded rows and compares the resulting
 * JobProfitability rows (revenue, costs, buckets, gross profit, margin, band).
 */

type Err = { message: string; code?: string | null } | null;
type Row = Record<string, unknown>;
interface Ins {
  select: (c: string) => { single: () => Promise<{ data: Row | null; error: Err }> };
}
interface Table {
  insert: (rows: Row | Row[]) => Ins & PromiseLike<{ data: Row[] | null; error: Err }>;
  update: (v: Row) => { eq: (k: string, v: unknown) => Promise<{ error: Err }> };
  select: (c: string) => {
    eq: (k: string, v: unknown) => PromiseLike<{ data: Row[] | null; error: Err }>;
  };
  delete: () => { eq: (k: string, v: unknown) => Promise<{ error: Err }> };
}
const db = (client: unknown) => client as unknown as { from: (t: string) => Table };
const rpcOf = (client: unknown) =>
  client as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Err }>;
  };

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  if (res.error) throw new Error(`insert ${table}: ${res.error.message}`);
  const id = res.data?.id;
  if (!id) throw new Error(`insert ${table}: no id`);
  return String(id);
}

const TOKEN = `r8-profit-${Date.now()}`;
// All seeded entries are CLOSED, so `now` is irrelevant to the hours — but both
// paths are driven by the SAME instant for total determinism.
const NOW = new Date("2026-07-01T12:00:00Z");

describeIntegration("R8 profit rollups · margin snapshot-equality (RPC == TS fold)", () => {
  const svc = db(serviceClient());
  let orgId = "";
  let memberId = "";
  let memberToken = "";
  let outsiderId = "";
  let outsiderToken = "";

  // Jobs
  let jobLabour = ""; // labour only (2 users + breaks + a zero-rate user)
  let jobStock = ""; // stock issues + one corrected issue (net COGS)
  let jobMixed = ""; // labour + stock + a finances bill
  let jobZeroCost = ""; // revenue only — 100% margin

  // Users
  let u1 = ""; // £20/h
  let u2 = ""; // £30/h
  let u3 = ""; // no pay rate → labour dropped in BOTH paths

  const hourlyByUser = new Map<string, number>();

  async function mkUser(label: string, org: string | null): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${TOKEN}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    const mirror = await svc.from("users").insert({ id, email, full_name: `${label}` });
    if (mirror.error) throw new Error(mirror.error.message);
    if (org) {
      const mem = await svc
        .from("memberships")
        .insert({ org_id: org, user_id: id, role: label === "member" ? "owner" : "staff" });
      if (mem.error) throw new Error(mem.error.message);
    }
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${TOKEN}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgId = await insId(svc, "organizations", { name: `R8 ${TOKEN}`, slug: `${TOKEN}` });
    const m = await mkUser("member", orgId);
    memberId = m.id;
    memberToken = m.token;
    u1 = memberId; // the owner clocks time too
    const two = await mkUser("u2", orgId);
    u2 = two.id;
    const three = await mkUser("u3", orgId);
    u3 = three.id;
    const out = await mkUser("outsider", null);
    outsiderId = out.id;
    outsiderToken = out.token;

    hourlyByUser.set(u1, 20);
    hourlyByUser.set(u2, 30);
    // u3 deliberately absent → rate 0.

    // ── Jobs ────────────────────────────────────────────────────────────────
    jobLabour = await insId(svc, "jobs", { org_id: orgId, status: "new" });
    jobStock = await insId(svc, "jobs", { org_id: orgId, status: "new" });
    jobMixed = await insId(svc, "jobs", { org_id: orgId, status: "new" });
    jobZeroCost = await insId(svc, "jobs", { org_id: orgId, status: "new" });

    // ── Revenue (invoices) + direct finances costs ───────────────────────────
    const invoice = (n: string, job: string, amount: number, status = "sent") =>
      insId(svc, "invoices", {
        org_id: orgId,
        number: `INV-${TOKEN}-${n}`,
        status,
        amount,
        job_id: job,
      });
    await invoice("L", jobLabour, 1000);
    await invoice("S", jobStock, 2000);
    await invoice("M", jobMixed, 5000);
    await invoice("Z", jobZeroCost, 800);
    // A voided invoice on jobMixed must NOT count as revenue (handled identically
    // by computeAllJobsProfitability in both paths; seeded for realism).
    await invoice("Mvoid", jobMixed, 9999, "void");
    // A direct materials bill on jobMixed (finances stream, disjoint from stock).
    await insId(svc, "finances", {
      org_id: orgId,
      job_id: jobMixed,
      amount: 300,
      category: "materials",
    });

    // ── Time entries (labour) ─────────────────────────────────────────────────
    // jobLabour: u1 2h with a 30-min break → 1.5h @ £20; u2 3h → 3h @ £30;
    //            u3 4h but no rate → dropped in both paths.
    // jobMixed:  u1 1h → @ £20.
    const te = (
      user: string,
      job: string,
      startIso: string,
      endIso: string,
      breaks: Array<{ started_at: string; ended_at: string | null }> = [],
    ) =>
      svc.from("time_entries").insert({
        org_id: orgId,
        user_id: user,
        job_id: job,
        started_at: startIso,
        ended_at: endIso,
        breaks,
      });
    const teResults = await Promise.all([
      te(u1, jobLabour, "2026-06-10T08:00:00Z", "2026-06-10T10:00:00Z", [
        { started_at: "2026-06-10T09:00:00Z", ended_at: "2026-06-10T09:30:00Z" },
      ]),
      te(u2, jobLabour, "2026-06-11T08:00:00Z", "2026-06-11T11:00:00Z"),
      te(u3, jobLabour, "2026-06-12T08:00:00Z", "2026-06-12T12:00:00Z"),
      te(u1, jobMixed, "2026-06-13T08:00:00Z", "2026-06-13T09:00:00Z"),
    ]);
    for (const r of teResults) if (r.error) throw new Error(`time_entries: ${r.error.message}`);

    // ── Stock (costed), via the REAL write RPCs so cost_effect is trigger-frozen ─
    const depot = await insId(svc, "sites", { org_id: orgId, name: "Depot", kind: "depot" });
    const yard = await insId(svc, "sites", { org_id: orgId, name: "Yard", kind: "depot" });
    const item = await insId(svc, "stock_items", { org_id: orgId, name: "Blocks", unit: "ea" });

    // A PO line @ £5/unit, received 100 → a costed receipt (wavg £5). Receipts are
    // NON-COGS and must be excluded from the per-job COGS rollup.
    const po = await insId(svc, "purchase_orders", {
      org_id: orgId,
      number: `PO-${TOKEN}`,
      status: "sent",
      subtotal: 500,
      vat_total: 100,
    });
    const poLine = await insId(svc, "purchase_order_line_items", {
      org_id: orgId,
      purchase_order_id: po,
      description: "Blocks",
      qty: 100,
      unit: "ea",
      unit_price: 5,
      line_total: 500,
      sort_order: 0,
    });
    const grn = await insId(svc, "goods_received_notes", {
      org_id: orgId,
      purchase_order_id: po,
      number: `GRN-${TOKEN}`,
      delivery_date: "2026-06-05",
    });
    const grnLineRes = await svc
      .from("goods_received_lines")
      .insert({
        org_id: orgId,
        goods_received_note_id: grn,
        purchase_order_line_item_id: poLine,
        qty_received: 100,
      })
      .select("id")
      .single();
    if (grnLineRes.error) throw new Error(`grn line: ${grnLineRes.error.message}`);
    const grnLineId = String(grnLineRes.data?.id ?? "");
    const postRes = await svc.from("goods_received_notes").update({ status: "posted" }).eq("id", grn);
    if (postRes.error) throw new Error(`post grn: ${postRes.error.message}`);

    const asMember = rpcOf(userClient(memberToken));
    const receipt = await asMember.rpc("record_stock_receipt_from_grn", {
      p_org_id: orgId,
      p_grn_line_id: grnLineId,
      p_item_id: item,
      p_site_id: depot,
      p_notes: null,
    });
    if (receipt.error) throw new Error(`receipt: ${receipt.error.message}`);

    // Issue 10 → jobStock (COGS £50), issue 6 → jobStock then CORRECT it (nets to
    // £50), issue 4 → jobMixed (COGS £20). Plus a transfer and an adjustment,
    // both NON-COGS and excluded.
    const issue = (qty: number, job: string | null) =>
      asMember.rpc("record_stock_issue", {
        p_org_id: orgId,
        p_item_id: item,
        p_site_id: depot,
        p_qty: qty,
        p_job_id: job,
        p_material_request_line_id: null,
        p_notes: null,
      });
    const i1 = await issue(10, jobStock);
    if (i1.error) throw new Error(`issue1: ${i1.error.message}`);
    const i2 = await issue(6, jobStock);
    if (i2.error) throw new Error(`issue2: ${i2.error.message}`);
    const correctable = String(i2.data);
    const corr = await asMember.rpc("record_stock_correction", {
      p_org_id: orgId,
      p_movement_id: correctable,
      p_reason: "mis-issued — returned to stock",
    });
    if (corr.error) throw new Error(`correction: ${corr.error.message}`);
    const i3 = await issue(4, jobMixed);
    if (i3.error) throw new Error(`issue3: ${i3.error.message}`);

    const transfer = await asMember.rpc("record_stock_transfer", {
      p_org_id: orgId,
      p_item_id: item,
      p_from_site_id: depot,
      p_to_site_id: yard,
      p_qty: 5,
      p_notes: null,
    });
    if (transfer.error) throw new Error(`transfer: ${transfer.error.message}`);
    const adjust = await asMember.rpc("record_stock_adjustment", {
      p_org_id: orgId,
      p_item_id: item,
      p_site_id: depot,
      p_delta: -2,
      p_reason: "breakage",
    });
    if (adjust.error) throw new Error(`adjustment: ${adjust.error.message}`);
  });

  afterAll(async () => {
    if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    for (const id of [memberId, u2, u3, outsiderId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  /** Ground-truth raw rows, read back with the service client (RLS-bypassing). */
  async function rawInputs() {
    const jobsRes = await svc.from("jobs").select("id").eq("org_id", orgId);
    const invRes = await svc.from("invoices").select("id, job_id, amount, status").eq("org_id", orgId);
    const finRes = await svc.from("finances").select("id, job_id, amount, category").eq("org_id", orgId);
    const teRes = await svc
      .from("time_entries")
      .select("id, user_id, job_id, started_at, ended_at, breaks")
      .eq("org_id", orgId);
    const movRes = await svc
      .from("stock_movements")
      .select("id, stock_item_id, movement_type, effect, qty, job_id, cost_effect, corrects_movement_id")
      .eq("org_id", orgId);
    for (const r of [jobsRes, invRes, finRes, teRes, movRes]) {
      if (r.error) throw new Error(r.error.message);
    }
    return {
      jobs: (jobsRes.data ?? []) as Array<{ id: string }>,
      invoices: (invRes.data ?? []) as Array<{ job_id: string | null; amount: number | string | null; status?: string | null }>,
      finances: (finRes.data ?? []) as Array<{ job_id: string | null; amount: number | string | null; category: string | null }>,
      timeEntries: (teRes.data ?? []) as unknown as TimeEntry[],
      movements: (movRes.data ?? []) as unknown as CostedMovementRow[],
    };
  }

  it("the two unbounded whole-history reads are gone from the profit report", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const report = readFileSync(resolve(__dirname, "../../../lib/reports/report-data.ts"), "utf8");
    // The profit builder must NOT read the whole time_entries / stock_movements
    // ledgers any more — it calls the rollup RPCs instead.
    expect(report).not.toMatch(/\.from\("time_entries"\)/);
    expect(report).toMatch(/report_profit_labour_hours/);
    expect(report).toMatch(/loadStockCogsRollup/);
  });

  it("report_profit_labour_hours == buildLabourSlices(time_entries, lifetime)", async () => {
    const { timeEntries } = await rawInputs();
    const expected = buildLabourSlices(timeEntries, lifetimeHoursSource(NOW))
      .map((s) => ({ job_id: String(s.job_id), user_id: s.user_id, hours: s.hours }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id) || a.user_id.localeCompare(b.user_id));

    const res = await rpcOf(userClient(memberToken)).rpc("report_profit_labour_hours", {
      p_org: orgId,
      p_now: NOW.toISOString(),
    });
    expect(res.error, res.error?.message).toBeNull();
    const actual = ((res.data as Array<{ job_id: string; user_id: string; hours: number | string }>) ?? [])
      .map((r) => ({ job_id: String(r.job_id), user_id: String(r.user_id), hours: Number(r.hours) }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id) || a.user_id.localeCompare(b.user_id));

    // u1 jobLabour 1.5h, u2 jobLabour 3h, u3 jobLabour 4h, u1 jobMixed 1h.
    expect(actual).toEqual(expected);
    const byKey = new Map(actual.map((r) => [`${r.job_id}:${r.user_id}`, r.hours]));
    expect(byKey.get(`${jobLabour}:${u1}`)).toBe(1.5);
    expect(byKey.get(`${jobLabour}:${u2}`)).toBe(3);
    expect(byKey.get(`${jobMixed}:${u1}`)).toBe(1);
  });

  it("report_profit_stock_cogs == buildStockCogsCostRows (receipts/transfers/adjustments/corrections handled)", async () => {
    const { movements } = await rawInputs();
    const expected = buildStockCogsCostRows(movements)
      .map((r) => ({ job_id: r.job_id, amount: r.amount }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id));

    const res = await rpcOf(userClient(memberToken)).rpc("report_profit_stock_cogs", { p_org: orgId });
    expect(res.error, res.error?.message).toBeNull();
    const actual = ((res.data as Array<{ job_id: string; amount: number | string }>) ?? [])
      .map((r) => ({ job_id: String(r.job_id), amount: Number(r.amount) }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id));

    expect(actual).toEqual(expected);
    const byJob = new Map(actual.map((r) => [r.job_id, r.amount]));
    // jobStock: issued 10 (£50) + 6 (£30) then corrected the 6 → net £50.
    expect(byJob.get(jobStock)).toBe(50);
    // jobMixed: issued 4 @ wavg £5 → £20.
    expect(byJob.get(jobMixed)).toBe(20);
  });

  it("per-job and overall PROFIT/MARGIN are byte-identical RPC vs TS fold", async () => {
    const { jobs, invoices, finances, timeEntries, movements } = await rawInputs();

    // EXPECTED — the pre-change TypeScript fold over the whole history.
    const expectedCost = buildJobCostInput({
      finances,
      timeEntries,
      hourlyByUser,
      hoursForEntries: lifetimeHoursSource(NOW),
      cycle: "monthly",
      stockCogs: buildStockCogsCostRows(movements),
    });
    const expected = computeAllJobsProfitability(jobs, invoices, expectedCost).sort((a, b) =>
      a.job_id.localeCompare(b.job_id),
    );

    // ACTUAL — the SQL rollups.
    const lab = await rpcOf(userClient(memberToken)).rpc("report_profit_labour_hours", {
      p_org: orgId,
      p_now: NOW.toISOString(),
    });
    expect(lab.error, lab.error?.message).toBeNull();
    const labourSlices: LabourEntry[] = (
      (lab.data as Array<{ job_id: string; user_id: string; hours: number | string }>) ?? []
    ).map((r) => ({ job_id: String(r.job_id), user_id: String(r.user_id), hours: Number(r.hours) }));

    const cog = await rpcOf(userClient(memberToken)).rpc("report_profit_stock_cogs", { p_org: orgId });
    expect(cog.error, cog.error?.message).toBeNull();
    const stockCogs = ((cog.data as Array<{ job_id: string; amount: number | string }>) ?? []).map((r) => ({
      job_id: String(r.job_id),
      amount: Number(r.amount),
      category: "materials" as const,
    }));

    const actualCost = buildJobCostInput({
      finances,
      labourSlices,
      hourlyByUser,
      cycle: "monthly",
      stockCogs,
    });
    const actual = computeAllJobsProfitability(jobs, invoices, actualCost).sort((a, b) =>
      a.job_id.localeCompare(b.job_id),
    );

    // Every figure, every job.
    expect(actual).toEqual(expected);
    // Overall margin + total gross profit also identical.
    expect(averageMargin(actual)).toEqual(averageMargin(expected));
    expect(actual.reduce((s, r) => s + r.gross_profit, 0)).toEqual(
      expected.reduce((s, r) => s + r.gross_profit, 0),
    );
    // Sanity: the four seeded jobs all appear with revenue.
    expect(actual.length).toBe(4);
  });

  it("a non-member is DENIED 42501 on both rollup RPCs", async () => {
    for (const fn of ["report_profit_labour_hours", "report_profit_stock_cogs"] as const) {
      const args =
        fn === "report_profit_labour_hours"
          ? { p_org: orgId, p_now: NOW.toISOString() }
          : { p_org: orgId };
      const res = await rpcOf(userClient(outsiderToken)).rpc(fn, args);
      expect(res.error, `${fn}: a non-member must be denied`).not.toBeNull();
      expect(res.error?.code, `${fn}: expected 42501`).toBe("42501");
    }
  });
});
