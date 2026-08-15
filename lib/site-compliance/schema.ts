import { z } from "zod";

/**
 * Site-compliance trust-boundary schemas + row types. The DB is the authority
 * for org derivation, membership, cross-tenant integrity and append-only
 * invariants; these validate SHAPE at the action boundary and give friendly
 * copy. Mirrors lib/health-safety/*-schema.ts and lib/sites/schema.ts.
 */

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim().length === 0 ? undefined : v;

export const siteIdSchema = z.string().uuid();
export const visitorIdSchema = z.string().uuid();

// ── Record a site induction ───────────────────────────────────────────────
export const recordInductionSchema = z
  .object({
    siteId: z.string().uuid(),
    // The inductee is EITHER an internal worker (userId) OR an external operative
    // (personName). The DB CHECK enforces the XOR; this validates the same shape
    // early so the form can say why.
    userId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    personName: z.preprocess(
      blankToUndefined,
      z.string().trim().min(1, "Enter the operative's name").max(160).optional(),
    ),
    personCompany: z.preprocess(blankToUndefined, z.string().trim().max(160).optional()),
    inductionVersion: z
      .string()
      .trim()
      .min(1, "Enter the induction version")
      .max(60),
    signedName: z.string().trim().min(2, "Enter the name signed").max(160),
    // Optional re-induction expiry (yyyy-mm-dd). Blank = no expiry.
    validUntil: z.preprocess(
      blankToUndefined,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")
        .optional(),
    ),
    // Optional drawn signature PNG data-URL; byte validation is server-side.
    signatureDataUrl: z
      .string()
      .max(3_000_000, "Signature image is too large")
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
  })
  .refine((d) => Boolean(d.userId) !== Boolean(d.personName), {
    message: "Choose a worker OR enter an external operative's name — not both.",
    path: ["personName"],
  });
export type RecordInductionInput = z.infer<typeof recordInductionSchema>;

// ── Sign a visitor in ─────────────────────────────────────────────────────
export const visitorSignInSchema = z.object({
  siteId: z.string().uuid(),
  visitorName: z.string().trim().min(1, "Enter the visitor's name").max(160),
  company: z.preprocess(blankToUndefined, z.string().trim().max(160).optional()),
  purpose: z.preprocess(blankToUndefined, z.string().trim().max(500).optional()),
  hostUserId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  vehicleRegistration: z.preprocess(
    blankToUndefined,
    z.string().trim().max(16, "That doesn't look like a registration").optional(),
  ),
});
export type VisitorSignInInput = z.infer<typeof visitorSignInSchema>;

// ── Row types (these tables post-date the generated Supabase types) ────────
export type SiteInductionRow = {
  id: string;
  org_id: string;
  site_id: string;
  user_id: string | null;
  person_name: string | null;
  person_company: string | null;
  induction_version: string;
  inducted_at: string;
  valid_until: string | null;
  statement: string;
  statement_version: string;
  signed_name: string;
  signature_image_bucket: string | null;
  signature_image_path: string | null;
  created_by: string | null;
  created_at: string;
};

export type SiteVisitorRow = {
  id: string;
  org_id: string;
  site_id: string;
  visitor_name: string;
  company: string | null;
  purpose: string | null;
  host_user_id: string | null;
  vehicle_registration: string | null;
  signed_in_at: string;
  signed_out_at: string | null;
  signed_in_by: string | null;
  signed_out_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Map a raw Postgres/PostgREST error to one sentence a foreman understands. */
export function friendlyComplianceError(
  code: string | undefined | null,
  message: string | undefined | null,
): string {
  if (code === "23505") return "That has already been recorded.";
  if (code === "23503" || code === "check_violation" || code === "23514") {
    return "That site isn't in this organisation any more.";
  }
  if (code === "42501") return "You don't have permission to do that.";
  return message?.trim() || "Something went wrong. Try again.";
}
