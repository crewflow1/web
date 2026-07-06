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
import { releaseConversationWork } from "@/server/services/receptionist-release";
import {
  getOwnership,
  getOwnershipHistory,
  getOwnershipSummary,
} from "@/server/services/receptionist-ownership-read-model";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work RELEASE pipeline — real-Postgres proof of the AI Receptionist Programme R50 (CONVERSATION WORK
 * RELEASE): the FIRST governed RELINQUISH, the only authorised mechanism for an operator to give an owned Conversation
 * Worklist item back to the unclaimed state. R46 made ownership a one-way door (claim, never release); R50 is the door's
 * other side. The unit tier proves the pure core resolves a release DECISION for a well-formed request only; the
 * security tier proves, as SOURCE, that the release ledger is append-only, service-role-only, deterministic, that the
 * Claim Engine stays authoritative, that organisation isolation is structural, and that NO execution path is
 * introduced. This tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME `releaseConversationWork`
 * files a release against a REAL claimed coordination over a live database, exactly one ownership-guarded, append-only
 * release row is written, the R48 read model returns the item to the unclaimed state, the append-only CLAIM ledger is
 * untouched, and the migration's storage / RLS / append-only guard / privilege model / vocabulary + fold CHECKs / and —
 * the R50 keystones — the CONFLICT KEY, the COORDINATION-AUTHORITY + ORGANISATION-ISOLATION gate and the OWNERSHIP gate
 * all hold in Postgres. The load-bearing R50 claims are proven here:
 *
 *   • THE RUNTIME RECORDS THE RELEASE AND RETURNS THE ITEM TO UNCLAIMED — driven through the real
 *     `releaseConversationWork` (not the RPC directly): given a claimed coordination and its owning operator, it files
 *     EXACTLY ONE release row — threaded to the coordination, the claim it undoes, the operator, the org, the
 *     conversation and the correlation trace — with `release_type`/`release_outcome` pinned to the fold, `status` pinned
 *     to 'released', and a `released_at` timestamp; and the R48 read model then reads the coordination as UNOWNED.
 *   • INVALID RELEASES ARE PREVENTED — an item with NO active claim is refused (`not_owned`, nothing written); an item
 *     held by a DIFFERENT operator is refused (`not_owned`, nothing written). You can only release what you hold.
 *   • THE CLAIM RUNTIME REMAINS AUTHORITATIVE — a release NEVER mutates or deletes the claim row: the claim ledger is
 *     unchanged after a release; the read model derives "unowned" from the presence of a release, not by rewriting the
 *     claim. The idempotent re-release by the owner returns the STABLE id and writes no second row.
 *   • ORGANISATION ISOLATION IS STRUCTURAL — org B naming org A's coordination is refused at the storage layer
 *     (`unavailable`, nothing written): the guard demands the coordination belong to the RELEASING organisation.
 *   • THE LEDGER IS APPEND-ONLY (UPDATE/DELETE rejected even for service_role), SERVICE-ROLE-ONLY (RLS:hq — anon cannot
 *     read it, insert into it, or call the write primitive), and its VOCABULARY, FOLD, OPERATOR IDENTITY and
 *     COORDINATION AUTHORITY are pinned by CHECKs + the guard, so a stored row can never misrepresent a relinquish.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. Both ledgers are append-only, so these tests intentionally leave their rows behind; each
 * assertion uses a FRESH random org id and addresses rows by a per-call coordination id so it sees only its own writes.
 */

// receptionist_conversation_claim_releases / record_receptionist_conversation_claim_release are service-role-only
// internals, NOT in the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the claim / fulfilment suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type LedgerTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type LedgerClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): LedgerTable;
};

const TABLE = "receptionist_conversation_claim_releases";
const CLAIM_TABLE = "receptionist_conversation_claims";
const RPC = "record_receptionist_conversation_claim_release";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;
const anon = (): LedgerClient => anonClient() as unknown as LedgerClient;

// The columns every assertion below reads back — the full captured release record.
const COLUMNS =
  "id, org_id, coordination_id, claim_id, conversation_id, correlation_id, operator_id, operator_email, " +
  "release_type, release_outcome, status, metadata, released_at, created_at";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

