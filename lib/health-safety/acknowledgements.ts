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

/** Validate a typed-name attestation before a write is attempted. */
export function validateSignature(signedName: string): string[] {
  const errs: string[] = [];
  const n = signedName?.trim() ?? "";
  if (n.length < 2) errs.push("Type your full name to sign.");
  if (n.length > 120) errs.push("Name is too long.");
  return errs;
}
