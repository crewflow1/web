import "server-only";
import {
  deliverDraft,
  getCommunication,
  listCommunicationsForDraft,
  listCommunicationsForSubject,
  type CommunicationRow,
} from "@/server/services/hq-comms";

/**
 * CrewFlow HQ — the `ctx.comms` SDK facet
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §12).
 *
 * The single way an AI employee delivers an APPROVED draft and reads its delivery
 * history. It does NOT re-implement anything — it BINDS the already-built Communication
 * Layer (`deliverDraft` + the read surfaces, ADR 0003) to one run's trace.
 *
 * Approval-gated, never autonomous (the load-bearing property). `send` delivers ONLY an
 * approved draft: `deliverDraft` fast-fails unless the approval is 'approved', and the
 * `hq_communications` BEFORE-INSERT trigger REFUSES the row regardless of caller — so
 * "every outbound communication requires the Approval Engine" holds in architecture, not
 * convention. The facet exposes a callable primitive; nothing here sends on a timer.
 *
 * Throw-based ABI (like memory, unlike events). A refused or failed delivery throws, so
 * the Task Engine records the run as a failure rather than silently swallowing it. The
 * read surfaces return their values (or null/[]).
 *
 * Identity note: attribution of a delivery flows from the draft + approval (the row's
 * `ai_employee_id` is the draft's author), not from this facet — so the bound `identity`
 * is informational today and the seam the Phase B authorisation layer will key to.
 */

/** The identity the comms facet is bound to — the canonical runtime slug (ADR 0007). */
export type CommsIdentity = {
  /** Canonical runtime handle (e.g. `sales-ai`). Delivery attribution flows from the draft. */
  slug: string;
};

/** What a handler supplies to `ctx.comms.send`. */
export type SendInput = {
  /** The approved draft to deliver (FK → hq_drafts.id). */
  draftId: string;
  /** The approval that gates this delivery (FK → hq_approvals.id; must be 'approved'). */
  approvalId: string;
  /** The resolved recipient address — the caller owns recipient resolution. */
  to: string;
  /** Optional From / Reply-To overrides for this send. */
  from?: string;
  replyTo?: string;
  /** Thread the delivery into the run's trace; defaults to the RunContext `correlationId`. */
  correlationId?: string;
};

/** The bound `ctx.comms` surface. */
export interface BoundComms {
  /**
   * Deliver an APPROVED draft and persist the attempt. THROWS on failure (the throw-based
   * ABI) — including when the approval is not 'approved' (the Approval Engine + the DB
   * trigger are the real boundary; the facet surfaces the refusal as a thrown Error).
   * Returns the persisted communication row on success. Approval-gated, never autonomous.
   */
  send(input: SendInput): Promise<CommunicationRow>;
  /** Read one delivery by id (or null). */
  get(id: string): Promise<CommunicationRow | null>;
  /** All deliveries for a draft, newest first. */
  listForDraft(draftId: string, limit?: number): Promise<CommunicationRow[]>;
  /** All deliveries for a subject (e.g. a lead / customer), newest first. */
  listForSubject(
    subjectType: string,
    subjectId: string,
    limit?: number,
  ): Promise<CommunicationRow[]>;
  /** The frozen identity this facet is bound to. */
  readonly identity: Readonly<CommsIdentity>;
}

/**
 * Bind the Communication Layer to one employee + one run's trace. The run's
 * `correlationId` threads onto a send unless a call overrides it; everything else is a
 * thin, identity-bound pass-through to the approval-gated service.
 */
export function createComms(identity: CommsIdentity, correlationId: string): BoundComms {
  return {
    identity: Object.freeze({ ...identity }),

    async send(input: SendInput): Promise<CommunicationRow> {
      const res = await deliverDraft({
        draftId: input.draftId,
        approvalId: input.approvalId,
        to: input.to,
        from: input.from,
        replyTo: input.replyTo,
        correlationId: input.correlationId ?? correlationId,
      });
      if (!res.ok) throw new Error(`comms.send failed: ${res.error}`);
      return res.communication;
    },

    get(id: string): Promise<CommunicationRow | null> {
      return getCommunication(id);
    },

    listForDraft(draftId: string, limit?: number): Promise<CommunicationRow[]> {
      return listCommunicationsForDraft(draftId, limit);
    },

    listForSubject(
      subjectType: string,
      subjectId: string,
      limit?: number,
    ): Promise<CommunicationRow[]> {
      return listCommunicationsForSubject(subjectType, subjectId, limit);
    },
  };
}
