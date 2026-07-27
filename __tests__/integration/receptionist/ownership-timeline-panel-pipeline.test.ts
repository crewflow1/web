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
import { projectOwnershipTimelinePanel } from "@/lib/receptionist/conversation-ownership-timeline-panel";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Ownership Timeline PANEL pipeline — real-Postgres proof of the AI Receptionist Programme R56 (CONVERSATION
 * OWNERSHIP TIMELINE PANEL): the read-only Conversation Detail panel projected over the live ownership history. The unit
 * tier proves the pure panel projection in isolation; the security tier proves, as SOURCE, that the panel derives ownership
 * nowhere and introduces no execution path. This tier proves the behaviour the mocks can't — that when the R55 runtime
 * (`getOwnershipTimeline`) reads back what the CANONICAL runtimes recorded (`claimConversationWork` R46,
 * `reassignConversationWork` R52, `releaseConversationWork` R50) over a LIVE database, and the R56 panel core
 * (`projectOwnershipTimelinePanel`) re-shapes that view for display, the operator sees the whole append-only history as
 * formatted rows, the present owner in the header, and org isolation preserved — the SAME composition the detail page
 * performs:
 *
 *   • THE PANEL SHOWS THE GROWING HISTORY, HEADER TRACKING THE PRESENT OWNER — before any claim the panel is its empty
 *     state under an "Unowned" header; each recorded event adds ONE formatted row; the header names the CURRENT holder
 *     ("Owned", by transfer after A→B) with formatted instants.
 *   • APPEND-ONLY HISTORY SURVIVES A RELEASE — after the holder releases, the header collapses to "Unowned" (the present
 *     fact), but the panel is NOT empty: every historical row (claim → transfer → release) remains, oldest first.
 *   • ORGANISATION ISOLATION HOLDS — a full history recorded under org A projects to the EMPTY-state panel for org B
 *     naming the SAME coordination id.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the database
 * is missing. The ledgers are append-only, so these tests intentionally leave their rows behind; each assertion uses a
 * FRESH random org id so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** A formatted panel instant — `YYYY-MM-DD HH:MM`, the slice the panel renders (never a re-zoned Date parse). */
const INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** Three distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item the panel projects over. */
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

/** The composition the detail PAGE performs: read the org-scoped timeline, then project the read-only panel over it. */
async function panelFor(orgId: string, coordinationId: string) {
  const view = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
  return projectOwnershipTimelinePanel(view);
}

