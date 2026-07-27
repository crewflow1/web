import { z } from "zod";

/**
 * Site Reports — input validation + the report content/snapshot shapes.
 *
 * Pure module. The `content` jsonb is the editable draft; the `snapshot` jsonb
 * (materialised at issue) reuses the same ReportSnapshot shape frozen with
 * resolved source data. Increment 1 keeps risks / client-decisions / next-steps
 * as edited text blocks; the structured-list editor is a later increment.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const requiredDate = z
  .string()
  .trim()
  .regex(ISO_DATE, "Use the date picker — format must be YYYY-MM-DD");

export const createSiteReportSchema = z
  .object({
    job_id: z.string().uuid("Pick a job"),
    title: z.string().trim().min(1, "Give the report a title").max(200),
    period_start: requiredDate,
    period_end: requiredDate,
  })
  .refine((v) => v.period_end >= v.period_start, {
    message: "The end date can't be before the start date",
    path: ["period_end"],
  });
export type CreateSiteReportInput = z.infer<typeof createSiteReportSchema>;

// Which source records the author has chosen to include in this report.
export const reportSourcesSchema = z.object({
  diary_entry_ids: z.array(z.string().uuid()).default([]),
  snag_ids: z.array(z.string().uuid()).default([]),
  toolbox_talk_ids: z.array(z.string().uuid()).default([]),
  photo_attachment_ids: z.array(z.string().uuid()).default([]),
});
export type ReportSources = z.infer<typeof reportSourcesSchema>;

// The editable commentary the author layers over the aggregated data.
export const reportContentSchema = z.object({
  overall_status: optionalText(120),
  current_phase: optionalText(120),
  progress_percent: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).max(100).optional(),
  ),
  summary: optionalText(8000),
  achievements: optionalText(8000),
  work_planned: optionalText(8000),
  programme_notes: optionalText(8000),
  completion_forecast: optionalText(2000),
  weather_notes: optionalText(2000),
  risks: optionalText(8000),
  client_decisions: optionalText(8000),
  next_steps: optionalText(8000),
  sources: reportSourcesSchema.optional(),
});
export type ReportContent = z.infer<typeof reportContentSchema>;

export const siteReportIdSchema = z.string().uuid();

/**
 * The frozen, customer-visible document written to `snapshot` at issue time.
 * It holds the resolved source records (not just their ids) so the report never
 * changes when the underlying diary/snag/toolbox rows are later edited.
 */
export type ReportSnapshot = {
  title: string;
  report_number: string | null;
  revision: number;
  period_start: string;
  period_end: string;
  customer_name: string | null;
  job_label: string | null;
  content: ReportContent;
  sources: {
    diary: Array<Record<string, unknown>>;
    snags: Array<Record<string, unknown>>;
    toolbox_talks: Array<Record<string, unknown>>;
  };
  issued_at: string;
};
