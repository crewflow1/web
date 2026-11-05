import { afterAll, describe, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  ERASE_ANONYMISE_TABLES,
  ERASE_HARD_DELETE_TABLES,
  ERASE_RETAIN_TABLES,
} from "@/lib/gdpr/erase-tables";

/**
 * GDPR right-to-erasure (Art. 17) — the DESTRUCTIVE primitive, proven END-TO-END
 * against real Postgres (migrations 20261169000000 + 20261291000000).
 *
 * This is the coverage that was MISSING and let two defects ship: the only
 * erasure tests were hermetic list-algebra, so nothing ever ran `gdpr_erase_org`
 * against seeded data. Both defects are pinned here:
 *
 *   1. UNDELETABLE PERSONAL DATA (fixed 20261291). Append-only / immutable triggers
 *      (ai_reply_audits, the receptionist_conversation_* family, …) raise for
 *      service_role on the anonymise UPDATE and the hard-delete DELETE, which USED
 *      to roll the whole erasure back — so an org with one AI-reply audit could
 *      never be erased. The fix suppresses USER triggers transactionally. This test
 *      proves erasure now completes, the anonymise row is KEPT-and-SCRUBBED, the
 *      hard-delete append-only row is GONE, and the guard is RE-ARMED afterwards.
 *
 *   2. STATUTORY RECORDS NEVER SILENTLY CASCADE-DESTROYED (guard added 20261291).
 *      A hard-delete parent (jobs) with an ON DELETE CASCADE, all-NOT-NULL FK from a
 *      retained statutory child (job_billing_plans) must FAIL CLOSED, not destroy the
 *      child. This test proves the erasure refuses and the statutory row survives.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): PromiseLike<Res<Row[]>>;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpcOf = (client: unknown) =>
  client as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<Res<Record<string, unknown>>>;
  };

const eraseArgs = (orgId: string, slug: string) => ({
  p_org_id: orgId,
  p_confirm: slug,
  p_anonymise: [...ERASE_ANONYMISE_TABLES],
  p_hard_delete: [...ERASE_HARD_DELETE_TABLES],
  p_retain: [...ERASE_RETAIN_TABLES],
  p_storage_objects_deleted: 0,
  p_requested_by: null,
});

const TOKEN = `it-erase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("gdpr erase · trigger-bypass + statutory fail-closed", () => {
  const orgs: string[] = [];

  async function newOrg(tag: string): Promise<{ id: string; slug: string }> {
    const slug = `zz-erase-it-${tag}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await db(serviceClient())
      .from("organizations")
      .insert({ name: `ERASE IT ${tag}`, slug })
      .select("id,slug")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const id = String(created.data?.id ?? "");
    orgs.push(id);
    return { id, slug };
  }

  afterAll(async () => {
    // Best-effort: remove the org shells. Neither append-only probe has an FK to
    // organizations, so any orphaned scrubbed rows simply remain in the disposable
    // local DB — they do not block org removal and do not affect other suites.
    const del = serviceClient() as unknown as {
      from: (t: string) => {
        delete: () => { eq: (c: string, v: unknown) => PromiseLike<Res<Row[]>> };
      };
    };
    for (const id of orgs) {
      try {
        await del.from("organizations").delete().eq("id", id);
      } catch {
        /* disposable local DB — ignore */
      }
    }
  });

  it("1. erases an org carrying append-only rows: scrubs the kept record, deletes the rest, re-arms the guard", async () => {
    const svc = db(serviceClient());
    const org = await newOrg("appendonly");

    // Anonymise target with an append-only UPDATE guard + PII columns (reason/metadata).
    const audit = await svc
      .from("ai_reply_audits")
      .insert({
        org_id: org.id,
        employee_slug: "voice-receptionist-ai",
        channel: "voice",
        correlation_id: crypto.randomUUID(),
        draft: "hello",
        verdict: "allow",
        allowed: true,
        reason: "caller John Smith on 07700900000",
        metadata: { caller: "John Smith" },
      })
      .select("id")
      .single();
    expect(audit.error, audit.error?.message).toBeNull();
    const auditId = String(audit.data?.id ?? "");

    // Hard-delete target with an append-only DELETE guard.
    const outcome = await svc
      .from("receptionist_conversation_outcomes")
      .insert({
        org_id: org.id,
        correlation_id: crypto.randomUUID(),
        outcome_type: "callback",
      })
      .select("id")
      .single();
    expect(outcome.error, outcome.error?.message).toBeNull();

    // A plain hard-delete business record, and an anonymise financial record.
    const customer = await svc
      .from("customers")
      .insert({ org_id: org.id, name: "Customer X", email: "cx@example.test" })
      .select("id")
      .single();
    expect(customer.error, customer.error?.message).toBeNull();
    const finance = await svc
      .from("finances")
      .insert({ org_id: org.id, amount: 100, vat_rate: 20, notes: "secret note" })
      .select("id")
      .single();
    expect(finance.error, finance.error?.message).toBeNull();

    // ERASE — this is the call that used to roll back on the append-only UPDATE.
    const res = await rpcOf(serviceClient()).rpc("gdpr_erase_org", eraseArgs(org.id, org.slug));
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("erased");

    // The append-only ANONYMISE row is KEPT, with PII scrubbed.
    const auditAfter = await svc.from("ai_reply_audits").select("id,reason,metadata").eq("org_id", org.id);
    expect(auditAfter.error, auditAfter.error?.message).toBeNull();
    expect(auditAfter.data?.length).toBe(1);
    expect(auditAfter.data?.[0]?.reason).toBe("[erased]");
    expect(auditAfter.data?.[0]?.metadata).toBeNull();

    // The append-only HARD-DELETE row is GONE.
    const outcomeAfter = await svc
      .from("receptionist_conversation_outcomes")
      .select("id")
      .eq("org_id", org.id);
    expect(outcomeAfter.error, outcomeAfter.error?.message).toBeNull();
    expect(outcomeAfter.data?.length).toBe(0);

    // The plain hard-delete record is GONE; the statutory financial record is KEPT, scrubbed.
    const custAfter = await svc.from("customers").select("id").eq("org_id", org.id);
    expect(custAfter.data?.length).toBe(0);
    const finAfter = await svc.from("finances").select("id,notes,amount").eq("org_id", org.id);
    expect(finAfter.data?.length).toBe(1);
    expect(finAfter.data?.[0]?.notes).toBe("[erased]");

    // The append-only guard is RE-ARMED: a post-erasure UPDATE is refused again.
    const reblocked = await svc.from("ai_reply_audits").update({ reason: "tamper" }).eq("id", auditId);
    expect(reblocked.error, "append-only guard must be live again after erasure").not.toBeNull();
    expect(String(reblocked.error?.message)).toMatch(/append-only/i);
  });

  it("2. refuses (fail-closed) when a hard-delete would CASCADE-destroy a retained statutory record", async () => {
    const svc = db(serviceClient());
    const org = await newOrg("cascade");

    const job = await svc.from("jobs").insert({ org_id: org.id }).select("id").single();
    expect(job.error, job.error?.message).toBeNull();
    const plan = await svc
      .from("job_billing_plans")
      .insert({ org_id: org.id, job_id: String(job.data?.id ?? "") })
      .select("id")
      .single();
    expect(plan.error, plan.error?.message).toBeNull();

    const res = await rpcOf(serviceClient()).rpc("gdpr_erase_org", eraseArgs(org.id, org.slug));
    expect(res.error, "erasure must fail closed rather than cascade-destroy the statutory child").not.toBeNull();
    expect(String(res.error?.message)).toMatch(/CASCADE-destroy statutory records/i);

    // The statutory child SURVIVED (nothing was committed).
    const planAfter = await svc.from("job_billing_plans").select("id").eq("org_id", org.id);
    expect(planAfter.error, planAfter.error?.message).toBeNull();
    expect(planAfter.data?.length).toBe(1);
  });

  it("3. the primitive is service_role-only (anon cannot invoke the destructive RPC)", async () => {
    const res = await rpcOf(anonClient()).rpc("gdpr_erase_org", eraseArgs(crypto.randomUUID(), "whatever"));
    // Either a privilege/role rejection or a not-found-in-schema (grant stripped).
    expect(res.error, "anon must never reach gdpr_erase_org").not.toBeNull();
  });
});
