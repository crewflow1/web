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
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import { getCoordinationOwnershipState } from "@/server/services/receptionist-ownership-state";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work REASSIGNMENT pipeline — real-Postgres proof of the AI Receptionist Programme R52 (CONVERSATION WORK
 * REASSIGNMENT): the FIRST governed TRANSFER, the only authorised mechanism for handing ownership of a Conversation
 * Worklist item from the operator who holds it to ANOTHER named operator. R46 made ownership a one-way door (claim), R50
 * gave it a release; R52 is the third door — the transfer. The unit tier proves the pure core resolves a reassignment
 * DECISION for a well-formed request only; the security tier proves, as SOURCE, that the reassignment ledger is
 * append-only, service-role-only, deterministic, that the Claim / Release / Ownership State engines stay authoritative,
 * that organisation isolation is structural, and that NO execution path is introduced. This tier proves the BEHAVIOUR
 * the mocks can't — that when the CANONICAL RUNTIME `reassignConversationWork` files a transfer against a REAL claimed
 * coordination over a live database, exactly one ownership-guarded, append-only reassignment row is written, ownership
 * genuinely moves to the new operator (the upgraded release writer now lets ONLY the new owner release), the append-only
 * CLAIM and RELEASE ledgers are untouched, and the migration's storage / RLS / append-only guard / privilege model /
 * vocabulary + fold + distinct-operators CHECKs / and — the R52 keystones — the CONFLICT KEY (request_id), the
 * COORDINATION-AUTHORITY + ORGANISATION-ISOLATION gate and the OWNERSHIP gate all hold in Postgres. The load-bearing R52
 * claims are proven here:
 *
 *   • THE RUNTIME RECORDS THE TRANSFER — driven through the real `reassignConversationWork` (not the RPC directly): given
 *     a claimed coordination held by A, a transfer to B files EXACTLY ONE reassignment row — threaded to the
 *     coordination, the claim it moves, the from + to operators, the org, the conversation and the correlation trace —
 *     with `reassignment_type`/`reassignment_outcome` pinned to the fold, `status` pinned to 'reassigned', and a
 *     `reassigned_at` timestamp.
 *   • THE TRANSFER IS AUTHORITATIVE — after A→B, the current owner is B: the upgraded Release Runtime lets ONLY B release
 *     the item and refuses A. Ownership genuinely changed hands; the reassignment "took".
 *   • THE OTHER ENGINES REMAIN AUTHORITATIVE — a reassignment NEVER mutates the claim ledger (still A, still 'claimed')
 *     and writes NO release row; a reassignment adds NO state to the R51 lifecycle (the item stays claimed). Since R53 the
 *     R51 state engine and the R48 read model FOLD the transfer: the item stays owned, but its CURRENT owner is now B
 *     (the original claimant A preserved alongside), proven here through both seams over the live database.
 *   • OWNERSHIP HISTORY IS PRESERVED IN FULL — A→B→C is a CHAIN of first-class append-only rows; each transfer is a new
 *     row, never an overwrite, so the complete lineage of who held the item survives.
 *   • INVALID TRANSFERS ARE PREVENTED — an item with NO claim, a RELEASED item, or an item held by a DIFFERENT operator
 *     than the named source is refused (`not_owned`, nothing written). You can only reassign what you hold.
 *   • ORGANISATION ISOLATION IS STRUCTURAL — org B naming org A's coordination is refused at the storage layer
 *     (`unavailable`, nothing written): the guard demands the coordination belong to the REASSIGNING organisation.
 *   • THE LEDGER IS APPEND-ONLY (UPDATE/DELETE rejected even for service_role), SERVICE-ROLE-ONLY (RLS:hq — anon cannot
 *     read it, insert into it, or call the write primitive), IDEMPOTENT on the request id (a replay returns the stable id
 *     even after the owner moved on), and its VOCABULARY, FOLD, DISTINCT OPERATORS and COORDINATION AUTHORITY are pinned
 *     by CHECKs + the guard, so a stored row can never misrepresent a transfer.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All three ledgers are append-only, so these tests intentionally leave their rows behind; each
 * assertion uses a FRESH random org id and addresses rows by a per-call coordination id so it sees only its own writes.
 */

