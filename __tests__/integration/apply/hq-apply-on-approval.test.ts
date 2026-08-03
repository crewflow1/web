import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

// createAdminClient (the durable store's client) reads NEXT_PUBLIC_SUPABASE_URL; mirror the bare
// values the harness resolves into the NEXT_PUBLIC names so the real store binds to the SAME local
// database — set BEFORE importing the server-only modules (they read env per call).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= process.env.SUPABASE_ANON_KEY;

import { createDurableApplicationStore } from "@/server/services/hq-application";
import {
  runApplyOnApprovalDrain,
  type ApplyAuthority,
  type ApprovedItem,
} from "@/server/services/hq-apply-drain";
import { appliedRecord, deriveIdempotencyKey, type ExecutionIdentity } from "@/server/sdk/application";
import type { ExecutionOutcome } from "@/server/sdk/executor";

/**
 * Apply-on-approval runtime — real-Postgres proof (Directive #014 C3 rollout; ADR 0009).
 *
 * The unit tier proves the sweep's pure logic over injected seams; this tier proves the BEHAVIOUR
 * the mocks can't, against a LIVE database with the real migration applied:
 *   • the durable store persists + reads back the "applied" marker; a re-run is idempotent;
 *   • RLS:hq denies anon; the SECURITY DEFINER write is service_role-only;
 *   • the store is append-only (UPDATE/DELETE rejected even under service_role);
 *   • the CHECK rejects a shadow outcome — the table cannot hold anything but an application status;
 *   • the drain's production reader loads ONLY approved items (a pending/rejected item is invisible)
 *     and, ON with a sanctioned authority, applies each approved item EXACTLY ONCE.
 *
 * Runs only against a live DB (describeIntegration). The table is append-only, so rows are left
 * behind (harmless in the ephemeral CI database); the approvals fixtures are cleaned on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;
interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  limit(n: number): Sel;
}
interface InsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
  rpc?: never;
}
interface Db {
  from(table: string): Table;
  rpc<T = unknown>(fn: string, args: Row): Thenable<T>;
}
const db = (client: unknown): Db => client as unknown as Db;

const RECORDS = "hq_application_records";
const RPC = "hq_record_application";

/** A sanctioned authority whose boundary always succeeds (a test stand-in for the CEO cut-over). */
function liveAuthority(): ApplyAuthority & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(item: ApprovedItem): (() => Promise<ExecutionOutcome>) | null {
      return async (): Promise<ExecutionOutcome> => {
        calls.push(item.id);
        return { status: "applied", label: item.descriptor.type, result: { applied: item.id } };
      };
    },
  };
}

const createdApprovalIds: string[] = [];
const createdEmployeeIds: string[] = [];
const createdReviewerIds: string[] = [];

afterAll(async () => {
  const svc = db(serviceClient());
  if (createdApprovalIds.length) {
    await svc.from("hq_approvals").delete().in("id", createdApprovalIds);
  }
  if (createdEmployeeIds.length) {
    await svc.from("ai_employees").delete().in("id", createdEmployeeIds);
  }
  for (const rid of createdReviewerIds) {
    await serviceClient().auth.admin.deleteUser(rid); // cascades to the mirrored public.users row
  }
});

