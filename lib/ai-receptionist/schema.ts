import { z } from "zod";

/**
 * Phase A — AI receptionist white-glove onboarding schemas.
 *
 * Pure module — used by server actions on both the customer side
 * (/settings/ai-receptionist) and the HQ side (/admin/ai-receptionist).
 */

export const AI_RECEPTIONIST_STATUSES = [
  "not_started",
  "in_progress",
  "testing",
  "live",
] as const;
export type AiReceptionistStatus = (typeof AI_RECEPTIONIST_STATUSES)[number];

export const AI_RECEPTIONIST_STATUS_LABELS: Record<AiReceptionistStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  testing: "Testing",
  live: "Live",
};

export const AI_RECEPTIONIST_STATUS_STYLES: Record<AiReceptionistStatus, string> = {
  not_started: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-800",
  testing: "bg-amber-100 text-amber-800",
  live: "bg-emerald-100 text-emerald-800",
};

export const TEST_CHECKLIST_ITEMS = [
  { key: "test_call_at", label: "Call tested" },
  { key: "test_sms_at", label: "SMS tested" },
  { key: "test_whatsapp_at", label: "WhatsApp tested" },
  { key: "test_meta_at", label: "Meta tested (Facebook + Instagram)" },
  { key: "test_voice_at", label: "Voice tested" },
  { key: "test_lead_at", label: "Lead creation tested" },
] as const;
export type TestChecklistKey = (typeof TEST_CHECKLIST_ITEMS)[number]["key"];

/** Optional trimmed-string field that empty-strings collapse to undefined. */
const trimmedOptional = (max: number, label?: string) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max, label ? `${label} is too long` : undefined),
      z.literal(""),
      z.undefined(),
    ])
    .transform((v) => (v === "" || v === undefined ? undefined : v));

export const AI_RECEPTIONIST_VOICES = [
  "british_female_warm",
  "british_female_professional",
  "british_male_warm",
  "british_male_professional",
  "scottish_female",
  "scottish_male",
  "welsh_female",
  "welsh_male",
  "irish_female",
  "irish_male",
] as const;

export const TRADE_TYPES = [
  "general_builder",
  "plumber",
  "electrician",
  "roofer",
  "carpenter",
  "plasterer",
  "painter_decorator",
  "landscaper",
  "tiler",
  "kitchen_bathroom",
  "extensions_renovations",
  "groundworks",
  "scaffolder",
  "joiner",
  "heating_engineer",
  "other",
] as const;

/**
 * Customer-side form: enable + channel handles. The enable flag is the
 * primary lever; when false, every other field can be blank.
 */
export const aiReceptionistSetupSchema = z
  .object({
    enabled: z
      .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal(""), z.undefined()])
      .transform((v) => v === "on" || v === "true"),
    business_phone: trimmedOptional(50, "Business phone"),
    whatsapp_number: trimmedOptional(50, "WhatsApp number"),
    facebook_page: trimmedOptional(200, "Facebook page"),
    instagram_handle: trimmedOptional(80, "Instagram account"),
    preferred_voice: trimmedOptional(80, "Preferred voice"),
    business_hours: trimmedOptional(500, "Business hours"),
    trade_type: trimmedOptional(80, "Trade type"),
  })
  .superRefine((val, ctx) => {
    if (val.enabled) {
      // When enabling, business_phone is the minimum required field so
      // HQ has something concrete to provision against.
      if (!val.business_phone) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["business_phone"],
          message: "Add a business number so we can start the setup.",
        });
      }
    }
  });

export type AiReceptionistSetupInput = z.infer<typeof aiReceptionistSetupSchema>;

/** HQ-side status move schema. */
export const aiReceptionistStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(AI_RECEPTIONIST_STATUSES),
});

/** HQ-side checklist toggle schema. */
export const aiReceptionistChecklistSchema = z.object({
  id: z.string().uuid(),
  key: z.enum([
    "test_call_at",
    "test_sms_at",
    "test_whatsapp_at",
    "test_meta_at",
    "test_voice_at",
    "test_lead_at",
  ]),
  // Toggling a checklist item — "true" stamps now, "false" clears.
  toggle: z.union([z.literal("true"), z.literal("false")]),
});

/** HQ notes update. */
export const aiReceptionistNotesSchema = z.object({
  id: z.string().uuid(),
  hq_notes: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