// receptionist_conversation_claim_reassignments / record_receptionist_conversation_claim_reassignment are
// service-role-only internals, NOT in the generated Database types. Cast to the minimal surface this suite exercises
// (the same `as unknown as` convention the claim / release suites use) rather than reaching for `any`.
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

const TABLE = "receptionist_conversation_claim_reassignments";
const CLAIM_TABLE = "receptionist_conversation_claims";
const RELEASE_TABLE = "receptionist_conversation_claim_releases";
const RPC = "record_receptionist_conversation_claim_reassignment";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;
const anon = (): LedgerClient => anonClient() as unknown as LedgerClient;

// The columns every assertion below reads back — the full captured reassignment record.
const COLUMNS =
  "id, org_id, coordination_id, claim_id, request_id, conversation_id, correlation_id, " +
  "from_operator_id, from_operator_email, to_operator_id, to_operator_email, " +
  "reassignment_type, reassignment_outcome, status, metadata, reassigned_at, created_at";

/** Three distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };
const OPERATOR_C: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-c@crewflow.uk" };

/** A valid direct-insert row (every NOT NULL column present, from ≠ to) — used ONLY for the append-only, anon-denial and
 *  column-CHECK negative cases (a direct insert bypasses the RPC's coordination + ownership guards, so random
 *  coordination / claim ids are fine here). */
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  coordination_id: crypto.randomUUID(),
  claim_id: crypto.randomUUID(),
  request_id: crypto.randomUUID(),
  from_operator_id: crypto.randomUUID(),
  to_operator_id: crypto.randomUUID(),
  reassignment_type: "reassign_conversation_work",
  reassignment_outcome: "work_reassigned",
});

/** A valid RPC payload — spread and overridden per rejection case. `coordinationId`/`orgId` name the coordination the
 *  transfer is filed against (a real, claimed one for the positive path; a random one is fine for the pre-guard
 *  vocabulary/NULL cases, which are rejected BEFORE the coordination-authority guard runs). */
const validRpcArgs = (coordinationId: string, orgId: string) => ({
  p_org_id: orgId,
  p_coordination_id: coordinationId,
  p_from_operator_id: crypto.randomUUID(),
  p_to_operator_id: crypto.randomUUID(),
  p_reassignment_type: "reassign_conversation_work",
  p_reassignment_outcome: "work_reassigned",
  p_from_operator_email: "from@crewflow.uk",
  p_to_operator_email: "to@crewflow.uk",
  p_conversation_id: crypto.randomUUID(),
  p_correlation_id: crypto.randomUUID(),
  p_request_id: crypto.randomUUID(),
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item R46 claims and R52 reassigns. */
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

/** Seed a coordination AND record OPERATOR_A's claim on it — the owned item R52 reassigns. */
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

/** Read every REASSIGNMENT row filed against one coordination id, as service_role (ground truth). */
function rowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("coordination_id", coordinationId);
}

/** Read every CLAIM row filed against one coordination id — the R46 ledger R52 must never touch. */
function claimRowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc()
    .from(CLAIM_TABLE)
    .select("id, operator_id, status")
    .eq("coordination_id", coordinationId);
}

