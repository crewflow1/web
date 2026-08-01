import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * `delay_events` (20261084) against real Postgres — the proofs only a live
 * database can give:
 *
 *   1. DUAL-ORG UNREPRESENTABILITY. A delay event can never name another
 *      tenant's job, diary entry or variation — the composite (col, org_id)
 *      FKs refuse it for EVERY role, service_role included. This is the
 *      job_warranties/20261078 guarantee extended to the evidence links.
 *   2. SAME-JOB LINK INTEGRITY. Even inside one org, a diary entry about a
 *      different job (or a plain non-variation quote) is not evidence and is
 *      refused by tg_delay_event_guard.
 *   3. THE LIFECYCLE GRAPH + IMMUTABILITY. Born draft; draft→recorded→
 *      withdrawn only; recorded rows frozen except write-once completion of
 *      ended_on/working_days_lost; provenance pinned to auth.uid() on the
 *      JWT path (a forged recorded_by cannot survive).
 *   4. GUESSED-ID ISOLATION. An authenticated member of org A gets nothing —
 *      not a row, not an error-shaped hint — from org B's event id.
 *   5. TEARDOWN. Deleting a linked diary entry SET-NULLs the link on a
 *      RECORDED event (the trigger's one escape) instead of blocking; job
 *      delete cascades its events; `delete from organizations` still works
 *      with the full evidence graph populated (the 20261052 lesson).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends PromiseLike<Res<null> & { count: number | null }> {
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
  update(patch: Row, opts?: { count: "exact" }): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());

const TOKEN = `it-eot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const BASE = {
  category: "weather",
  started_on: "2026-07-01",
  ended_on: "2026-07-03",
  working_days_lost: 2,
  description: "Storm — site stood down",
};

describeIntegration("delay_events · org binding, lifecycle, teardown (20261084)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobA2 = "";
  let jobB = "";
  let diaryA = ""; // on jobA
  let diaryA2 = ""; // on jobA2 (same org, different job)
  let diaryB = ""; // on jobB (other org)
  let variationA = ""; // variation on jobA
  let plainQuoteA = ""; // NON-variation quote in org A
  let userAId = "";
  let userAToken = "";

  const mkOrg = async (name: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name, slug: `${TOKEN}-${name.toLowerCase().replace(/\s+/g, "-")}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  };
  const mkJob = async (org: string) => {
    const r = await svc()
      .from("jobs")
      .insert({ org_id: org, status: "in_progress" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  };
  const mkDiary = async (org: string, job: string) => {
    const r = await svc()
      .from("site_diary_entries")
      .insert({ org_id: org, job_id: job, entry_date: "2026-07-01", delays: "storm" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  };

  beforeAll(async () => {
    orgA = await mkOrg("EOT A");
    orgB = await mkOrg("EOT B");
    jobA = await mkJob(orgA);
    jobA2 = await mkJob(orgA);
    jobB = await mkJob(orgB);
    diaryA = await mkDiary(orgA, jobA);
    diaryA2 = await mkDiary(orgA, jobA2);
    diaryB = await mkDiary(orgB, jobB);

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: `Customer ${TOKEN}` })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();

    const variation = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: String(cust.data?.id),
        job_id: jobA,
        number: `${TOKEN}-V-1`,
        variation_number: 1,
        status: "draft",
        subtotal: 1000,
        vat_total: 200,
        total: 1200,
        eot_requested_completion_date: "2026-09-01",
      })
      .select("id")
      .single();
    expect(variation.error, variation.error?.message).toBeNull();
    variationA = String(variation.data?.id ?? "");

    const plain = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: String(cust.data?.id),
        job_id: jobA,
        number: `${TOKEN}-Q-1`,
        status: "draft",
        subtotal: 100,
        vat_total: 20,
        total: 120,
      })
      .select("id")
      .single();
    expect(plain.error, plain.error?.message).toBeNull();
    plainQuoteA = String(plain.data?.id ?? "");

    // An authenticated member of org A only.
    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    userAId = created.data.user?.id ?? "";
    const m = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: userAId, role: "staff" })
      .select("user_id")
      .single();
    expect(m.error, m.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    userAToken = signedIn.data.session?.access_token ?? "";
    if (!userAToken) throw new Error("failed to sign the probe user in");
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
    if (userAId) await serviceClient().auth.admin.deleteUser(userAId).catch(() => {});
  });

  const insertA = (over: Row = {}) =>
    svc()
      .from("delay_events")
      .insert({ org_id: orgA, job_id: jobA, ...BASE, ...over })
      .select("id, status")
      .single();

  // ── 1. Dual-org unrepresentability ─────────────────────────────────────────
  it("refuses a delay in org A naming org B's job (service_role included)", async () => {
    const r = await insertA({ job_id: jobB });
    expect(r.error, "a cross-org job_id must be unrepresentable").not.toBeNull();
  });

  it("refuses a delay in org A linking org B's diary entry", async () => {
    const r = await insertA({ diary_entry_id: diaryB });
    expect(r.error, "a cross-org diary link must be unrepresentable").not.toBeNull();
  });

  it("accepts a fully same-org, same-job evidence chain", async () => {
    const r = await insertA({ diary_entry_id: diaryA, variation_quote_id: variationA });
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data?.status).toBe("draft");
  });

  // ── 2. Same-org link integrity (the guard) ─────────────────────────────────
  it("refuses a diary entry from ANOTHER JOB in the same org", async () => {
    const r = await insertA({ diary_entry_id: diaryA2 });
    expect(r.error?.message ?? "").toMatch(/does not record this job/i);
  });

  it("refuses a plain quote as a 'variation' link", async () => {
    const r = await insertA({ variation_quote_id: plainQuoteA });
    expect(r.error?.message ?? "").toMatch(/not a variation on this job/i);
  });

  it("refuses future-dated facts", async () => {
    const r = await insertA({ started_on: "2099-01-01", ended_on: null });
    expect(r.error?.message ?? "").toMatch(/future/i);
  });

  // ── 3. Lifecycle + immutability ────────────────────────────────────────────
  it("is born a draft — a direct 'recorded' insert is refused even for service_role", async () => {
    const r = await insertA({ status: "recorded", recorded_at: new Date().toISOString() });
    expect(r.error?.message ?? "").toMatch(/created as a draft/i);
  });

  it("refuses draft→withdrawn (delete the draft instead)", async () => {
    const d = await insertA({});
    const id = String(d.data?.id);
    const r = await svc()
      .from("delay_events")
      .update({ status: "withdrawn", withdrawn_at: new Date().toISOString() })
      .eq("id", id);
    expect(r.error?.message ?? "").toMatch(/not a legal transition/i);
  });

  it("JWT record pins provenance: a forged recorded_by cannot survive", async () => {
    const d = await insertA({});
    const id = String(d.data?.id);
    const me = db(userClient(userAToken));
    const r = await me
      .from("delay_events")
      .update({ status: "recorded", recorded_by: "00000000-0000-0000-0000-000000000000" })
      .eq("id", id);
    expect(r.error, r.error?.message).toBeNull();
    const after = await svc().from("delay_events").select("recorded_by, recorded_at").eq("id", id);
    expect(after.data?.[0]?.recorded_by).toBe(userAId);
    expect(after.data?.[0]?.recorded_at).toBeTruthy();
  });

  it("a recorded event is frozen: description, dates, category, links all refused", async () => {
    const d = await insertA({ diary_entry_id: diaryA });
    const id = String(d.data?.id);
    await svc().from("delay_events").update({ status: "recorded" }).eq("id", id);
    for (const patch of [
      { description: "rewritten history" },
      { started_on: "2026-06-01" },
      { ended_on: "2026-07-04" }, // value → different value
      { working_days_lost: 99 }, // value → different value
      { category: "other" },
      { diary_entry_id: diaryA2 }, // link swap (even to a same-job-invalid one)
    ]) {
      const r = await svc().from("delay_events").update(patch).eq("id", id);
      expect(r.error, `recorded event must refuse ${JSON.stringify(patch)}`).not.toBeNull();
    }
  });

  it("write-once completion: ended_on/working_days_lost NULL→value once, then frozen", async () => {
    const d = await insertA({ ended_on: null, working_days_lost: null });
    const id = String(d.data?.id);
    await svc().from("delay_events").update({ status: "recorded" }).eq("id", id);

    const complete = await svc()
      .from("delay_events")
      .update({ ended_on: "2026-07-05", working_days_lost: 3 })
      .eq("id", id);
    expect(complete.error, complete.error?.message).toBeNull();

    const again = await svc().from("delay_events").update({ ended_on: "2026-07-06" }).eq("id", id);
    expect(again.error, "a completed end date must be frozen").not.toBeNull();
  });

  it("withdrawal changes standing, not substance — and withdrawn is terminal", async () => {
    const d = await insertA({});
    const id = String(d.data?.id);
    await svc().from("delay_events").update({ status: "recorded" }).eq("id", id);

    // A withdrawal that also edits the record is refused.
    const dirty = await svc()
      .from("delay_events")
      .update({ status: "withdrawn", description: "never happened" })
      .eq("id", id);
    expect(dirty.error?.message ?? "").toMatch(/cannot alter the record/i);

    const clean = await svc().from("delay_events").update({ status: "withdrawn" }).eq("id", id);
    expect(clean.error, clean.error?.message).toBeNull();

    const revive = await svc().from("delay_events").update({ status: "recorded" }).eq("id", id);
    expect(revive.error, "withdrawn must be terminal").not.toBeNull();
    const edit = await svc().from("delay_events").update({ description: "x" }).eq("id", id);
    expect(edit.error, "withdrawn must be frozen").not.toBeNull();
  });

  // ── 4. Guessed-id isolation with a real JWT ────────────────────────────────
  it("an org A member gets NOTHING from org B's event id — read or write", async () => {
    const foreign = await svc()
      .from("delay_events")
      .insert({ org_id: orgB, job_id: jobB, ...BASE })
      .select("id")
      .single();
    expect(foreign.error, foreign.error?.message).toBeNull();
    const foreignId = String(foreign.data?.id);

    const me = db(userClient(userAToken));
    const read = await me.from("delay_events").select("id").eq("id", foreignId);
    expect(read.error).toBeNull();
    expect(read.data ?? []).toHaveLength(0);

    const write = await me
      .from("delay_events")
      .update({ description: "poisoned" }, { count: "exact" })
      .eq("id", foreignId);
    expect(write.count ?? 0).toBe(0);
    const after = await svc().from("delay_events").select("description").eq("id", foreignId);
    expect(after.data?.[0]?.description).toBe(BASE.description);
  });

  it("anon is denied entirely", async () => {
    const r = await db(anonClient()).from("delay_events").select("id").eq("org_id", orgA);
    expect((r.data ?? []).length).toBe(0);
  });

  // ── 5. Teardown paths ──────────────────────────────────────────────────────
  it("deleting a linked diary entry SET-NULLs the link on a RECORDED event instead of blocking", async () => {
    const diary = await mkDiary(orgA, jobA);
    const d = await insertA({ diary_entry_id: diary });
    const id = String(d.data?.id);
    await svc().from("delay_events").update({ status: "recorded" }).eq("id", id);

    const del = await svc().from("site_diary_entries").delete().eq("id", diary);
    expect(del.error, "diary delete must not be blocked by the frozen event").toBeNull();

    const after = await svc()
      .from("delay_events")
      .select("diary_entry_id, status, description")
      .eq("id", id);
    expect(after.data?.[0]?.diary_entry_id).toBeNull();
    expect(after.data?.[0]?.status).toBe("recorded"); // the record itself survives, frozen
    expect(after.data?.[0]?.description).toBe(BASE.description);
  });

  it("deleting the JOB takes its delay events with it", async () => {
    const job = await mkJob(orgA);
    const d = await svc()
      .from("delay_events")
      .insert({ org_id: orgA, job_id: job, ...BASE })
      .select("id")
      .single();
    expect(d.error, d.error?.message).toBeNull();
    const del = await svc().from("jobs").delete().eq("id", job);
    expect(del.error, del.error?.message).toBeNull();
    const after = await svc().from("delay_events").select("id").eq("id", String(d.data?.id));
    expect(after.data ?? []).toHaveLength(0);
  });

  it("org teardown works with the FULL evidence graph populated (the 20261052 lesson)", async () => {
    const org = await mkOrg("EOT T");
    const job = await mkJob(org);
    const diary = await mkDiary(org, job);
    const cust = await svc()
      .from("customers")
      .insert({ org_id: org, name: `Teardown ${TOKEN}` })
      .select("id")
      .single();
    const variation = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: String(cust.data?.id),
        job_id: job,
        number: `${TOKEN}-T-1`,
        variation_number: 1,
        status: "draft",
        subtotal: 0,
        vat_total: 0,
        total: 0,
      })
      .select("id")
      .single();
    const d = await svc()
      .from("delay_events")
      .insert({
        org_id: org,
        job_id: job,
        ...BASE,
        diary_entry_id: diary,
        variation_quote_id: String(variation.data?.id),
      })
      .select("id")
      .single();
    expect(d.error, d.error?.message).toBeNull();
    await svc().from("delay_events").update({ status: "recorded" }).eq("id", String(d.data?.id));

    const teardown = await svc().from("organizations").delete().eq("id", org);
    expect(teardown.error, "org teardown must survive a recorded, fully-linked event").toBeNull();
    const after = await svc().from("delay_events").select("id").eq("org_id", org);
    expect(after.data ?? []).toHaveLength(0);
  });
});
