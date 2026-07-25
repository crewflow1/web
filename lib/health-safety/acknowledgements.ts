/**
 * Health & Safety — operative acknowledgement (sign-off) pure domain logic.
 * Deterministic, no DB/IO. The generic subject-based model (RAMS + permits, and
 * later toolbox) means ONE acknowledgement system, version-anchored + append-only.
 */

export const ACK_SUBJECT_TYPES = ["risk_assessment", "permit_to_work"] as const;
export type AckSubjectType = (typeof ACK_SUBJECT_TYPES)[number];

export const ACK_SUBJECT_LABELS: Record<AckSubjectType, string> = {
  risk_assessment: "risk assessment",
  permit_to_work: "permit to work",
};

/** The current attestation wording + version (bump the version if the wording
 *  changes so re-acknowledgement can be required). */
export const ACK_STATEMENT_VERSION = "v1";
export function ackStatement(subjectType: AckSubjectType, reference: string): string {
  const noun = ACK_SUBJECT_LABELS[subjectType];
  return `I confirm I have read and understood ${noun} ${reference}, and I will work in accordance with its controls.`;
}

/** Has this specific operative acknowledged this specific issued version? */
export function hasAcknowledged(
  acks: Array<{ user_id: string; subject_version: string }>,
  userId: string,
  version: string,
): boolean {
  return acks.some((a) => a.user_id === userId && a.subject_version === version);
}

/** Acknowledgement progress for a document: distinct signers / expected. */
export function acknowledgementProgress(
  acks: Array<{ user_id: string }>,
  expected: number,
): { signed: number; expected: number; complete: boolean } {
  const signed = new Set(acks.map((a) => a.user_id)).size;
  return { signed, expected, complete: expected > 0 && signed >= expected };
}

export type SignoffState = "fully_signed" | "partially_signed" | "unsigned" | "not_tracked";

export type SignoffSummary = {
  state: SignoffState;
  required: number; // required operatives (0 when the document isn't job-tracked)
  signedRequired: number; // required operatives who have signed the current version
  outstanding: string[]; // required user_ids not yet signed
  extraSigned: number; // signers not in the required set (e.g. a visiting manager)
};

export const SIGNOFF_STATE_LABEL: Record<SignoffState, string> = {
  fully_signed: "Fully acknowledged",
  partially_signed: "Partially acknowledged",
  unsigned: "Not acknowledged",
  not_tracked: "Not tracked",
};

/**
 * Sign-off status of a document against the REQUIRED operatives — the crew rota'd
 * to its job (M6b). We NEVER invent a requirement: when no operatives can be
 * derived (no job link, or an empty rota) the document is `not_tracked` — signatures
 * are still recorded, but there is no N-of-M denominator to imply an obligation.
 * Pure + deterministic; the acknowledged set is the signers of the CURRENT version.
 */
export function summariseSignoff(
  requiredUserIds: string[],
  acknowledgedUserIds: string[],
): SignoffSummary {
  const required = [...new Set(requiredUserIds)];
  const signed = new Set(acknowledgedUserIds);
  if (required.length === 0) {
    return { state: "not_tracked", required: 0, signedRequired: 0, outstanding: [], extraSigned: signed.size };
  }
  const requiredSet = new Set(required);
  const outstanding = required.filter((u) => !signed.has(u));
  const signedRequired = required.length - outstanding.length;
  const extraSigned = [...signed].filter((u) => !requiredSet.has(u)).length;
  const state: SignoffState =
    outstanding.length === 0 ? "fully_signed" : signedRequired > 0 ? "partially_signed" : "unsigned";
  return { state, required: required.length, signedRequired, outstanding, extraSigned };
}

/** Validate a typed-name attestation before a write is attempted. */
export function validateSignature(signedName: string): string[] {
  const errs: string[] = [];
  const n = signedName?.trim() ?? "";
  if (n.length < 2) errs.push("Type your full name to sign.");
  if (n.length > 120) errs.push("Name is too long.");
  return errs;
}
