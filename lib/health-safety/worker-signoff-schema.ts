import { z } from "zod";
import { ACK_SUBJECT_TYPES } from "./acknowledgements";

/**
 * Trust-boundary shape validation for the external worker sign-off feature.
 * The DB is the authority for tenant/job isolation, immutability and version
 * anchoring (see 20261185000000); these validate shape/range before a write.
 */

const uuid = z.string().uuid();

/** Staff issuing a link: the job to scope it to, who it's for, and how long it
 *  lives. Expiry is mandatory (every worker link lapses). */
export const issueWorkerLinkSchema = z.object({
  jobId: uuid,
  workerName: z.string().trim().min(1, "Enter the worker's name.").max(160),
  workerCompany: z
    .string()
    .trim()
    .max(160)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  // Whole days until the link expires. Bounded so a link can neither be minted
  // already-dead nor open-ended (1 day .. ~1 year).
  expiresInDays: z.coerce.number().int().min(1).max(365),
});
export type IssueWorkerLinkInput = z.infer<typeof issueWorkerLinkSchema>;

export const revokeWorkerLinkSchema = z.object({ tokenId: uuid });

/**
 * A worker signing off ONE document through the portal. subjectVersion is the
 * issued reference anchor; the DB re-checks it against the live subject. The
 * drawn-signature data-URL is optional and only length-bounded here (byte-level
 * PNG validation is server-side in lib/signatures/data-url).
 */
export const workerAcknowledgeSchema = z.object({
  subjectType: z.enum(ACK_SUBJECT_TYPES),
  subjectId: uuid,
  subjectVersion: z.string().trim().min(1).max(60),
  signedName: z.string().trim().min(2, "Type your full name to sign.").max(160),
  signatureDataUrl: z
    .string()
    .max(3_000_000, "Signature image is too large")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});
export type WorkerAcknowledgeInput = z.infer<typeof workerAcknowledgeSchema>;