/** Mint an auth user + mirror it into public.users (reviewer_id's FK), returning the reviewer. */
async function mintReviewer(): Promise<{ id: string; email: string }> {
  const svc = serviceClient();
  const email = `apply-it-rev-${Date.now()}-${crypto.randomUUID().slice(0, 6)}@probe.crewflow.test`;
  const created = await svc.auth.admin.createUser({ email, password: `Pw!${crypto.randomUUID()}`, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id;
  if (!id) throw new Error("could not mint the reviewer auth user");
  createdReviewerIds.push(id);
  const mirrored = await db(svc).from("users").insert({ id, email }).select("id");
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  return { id, email };
}

/** Mint an AI employee (hq_approvals.ai_employee_id is a NOT NULL FK) and return its id. */
async function mintEmployee(): Promise<string> {
  const svc = db(serviceClient());
  const slug = `apply-it-${crypto.randomUUID().slice(0, 8)}`;
  const ins = await svc
    .from("ai_employees")
    .insert({ slug, name: "Apply IT", role: "outreach", department: "operations", status: "idle" })
    .select("id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = String((ins.data ?? [])[0]?.id);
  createdEmployeeIds.push(id);
  return id;
}

/** Insert a pending approval and drive it to `approved` through the trigger. Returns the row. */
async function seedApprovedApproval(
  employeeId: string,
  reviewer: { id: string; email: string },
): Promise<Row> {
  const svc = db(serviceClient());
  const ins = await svc
    .from("hq_approvals")
    .insert({
      ai_employee_id: employeeId,
      subject_type: "outreach_email",
      subject_id: crypto.randomUUID(),
      action: "send",
      proposed_payload: { body: "hello" },
    })
    .select("id, correlation_id");
  expect(ins.error, ins.error?.message).toBeNull();
  const id = String((ins.data ?? [])[0]?.id);
  createdApprovalIds.push(id);
  const upd = await svc
    .from("hq_approvals")
    .update({ state: "approved", reviewer_id: reviewer.id, reviewer_email: reviewer.email })
    .eq("id", id);
  expect(upd.error, upd.error?.message).toBeNull();
  const read = await svc.from("hq_approvals").select("id, state, correlation_id").eq("id", id);
  return (read.data ?? [])[0]!;
}

describeIntegration("Apply-on-approval durable store · hq_application_records", () => {
  const identity = (approvalId: string): Extract<ExecutionIdentity, { source: "approval" }> => ({
    source: "approval",
    correlationId: crypto.randomUUID(),
    approvalId,
    toolLabel: "send",
    actionId: `outreach_email:${approvalId}:send`,
  });

  it("service_role persists an applied marker and reads it back (round-trip)", async () => {
    const store = createDurableApplicationStore();
    const id = identity(crypto.randomUUID());
    const key = deriveIdempotencyKey(id);
    await store.put(
      appliedRecord({ key, identity: id, label: "send", result: { ok: true }, approver: { approverId: "rev-1", approverEmail: "r@crewflow.uk" } }),
    );
    const got = await store.get(key);
    expect(got?.status).toBe("applied");
    expect(got?.key).toBe(key);
    expect(got?.identity.source).toBe("approval");
    expect(got?.approver?.approverEmail).toBe("r@crewflow.uk");
  });

  it("get returns the LATEST row under a key (append-only, latest-wins)", async () => {
    const store = createDurableApplicationStore();
    const id = identity(crypto.randomUUID());
    const key = deriveIdempotencyKey(id);
    // A failed attempt, then a successful one — both rows persist; get() sees the latest.
    await db(serviceClient()).rpc(RPC, {
      p_key: key, p_status: "failed", p_source: "approval", p_correlation_id: id.correlationId,
      p_tool_label: "send", p_action_id: id.actionId, p_approval_id: id.approvalId, p_attempts: 1,
      p_escalated: false, p_error: "boom",
    });
    await store.put(appliedRecord({ key, identity: id, label: "send", result: { ok: true }, attempts: 2 }));
    const got = await store.get(key);
    expect(got?.status).toBe("applied");
    expect(got?.attempts).toBe(2);
    // Both rows are on the permanent record.
    const rows = await db(serviceClient()).from(RECORDS).select("id").eq("key", key);
    expect(rows.data).toHaveLength(2);
  });

  it("the CHECK rejects a non-application status — the table cannot hold a shadow outcome", async () => {
    const bad = await db(serviceClient()).rpc(RPC, {
      p_key: `k-${crypto.randomUUID()}`, p_status: "planned", p_source: "approval",
      p_correlation_id: crypto.randomUUID(), p_tool_label: "send", p_action_id: "a",
    });
    expect(bad.error, "a shadow outcome must be rejected by the status CHECK").not.toBeNull();
  });

  it("anon cannot read the table nor call the write RPC — RLS:hq + service_role-only EXECUTE", async () => {
    const store = createDurableApplicationStore();
    const id = identity(crypto.randomUUID());
    const key = deriveIdempotencyKey(id);
    await store.put(appliedRecord({ key, identity: id, label: "send", result: {} }));

    const asAnon = await db(anonClient()).from(RECORDS).select("id").eq("key", key);
    if (!asAnon.error) expect(asAnon.data ?? []).toHaveLength(0);

    const anonWrite = await db(anonClient()).rpc(RPC, {
      p_key: key, p_status: "applied", p_source: "approval", p_correlation_id: id.correlationId,
      p_tool_label: "send", p_action_id: id.actionId,
    });
    expect(anonWrite.error, "anon must not be able to record application markers").not.toBeNull();
  });

  it("the store is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const store = createDurableApplicationStore();
    const id = identity(crypto.randomUUID());
    const key = deriveIdempotencyKey(id);
    await store.put(appliedRecord({ key, identity: id, label: "send", result: {} }));

    const upd = await db(serviceClient()).from(RECORDS).update({ error: "tampered" }).eq("key", key);
    expect(upd.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();
    const del = await db(serviceClient()).from(RECORDS).delete().eq("key", key);
    expect(del.error, "DELETE must be blocked by the append-only guard").not.toBeNull();
  });
});

describeIntegration("Apply-on-approval drain · approved-only, exactly-once, over real approvals", () => {
  it("reads ONLY approved approvals and applies each exactly once; a re-run is idempotent", async () => {
    const employeeId = await mintEmployee();
    const reviewer = await mintReviewer();
    const approved = await seedApprovedApproval(employeeId, reviewer);
    const approvedId = String(approved.id);

    // A pending approval under the same employee — it must NOT be swept.
    const svc = db(serviceClient());
    const pendingIns = await svc
      .from("hq_approvals")
      .insert({ ai_employee_id: employeeId, subject_type: "outreach_email", subject_id: crypto.randomUUID(), action: "send", proposed_payload: {} })
      .select("id");
    const pendingId = String((pendingIns.data ?? [])[0]?.id);
    createdApprovalIds.push(pendingId);

    const store = createDurableApplicationStore();
    const authority = liveAuthority();
    const deps = { env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" }, store, authority, limit: 500 };

    const first = await runApplyOnApprovalDrain(deps);
    expect(first.enabled).toBe(true);
    // Our approved row was applied; the pending one was never even loaded.
    expect(authority.calls).toContain(approvedId);
    expect(authority.calls).not.toContain(pendingId);
    const appliedForOurs = authority.calls.filter((c) => c === approvedId);
    expect(appliedForOurs).toHaveLength(1);

    // A second sweep re-applies nothing for our item (idempotent via the durable marker).
    const before = authority.calls.filter((c) => c === approvedId).length;
    const second = await runApplyOnApprovalDrain(deps);
    expect(second.enabled).toBe(true);
    const after = authority.calls.filter((c) => c === approvedId).length;
    expect(after, "the approved item must not cross the boundary twice").toBe(before);
  });

  it("kill-switch OFF against the live DB is a total no-op — nothing applied", async () => {
    const employeeId = await mintEmployee();
    const reviewer = await mintReviewer();
    await seedApprovedApproval(employeeId, reviewer);
    const authority = liveAuthority();
    const summary = await runApplyOnApprovalDrain({
      env: {}, // default-off
      store: createDurableApplicationStore(),
      authority,
    });
    expect(summary.enabled).toBe(false);
    expect(summary.swept).toBe(0);
    expect(authority.calls).toHaveLength(0);
  });
});
