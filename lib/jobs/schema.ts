/**
 * Shared schema for the job create/update form.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

export const JOB_STATUSES = ["new", "in-progress", "completed", "blocked"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_RECURRING_PATTERNS = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
] as const;
export type JobRecurringPattern = (typeof JOB_RECURRING_PATTERNS)[number];

export const jobFormSchema = z.object({
  customer_id: z
    .string()
    .uuid()
    .or(z.literal("").transform(() => undefined))
    .optional(),
  assigned_to: z
    .string()
    .uuid()
    .or(z.literal("").transform(() => undefined))
    .optional(),
  status: z.enum(JOB_STATUSES),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .or(z.literal("").transform(() => undefined))
    .optional(),
  notes: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  recurring_pattern: z
    .enum(JOB_RECURRING_PATTERNS)
    .or(z.literal("").transform(() => undefined))
    .optional(),
  recurring_end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .or(z.literal("").transform(() => undefined))
    .optional(),
});

export type JobFormInput = z.infer<typeof jobFormSchema>;

/**
 * Canonical builder for a job detail route.
 *
 * The job detail page resolves on the full job UUID (`.eq("id", id)`), so the
 * href MUST use the complete id. Never truncate the id for the link target —
 * a shortened id (e.g. the first 8 chars) produces a 404. Use a separate,
 * human-friendly label for display instead of the raw URL.
 */
export function jobHref(jobId: string): string {
  return `/jobs/${jobId}`;
}
