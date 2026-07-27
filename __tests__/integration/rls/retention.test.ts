import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Construction retention — DB invariants against real Postgres (migration
 * 20261005000000).
 *
 * Retention held is DERIVED (rate% × non-draft invoiced NET − released); the
 * database guarantees the commercial invariants a mock cannot:
 *   - a release can never exceed accrued retention (no over-release);
 *   - a recorded release is immutable;
 *   - a release amount is positive;
 *   - a release's org matches its job's org (tenant integrity);
 *   - draft invoices don't accrue retention;
 *   - deleting the job cascades its releases away.
 *
 * All on the service-role (RLS-bypassing) client — the most privileged writer;
 * if the invariants hold against it, they hold for every app path.
 */

type Ins = { error: { message: string; code?: string } | null };
type InsSingle = { data: { id: string } | null; error: { message: string; code?: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<Ins> & { select: (c: string) => { single: () => Promise<InsSingle> } };
    update: (v: unknown) => { eq: (k: string, v: unknown) => Promise<Ins> };
    delete: () => { eq: (k: string, v: unknown) => Promise<Ins> };
    select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: unknown }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("retention · invariants (20261005)", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let n = 0;
  const svc = () => db(serviceClient());

  /** A job in org A with the given retention rate. Returns the job id. */
  const mkJob = async (retentionPercent: number) => {
    const j = await svc()
      .from("jobs")
      .insert({ org_id: orgA, customer_id: custA, retention_percent: retentionPercent })
      .select("id")
      .single();
    expect(j.error, j.error?.message).toBeNull();
    return j.data!.id;
  };

  /** A certified (or draft) invoice on the job, NET `amount`. */
  const mkInvoice = async (jobId: string, amount: number, status = "sent") => {
    n += 1;
    const inv = await svc()
      .from("invoices")
      .insert({ org_id: orgA, number: `${TOKEN}-INV-${n}`, amount, vat_total: 0, status, job_id: jobId, customer_id: custA })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();
    return inv.data!.id;
  };

  const release = (jobId: string, amount: number, org = orgA) =>
    svc().from("retention_releases").insert({ org_id: org, job_id: jobId, amount }).select("id").single();

  beforeAll(async () => {
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const o = await svc().from("organizations").insert({ name: `Ret ${label}`, slug }).select("id").single();
      expect(o.error, o.error?.message).toBeNull();
      if (label === "A") orgA = o.data!.id;
      else orgB = o.data!.id;
    }
    const c = await svc().from("customers").insert({ org_id: orgA, name: "Cust A" }).select("id").single();
    custA = c.data!.id;
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
  });

  // ── Happy path — release within accrued ────────────────────────────────────
  it("allows releasing up to accrued retention", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000); // accrued = 5% × 10000 = 500
    const r1 = await release(job, 300);
    expect(r1.error, r1.error?.message).toBeNull();
    const r2 = await release(job, 200); // total 500 == accrued
    expect(r2.error, r2.error?.message).toBeNull();
  });

  // ── No over-release ────────────────────────────────────────────────────────
  it("REJECTS a release that would exceed accrued retention", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000); // accrued 500
    expect((await release(job, 300)).error).toBeNull();
    const over = await release(job, 300); // 600 > 500
    expect(over.error).not.toBeNull();
    expect(over.error?.message ?? "").toMatch(/exceeds held retention/i);
  });

  it("REJECTS the first release when nothing is accrued yet", async () => {
    const job = await mkJob(5); // rate set, but no certified invoices
    const r = await release(job, 0.01);
    expect(r.error).not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/exceeds held retention/i);
  });

  // ── Draft invoices don't accrue ────────────────────────────────────────────
  it("does NOT accrue retention on draft invoices", async () => {
    const job = await mkJob(10);
    await mkInvoice(job, 5000, "draft"); // accrued stays 0
    const r = await release(job, 1);
    expect(r.error).not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/exceeds held retention/i);
  });

  // ── Positive amount ────────────────────────────────────────────────────────
  it("REJECTS a non-positive release amount", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000);
    const zero = await release(job, 0);
    expect(zero.error).not.toBeNull();
    const neg = await release(job, -50);
    expect(neg.error).not.toBeNull();
  });

  // ── Tenant integrity ───────────────────────────────────────────────────────
  it("REJECTS a release whose org does not match the job's org", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000);
    const bad = await release(job, 100, orgB); // job is org A
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/org mismatch/i);
  });

  // ── Immutability ───────────────────────────────────────────────────────────
  it("REJECTS updating a recorded release (append-only)", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000);
    const rel = await release(job, 100);
    expect(rel.error, rel.error?.message).toBeNull();

    const upd = await svc().from("retention_releases").update({ amount: 999 }).eq("id", rel.data!.id);
    expect(upd.error).not.toBeNull();
    expect(upd.error?.message ?? "").toMatch(/immutable/i);
  });

  // ── Cascade delete stays open ──────────────────────────────────────────────
  it("cascades releases away when the job is deleted", async () => {
    const job = await mkJob(5);
    await mkInvoice(job, 10000);
    expect((await release(job, 100)).error).toBeNull();

    const del = await svc().from("jobs").delete().eq("id", job);
    expect(del.error, del.error?.message).toBeNull();

    const left = await svc().from("retention_releases").select("id").eq("job_id", job);
    expect(left.error, JSON.stringify(left.error)).toBeNull();
    expect(left.data ?? []).toHaveLength(0);
  });
});
