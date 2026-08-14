import { z } from "zod";
import { ACK_SUBJECT_TYPES } from "./acknowledgements";

/** Acknowledge-document action input. The DB is the authority for version
 *  anchoring, membership, live-document + append-only invariants; this validates
 *  shape at the trust boundary. */
export const acknowledgeSchema = z.object({
  subjectType: z.enum(ACK_SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  subjectVersion: z.string().trim().min(1).max(60),
  signedName: z.string().trim().min(2).max(120),
  // Optional drawn-signature PNG data-URL. Only length-bounded here; the
  // byte-level PNG validation is server-side in lib/signatures/data-url. Blank
  // means "typed name only" — the acknowledgement still records normally.
  signatureDataUrl: z
    .string()
    .max(3_000_000, "Signature image is too large")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;

export type AcknowledgementRow = {
  id: string;
  org_id: string;
  subject_type: "risk_assessment" | "permit_to_work" | "toolbox_talk";
  subject_id: string;
  subject_version: string;
  user_id: string;
  acknowledged_at: string;
  statement: string;
  statement_version: string;
  signed_name: string;
};
