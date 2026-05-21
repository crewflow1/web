/**
 * Lead pipeline — shared constants + validation.
 *
 * Stage order matches the canonical pipeline left-to-right:
 *   new → contacted → qualified → quoted → won
 *                                       ↘ lost
 *                                       ↘ job_booked  (won + scheduled)
 *
 * Stored in leads.status as free-text (no DB CHECK). The TS enum is the
 * source of truth for the UI; legacy/unknown values fall back to "new"
 * in display logic.
 */

import { z } from "zod";

export const LEAD_STAGES = [
  "new",
  "contacted",
  "qualified",
  "quoted",
  "won",
  "lost",
  "job_booked",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
  job_booked: "Job booked",
};

export const LEAD_STAGE_STYLES: Record<LeadStage, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-indigo-100 text-indigo-800",
  qualified: "bg-violet-100 text-violet-800",
  quoted: "bg-amber-100 text-amber-800",
  won: "bg-green-100 text-green-800",
  lost: "bg-red-100 text-red-800",
  job_booked: "bg-teal-100 text-teal-800",
};

/** Stages that count as "closed". Conversion % = won / (won + lost). */
export const LEAD_STAGES_CLOSED = ["won", "lost", "job_booked"] as const;
export const LEAD_STAGES_OPEN = ["new", "contacted", "qualified", "quoted"] as const;

export const LEAD_URGENCIES = ["low", "normal", "high", "urgent"] as const;
export type LeadUrgency = (typeof LEAD_URGENCIES)[number];

export const LEAD_URGENCY_STYLES: Record<LeadUrgency, string> = {
  low: "bg-slate-100 text-slate-700",
  normal: "bg-slate-100 text-slate-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export const LEAD_SOURCES = [
  "phone",
  "web",
  "referral",
  "walk_in",
  "social",
  "repeat",
  "other",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().uuid().optional(),
);

const optionalNumber = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().nonnegative().max(99_999_999).optional(),
);

export const createLeadSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  service: optionalString(200),
  urgency: z.enum(LEAD_URGENCIES).default("normal"),
  postcode: optionalString(20),
  customer_id: optionalUuid,
  assigned_to: optionalUuid,
  estimated_value: optionalNumber,
  notes: optionalString(5000),
  ai_summary: optionalString(5000),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = createLeadSchema.partial();

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const moveStageSchema = z.object({
  status: z.enum(LEAD_STAGES),
});
