import { z } from "zod";
import { ANSWERING_MODES, WEEKDAYS, type DayHours, type Weekday } from "@/lib/telephony/answering-policy";

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

/** The answering modes exposed in the settings UI (with human labels). */
export const ANSWERING_MODE_LABELS: Record<(typeof ANSWERING_MODES)[number], string> = {
  missed_only: "Only calls my team misses",
  out_of_hours: "Only outside business hours",
  both: "Missed calls AND outside hours",
};

/** The timezones offered in the UI (UK + Ireland; most tenants are Europe/London). */
export const AI_RECEPTIONIST_TIMEZONES = ["Europe/London", "Europe/Dublin", "UTC"] as const;

/** Human day labels for the weekly-hours editor, in week order. */
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const E164_RE = /^\+[1-9]\d{6,14}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise one phone value to strict E.164, or null (strips spaces/dashes/parens). */
export function normaliseE164(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[\s()\-.]/g, "").trim();
  return E164_RE.test(cleaned) ? cleaned : null;
}

/**
 * Parse a staff-numbers textarea (one number per line or comma-separated) into a
 * clean E.164 list + the list of tokens that failed validation (for a field error).
 */
export function parseStaffNumbers(raw: string | null | undefined): {
  numbers: string[];
  invalid: string[];
} {
  const tokens = (raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const numbers: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const n = normaliseE164(token);
    if (n) {
      if (!numbers.includes(n)) numbers.push(n);
    } else {
      invalid.push(token);
    }
  }
  return { numbers, invalid };
}

/** Parse a closures textarea (YYYY-MM-DD per line) into a clean list + invalid tokens. */
export function parseClosureDates(raw: string | null | undefined): {
  dates: string[];
  invalid: string[];
} {
  const tokens = (raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dates: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    // Validate it is BOTH well-formed AND a real calendar date.
    if (YMD_RE.test(token) && !Number.isNaN(Date.parse(`${token}T00:00:00Z`))) {
      if (!dates.includes(token)) dates.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { dates, invalid };
}

/**
 * Parse the flat per-weekday form fields (`hours_<day>_closed` / `_open` / `_close`)
 * into the structured `weekly_hours` map, with per-day validation errors. Pure:
 * takes a getter so it is testable without a real FormData.
 */
export function parseWeeklyHours(get: (name: string) => string | null): {
  weekly: Record<Weekday, DayHours>;
  errors: Record<string, string>;
} {
  const weekly = {} as Record<Weekday, DayHours>;
  const errors: Record<string, string> = {};
  for (const day of WEEKDAYS) {
    const closed = get(`hours_${day}_closed`) === "on" || get(`hours_${day}_closed`) === "true";
    if (closed) {
      weekly[day] = null;
      continue;
    }
    const open = (get(`hours_${day}_open`) ?? "").trim();
    const close = (get(`hours_${day}_close`) ?? "").trim();
    if (!open && !close) {
      // Neither supplied and not marked closed → treat as closed (safe default).
      weekly[day] = null;
      continue;
    }
    if (!HHMM_RE.test(open) || !HHMM_RE.test(close)) {
      errors[`hours_${day}`] = "Use 24-hour HH:MM times, or mark the day closed.";
      weekly[day] = null;
      continue;
    }
    const openMin = Number(open.slice(0, 2)) * 60 + Number(open.slice(3));
    const closeMin = Number(close.slice(0, 2)) * 60 + Number(close.slice(3));
    if (closeMin <= openMin) {
      errors[`hours_${day}`] = "Closing time must be after opening time.";
      weekly[day] = null;
      continue;
    }
    weekly[day] = { open, close };
  }
  return { weekly, errors };
}

/** An optional E.164 field: empty → undefined; present-but-bad → a field error. */
const optionalE164 = (label: string) =>
  z
    .union([z.string().trim(), z.literal(""), z.undefined()])
    .transform((v) => (v == null || v === "" ? undefined : v.replace(/[\s()\-.]/g, "")))
    .refine((v) => v === undefined || E164_RE.test(v), {
      message: `${label} must be a full number in international format, e.g. +447700900123.`,
    });

/** A checkbox value → boolean. */
const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal(""), z.undefined()])
  .transform((v) => v === "on" || v === "true");

/**
 * Customer-side form: enable + channel handles + the SELF-SERVE structured
 * answering policy (modes / hours / staff routing / recording). The enable flag
 * is the primary lever; when false, every other field can be blank. The nested
 * `weekly_hours`, `staff_numbers` and `closures` are parsed from flat form fields
 * by the pure helpers above (the action composes them onto the payload).
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
    // Structured answering policy (scalars — the nested fields are parsed separately).
    answering_mode: z
      .union([z.enum(ANSWERING_MODES), z.literal(""), z.undefined()])
      .transform((v) => (v && (ANSWERING_MODES as readonly string[]).includes(v) ? v : "both")),
    timezone: z
      .union([z.string().trim(), z.literal(""), z.undefined()])
      .transform((v) => (v == null || v === "" ? "Europe/London" : v)),
    ring_timeout_seconds: z
      .union([z.string().trim(), z.literal(""), z.undefined()])
      .transform((v) => {
        const n = Number.parseInt((v ?? "").toString(), 10);
        return Number.isFinite(n) ? Math.max(5, Math.min(120, n)) : 20;
      }),
    fallback_number: optionalE164("Fallback number"),
    urgent_escalation_number: optionalE164("Urgent transfer number"),
    greeting: trimmedOptional(300, "Greeting"),
    service_areas: trimmedOptional(500, "Service areas"),
    recording_enabled: checkbox,
    transcription_enabled: checkbox,
    recording_consent_message: trimmedOptional(300, "Recording consent message"),
    notify_email: checkbox,
    notify_sms: checkbox,
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
    // If recording is on, a consent line is required (UK disclosure guidance).
    if (val.recording_enabled && !val.recording_consent_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recording_consent_message"],
        message: "Add the consent message callers will hear before recording starts.",
      });
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
