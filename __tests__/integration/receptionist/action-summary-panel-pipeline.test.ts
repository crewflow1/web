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
import { getCoordinationById } from "@/server/services/receptionist-coordination-view";
import { getOwnershipTimeline } from "@/server/services/receptionist-ownership-timeline";
import { projectConversationActionSummary } from "@/lib/receptionist/conversation-action-summary-panel";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Action Summary PANEL pipeline — real-Postgres proof of the AI Receptionist Programme R57 (CONVERSATION ACTION
 * SUMMARY PANEL): the read-only at-a-glance digest projected over the live coordination record + ownership history. The unit
 * tier proves the pure summary projection in isolation; the security tier proves, as SOURCE, that the summary consumes only
 * the two authorised views and introduces no execution path. This tier proves the behaviour the mocks can't — that when the
 * page reads the SAME two seams it renders from (the R37 read model's `getCoordinationById` for the recorded decision, and the
 * R55 runtime's `getOwnershipTimeline` for the ownership history) over a LIVE database, and the R57 core
 * (`projectConversationActionSummary`) re-shapes them, the operator sees a faithful digest of the recorded state — with org
 * isolation preserved — the SAME composition the detail page performs:
 *
 *   • THE SUMMARY MIRRORS THE RECORDED DECISION — the lifecycle, resolution, coordination mode and human-required facts are
 *     each COPIED (humanised) from the coordination record the R37 reader returns; the summary re-derives none of them.
 *   • THE OWNERSHIP DIGEST TRACKS THE LIVE HISTORY — before any claim the digest is Unowned with no history; each recorded
 *     ownership event updates the current-owner + history summary; after a release the digest is Unowned yet still reports
 *     the preserved history count.
 *   • ORGANISATION ISOLATION HOLDS — a coordination recorded under org A is invisible to org B: the R37 read for org B
 *     resolves to null (the page would 404), and the ownership timeline for org B is empty.
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
const INSTANT = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

/** The pure humanisation the R57 core applies — Title-Case a recorded token; the em dash for an absent one. */
function humanise(token: string | null): string {
  if (token === null) return "—";
  const spaced = token.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return "—";
  return spaced
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item the summary projects over. */
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

/** The composition the detail PAGE performs: read the org-scoped record + timeline, then project the read-only summary. */
async function summaryFor(orgId: string, coordinationId: string) {
  const record = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
  if (!record) throw new Error("test setup: expected a coordination record");
  const timeline = await getOwnershipTimeline({ org_id: orgId, coordination_id: coordinationId });
  return { record, summary: projectConversationActionSummary({ coordination: record, ownership: timeline }) };
}

describeIntegration(
  "Conversation Action Summary Panel pipeline · read-only digest projected over the live record + ownership history (R57)",
  () => {
    it("mirrors the recorded decision and tracks the ownership digest as the live history grows, then collapses on release", async () => {
      const orgId = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

      // THE DECISION FACTS — each is COPIED (humanised) from the coordination record; the summary re-derives none.
      const before = await summaryFor(orgId, coordinationId);
      expect(before.summary.coordinationId).toBe(coordinationId);
      expect(before.summary.conversationId).toBe(before.record.conversation_id);

      expect(["closed", "retained", "escalated"]).toContain(before.record.decision.lifecycle_state);
      expect(before.summary.lifecycle.state).toBe(before.record.decision.lifecycle_state);
      expect(before.summary.lifecycle.stateLabel).toBe(humanise(before.record.decision.lifecycle_state));
      expect(before.summary.lifecycle.summary).toBe(
        `The coordination lifecycle is recorded as ${before.summary.lifecycle.stateLabel}.`,
      );

      expect(["finalising", "remediating", "escalating"]).toContain(before.record.decision.mode);
      expect(before.summary.coordination.mode).toBe(before.record.decision.mode);
      expect(before.summary.coordination.modeLabel).toBe(humanise(before.record.decision.mode));
      expect(before.summary.coordination.summary).toBe(
        `The response is coordinated in ${before.summary.coordination.modeLabel} mode.`,
      );

      expect(before.summary.humanRequired.required).toBe(before.record.decision.requires_human);
      expect(before.summary.humanRequired.tone).toBe(
        before.record.decision.requires_human ? "required" : "autonomous",
      );

      const resState = before.record.context.resolution?.state ?? null;
      expect(before.summary.resolution.state).toBe(resState);
      expect(before.summary.resolution.recorded).toBe(resState !== null);
      expect(before.summary.resolution.stateLabel).toBe(humanise(resState));

      // BEFORE ANY CLAIM — the ownership digest is Unowned with no history.
      expect(before.summary.ownership.owned).toBe(false);
      expect(before.summary.ownership.statusLabel).toBe("Unowned");
      expect(before.summary.ownership.currentOwnerLabel).toBeNull();
      expect(before.summary.ownership.hasHistory).toBe(false);
      expect(before.summary.ownership.eventCount).toBe(0);
      expect(before.summary.ownership.summary).toBe("No operator has claimed this conversation yet.");
      expect(before.summary.ownership.historySummary).toBe("No ownership events have been recorded yet.");

      // AFTER THE R46 CLAIM — Owned, naming A, with a one-event history summary.
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");
      const claimed = await summaryFor(orgId, coordinationId);
      expect(claimed.summary.ownership.owned).toBe(true);
      expect(claimed.summary.ownership.statusLabel).toBe("Owned");
      expect(claimed.summary.ownership.tone).toBe("held");
      expect(claimed.summary.ownership.currentOwnerLabel).toBe(OPERATOR_A.email);
      expect(claimed.summary.ownership.reassigned).toBe(false);
      expect(claimed.summary.ownership.summary).toBe(`Currently held by ${OPERATOR_A.email}.`);
      expect(claimed.summary.ownership.eventCount).toBe(1);
      expect(claimed.summary.ownership.hasHistory).toBe(true);
      expect(claimed.summary.ownership.historySummary).toMatch(
        new RegExp(`^1 ownership event recorded, ${INSTANT.source} → ${INSTANT.source}\\.$`),
      );

      // AFTER THE R52 TRANSFER A→B — Owned, naming B by transfer, with a two-event history.
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
      const toB = await summaryFor(orgId, coordinationId);
      expect(toB.summary.ownership.currentOwnerLabel).toBe(OPERATOR_B.email);
      expect(toB.summary.ownership.reassigned).toBe(true);
      expect(toB.summary.ownership.summary).toBe(`Currently held by ${OPERATOR_B.email}, by transfer.`);
      expect(toB.summary.ownership.eventCount).toBe(2);
      expect(toB.summary.ownership.historySummary).toMatch(
        new RegExp(`^2 ownership events recorded, ${INSTANT.source} → ${INSTANT.source}\\.$`),
      );

      // AFTER THE R50 RELEASE — Unowned, no owner, but the history summary is PRESERVED (three events).
      expect(
        (await releaseConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_B }))
          .resolution,
      ).toBe("released");
      const released = await summaryFor(orgId, coordinationId);
      expect(released.summary.ownership.owned).toBe(false);
      expect(released.summary.ownership.statusLabel).toBe("Unowned");
      expect(released.summary.ownership.currentOwnerLabel).toBeNull();
      expect(released.summary.ownership.hasHistory).toBe(true);
      expect(released.summary.ownership.eventCount).toBe(3);
      expect(released.summary.ownership.summary).toBe(
        "No operator currently holds this conversation — it has been released.",
      );
      expect(released.summary.ownership.historySummary).toMatch(
        new RegExp(`^3 ownership events recorded, ${INSTANT.source} → ${INSTANT.source}\\.$`),
      );

      // The DECISION facts are stable across ownership changes — ownership is orthogonal to the recorded decision.
      expect(released.summary.lifecycle).toEqual(before.summary.lifecycle);
      expect(released.summary.coordination).toEqual(before.summary.coordination);
      expect(released.summary.humanRequired).toEqual(before.summary.humanRequired);
      expect(released.summary.resolution).toEqual(before.summary.resolution);
    });

    it("preserves ORGANISATION ISOLATION — org B cannot read org A's coordination record, and its timeline is empty", async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });
      expect(
        (await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A }))
          .resolution,
      ).toBe("claimed");

      // Org A projects the real digest — the recorded decision + the owned history.
      const seenByA = await summaryFor(orgA, coordinationId);
      expect(seenByA.summary.ownership.owned).toBe(true);
      expect(seenByA.summary.ownership.currentOwnerLabel).toBe(OPERATOR_A.email);

      // …but org B, naming the SAME coordination id, cannot read the record at all — the R37 seam is org-scoped, so it
      // resolves to null (the page would 404) — and the ownership timeline for org B is its empty state.
      const recordForB = await getCoordinationById({ org_id: orgB, coordination_id: coordinationId });
      expect(recordForB, "org B cannot read org A's coordination record").toBeNull();
      const timelineForB = await getOwnershipTimeline({ org_id: orgB, coordination_id: coordinationId });
      expect(timelineForB.owned).toBe(false);
      expect(timelineForB.eventCount).toBe(0);
    });
  },
);
