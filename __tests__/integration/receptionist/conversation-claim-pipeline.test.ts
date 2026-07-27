import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work CLAIM pipeline — real-Postgres proof of the AI Receptionist Programme R46 (CONVERSATION WORK
 * CLAIM): the FIRST layer in the whole engine stack that lets a HUMAN OPERATOR WRITE. R37–R45 built the READ spine
 * over recorded coordinations (Read Model → … → Detail Surface); every one of those layers only LISTS and INSPECTS.
 * R46 records that an operator has taken OWNERSHIP of one Conversation Worklist item — and does nothing else.
 *
 * The unit tier proves the pure core resolves a claim DECISION deterministically and ONLY for a well-formed request;
 * the security tier proves, as SOURCE, that the ledger is append-only, service-role-only, deterministic, that the
 * Coordination Engine stays authoritative, that organisation isolation is structural, and that NO execution path is
 * introduced. This tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME `claimConversationWork`
 * actually files a claim against a REAL coordination over a live database, exactly one conflict-guarded, append-only
 * claim row is really written, and the migration's storage / RLS / append-only guard / privilege model / vocabulary
 * CHECKs / fold CHECK / and — the R46 keystones — the CONFLICT KEY and the COORDINATION-AUTHORITY + ORGANISATION-
 * ISOLATION guard all hold in Postgres. The load-bearing R46 claims are proven here:
 *
 *   • THE RUNTIME RECORDS THE CLAIM — driven through the real `claimConversationWork` (not the RPC directly): given a
 *     seeded coordination and an authenticated operator, it files EXACTLY ONE claim row — threaded to the coordination
 *     it is filed against, the operator who took it (id + denormalised email), the organisation, the conversation and
 *     the correlation trace — with its `claim_type`/`claim_outcome` pinned to the fold, its `status` pinned to
 *     'claimed', and a recorded `claimed_at` timestamp. The runtime's returned handle IS the stored row.
 *   • CONFLICTING ACTIVE CLAIMS ARE PREVENTED — a DIFFERENT operator claiming an already-owned item is refused
 *     (`already_claimed`, nothing written); the SAME operator re-claiming is idempotent (`claimed`, the STABLE id, no
 *     second row). Two operators can never both hold the same item.
 *   • THE COORDINATION ENGINE REMAINS AUTHORITATIVE — a claim against a coordination that does not exist is refused
 *     (`unavailable`, nothing written). The runtime invents no work item.
 *   • ORGANISATION ISOLATION IS STRUCTURAL — org B naming org A's coordination is refused at the storage layer
 *     (`unavailable`, nothing written): the guard demands the coordination belong to the CLAIMING organisation. A
 *     cross-tenant claim is impossible, not merely disallowed by discipline.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role, so the audit of who claimed
 *     what, and when, can never be silently rewritten or erased.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, or call the write primitive.
 *   • THE VOCABULARY, THE FOLD, THE OPERATOR IDENTITY AND THE COORDINATION AUTHORITY ARE PINNED — a claim type/outcome
 *     outside its set, a status other than 'claimed', a null operator/org/coordination, or a coordination absent from
 *     the claiming organisation is rejected, so a stored row can never misrepresent a taking of ownership.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. The claim ledger is append-only (even service_role cannot DELETE), so these tests intentionally
 * leave their rows behind — harmless in the ephemeral CI database, and proving exactly that is one of the tests below.
 * Rows are addressed by a per-call coordination id so each assertion sees only its own writes.
 */

// receptionist_conversation_claims / record_receptionist_conversation_claim are service-role-only internals, NOT in
// the generated Database types. Cast to the minimal surface this suite exercises (the same `as unknown as` convention
// the fulfilment / coordination suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type ClaimTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ClaimClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ClaimTable;
};

const TABLE = "receptionist_conversation_claims";
const RPC = "record_receptionist_conversation_claim";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): ClaimClient => serviceClient() as unknown as ClaimClient;
const anon = (): ClaimClient => anonClient() as unknown as ClaimClient;

