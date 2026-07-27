import { expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import { releaseConversationWork } from "@/server/services/receptionist-release";
import { getOwnershipTimeline } from "@/server/services/receptionist-ownership-timeline";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Ownership TIMELINE pipeline — real-Postgres proof of the AI Receptionist Programme R55 (CONVERSATION
 * OWNERSHIP TIMELINE): the canonical HISTORICAL projection of ownership over the append-only event stream. The unit tier
 * proves the pure projection in isolation (claim=null→claimant, reassign=from→to, release=releaser→null, ordered oldest
 * first); the security tier proves, as SOURCE, that the timeline consumes ONLY the authorised ownership seams (the R51
 * State Engine + the R48/R53 Read Model) and reads no ledger. This tier proves the behaviour the mocks can't — that when
 * the R55 runtime (`getOwnershipTimeline`) reads back what the CANONICAL runtimes recorded (`claimConversationWork` R46,
 * `reassignConversationWork` R52, `releaseConversationWork` R50) over a LIVE database, it presents the whole append-only
 * history chronologically, tracks the CURRENT owner in its header, and stays org-isolated:
 *
 *   • THE TIMELINE GROWS APPEND-ONLY AND IN ORDER — each recorded event adds ONE chronological entry (claim, then each
 *     transfer), and the header attributes the CURRENT holder (operator B after A→B, C after B→C).
 *   • APPEND-ONLY HISTORY SURVIVES A RELEASE — after the holder releases, the header collapses to `unowned` (the present
 *     fact), but EVERY historical entry (claim → transfers → release) remains: the history is the raw events, not the
 *     collapsed header.
 *   • THE ENGINE + READ MODEL REMAIN AUTHORITATIVE — the timeline records nothing; it reads state through the engine and
 *     the present owner through the read model, and only relabels + orders. It introduces no write and no execution path.
 *   • ORGANISATION ISOLATION HOLDS — a full history recorded under org A is invisible to org B: org B reads an EMPTY
 *     timeline for the SAME coordination id. The `org_id` filter is structural on every underlying read.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. The ledgers are append-only, so these tests intentionally leave their rows behind; each assertion
 * uses a FRESH random org id so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Three distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };
const OPERATOR_C: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-c@crewflow.uk" };

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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item the timeline projects over. */
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

