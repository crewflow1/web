import { z } from "zod";

/**
 * Public per-company lead-capture form (`/l/[slug]` → POST /api/public/lead).
 *
 * UNAUTHENTICATED surface, so the schema is strict: it accepts ONLY these
 * fields (no `org_id`, `status`, `source` — those are set server-side), rejects
 * unknown keys (no mass-assignment), requires an explicit consent box, and
 * carries a `website` HONEYPOT that must be empty (a bot that fills every field
 * is silently dropped). `orgSlug` selects the company server-side; the client
 * never supplies an org id.
 */

const trimmed = (max: number) => z.string().trim().max(max);

export const publicLeadSchema = z
  .object({
    orgSlug: trimmed(100).min(1, "Missing company."),
    name: trimmed(120).min(1, "Please enter your name."),
    email: z
      .union([z.literal(""), z.string().trim().max(254).email("Enter a valid email.")])
      .optional()
      .transform((v) => (v ? v : "")),
    phone: z
      .union([z.literal(""), z.string().trim().max(40)])
      .optional()
      .transform((v) => (v ? v : "")),
    service: trimmed(120).optional().transform((v) => v ?? ""),
    postcode: trimmed(12).optional().transform((v) => v ?? ""),
    message: trimmed(4000).min(1, "Please describe what you need."),
    // Consent is mandatory and must be explicitly true.
    consent: z.literal(true, {
      errorMap: () => ({ message: "Please agree to be contacted about your enquiry." }),
    }),
    // Honeypot — real users never see or fill this; a non-empty value = bot.
    website: z.string().optional().transform((v) => v ?? ""),
  })
  .strict()
  .refine((d) => d.email !== "" || d.phone !== "", {
    message: "Please give an email or a phone number so we can reply.",
    path: ["email"],
  });

export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

export type PublicLeadParse =
  | { ok: true; data: PublicLeadInput; spam: boolean }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Pure parse (unit-tested). Returns field errors on invalid input, and on valid
 * input flags `spam: true` when the honeypot was filled — the caller returns a
 * fake-success (200) for spam so a bot learns nothing, but writes no lead.
 */
export function parsePublicLead(input: unknown): PublicLeadParse {
  const parsed = publicLeadSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0];
      if (typeof k === "string" && !fieldErrors[k]) fieldErrors[k] = issue.message;
    }
    return { ok: false, fieldErrors };
  }
  return { ok: true, data: parsed.data, spam: parsed.data.website.trim() !== "" };
}
