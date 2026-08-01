import { z } from "zod";

/**
 * Customers — portal contact & communication preferences (pure).
 *
 * Two distinct things live on the portal profile page, with deliberately
 * different write models:
 *
 *  1. COMMUNICATION PREFERENCES — customer-owned, written directly (upserted)
 *     to customer_portal_preferences by the portal action. Bounded enum +
 *     bounded note; idempotent by construction (natural-key upsert).
 *
 *  2. PROFILE DETAILS (name/email/phone) — org-owned records the business
 *     invoices and contacts against. The portal NEVER writes public.customers.
 *     A change is a REQUEST: a support ticket (existing category 'account')
 *     with a structured body that staff apply manually. This is a design
 *     decision, not a shortcut — a token-holder silently rewriting the email
 *     that invoices, quotes and this very portal link are sent to would turn a
 *     leaked link into an account-takeover primitive.
 */

export const PREFERRED_CHANNELS = [
  "email",
  "phone",
  "whatsapp",
  "post",
] as const;
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

export const PREFERRED_CHANNEL_LABELS: Record<PreferredChannel, string> = {
  email: "Email",
  phone: "Phone call",
  whatsapp: "WhatsApp",
  post: "Post",
};

/** Mirrors the DB checks (channel enum + 500-char note) exactly. */
export const portalPreferencesSchema = z.object({
  preferred_channel: z.enum(PREFERRED_CHANNELS),
  contact_notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(500, "Keep the note under 500 characters").optional(),
  ),
});
export type PortalPreferencesInput = z.infer<typeof portalPreferencesSchema>;

/** Declared, exhaustive customer-facing preferences shape. */
export const PREFERENCES_PORTAL_KEYS = [
  "preferred_channel",
  "contact_notes",
  "updated_on",
] as const;

export type PortalPreferencesView = {
  preferred_channel: PreferredChannel;
  contact_notes: string | null;
  /** YYYY-MM-DD of the last change, for "saved on …" copy. */
  updated_on: string | null;
};

export function buildPortalPreferencesView(row: {
  preferred_channel: string;
  contact_notes: string | null;
  updated_at: string | null;
}): PortalPreferencesView {
  const channel = (PREFERRED_CHANNELS as readonly string[]).includes(
    row.preferred_channel,
  )
    ? (row.preferred_channel as PreferredChannel)
    : "email";
  return {
    preferred_channel: channel,
    contact_notes: row.contact_notes,
    updated_on: row.updated_at ? row.updated_at.slice(0, 10) : null,
  };
}

/**
 * Profile-change request. At least one field must actually be provided; each
 * is bounded to the same widths the customers table is edited with by staff.
 */
export const profileUpdateRequestSchema = z
  .object({
    requested_name: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(200).optional(),
    ),
    requested_email: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(254).email("Enter a valid email").optional(),
    ),
    requested_phone: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(50).optional(),
    ),
  })
  .refine(
    (v) =>
      Boolean(v.requested_name) ||
      Boolean(v.requested_email) ||
      Boolean(v.requested_phone),
    { message: "Fill in at least one field you'd like changed" },
  );
export type ProfileUpdateRequestInput = z.infer<
  typeof profileUpdateRequestSchema
>;

/**
 * The ticket body staff read. Structured line-per-field, current → requested,
 * only for fields the customer actually asked to change. The CURRENT values
 * come from the token-resolved customer row — the customer already sees them
 * on the profile page, so repeating them here leaks nothing new.
 */
export function buildProfileUpdateTicketBody(input: {
  current: { name: string; email: string | null; phone: string | null };
  requested: ProfileUpdateRequestInput;
}): string {
  const lines: string[] = [
    "Contact-details update requested via the customer portal.",
    "The portal does not change customer records — please review and apply manually.",
    "",
  ];
  if (input.requested.requested_name) {
    lines.push(`Name:  ${input.current.name} → ${input.requested.requested_name}`);
  }
  if (input.requested.requested_email) {
    lines.push(
      `Email: ${input.current.email ?? "(none on file)"} → ${input.requested.requested_email}`,
    );
  }
  if (input.requested.requested_phone) {
    lines.push(
      `Phone: ${input.current.phone ?? "(none on file)"} → ${input.requested.requested_phone}`,
    );
  }
  return lines.join("\n");
}
