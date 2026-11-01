import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Reports A6 — reports_jobs_per_week + reports_revenue_per_month (real Postgres).
 *
 * The TypeScript jobsPerWeek()/revenuePerMonth() used to fetch EVERY job scheduled
 * in the window / EVERY paid invoice in the window (paged under the 1000-row cap)
 * and group/count/sum in TS; A6 moves that into the SECURITY DEFINER RPCs
 * reports_jobs_per_week / reports_revenue_per_month (migration 20261240000000).
 * This suite is the only tier that can prove the SQL reproduces the OLD contract
 * EXACTLY, because the behaviour is now SQL:
 *
 *   SNAPSHOT EQUALITY — the RPC output for a representative fixture (rows inside
 *     the window, rows OUTSIDE it, an empty bucket, a completed vs non-completed
 *     job, a VAT-bearing ex-VAT invoice, a UTC month/week-edge timestamp) is
 *     deep-equal to a REFERENCE implementation ported VERBATIM from the prior
 *     TypeScript, run over the same seeded rows. The reference is the authority:
 *     identical window + bucket math (UTC, day-1-normalised, Monday weeks), so the
 *     assertion is "the RPC == the exact prior computation".
 *
 *   WINDOW EDGES — a job/invoice just inside the lower bound counts; one just
 *     outside is dropped; a future-dated one is dropped. The window is always
 *     exactly N consecutive buckets (the C48 no-overflow guarantee, now date-
 *     independent in SQL), and flat periods pre-fill to 0 rather than a gap.
 *
 *   TIMEZONE EDGE — paid_at at 23:30Z on a month's last day buckets into THAT
 *     month; 00:30Z on the next day into the NEXT — UTC month boundaries, matching
 *     the TS getUTCMonth() path (never the server-local calendar).
 *
 *   F-1 ALL-ROWS — the SQL aggregate covers EVERY matching row, with none of the
 *     1000-row PostgREST truncation a bare .select() suffered: >1000 invoices in
 *     one month sum in full.
 *
 *   SECURITY — the canonical secdef-org guard: a NON-member is refused 42501; a
 *     member gets exactly the service-role ground truth. (The whole secdef-org
 *     class is also covered generically by secdef-org-rpc-guard.test.ts, which
 *     both functions auto-pass because they use current_org_ids() + 42501.)
 *
 *   ISOLATION — a second org's rows never appear in the first org's buckets.
 *
 * Revenue is EX-VAT (`amount`): a VAT-bearing invoice contributes its net amount,
 * never the gross generated `total`.
 */

type Row = Record<string, unknown>;
interface Res<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<Row[]>>;
  };
const db = (client: unknown) =>
  client as unknown as {
    from(t: string): {
      insert(rows: Row | Row[]): PromiseLike<{ error: { message: string } | null }> & {
        select(c: string): { single(): PromiseLike<{ data: Row | null; error: { message: string } | null }> };
      };
      select(c: string): {
        eq(k: string, v: unknown): PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
      };
      delete(): { eq(k: string, v: unknown): PromiseLike<{ error: { message: string } | null }> };
    };
  };