describeIntegration(
  "Conversation Ownership Timeline Panel pipeline · read-only panel projected over the live ownership history (R56)",
  () => {
    it("shows the growing history with the header tracking the present owner, then collapses to unowned on release", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      // BEFORE ANY CLAIM — the coordination exists but no ownership event does: the panel is its EMPTY state, unowned.
      const empty = await panelFor(orgId, coordinationId);
      expect(empty.coordinationId).toBe(coordinationId);
      expect(empty.isEmpty).toBe(true);
      expect(empty.entries).toEqual([]);
      expect(empty.eventCount).toBe(0);
      expect(empty.firstEventAt).toBe("—");
      expect(empty.lastEventAt).toBe("—");
      expect(empty.emptyMessage).toBe(
        "No ownership events have been recorded for this conversation yet.",
      );
      expect(empty.header.statusLabel).toBe("Unowned");
      expect(empty.header.tone).toBe("unheld");
      expect(empty.header.owned).toBe(false);
      expect(empty.header.currentOwnerLabel).toBeNull();
      expect(empty.header.summary).toBe("No operator has claimed this conversation yet.");

      // AFTER THE R46 CLAIM — an "Owned"/held header naming A, and one formatted "Claimed" row.
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");
      const claimed = await panelFor(orgId, coordinationId);
      expect(claimed.isEmpty).toBe(false);
      expect(claimed.header.statusLabel).toBe("Owned");
      expect(claimed.header.tone).toBe("held");
      expect(claimed.header.owned).toBe(true);
      expect(claimed.header.reassigned).toBe(false);
      expect(claimed.header.currentOwnerLabel).toBe(OPERATOR_A.email);
      expect(claimed.header.claimedAt).toMatch(INSTANT);
      expect(claimed.header.heldSince).toMatch(INSTANT);
      expect(claimed.header.summary).toBe(
        `Currently held by ${OPERATOR_A.email}, claimed ${claimed.header.claimedAt}.`,
      );
      expect(claimed.eventCount).toBe(1);
      expect(claimed.entries).toHaveLength(1);
      expect(claimed.entries[0]!.kindLabel).toBe("Claimed");
      expect(claimed.entries[0]!.at).toMatch(INSTANT);
      expect(claimed.entries[0]!.fromLabel).toBeNull();
      expect(claimed.entries[0]!.toLabel).toBe(OPERATOR_A.email);
      expect(claimed.entries[0]!.headline).toBe(`Claimed by ${OPERATOR_A.email}`);

      // AFTER THE R52 TRANSFER A→B — the header now names B by TRANSFER; a second "Reassigned" row with both operators.
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
      const toB = await panelFor(orgId, coordinationId);
      expect(toB.header.statusLabel).toBe("Owned");
      expect(toB.header.reassigned).toBe(true);
      expect(toB.header.currentOwnerLabel).toBe(OPERATOR_B.email);
      expect(toB.header.summary).toBe(
        `Currently held by ${OPERATOR_B.email}, by transfer, since ${toB.header.heldSince}.`,
      );
      expect(toB.entries.map((e) => e.kindLabel)).toEqual(["Claimed", "Reassigned"]);
      expect(toB.entries[1]!.fromLabel).toBe(OPERATOR_A.email);
      expect(toB.entries[1]!.toLabel).toBe(OPERATOR_B.email);
      expect(toB.entries[1]!.headline).toBe(`Reassigned from ${OPERATOR_A.email} to ${OPERATOR_B.email}`);
      expect(toB.eventCount).toBe(2);

      // AFTER THE R50 RELEASE — the header collapses to "Unowned", but the panel is NOT empty: the full history remains.
      expect(
        (await releaseConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_B }))
          .resolution,
      ).toBe("released");
      const released = await panelFor(orgId, coordinationId);
      expect(released.header.statusLabel).toBe("Unowned");
      expect(released.header.tone).toBe("unheld");
      expect(released.header.owned).toBe(false);
      expect(released.header.currentOwnerLabel).toBeNull();
      expect(released.header.claimedAt).toBe("—");
      expect(released.header.heldSince).toBe("—");
      expect(released.header.summary).toBe(
        "No operator currently holds this conversation — it has been released. Its ownership history is preserved below.",
      );
      // THE HISTORY IS PRESERVED — three formatted rows, oldest first, and the panel is not its empty state.
      expect(released.isEmpty).toBe(false);
      expect(released.emptyMessage).toBeNull();
      expect(released.entries.map((e) => e.kindLabel)).toEqual(["Claimed", "Reassigned", "Released"]);
      expect(released.entries[2]!.fromLabel).toBe(OPERATOR_B.email);
      expect(released.entries[2]!.toLabel).toBeNull();
      expect(released.entries[2]!.headline).toBe(`Released by ${OPERATOR_B.email}`);
      expect(released.eventCount).toBe(3);
      expect(released.firstEventAt).toMatch(INSTANT);
      expect(released.lastEventAt).toMatch(INSTANT);
    });

    it("preserves ORGANISATION ISOLATION — org B's panel is the empty state for org A's coordination", async () => {
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

      // Org A's panel shows the real history, header naming the present owner (B, by transfer).
      const seenByA = await panelFor(orgA, coordinationId);
      expect(seenByA.entries.map((e) => e.kindLabel)).toEqual(["Claimed", "Reassigned"]);
      expect(seenByA.header.statusLabel).toBe("Owned");
      expect(seenByA.header.currentOwnerLabel).toBe(OPERATOR_B.email);

      // …but org B, naming the SAME coordination id, projects the EMPTY-state panel — the org filter isolates every
      // underlying read, so B's panel sees neither A's claim nor A's transfer.
      const seenByB = await panelFor(orgB, coordinationId);
      expect(seenByB.isEmpty).toBe(true);
      expect(seenByB.entries).toEqual([]);
      expect(seenByB.eventCount).toBe(0);
      expect(seenByB.header.statusLabel).toBe("Unowned");
      expect(seenByB.header.owned).toBe(false);
      expect(seenByB.header.currentOwnerLabel).toBeNull();
      expect(seenByB.emptyMessage).toBe(
        "No ownership events have been recorded for this conversation yet.",
      );
    });
  },
);
