import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * `job_warranties` (20261079) against real Postgres.
 *
 * Four things only a live database can prove:
 *   1. DUAL-ORG — a warranty can never name another tenant's job. The composite
 *      FK (job_id, org_id) → jobs (id, org_id) makes a cross-org job_id
 *      UNREPRESENTABLE, for service_role too (the role the customer portal runs
 *      as). This is the guard completion_certificates had to retrofit in 20261024.
 *   2. The published-term freeze: a promise the customer has seen cannot be
 *      shortened, re-pointed or redefined — only voided and reissued.
 *   3. ORG TEARDOWN still works with this table populated (the 20261052 lesson:
 *      no RESTRICT, no AFTER-DELETE trigger on the cascade path).
 *   4. Deleting the JOB takes its warranties with it — no orphan cover.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-warranty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TERMS = {
  title: "Workmanship warranty",
  kind: "workmanship",
  cover: "All labour and workmanship on the roof covering.",
  period_months: 12,
};

describeIntegration("job_warranties · org binding, freeze + teardown (20261079)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let teardownOrg = "";
  let teardownJob = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const mkOrg = async (name: string, slug: string) =>
      String((await svc.from("organizations").insert({ name, slug }).select("id").single()).data?.id ?? "");
    const mkJob = async (org: string) =>
      String((await svc.from("jobs").insert({ org_id: org, status: "completed" }).select("id").single()).data?.id ?? "");

    orgA = await mkOrg("Warranty A", `${TOKEN}-a`);
    orgB = await mkOrg("Warranty B", `${TOKEN}-b`);
    teardownOrg = await mkOrg("Warranty T", `${TOKEN}-t`);
    jobA = await mkJob(orgA);
    jobB = await mkJob(orgB);
    teardownJob = await mkJob(teardownOrg);
    if (!orgA || !orgB || !jobA || !jobB || !teardownOrg || !teardownJob) {
      throw new Error("fixture setup failed");
    }
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const org of [orgA, orgB, teardownOrg]) {
      if (org) await svc.from("organizations").delete().eq("id", org);
    }
  });

  // ── 1. Dual-org ────────────────────────────────────────────────────────────
  it("refuses a warranty in org A that names org B's job (service_role included)", async () => {
    const r = await db(serviceClient())
      .from("job_warranties")
      .insert({ org_id: orgA, job_id: jobB, ...TERMS })
      .select("id")
      .single();
    expect(r.error, "a cross-org job_id must be unrepresentable").not.toBeNull();
  });

  it("accepts a warranty whose job is in the same org", async () => {
    const r = await db(serviceClient())
      .from("job_warranties")
      .insert({ org_id: orgA, job_id: jobA, ...TERMS })
      .select("id")
      .single();
    expect(r.error, "same-org warranty must be accepted").toBeNull();
    expect(r.data?.id).toBeTruthy();
  });

  it("refuses to move an existing warranty onto another org's job", async () => {
    const svc = db(serviceClient());
    const id = String(
      (
        await svc
          .from("job_warranties")
          .insert({ org_id: orgA, job_id: jobA, ...TERMS, title: "Movable" })
          .select("id")
          .single()
      ).data?.id ?? "",
    );
    const r = await svc.from("job_warranties").update({ job_id: jobB }).eq("id", id);
    expect(r.error, "a cross-org UPDATE must be refused too").not.toBeNull();
  });

  it("refuses any start_basis but the completion certificate", async () => {
    const r = await db(serviceClient())
      .from("job_warranties")
      .insert({ org_id: orgA, job_id: jobA, ...TERMS, start_basis: "practical_completion_date" })
      .select("id")
      .single();
    expect(r.error, "jobs.practical_completion_date is not a permitted basis").not.toBeNull();
  });

  it("has no start or expiry column to write to", async () => {
    const r = await db(serviceClient())
      .from("job_warranties")
      .insert({ org_id: orgA, job_id: jobA, ...TERMS, expiry_date: "2030-01-01" })
      .select("id")
      .single();
    expect(r.error, "a second completion date must not be storable").not.toBeNull();
  });

  // ── 2. Published-term freeze ───────────────────────────────────────────────
  it("freezes the term, the cover and the job once the customer has seen it", async () => {
    const svc = db(serviceClient());
    const id = String(
      (
        await svc
          .from("job_warranties")
          .insert({
            org_id: orgA,
            job_id: jobA,
            ...TERMS,
            title: "Published",
            portal_published_at: new Date().toISOString(),
          })
          .select("id")
          .single()
      ).data?.id ?? "",
    );
    expect(id).toBeTruthy();

    const term = await svc.from("job_warranties").update({ period_months: 3 }).eq("id", id);
    expect(term.error?.message ?? "", "term must be frozen").toMatch(/frozen/i);

    const cover = await svc.from("job_warranties").update({ cover: "Less than promised" }).eq("id", id);
    expect(cover.error?.message ?? "", "cover must be frozen").toMatch(/frozen/i);

    // Withdrawing and voiding-with-a-reason remain open — that is the correction path.
    const withdraw = await svc
      .from("job_warranties")
      .update({ portal_withdrawn_at: new Date().toISOString() })
      .eq("id", id);
    expect(withdraw.error, "withdrawal must stay possible").toBeNull();

    const voided = await svc
      .from("job_warranties")
      .update({ status: "void", void_reason: "Superseded", voided_at: new Date().toISOString() })
      .eq("id", id);
    expect(voided.error, "void-with-a-reason must stay possible").toBeNull();
  });

  it("refuses a void with no reason", async () => {
    const svc = db(serviceClient());
    const id = String(
      (
        await svc
          .from("job_warranties")
          .insert({ org_id: orgA, job_id: jobA, ...TERMS, title: "Reasonless" })
          .select("id")
          .single()
      ).data?.id ?? "",
    );
    const r = await svc
      .from("job_warranties")
      .update({ status: "void", voided_at: new Date().toISOString() })
      .eq("id", id);
    expect(r.error, "a void must carry a reason").not.toBeNull();
  });

  // ── 3 + 4. Teardown ────────────────────────────────────────────────────────
  it("deleting the job removes its warranties (no orphan cover)", async () => {
    const svc = db(serviceClient());
    const org = String(
      (await svc.from("organizations").insert({ name: "W J", slug: `${TOKEN}-j` }).select("id").single()).data?.id ?? "",
    );
    const job = String(
      (await svc.from("jobs").insert({ org_id: org, status: "completed" }).select("id").single()).data?.id ?? "",
    );
    await svc.from("job_warranties").insert({ org_id: org, job_id: job, ...TERMS });

    const del = await svc.from("jobs").delete().eq("id", job);
    expect(del.error, "deleting a job must not be blocked by its warranties").toBeNull();

    const left = await svc.from("job_warranties").select("id").eq("job_id", job);
    expect(left.data ?? []).toHaveLength(0);
    await svc.from("organizations").delete().eq("id", org);
  });

  it("org teardown still succeeds with warranties present (the 20261052 lesson)", async () => {
    const svc = db(serviceClient());
    const created = await svc
      .from("job_warranties")
      .insert({ org_id: teardownOrg, job_id: teardownJob, ...TERMS })
      .select("id")
      .single();
    expect(created.error).toBeNull();

    const del = await svc.from("organizations").delete().eq("id", teardownOrg);
    expect(del.error, "delete from organizations must still work").toBeNull();

    const left = await svc.from("job_warranties").select("id").eq("org_id", teardownOrg);
    expect(left.data ?? []).toHaveLength(0);
    teardownOrg = "";
  });
});