/** Read every RELEASE row filed against one coordination id — the R50 ledger a reassignment must never write. */
function releaseRowsForCoordination(coordinationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(RELEASE_TABLE).select("id, operator_id").eq("coordination_id", coordinationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration(
  "Conversation Work Reassignment pipeline · receptionist_conversation_claim_reassignments (R52)",
  () => {
    it("reassignConversationWork RECORDS the transfer — files EXACTLY ONE row from A to B", async () => {
      const orgId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      const { coordinationId, claimId } = await seedClaimed(orgId);

      // THE OPERATOR TRANSFERS OWNERSHIP — driven through the real runtime, exactly as an authenticated operator action.
      const reassigned = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
        conversation_id: conversationId,
        correlation_id: correlationId,
      });
      expect(reassigned.resolution).toBe("reassigned");
      if (reassigned.resolution !== "reassigned") throw new Error("expected a recorded reassignment");
      expect(reassigned.reassignment.coordination_id).toBe(coordinationId);
      expect(reassigned.reassignment.from_operator_id).toBe(OPERATOR_A.id);
      expect(reassigned.reassignment.to_operator_id).toBe(OPERATOR_B.id);
      expect(reassigned.reassignment.reassignment_type).toBe("reassign_conversation_work");
      expect(reassigned.reassignment.reassignment_outcome).toBe("work_reassigned");

      // EXACTLY ONE reassignment row — not zero (unrecorded), not two (double-transferred).
      const read = await rowsForCoordination(coordinationId);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(reassigned.reassignment.reassignment_id);
      // WHERE it is scoped, and WHAT it is filed against — the coordination is the load-bearing anchor.
      expect(row.org_id).toBe(orgId);
      expect(row.coordination_id).toBe(coordinationId);
      // Threaded to the exact CLAIM it moves (resolved by the primitive from the R46 ledger).
      expect(row.claim_id).toBe(claimId);
      // The optional provenance threaded onto the audit row.
      expect(row.conversation_id).toBe(conversationId);
      expect(row.correlation_id).toBe(correlationId);
      // WHO gave it up, and WHO received it — both operators' ids + denormalised emails.
      expect(row.from_operator_id).toBe(OPERATOR_A.id);
      expect(row.from_operator_email).toBe(OPERATOR_A.email);
      expect(row.to_operator_id).toBe(OPERATOR_B.id);
      expect(row.to_operator_email).toBe(OPERATOR_B.email);
      // WHAT was transferred, folded deterministically, and HELD by construction.
      expect(row.reassignment_type).toBe("reassign_conversation_work");
      expect(row.reassignment_outcome).toBe("work_reassigned");
      expect(row.status).toBe("reassigned");
      // WHEN — the transfer records its timestamp.
      expect(typeof row.reassigned_at).toBe("string");
      expect((row.reassigned_at as string).length).toBeGreaterThan(0);
      // A fresh request id was minted (the caller supplied none) — the conflict key is present.
      expect(typeof row.request_id).toBe("string");
    });

    it("the transfer is AUTHORITATIVE — after A→B, only B (the new owner) can release; A can no longer", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // OPERATOR_A holds it

      const reassigned = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(reassigned.resolution).toBe("reassigned");

      // A is NO LONGER the owner — the upgraded Release Runtime refuses A (not_owned, nothing written).
      const releaseByA = await releaseConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        operator: OPERATOR_A,
      });
      expect(releaseByA.resolution).toBe("not_owned");
      expect((await releaseRowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

      // B IS the current owner — B can release the item. Ownership genuinely changed hands.
      const releaseByB = await releaseConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        operator: OPERATOR_B,
      });
      expect(releaseByB.resolution).toBe("released");
      if (releaseByB.resolution !== "released") throw new Error("expected B's release to be recorded");
      expect(releaseByB.release.operator_id).toBe(OPERATOR_B.id);
    });

    it("reassignment FOLDS ownership to B — the item stays claimed, the read model names B (claimant A preserved); the Claim + Release ledgers are untouched", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId);

      await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });

      // The item stays CLAIMED — a reassignment adds no state to the R51 lifecycle (a reassigned item is still owned).
      const record = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
      expect(record.owned).toBe(true);
      // SINCE R53 THE READ MODEL FOLDS THE TRANSFER — it names the CURRENT owner (B), not the original claimant (A). The
      // ownership read model reads the reassignment chain THROUGH the state engine and re-attributes the held item to its
      // current holder, preserving A as the original claimant. This closes the former R53 gap, proven over the live DB.
      expect(record.owner?.operatorId).toBe(OPERATOR_B.id);
      expect(record.owner?.operatorEmail).toBe(OPERATOR_B.email);
      expect(record.reassigned).toBe(true);
      expect(record.claimant?.operatorId).toBe(OPERATOR_A.id);

      // THE STATE ENGINE FOLDS THE SAME TRANSFER — the coordination is still `claimed` (state is claim+release only), its
      // CURRENT owner is B, and it carries EXACTLY ONE reassignment leg (A→B). State and current owner agree with the read
      // model above, because the read model reads ownership THROUGH this engine.
      const state = await getCoordinationOwnershipState({ org_id: orgId, coordination_id: coordinationId });
      expect(state.state).toBe("claimed");
      expect(state.currentOwner?.operatorId).toBe(OPERATOR_B.id);
      expect(state.reassignments).toHaveLength(1);
      expect(state.reassignments[0]?.to_operator_id).toBe(OPERATOR_B.id);

      // THE CLAIM RUNTIME REMAINS AUTHORITATIVE — the append-only claim row is UNCHANGED (still A, still 'claimed'). A
      // reassignment never mutates or deletes the claim.
      const claimRows = await claimRowsForCoordination(coordinationId);
      expect(claimRows.data).toHaveLength(1);
      expect(claimRows.data?.[0]?.operator_id).toBe(OPERATOR_A.id);
      expect(claimRows.data?.[0]?.status).toBe("claimed");

      // THE RELEASE RUNTIME REMAINS AUTHORITATIVE — a reassignment writes NO release row. The item was transferred, not
      // relinquished.
      expect((await releaseRowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);
    });

    it("supports a CHAIN of transfers — A→B→C, each an append-only row; only the latest owner holds the item", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // A holds

      // A hands it to B.
      const first = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(first.resolution).toBe("reassigned");

      // B — now the current owner — hands it on to C. The ownership gate accepts B (it is the latest owner).
      const second = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_B,
        to_operator: OPERATOR_C,
      });
      expect(second.resolution).toBe("reassigned");

      // TWO first-class rows — the full lineage is preserved, never overwritten (coordination_id is NOT unique).
      const read = await rowsForCoordination(coordinationId);
      expect(read.data).toHaveLength(2);
      const legs = (read.data ?? []).map((r) => `${r.from_operator_id}->${r.to_operator_id}`);
      expect(legs).toContain(`${OPERATOR_A.id}->${OPERATOR_B.id}`);
      expect(legs).toContain(`${OPERATOR_B.id}->${OPERATOR_C.id}`);

      // Only C, the LATEST owner, holds the item — an attempt by the SUPERSEDED owner B to hand it on again is refused.
      const staleB = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_B,
        to_operator: OPERATOR_A,
      });
      expect(staleB.resolution).toBe("not_owned");
      // No third row was written.
      expect((await rowsForCoordination(coordinationId)).data).toHaveLength(2);

      // THE READ MODEL FOLDS THE WHOLE CHAIN — after A→B→C the current owner is the TAIL of the chain (C), the item is
      // still owned, and the ORIGINAL claimant (A) is preserved. Ownership history survives across every leg.
      const chained = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
      expect(chained.owned).toBe(true);
      expect(chained.owner?.operatorId).toBe(OPERATOR_C.id);
      expect(chained.reassigned).toBe(true);
      expect(chained.claimant?.operatorId).toBe(OPERATOR_A.id);

      // C can release the item (C is the current owner); the release writer resolves the tail of the chain.
      const releaseByC = await releaseConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        operator: OPERATOR_C,
      });
      expect(releaseByC.resolution).toBe("released");
    });

    it("PREVENTS an invalid transfer — an item with NO active claim is refused (not_owned), nothing written", async () => {
      const orgId = crypto.randomUUID();
      // A seeded-but-unclaimed coordination — there is no claim to transfer.
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      const reassigned = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(reassigned.resolution).toBe("not_owned");
      expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);
    });

    it("PREVENTS an invalid transfer — a NON-owner cannot reassign an item held by someone else (not_owned)", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // OPERATOR_A holds it

      // OPERATOR B (who does not hold it) attempts to hand it to C — the ownership gate refuses, writing nothing.
      const reassigned = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_B,
        to_operator: OPERATOR_C,
      });
      expect(reassigned.resolution).toBe("not_owned");
      expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

      // A still holds it — A CAN reassign its own item.
      const byOwner = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(byOwner.resolution).toBe("reassigned");
    });

    it("PREVENTS an invalid transfer — a RELEASED item has no current owner and cannot be reassigned (not_owned)", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // A holds

      // A releases the item — it returns to the unclaimed state.
      const released = await releaseConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        operator: OPERATOR_A,
      });
      expect(released.resolution).toBe("released");

      // A released item has NO current owner — it must be re-claimed before it can be reassigned. The transfer is refused.
      const reassigned = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(reassigned.resolution).toBe("not_owned");
      expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);
    });

    it("preserves ORGANISATION ISOLATION — org B cannot reassign org A's coordination (unavailable), nothing written", async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgA); // OPERATOR_A holds it under org A

      // org B names org A's coordination. The guard demands the coordination belong to the REASSIGNING org — it does
      // not, so the transfer is refused at the storage layer and NOTHING is written. Isolation is structural.
      const cross = await reassignConversationWork({
        org_id: orgB,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(cross.resolution).toBe("unavailable");
      expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

      // org A, the owner, CAN reassign its own coordination.
      const own = await reassignConversationWork({
        org_id: orgA,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
      });
      expect(own.resolution).toBe("reassigned");
    });

    it("is idempotent — replaying the SAME request_id returns the STABLE id and writes no second row, even after the owner moved on", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // A holds
      const requestId = crypto.randomUUID();

      const first = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
        request_id: requestId,
      });
      expect(first.resolution).toBe("reassigned");
      if (first.resolution !== "reassigned") throw new Error("expected the first transfer to be recorded");

      // Replay the SAME request (a retried operator action). The current owner is now B, so the ownership gate would
      // reject `from = A` — but the request-id short-circuit runs FIRST and returns the existing id. Idempotent.
      const again = await reassignConversationWork({
        org_id: orgId,
        coordination_id: coordinationId,
        from_operator: OPERATOR_A,
        to_operator: OPERATOR_B,
        request_id: requestId,
      });
      expect(again.resolution).toBe("reassigned");
      if (again.resolution !== "reassigned") throw new Error("expected the idempotent replay to resolve");
      expect(again.reassignment.reassignment_id).toBe(first.reassignment.reassignment_id);

      const read = await rowsForCoordination(coordinationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first.reassignment.reassignment_id);
    });

    it("the write primitive enforces the OWNERSHIP gate, distinct operators, and idempotency (direct RPC)", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedClaimed(orgId); // OPERATOR_A holds it

      // A NON-owner `from` is refused — the primitive returns NULL (no error), writing nothing.
      const nonOwner = await svc().rpc<string>(RPC, {
        ...validRpcArgs(coordinationId, orgId),
        p_from_operator_id: crypto.randomUUID(),
        p_to_operator_id: crypto.randomUUID(),
      });
      expect(nonOwner.error, nonOwner.error?.message).toBeNull();
      expect(nonOwner.data, "a non-owner's transfer is refused with NULL").toBeNull();
      expect((await rowsForCoordination(coordinationId)).data ?? []).toHaveLength(0);

      // A self-transfer (from = to) is rejected by the distinct-operators guard — it raises.
      const sameId = crypto.randomUUID();
      const selfTransfer = await svc().rpc<string>(RPC, {
        ...validRpcArgs(coordinationId, orgId),
        p_from_operator_id: sameId,
        p_to_operator_id: sameId,
      });
      expect(selfTransfer.error, "a self-transfer (from = to) must be rejected").not.toBeNull();

      // The OWNER hands the item on — the primitive files the row and returns its id. A FIXED request id is reused below.
      const ownerArgs = {
        ...validRpcArgs(coordinationId, orgId),
        p_from_operator_id: OPERATOR_A.id,
        p_to_operator_id: OPERATOR_B.id,
      };
      const owner = await svc().rpc<string>(RPC, ownerArgs);
      expect(owner.error, owner.error?.message).toBeNull();
      expect(owner.data, "the owner's transfer returns the reassignment id").toBeTruthy();

      // Replaying the SAME request id — ON CONFLICT (request_id) returns the existing id, files no second row.
      const idempotent = await svc().rpc<string>(RPC, ownerArgs);
      expect(idempotent.error, idempotent.error?.message).toBeNull();
      expect(idempotent.data).toBe(owner.data);

      // Exactly one row survives.
      const read = await rowsForCoordination(coordinationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(owner.data);
      expect(read.data?.[0]?.from_operator_id).toBe(OPERATOR_A.id);
      expect(read.data?.[0]?.to_operator_id).toBe(OPERATOR_B.id);
      expect(read.data?.[0]?.status).toBe("reassigned");
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const row = validInsertRow();
      const filed = await svc().from(TABLE).insert(row).select("id");
      expect(filed.error, filed.error?.message).toBeNull();
      const coordinationId = row.coordination_id;

      // A reassignment can never be rewritten…
      const updated = await svc()
        .from(TABLE)
        .update({ to_operator_id: crypto.randomUUID() })
        .eq("coordination_id", coordinationId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      // …nor erased.
      const deleted = await svc().from(TABLE).delete().eq("coordination_id", coordinationId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      // The row survived both attempts — still exactly one, unchanged.
      const read = await rowsForCoordination(coordinationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.from_operator_id).toBe(row.from_operator_id);
      expect(read.data?.[0]?.to_operator_id).toBe(row.to_operator_id);
      expect(read.data?.[0]?.status).toBe("reassigned");
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
      expect(anonWrite.error, "anon must not be able to record a reassignment").not.toBeNull();

      // anon cannot write around the RPC with a direct insert either.
      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the fold, the distinct operators and the coordination authority", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      // A type outside {reassign_conversation_work} is rejected by the RPC (before the coordination/ownership gate).
      const badType = await svc().rpc<string>(RPC, {
        ...validRpcArgs(coordinationId, orgId),
        p_reassignment_type: "release_conversation_work",
      });
      expect(badType.error, "a reassignment type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {work_reassigned} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(coordinationId, orgId),
        p_reassignment_outcome: "work_released",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // The org / coordination / from / to are MANDATORY — a null in any is rejected.
      const noFrom = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_from_operator_id: null });
      expect(noFrom.error, "a reassignment with no source operator must be rejected").not.toBeNull();
      const noTo = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_to_operator_id: null });
      expect(noTo.error, "a reassignment with no target operator must be rejected").not.toBeNull();
      const noOrg = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_org_id: null });
      expect(noOrg.error, "a reassignment with no organisation must be rejected").not.toBeNull();
      const noCoordination = await svc().rpc<string>(RPC, { ...validRpcArgs(coordinationId, orgId), p_coordination_id: null });
      expect(noCoordination.error, "a reassignment with no coordination must be rejected").not.toBeNull();

      // DISTINCT OPERATORS: from = to is rejected by the RPC guard.
      const shared = crypto.randomUUID();
      const sameOperator = await svc().rpc<string>(RPC, {
        ...validRpcArgs(coordinationId, orgId),
        p_from_operator_id: shared,
        p_to_operator_id: shared,
      });
      expect(sameOperator.error, "a self-transfer (from = to) must be rejected").not.toBeNull();

      // COORDINATION AUTHORITY: an otherwise-valid transfer against a coordination absent from the org is refused
      // (raises, BEFORE the ownership gate) — a cross-tenant or phantom coordination can never be named.
      const unknownCoordination = await svc().rpc<string>(RPC, validRpcArgs(crypto.randomUUID(), orgId));
      expect(unknownCoordination.error, "a reassignment naming no coordination in the org must be rejected").not.toBeNull();

      // The column CHECKs pin the same vocabulary + fold on a direct service_role insert — nothing can be forged.
      const badTypeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), reassignment_type: "release_conversation_work" });
      expect(badTypeInsert.error, "a type CHECK rejects an out-of-vocabulary type, even for service_role").not.toBeNull();
      const badOutcomeInsert = await svc().from(TABLE).insert({ ...validInsertRow(), reassignment_outcome: "work_released" });
      expect(badOutcomeInsert.error, "an outcome CHECK rejects an out-of-vocabulary outcome").not.toBeNull();
      const badStatusInsert = await svc().from(TABLE).insert({ ...validInsertRow(), status: "released" });
      expect(badStatusInsert.error, "a status other than 'reassigned' must be rejected by the CHECK").not.toBeNull();
      const sharedInsertId = crypto.randomUUID();
      const sameOperatorInsert = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), from_operator_id: sharedInsertId, to_operator_id: sharedInsertId });
      expect(sameOperatorInsert.error, "a from = to row must be rejected by the distinct-operators CHECK").not.toBeNull();
    });
  },
);
