/**
 * Shared, server/client-safe schema + types for job templates.
 *
 * No server-only imports — used by both the template form (client) and the
 * template server actions.
 */

import { z } from "zod";
import { JOB_STATUSES } from "./schema";

/** Milestone/checklist form rows offered per template. */
export const TEMPLATE_MILESTONE_ROWS = 8;
export const TEMPLATE_CHECKLIST_ROWS = 10;

export const templateHeaderSchema = z.object({
  name: z.string().trim().min(1, "A template needs a name").max(200),
  job_type: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  default_status: z
    .enum(JOB_STATUSES)
    .or(z.literal("").transform(() => undefined))
    .optional(),
});

export type TemplateHeaderInput = z.infer<typeof templateHeaderSchema>;

export interface TemplateMilestonePayload {
  title: string;
  offset_start_days: number | null;
  offset_end_days: number;
  weight: number | null;
  customer_visible: boolean;
}

export interface TemplateChecklistPayload {
  label: string;
  requires_photo: boolean;
}

/** A non-negative whole-day offset, or null for a blank field. */
export function parseOffset(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return NaN as unknown as number;
  return n;
}