/** A valid direct-insert row (every NOT NULL column present, every field well-formed) — used ONLY for the append-only,
 *  anon-denial and column-CHECK negative cases (a direct insert bypasses the RPC's coordination + ownership guards, so
 *  random coordination / claim ids are fine here). */
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  coordination_id: crypto.randomUUID(),
  claim_id: crypto.randomUUID(),
  operator_id: crypto.randomUUID(),
  release_type: "release_conversation_work",
  release_outcome: "work_released",
});

/** A valid RPC payload — spread and overridden per rejection case. `coordinationId`/`orgId` name the coordination the
 *  release is filed against (a real, claimed one for the positive path; a random one is fine for the pre-guard
 *  vocabulary/NULL cases, which are rejected BEFORE the coordination-authority guard runs). */
const validRpcArgs = (coordinationId: string, orgId: string) => ({
  p_org_id: orgId,
  p_coordination_id: coordinationId,
  p_operator_id: crypto.randomUUID(),
  p_release_type: "release_conversation_work",
  p_release_outcome: "work_released",
  p_operator_email: "op@crewflow.uk",
  p_conversation_id: crypto.randomUUID(),
  p_correlation_id: crypto.randomUUID(),
  p_metadata: {},
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the deterministic fold
 * of the eligibility they are recorded with — a genuine composition of R28 execution + R29 authorisation.
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item R46 claims and R50 releases. */
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

/** Seed a coordination AND record OPERATOR_A's claim on it — the owned item R50 releases. */
async function seedClaimed(orgId: string): Promise<{ coordinationId: string; claimId: string }> {
  const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
  const claimed = await claimConversationWork({
    org_id: orgId,
    coordination_id: coordinationId,
    operator: OPERATOR_A,
  });
  expect(claimed.resolution).toBe("claimed");
  if (claimed.resolution !== "claimed") throw new Error("test setup: expected a recorded claim");
  return { coordinationId, claimId: claimed.claim.claim_id };
}

/** Read every RELEASE row filed against one coordination id, as service_role (ground truth). */
function rowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("coordination_id", coordinationId);
}

/** Read every CLAIM row filed against one coordination id, as service_role — the R46 ledger R50 must never touch. */
function claimRowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(CLAIM_TABLE).select("id, operator_id, status").eq("coordination_id", coordinationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Work Release pipeline · receptionist_conversation_claim_releases (R50)", () => {
  it("releaseConversationWork RECORDS the release — files EXACTLY ONE row and returns the item to the unclaimed state", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const { coordinationId, claimId } = await seedClaimed(orgId);

    // Before the release, the read model reads the coordination OWNED.
    expect((await getOwnership({ org_id: orgId, coordination_id: coordinationId })).owned).toBe(true);

    // THE OPERATOR RELINQUISHES OWNERSHIP — driven through the real runtime, exactly as an authenticated operator action.
    const released = await releaseConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
      conversation_id: conversationId,
      correlation_id: correlationId,
    });
    expect(released.resolution).toBe("released");
    if (released.resolution !== "released") throw new Error("expected a recorded release");
    expect(released.release.coordination_id).toBe(coordinationId);
    expect(released.release.operator_id).toBe(OPERATOR_A.id);
    expect(released.release.release_type).toBe("release_conversation_work");
    expect(released.release.release_outcome).toBe("work_released");

    // EXACTLY ONE release row — not zero (unrecorded), not two (double-released).
    const read = await rowsForCoordination(coordinationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The runtime's returned handle is the real stored row.
    expect(row.id).toBe(released.release.release_id);
    // WHERE it is scoped, and WHAT it is filed against — the coordination is the load-bearing anchor.
    expect(row.org_id).toBe(orgId);
    expect(row.coordination_id).toBe(coordinationId);
    // Threaded to the exact CLAIM it undoes (resolved by the primitive from the R46 ledger).
    expect(row.claim_id).toBe(claimId);
    // The optional provenance threaded onto the audit row.
    expect(row.conversation_id).toBe(conversationId);
    expect(row.correlation_id).toBe(correlationId);
    // WHO relinquished it — the operator's id + denormalised email.
    expect(row.operator_id).toBe(OPERATOR_A.id);
    expect(row.operator_email).toBe(OPERATOR_A.email);
    // WHAT was released, folded deterministically, and HELD by construction.
    expect(row.release_type).toBe("release_conversation_work");
    expect(row.release_outcome).toBe("work_released");
    expect(row.status).toBe("released");
    // WHEN — the release records its timestamp.
    expect(typeof row.released_at).toBe("string");
    expect((row.released_at as string).length).toBeGreaterThan(0);

    // THE READ MODEL RETURNS THE ITEM TO THE UNCLAIMED STATE — the R48 reader now reads it UNOWNED.
    const record = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
    expect(record.status).toBe("unowned");
    expect(record.owned).toBe(false);
    expect(record.owner).toBeNull();
    expect(record.claimedAt).toBeNull();

    // THE CLAIM RUNTIME REMAINS AUTHORITATIVE — the append-only claim row is UNCHANGED. The read model derives
    // "unowned" from the presence of a release; it never mutates or deletes the claim.
    const claimRows = await claimRowsForCoordination(coordinationId);
    expect(claimRows.data).toHaveLength(1);
    expect(claimRows.data?.[0]?.operator_id).toBe(OPERATOR_A.id);
    expect(claimRows.data?.[0]?.status).toBe("claimed");
  });

  it("returns a released item to the unclaimed state across ALL THREE read seams — owner, history and summary", async () => {
    const orgId = crypto.randomUUID();
    const one = await seedClaimed(orgId);
    const two = await seedClaimed(orgId);

    // Both owned — history lists two events, the summary counts two.
    expect(await getOwnershipHistory({ org_id: orgId })).toHaveLength(2);
    expect((await getOwnershipSummary({ org_id: orgId })).totalClaims).toBe(2);

    // Release exactly ONE of them.
    expect(
      (await releaseConversationWork({ org_id: orgId, coordination_id: one.coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("released");

    // OWNER seam — the released one is unowned; the other is still owned.
    expect((await getOwnership({ org_id: orgId, coordination_id: one.coordinationId })).owned).toBe(false);
    expect((await getOwnership({ org_id: orgId, coordination_id: two.coordinationId })).owned).toBe(true);

    // HISTORY seam — only the still-owned coordination remains a current ownership event.
    const history = await getOwnershipHistory({ org_id: orgId });
    expect(history).toHaveLength(1);
    expect(history[0]?.coordinationId).toBe(two.coordinationId);

    // SUMMARY seam — the released item counts toward no tally.
    const summary = await getOwnershipSummary({ org_id: orgId });
    expect(summary.totalClaims).toBe(1);
    expect(summary.distinctOwners).toBe(1);
    expect(summary.owners).toHaveLength(1);
    expect(summary.owners[0]?.operatorId).toBe(OPERATOR_A.id);
    expect(summary.owners[0]?.claimCount).toBe(1);
  });

  it("PREVENTS an invalid release — an item with NO active claim is refused (not_owned), nothing written", async () => {
    const orgId = crypto.randomUUID();
    // A seeded-but-unclaimed coordination — there is no claim to release.
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    const released = await releaseConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(released.resolution).toBe("not_owned");

    // Nothing was written.
    expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);
  });

  it("PREVENTS an invalid release — a DIFFERENT operator cannot release an item held by someone else (not_owned)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedClaimed(orgId); // OPERATOR_A holds it

    // OPERATOR B attempts to release A's item — the ownership gate refuses, writing nothing.
    const released = await releaseConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_B,
    });
    expect(released.resolution).toBe("not_owned");
    expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

    // A still owns it — the read model is unchanged.
    expect((await getOwnership({ org_id: orgId, coordination_id: coordinationId })).owner?.operatorId).toBe(
      OPERATOR_A.id,
    );
  });

  it("preserves ORGANISATION ISOLATION — org B cannot release org A's coordination (unavailable), nothing written", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedClaimed(orgA); // OPERATOR_A holds it under org A

    // org B names org A's coordination. The guard demands the coordination belong to the RELEASING org — it does not,
    // so the release is refused at the storage layer and NOTHING is written. Isolation is structural.
    const cross = await releaseConversationWork({
      org_id: orgB,
      coordination_id: coordinationId,
      operator: OPERATOR_B,
    });
    expect(cross.resolution).toBe("unavailable");
    expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);
    // org A still owns its item.
    expect((await getOwnership({ org_id: orgA, coordination_id: coordinationId })).owned).toBe(true);

    // org A, the owner, CAN release its own coordination.
    const own = await releaseConversationWork({
      org_id: orgA,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(own.resolution).toBe("released");
    expect((await getOwnership({ org_id: orgA, coordination_id: coordinationId })).owned).toBe(false);
  });

  it("is idempotent — the same operator re-releasing returns the STABLE id and writes no second row", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedClaimed(orgId);

    const first = await releaseConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(first.resolution).toBe("released");
    if (first.resolution !== "released") throw new Error("expected the first release to be recorded");

    // The SAME operator re-releases (a retried operator action) — idempotent: the SAME id, no second row.
    const again = await releaseConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(again.resolution).toBe("released");
    if (again.resolution !== "released") throw new Error("expected the idempotent re-release to resolve");
    expect(again.release.release_id).toBe(first.release.release_id);

    const read = await rowsForCoordination(coordinationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(first.release.release_id);
  });

  it("the write primitive enforces the OWNERSHIP gate and is idempotent (direct RPC)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedClaimed(orgId); // OPERATOR_A holds it

    // A DIFFERENT operator is refused — the primitive returns NULL (no error), writing nothing.
    const other = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: crypto.randomUUID(),
    });
    expect(other.error, other.error?.message).toBeNull();
    expect(other.data, "a non-owner's release is refused with NULL").toBeNull();
    expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

    // The OWNER releases — the primitive files the row and returns its id.
    const owner = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: OPERATOR_A.id,
    });
    expect(owner.error, owner.error?.message).toBeNull();
    expect(owner.data, "the owner's release returns the release id").toBeTruthy();

    // The owner re-releases — ON CONFLICT (coordination_id) returns the existing id, files no second row.
    const idempotent = await svc().rpc<string>(RPC, {
      ...validRpcArgs(coordinationId, orgId),
      p_operator_id: OPERATOR_A.id,
    });
    expect(idempotent.error, idempotent.error?.message).toBeNull();
    expect(idempotent.data).toBe(owner.data);

    // Exactly one row survives.
    const read = await rowsForCoordination(coordinationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(owner.data);
    expect(read.data?.[0]?.operator_id).toBe(OPERATOR_A.id);
    expect(read.data?.[0]?.status).toBe("released");
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const row = validInsertRow();
    const filed = await svc().from(TABLE).insert(row).select("id");
    expect(filed.error, filed.error?.message).toBeNull();
    const coordinationId = row.coordination_id;

    // A release can never be rewritten…
    const updated = await svc().from(TABLE).update({ status: "released" }).eq("coordination_id", coordinationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TABLE).delete().eq("coordination_id", coordinationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await rowsForCoordination(coordinationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.operator_id).toBe(row.operator_id);
    expect(read.data?.[0]?.status).toBe("released");
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
    expect(anonWrite.error, "anon must not be able to record a release").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert(validInsertRow());
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the vocabulary, the fold, the operator identity and the coordination authority", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // A release type outside {release_conversation_work} is rejected by the RPC (before the coordination/ownership gate).
    const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_release_type: "claim_conversation_work" });
    expect(badType.error, "a release type outside the vocabulary must be rejected").not.toBeNull();

    // An outcome outside {work_released} is rejected.
    const badOutcome = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_release_outcome: "work_claimed" });
    expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

    // The org / coordination / operator are MANDATORY — a null in any is rejected.
    const noOperator = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_operator_id: null });
    expect(noOperator.error, "a release with no operator must be rejected").not.toBeNull();
    const noOrg = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_org_id: null });
    expect(noOrg.error, "a release with no organisation must be rejected").not.toBeNull();
    const noCoordination = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_coordination_id: null });
    expect(noCoordination.error, "a release with no coordination must be rejected").not.toBeNull();

    // COORDINATION AUTHORITY: an otherwise-valid release against a coordination absent from the org is refused (raises,
    // BEFORE the ownership gate) — a cross-tenant or phantom coordination can never be named.
    const unknownCoordination = await svc().rpc<string>(RPC, validRpcArgs(crypto.randomUUID(), orgId));
    expect(unknownCoordination.error, "a release naming no coordination in the org must be rejected").not.toBeNull();

    // The column CHECKs pin the same vocabulary on a direct service_role insert — the fold and status cannot be forged.
    const badTypeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), release_type: "claim_conversation_work" });
    expect(badTypeInsert.error, "a release type CHECK rejects an out-of-vocabulary type, even for service_role").not.toBeNull();
    const badOutcomeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), release_outcome: "work_claimed" });
    expect(badOutcomeInsert.error, "a release outcome CHECK rejects an out-of-vocabulary outcome").not.toBeNull();
    const badStatusInsert = await svc().from(TABLE).insert({ ...validInsertRow(), status: "claimed" });
    expect(badStatusInsert.error, "a status other than 'released' must be rejected by the CHECK").not.toBeNull();
  });
});