const T = `it-rptagg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY_MS = 86_400_000;

// ── Reference implementations — ported VERBATIM from lib/reports/aggregates.ts
//    (the computation A6 moved into SQL). These are the snapshot-equality oracle.
type JobsPerWeek = { week_start: string; total: number; completed: number };
type RevenuePerMonth = { month: string; revenue: number };

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
function startOfWeek(d: Date): Date {
  const dow = d.getUTCDay();
  const daysFromMon = (dow + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMon));
}
function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function refJobsPerWeek(
  rows: Array<{ status: string | null; scheduled_date: string | null }>,
  weeks = 8,
): JobsPerWeek[] {
  const since = new Date(Date.now() - weeks * 7 * DAY_MS).toISOString().slice(0, 10);
  const buckets = new Map<string, JobsPerWeek>();
  const todayWeekStart = startOfWeek(new Date());
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(todayWeekStart);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = isoDate(d);
    buckets.set(key, { week_start: key, total: 0, completed: 0 });
  }
  for (const j of rows) {
    if (!j.scheduled_date) continue;
    if (j.scheduled_date < since) continue; // the .gte("scheduled_date", since) filter
    const key = isoDate(startOfWeek(new Date(`${j.scheduled_date}T00:00:00Z`)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.total++;
    if (j.status === "completed") slot.completed++;
  }
  return Array.from(buckets.values());
}

function refRevenuePerMonth(
  rows: Array<{ paid_at: string | null; amount: number | null; status: string | null }>,
  months = 12,
): RevenuePerMonth[] {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const buckets = new Map<string, RevenuePerMonth>();
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.set(isoDate(m), { month: isoDate(m), revenue: 0 });
  }
  for (const inv of rows) {
    if (inv.status !== "paid") continue; // .eq("status","paid")
    if (!inv.paid_at) continue;
    if (inv.paid_at < since.toISOString()) continue; // .gte("paid_at", since)
    const key = isoDate(startOfMonth(new Date(inv.paid_at)));
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.revenue += Number(inv.amount ?? 0);
  }
  return Array.from(buckets.values());
}

// ── Normalisers for the RPC rows (PostgREST may type numerics loosely). ──
const normJobs = (rows: Row[] | null): JobsPerWeek[] =>
  (rows ?? []).map((r) => ({
    week_start: String(r.week_start),
    total: Number(r.total),
    completed: Number(r.completed),
  }));
const normRev = (rows: Row[] | null): RevenuePerMonth[] =>
  (rows ?? []).map((r) => ({ month: String(r.month), revenue: Number(r.revenue) }));

describeIntegration("reports · windowed aggregate RPCs (A6)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  // Dedicated org for the UTC month-boundary bucketing probe. It holds ONLY the
  // two edge invoices, so the general orgA fixtures (notably the "10 days ago"
  // £200 invoice, which lands in the previous calendar month when the suite runs
  // in the first ~10 days of a month) can never leak into the edge buckets. This
  // is what used to make the edge test flaky around month boundaries
  // (expected 13, got 213 = 13 + 200).
  let orgEdge = "";
  let adminA = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  // A recent, in-window month boundary used for the UTC timezone-edge probe:
  // two months before now, so both the 23:30Z last-day and 00:30Z next-day
  // invoices sit comfortably inside the 12-month window with day-level margin.
  const edgeMonthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1),
  );
  const nextMonthStart = new Date(
    Date.UTC(edgeMonthStart.getUTCFullYear(), edgeMonthStart.getUTCMonth() + 1, 1),
  );
  const lastDayOfEdgeMonth = new Date(nextMonthStart.getTime() - DAY_MS); // the 28th–31st
  const edgeLateZ = new Date(
    Date.UTC(
      lastDayOfEdgeMonth.getUTCFullYear(),
      lastDayOfEdgeMonth.getUTCMonth(),
      lastDayOfEdgeMonth.getUTCDate(),
      23,
      30,
    ),
  ).toISOString();
  const edgeEarlyZ = new Date(
    Date.UTC(nextMonthStart.getUTCFullYear(), nextMonthStart.getUTCMonth(), 1, 0, 30),
  ).toISOString();

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${suffix}@example.test`;
    const password = `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `RptAgg ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(label: string): Promise<string> {
    const r = await svc()
      .from("organizations")
      .insert({ name: `RptAgg ${label}`, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  let jn = 0;
  async function seedJob(org: string, status: string, scheduledDate: string): Promise<void> {
    jn += 1;
    const r = await svc()
      .from("jobs")
      .insert({ org_id: org, status, scheduled_date: scheduledDate })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
  }

  let inv = 0;
  async function seedInvoice(org: string, fields: Row): Promise<void> {
    inv += 1;
    const r = await svc()
      .from("invoices")
      .insert({
        org_id: org,
        number: `${T}-INV-${inv}`,
        amount: 0,
        vat_total: 0,
        status: "paid",
        ...fields,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
  }

  const dOffsetDate = (daysAgo: number): string =>
    new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const dOffsetIso = (daysAgo: number): string =>
    new Date(Date.now() - daysAgo * DAY_MS).toISOString();

  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    orgEdge = await makeOrg("edge");
    if (!orgA || !orgB || !orgEdge) throw new Error("failed to create probe orgs");
    adminA = await makeUser("admin-a");
    adminB = await makeUser("admin-b");
    for (const [org, user] of [
      [orgA, adminA.id],
      [orgB, adminB.id],
    ] as const) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: user, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }

    // ── jobs (org A), day-level margins off every boundary ──
    //  within the 8-week window, this week:
    await seedJob(orgA, "completed", dOffsetDate(2));
    await seedJob(orgA, "new", dOffsetDate(2));
    //  within the window, ~3 weeks back (a different, non-empty bucket):
    await seedJob(orgA, "completed", dOffsetDate(20));
    //  OUTSIDE the window (older than 8 weeks): must be dropped:
    await seedJob(orgA, "completed", dOffsetDate(80));
    //  FUTURE-dated in a LATER ISO week (>=7d ahead lands past this week's
    //  Sunday on any weekday): bucket is after the current-week bucket → dropped.
    await seedJob(orgA, "new", dOffsetDate(-10));
    //  a null scheduled_date: must be ignored:
    await seedJob(orgA, "completed", null as unknown as string);
    //  org B job — must never reach org A's buckets:
    await seedJob(orgB, "completed", dOffsetDate(2));

    // ── invoices (org A) ──
    //  paid, in a recent month, ex-VAT amount 200 (gross total would be 240):
    await seedInvoice(orgA, { amount: 200, vat_total: 40, paid_at: dOffsetIso(10) });
    //  another paid invoice, ~5 months back (distinct, non-empty bucket):
    await seedInvoice(orgA, { amount: 150, vat_total: 30, paid_at: dOffsetIso(150) });
    //  UNPAID invoice in-window — must NOT count:
    await seedInvoice(orgA, {
      amount: 9999,
      vat_total: 0,
      status: "sent",
      paid_at: null,
    });
    //  paid but OUTSIDE the 12-month window — must be dropped:
    await seedInvoice(orgA, { amount: 7777, vat_total: 0, paid_at: dOffsetIso(400) });
    //  TIMEZONE EDGE: 23:30Z on a month's last day vs 00:30Z next day →
    //  different UTC months:
    await seedInvoice(orgA, { amount: 11, vat_total: 0, paid_at: edgeLateZ });
    await seedInvoice(orgA, { amount: 13, vat_total: 0, paid_at: edgeEarlyZ });
    //  org B paid invoice — must never reach org A's buckets:
    await seedInvoice(orgB, { amount: 5555, vat_total: 0, paid_at: dOffsetIso(10) });

    // ── invoices (org EDGE) — ONLY the two month-boundary invoices, in isolation
    //    so the general fixtures above can never pollute the edge-bucketing probe:
    await seedInvoice(orgEdge, { amount: 11, vat_total: 0, paid_at: edgeLateZ });
    await seedInvoice(orgEdge, { amount: 13, vat_total: 0, paid_at: edgeEarlyZ });
  });

  afterAll(async () => {
    for (const id of [orgA, orgB, orgEdge]) if (id) await svc().from("organizations").delete().eq("id", id);
    for (const u of [adminA.id, adminB.id])
      if (u) await serviceClient().auth.admin.deleteUser(u).catch(() => undefined);
  });

  // ── Snapshot equality vs the ported reference ─────────────────────────────

  it("reports_jobs_per_week EXACTLY equals the prior TS computation", async () => {
    const seeded = await svc().from("jobs").select("status, scheduled_date").eq("org_id", orgA);
    expect(seeded.error, seeded.error?.message).toBeNull();
    const expected = refJobsPerWeek(
      (seeded.data ?? []) as Array<{ status: string | null; scheduled_date: string | null }>,
      8,
    );

    const got = await rpc(serviceClient()).rpc("reports_jobs_per_week", {
      p_org_id: orgA,
      p_weeks: 8,
    });
    expect(got.error, got.error?.message).toBeNull();
    expect(normJobs(got.data)).toEqual(expected);

    // And the window is well-formed: exactly 8 consecutive Monday buckets.
    const weeks = normJobs(got.data);
    expect(weeks).toHaveLength(8);
    for (let i = 1; i < weeks.length; i++) {
      const prev = new Date(`${weeks[i - 1]!.week_start}T00:00:00Z`).getTime();
      const cur = new Date(`${weeks[i]!.week_start}T00:00:00Z`).getTime();
      expect(cur - prev).toBe(7 * DAY_MS);
    }
    // This week has 1 completed + 1 scheduled; the future/out-of-window/null jobs
    // and org B's job are absent.
    const total = weeks.reduce((s, w) => s + w.total, 0);
    const completed = weeks.reduce((s, w) => s + w.completed, 0);
    expect(total).toBe(3); // 2 this week + 1 three weeks back
    expect(completed).toBe(2);
  });

  it("reports_revenue_per_month EXACTLY equals the prior TS computation (ex-VAT)", async () => {
    const seeded = await svc()
      .from("invoices")
      .select("paid_at, amount, status")
      .eq("org_id", orgA);
    expect(seeded.error, seeded.error?.message).toBeNull();
    const expected = refRevenuePerMonth(
      (seeded.data ?? []) as Array<{
        paid_at: string | null;
        amount: number | null;
        status: string | null;
      }>,
      12,
    );

    const got = await rpc(serviceClient()).rpc("reports_revenue_per_month", {
      p_org_id: orgA,
      p_months: 12,
    });
    expect(got.error, got.error?.message).toBeNull();
    expect(normRev(got.data)).toEqual(expected);

    // Window well-formed: exactly 12 consecutive first-of-month buckets (C48 — no
    // overflow/duplication on any run date).
    const months = normRev(got.data);
    expect(months).toHaveLength(12);
    expect(new Set(months.map((m) => m.month)).size).toBe(12);

    // Ex-VAT: turnover is the NET amount (200 + 150 + 11 + 13), never gross; the
    // unpaid (9999) and out-of-window (7777) invoices are excluded.
    const totalRevenue = months.reduce((s, m) => s + m.revenue, 0);
    expect(totalRevenue).toBe(200 + 150 + 11 + 13);
  });

  it("buckets by UTC month across a last-day 23:30Z / next-day 00:30Z edge", async () => {
    // orgEdge holds ONLY the two boundary invoices, so no general fixture can
    // leak into these buckets regardless of the date the suite runs (the old
    // flake: orgA's "10 days ago" £200 invoice falling into the lateKey month
    // in the first days of a month → expected 13, got 213).
    const got = await rpc(serviceClient()).rpc("reports_revenue_per_month", {
      p_org_id: orgEdge,
      p_months: 12,
    });
    expect(got.error, got.error?.message).toBeNull();
    const months = normRev(got.data);
    const earlyKey = isoDate(edgeMonthStart); // the 23:30Z invoice's UTC month
    const lateKey = isoDate(nextMonthStart); // the 00:30Z invoice's UTC month
    expect(months.find((m) => m.month === earlyKey)?.revenue).toBe(11);
    expect(months.find((m) => m.month === lateKey)?.revenue).toBe(13);
    expect(earlyKey).not.toBe(lateKey);
  });

  it("empty buckets pre-fill to 0 (a quiet org is all-zero, not a gap)", async () => {
    const jobs = await rpc(serviceClient()).rpc("reports_jobs_per_week", {
      p_org_id: orgB,
      p_weeks: 8,
    });
    expect(jobs.error, jobs.error?.message).toBeNull();
    // org B has exactly one job this week; every other week must be a 0 bucket.
    const weeks = normJobs(jobs.data);
    expect(weeks).toHaveLength(8);
    expect(weeks.filter((w) => w.total === 0).length).toBe(7);
  });

  // ── F-1: the SQL aggregate covers every row, no 1000-row truncation ────────

  it("sums EVERY paid invoice in a month, past the 1000-row PostgREST cap (F-1)", async () => {
    const bulkOrg = await makeOrg("bulk");
    const N = 1100; // strictly greater than the 1000-row cap a bare .select() hits
    const paidAt = dOffsetIso(15); // all in one recent, in-window month
    const batch = Array.from({ length: N }, (_, i) => ({
      org_id: bulkOrg,
      number: `${T}-BULK-${i}`,
      amount: 1,
      vat_total: 0,
      status: "paid",
      paid_at: paidAt,
    }));
    // Insert in chunks to keep each request modest.
    for (let i = 0; i < batch.length; i += 500) {
      const slice = batch.slice(i, i + 500);
      const r = await (serviceClient() as unknown as {
        from(t: string): { insert(rows: Row[]): PromiseLike<{ error: { message: string } | null }> };
      })
        .from("invoices")
        .insert(slice);
      expect(r.error, r.error?.message).toBeNull();
    }

    const got = await rpc(serviceClient()).rpc("reports_revenue_per_month", {
      p_org_id: bulkOrg,
      p_months: 12,
    });
    expect(got.error, got.error?.message).toBeNull();
    const total = normRev(got.data).reduce((s, m) => s + m.revenue, 0);
    expect(total).toBe(N); // all 1100 × £1, not truncated at 1000

    await svc().from("organizations").delete().eq("id", bulkOrg);
  });

  // ── Security + isolation ───────────────────────────────────────────────────

  it("refuses a NON-member with 42501 (canonical secdef-org guard)", async () => {
    const jobs = await rpc(userClient(adminB.token)).rpc("reports_jobs_per_week", {
      p_org_id: orgA,
      p_weeks: 8,
    });
    expect(jobs.error?.code, `org B admin must be denied org A jobs: ${jobs.error?.message}`).toBe(
      "42501",
    );
    const rev = await rpc(userClient(adminB.token)).rpc("reports_revenue_per_month", {
      p_org_id: orgA,
      p_months: 12,
    });
    expect(rev.error?.code, `org B admin must be denied org A revenue: ${rev.error?.message}`).toBe(
      "42501",
    );
  });

  it("a MEMBER gets exactly the service-role ground truth", async () => {
    const memJobs = await rpc(userClient(adminA.token)).rpc("reports_jobs_per_week", {
      p_org_id: orgA,
      p_weeks: 8,
    });
    const svcJobs = await rpc(serviceClient()).rpc("reports_jobs_per_week", {
      p_org_id: orgA,
      p_weeks: 8,
    });
    expect(memJobs.error, memJobs.error?.message).toBeNull();
    expect(normJobs(memJobs.data)).toEqual(normJobs(svcJobs.data));

    const memRev = await rpc(userClient(adminA.token)).rpc("reports_revenue_per_month", {
      p_org_id: orgA,
      p_months: 12,
    });
    const svcRev = await rpc(serviceClient()).rpc("reports_revenue_per_month", {
      p_org_id: orgA,
      p_months: 12,
    });
    expect(memRev.error, memRev.error?.message).toBeNull();
    expect(normRev(memRev.data)).toEqual(normRev(svcRev.data));
  });

  it("never leaks another org's rows into the buckets", async () => {
    const rev = await rpc(serviceClient()).rpc("reports_revenue_per_month", {
      p_org_id: orgA,
      p_months: 12,
    });
    const total = normRev(rev.data).reduce((s, m) => s + m.revenue, 0);
    expect(total).toBe(200 + 150 + 11 + 13); // org B's 5555 absent
  });
});