// The columns every assertion below reads back — the full captured claim record.
const COLUMNS =
  "id, org_id, coordination_id, conversation_id, correlation_id, operator_id, operator_email, " +
  "claim_type, claim_outcome, status, metadata, claimed_at, created_at";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

/** A valid direct-insert row (every NOT NULL column present, every field well-formed) — used ONLY for the append-only,
 *  anon-denial and column-CHECK negative cases (a direct insert bypasses the RPC's coordination-authority guard, so a
 *  random coordination id is fine here). */
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  coordination_id: crypto.randomUUID(),
  operator_id: crypto.randomUUID(),
  claim_type: "claim_conversation_work",
  claim_outcome: "work_claimed",
});

/** A valid RPC payload — spread and overridden per rejection case. `coordinationId`/`orgId` name the coordination the
 *  claim is filed against (a real one for the positive path; a random one is fine for the pre-guard vocabulary/NULL
 *  cases, which are rejected BEFORE the coordination-authority guard runs). */
const validRpcArgs = (coordinationId: string, orgId: string) => ({
  p_org_id: orgId,
  p_coordination_id: coordinationId,
  p_operator_id: crypto.randomUUID(),
  p_claim_type: "claim_conversation_work",
  p_claim_outcome: "work_claimed",
  p_operator_email: "op@crewflow.uk",
  p_conversation_id: crypto.randomUUID(),
  p_correlation_id: crypto.randomUUID(),
  p_metadata: {},
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the deterministic fold
 * of the eligibility they are recorded with — a genuine composition of R28 execution + R29 authorisation, never a
 * hand-forged decision.
 */
function authorise(verdict: GuardrailVerdict, live: boolean): ApproveBookingAuthorisation {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  const a = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(a)) throw new Error("test setup: expected a decided authorisation");
  return a;
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route. */
async function governThroughStack(opts: { orgId: string; reviewAuditId: string }): Promise<void> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: crypto.randomUUID(),
    customer_ref: CALLER,
    correlation_id: crypto.randomUUID(),
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  const fulfilled = await fulfilApprovedBooking({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(fulfilled, "R30 performed the approved booking").not.toBeNull();

  await verifyApprovedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await recoverVerifiedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await resolveConversationCompletion({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const governed = await governConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(governed, "the resolved conversation's lifecycle was governed").not.toBeNull();
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item R46 claims. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
}): Promise<{ coordinationId: string }> {
  await governThroughStack(opts);
  await orchestrateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const coordinated = await coordinateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
  if (!coordinated) throw new Error("test setup: expected a coordination to be filed");
  return { coordinationId: coordinated.coordination_id };
}

/** Read every claim row filed against one coordination id, as service_role (ground truth). */
function rowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("coordination_id", coordinationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Work Claim pipeline · receptionist_conversation_claims (R46)", () => {
  it("claimConversationWork RECORDS the claim — files EXACTLY ONE row threaded to the coordination, operator and org", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // THE OPERATOR TAKES OWNERSHIP — driven through the real runtime, exactly as an authenticated operator action would.
    const result = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
      conversation_id: conversationId,
      correlation_id: correlationId,
    });
    expect(result.resolution).toBe("claimed");
    if (result.resolution !== "claimed") throw new Error("expected a recorded claim");
    expect(result.claim.coordination_id).toBe(coordinationId);
    expect(result.claim.operator_id).toBe(OPERATOR_A.id);
    expect(result.claim.claim_type).toBe("claim_conversation_work");
    expect(result.claim.claim_outcome).toBe("work_claimed");

    // EXACTLY ONE row — not zero (unrecorded), not two (double-claimed).
    const read = await rowsForCoordination(coordinationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The runtime's returned handle is the real stored row.
    expect(row.id).toBe(result.claim.claim_id);
    // WHERE it is scoped, and WHAT it is filed against — the coordination is the load-bearing anchor.
    expect(row.org_id).toBe(orgId);
    expect(row.coordination_id).toBe(coordinationId);
    // The optional provenance threaded onto the audit row.
    expect(row.conversation_id).toBe(conversationId);
    expect(row.correlation_id).toBe(correlationId);
    // WHO took it — the operator's id + denormalised email (attributable even without a tenant-membership row).
    expect(row.operator_id).toBe(OPERATOR_A.id);
    expect(row.operator_email).toBe(OPERATOR_A.email);
    // WHAT was claimed, folded deterministically, and HELD by construction.
    expect(row.claim_type).toBe("claim_conversation_work");
    expect(row.claim_outcome).toBe("work_claimed");
    expect(row.status).toBe("claimed");
    // WHEN — the claim records its timestamp.
    expect(typeof row.claimed_at).toBe("string");
    expect((row.claimed_at as string).length).toBeGreaterThan(0);
  });

  it("PREVENTS conflicting active claims — a different operator is refused, the same operator is idempotent", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // OPERATOR A takes the claim.
    const first = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(first.resolution).toBe("claimed");
    if (first.resolution !== "claimed") throw new Error("expected the first claim to be recorded");

    // OPERATOR B attempts the SAME item — refused. The conflict key (unique coordination_id) + ON CONFLICT DO NOTHING
    // means nothing is written; the existing owner is a different operator, so the runtime reports `already_claimed`.
    const contested = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_B });
    expect(contested.resolution).toBe("already_claimed");

    // Still exactly one row, still owned by A — B wrote nothing.
    const afterContest = await rowsForCoordination(coordinationId);
    expect(afterContest.data).toHaveLength(1);
    expect(afterContest.data?.[0]?.id).toBe(first.claim.claim_id);
    expect(afterContest.data?.[0]?.operator_id).toBe(OPERATOR_A.id);

    // OPERATOR A re-claims (a retried operator action) — idempotent: the SAME id, no second row.
    const reclaim = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(reclaim.resolution).toBe("claimed");
    if (reclaim.resolution !== "claimed") throw new Error("expected the idempotent re-claim to resolve");
    expect(reclaim.claim.claim_id).toBe(first.claim.claim_id);

    const afterReclaim = await rowsForCoordination(coordinationId);
    expect(afterReclaim.data).toHaveLength(1);
    expect(afterReclaim.data?.[0]?.id).toBe(first.claim.claim_id);
  });

  it("keeps the COORDINATION ENGINE authoritative — a claim against an unknown coordination is refused", async () => {
    const orgId = crypto.randomUUID();
    // No coordination is seeded — this id names no recorded coordination.
    const result = await claimConversationWork({
      org_id: orgId,
      coordination_id: crypto.randomUUID(),
      operator: OPERATOR_A,
    });
    // The storage-layer coordination-authority guard refuses; the runtime reports `unavailable` (best-effort, no throw).
    expect(result.resolution).toBe("unavailable");
  });

  it("preserves ORGANISATION ISOLATION — org B cannot claim org A's coordination", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

    // org B names org A's coordination. The guard demands the coordination belong to the CLAIMING org — it does not,
    // so the claim is refused at the storage layer and NOTHING is written. Isolation is structural.
    const cross = await claimConversationWork({ org_id: orgB, coordination_id: coordinationId, operator: OPERATOR_B });
    expect(cross.resolution).toBe("unavailable");
    const afterCross = await rowsForCoordination(coordinationId);
    expect(afterCross.data ?? [], "org B wrote no claim against org A's coordination").toHaveLength(0);

    // org A, the owner, CAN claim its own coordination.
    const own = await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(own.resolution).toBe("claimed");
    const afterOwn = await rowsForCoordination(coordinationId);
    expect(afterOwn.data).toHaveLength(1);
    expect(afterOwn.data?.[0]?.org_id).toBe(orgA);
  });

  it("the write primitive is idempotent on the coordination and refuses a different operator (direct RPC)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const operatorId = crypto.randomUUID();

    // First claim — the primitive files the row and returns its id.
    const first = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: operatorId,
    });
    expect(first.error, first.error?.message).toBeNull();
    expect(first.data, "the primitive returns the claim id").toBeTruthy();

    // The SAME operator re-claims — ON CONFLICT (coordination_id) returns the existing id, files no second row.
    const same = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: operatorId,
    });
    expect(same.error, same.error?.message).toBeNull();
    expect(same.data).toBe(first.data);

    // A DIFFERENT operator is refused — the primitive returns NULL (the conflict), writing nothing.
    const other = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: crypto.randomUUID(),
    });
    expect(other.error, other.error?.message).toBeNull();
    expect(other.data, "a different operator's claim is refused with NULL").toBeNull();

    // Exactly one row survives, owned by the first operator.
    const read = await rowsForCoordination(coordinationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(first.data);
    expect(read.data?.[0]?.operator_id).toBe(operatorId);
    expect(read.data?.[0]?.status).toBe("claimed");
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const row = validInsertRow();
    const filed = await svc().from(TABLE).insert(row).select("id");
    expect(filed.error, filed.error?.message).toBeNull();
    const coordinationId = row.coordination_id;

    // A claim can never be rewritten…
    const updated = await svc().from(TABLE).update({ status: "claimed" }).eq("coordination_id", coordinationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TABLE).delete().eq("coordination_id", coordinationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await rowsForCoordination(coordinationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.operator_id).toBe(row.operator_id);
    expect(read.data?.[0]?.status).toBe("claimed");
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write primitive", async () => {
    const row = validInsertRow();
    await svc().from(TABLE).insert(row);
    const coordinationId = row.coordination_id;

    // service_role (BYPASSRLS) sees the row…
    const asService = await rowsForCoordination(coordinationId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny).
    expectAnonDenied(await anon().from(TABLE).select("id").eq("coordination_id", coordinationId));

    // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
    const anonWrite = await anon().rpc<string>(RPC, validRpcArgs(crypto.randomUUID(), crypto.randomUUID()));
    expect(anonWrite.error, "anon must not be able to record a claim").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert(validInsertRow());
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the vocabulary, the operator identity and the coordination authority", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // A claim type outside {claim_conversation_work} is rejected by the RPC's validation (before the coordination guard).
    const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_claim_type: "release_conversation_work" });
    expect(badType.error, "a claim type outside the vocabulary must be rejected").not.toBeNull();

    // An outcome outside {work_claimed} is rejected.
    const badOutcome = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_claim_outcome: "work_released" });
    expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

    // The org / coordination / operator are MANDATORY — a null in any is rejected.
    const noOperator = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_operator_id: null });
    expect(noOperator.error, "a claim with no operator must be rejected").not.toBeNull();
    const noOrg = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_org_id: null });
    expect(noOrg.error, "a claim with no organisation must be rejected").not.toBeNull();
    const noCoordination = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_coordination_id: null });
    expect(noCoordination.error, "a claim with no coordination must be rejected").not.toBeNull();

    // COORDINATION AUTHORITY: an otherwise-valid claim against a coordination that does not exist in the org is refused.
    const unknownCoordination = await svc().rpc<string>(RPC, validRpcArgs(crypto.randomUUID(), orgId));
    expect(unknownCoordination.error, "a claim naming no coordination in the org must be rejected").not.toBeNull();

    // The column CHECKs pin the same vocabulary on a direct service_role insert — the fold and status cannot be forged.
    const badTypeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), claim_type: "release_conversation_work" });
    expect(badTypeInsert.error, "a claim type CHECK rejects an out-of-vocabulary type, even for service_role").not.toBeNull();
    const badOutcomeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), claim_outcome: "work_released" });
    expect(badOutcomeInsert.error, "a claim outcome CHECK rejects an out-of-vocabulary outcome").not.toBeNull();
    const badStatusInsert = await svc().from(TABLE).insert({ ...validInsertRow(), status: "released" });
    expect(badStatusInsert.error, "a status other than 'claimed' must be rejected by the CHECK").not.toBeNull();
  });
});