describeIntegration(
  "Conversation Ownership Timeline pipeline · chronological projection over the append-only ownership event stream (R55)",
  () => {
    it("GROWS APPEND-ONLY AND IN ORDER — claim → A→B → B→C, the header tracking the CURRENT owner", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      // BEFORE ANY CLAIM — the coordination exists but no ownership event does: an EMPTY timeline, unowned header.
      const empty = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
      expect(empty.coordinationId).toBe(coordinationId);
      expect(empty.owned).toBe(false);
      expect(empty.status).toBe("unowned");
      expect(empty.currentOwner).toBeNull();
      expect(empty.entries).toEqual([]);
      expect(empty.eventCount).toBe(0);
      expect(empty.firstEventAt).toBeNull();
      expect(empty.lastEventAt).toBeNull();

      // AFTER THE R46 CLAIM — one entry, a null→claimant transition; the header is owned by A.
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");
      const claimed = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
      expect(claimed.entries.map((e) => e.kind)).toEqual(["claimed"]);
      expect(claimed.entries[0]!.from).toBeNull();
      expect(claimed.entries[0]!.to?.operatorId).toBe(OPERATOR_A.id);
      expect(claimed.entries[0]!.sequence).toBe(1);
      expect(claimed.owned).toBe(true);
      expect(claimed.currentOwner?.operatorId).toBe(OPERATOR_A.id);
      expect(claimed.reassigned).toBe(false);
      expect(claimed.eventCount).toBe(1);

      // AFTER THE R52 TRANSFER A→B — a second entry, from A to B; the header now attributes B, flagged reassigned.
      expect(
        (
          await reassignConversationWork({
            org_id: orgId,
            coordination_id: coordinationId,
            from_operator: OPERATOR_A,
            to_operator: OPERATOR_B,
          })
        ).resolution,
      ).toBe("reassigned");
      const toB = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
      expect(toB.entries.map((e) => e.kind)).toEqual(["claimed", "reassigned"]);
      expect(toB.entries[1]!.from?.operatorId).toBe(OPERATOR_A.id);
      expect(toB.entries[1]!.to?.operatorId).toBe(OPERATOR_B.id);
      expect(toB.entries[1]!.sequence).toBe(2);
      expect(toB.owned).toBe(true);
      expect(toB.currentOwner?.operatorId).toBe(OPERATOR_B.id);
      expect(toB.reassigned).toBe(true);
      expect(toB.eventCount).toBe(2);

      // AFTER THE R52 TRANSFER B→C — a third entry, from B to C; the header now attributes C.
      expect(
        (
          await reassignConversationWork({
            org_id: orgId,
            coordination_id: coordinationId,
            from_operator: OPERATOR_B,
            to_operator: OPERATOR_C,
          })
        ).resolution,
      ).toBe("reassigned");
      const toC = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
      expect(toC.entries.map((e) => e.kind)).toEqual(["claimed", "reassigned", "reassigned"]);
      expect(toC.entries[2]!.from?.operatorId).toBe(OPERATOR_B.id);
      expect(toC.entries[2]!.to?.operatorId).toBe(OPERATOR_C.id);
      expect(toC.entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(toC.owned).toBe(true);
      expect(toC.currentOwner?.operatorId).toBe(OPERATOR_C.id);
      expect(toC.reassigned).toBe(true);
      expect(toC.eventCount).toBe(3);
      // The chronology is intact: the first entry is the claim, the last is the most recent transfer.
      expect(toC.firstEventAt).toBe(toC.entries[0]!.at);
      expect(toC.lastEventAt).toBe(toC.entries[2]!.at);
    });

    it("PRESERVES APPEND-ONLY HISTORY after a release — the header collapses to unowned, every entry remains", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      // Claim (A), transfer A→B, then B — the current owner — releases.
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");
      expect(
        (
          await reassignConversationWork({
            org_id: orgId,
            coordination_id: coordinationId,
            from_operator: OPERATOR_A,
            to_operator: OPERATOR_B,
          })
        ).resolution,
      ).toBe("reassigned");
      expect(
        (await releaseConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_B }))
          .resolution,
      ).toBe("released");

      const afterRelease = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
      // THE HEADER IS THE PRESENT FACT — released ⇒ unowned, no current owner.
      expect(afterRelease.owned).toBe(false);
      expect(afterRelease.status).toBe("unowned");
      expect(afterRelease.currentOwner).toBeNull();
      expect(afterRelease.claimedAt).toBeNull();
      expect(afterRelease.heldSince).toBeNull();
      // …YET THE FULL HISTORY REMAINS — claim → transfer → release, three append-only entries, in order.
      expect(afterRelease.entries.map((e) => e.kind)).toEqual(["claimed", "reassigned", "released"]);
      expect(afterRelease.entries[0]!.to?.operatorId).toBe(OPERATOR_A.id);
      expect(afterRelease.entries[1]!.from?.operatorId).toBe(OPERATOR_A.id);
      expect(afterRelease.entries[1]!.to?.operatorId).toBe(OPERATOR_B.id);
      expect(afterRelease.entries[2]!.from?.operatorId).toBe(OPERATOR_B.id);
      expect(afterRelease.entries[2]!.to).toBeNull();
      expect(afterRelease.eventCount).toBe(3);
    });

    it("preserves ORGANISATION ISOLATION — org B reads an EMPTY timeline for org A's coordination", async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

      // A records a full history under its own org — claim + transfer.
      expect(
        (await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");
      expect(
        (
          await reassignConversationWork({
            org_id: orgA,
            coordination_id: coordinationId,
            from_operator: OPERATOR_A,
            to_operator: OPERATOR_B,
          })
        ).resolution,
      ).toBe("reassigned");

      // Org A reads the real timeline…
      const seenByA = await getOwnershipTimeline({ org_id: orgA, coordination_id: coordinationId });
      expect(seenByA.entries.map((e) => e.kind)).toEqual(["claimed", "reassigned"]);
      expect(seenByA.currentOwner?.operatorId).toBe(OPERATOR_B.id);

      // …but org B, naming the SAME coordination id, reads an EMPTY timeline — the org filter isolates every underlying
      // read, so B sees neither A's claim nor A's transfer.
      const seenByB = await getOwnershipTimeline({ org_id: orgB, coordination_id: coordinationId });
      expect(seenByB.owned).toBe(false);
      expect(seenByB.status).toBe("unowned");
      expect(seenByB.currentOwner).toBeNull();
      expect(seenByB.entries).toEqual([]);
      expect(seenByB.eventCount).toBe(0);
    });
  },
);
