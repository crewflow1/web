import { z } from "zod";

/**
 * Site Diary — shared domain helpers + input validation.
 *
 * Pure module (no I/O): imported by the server actions AND unit-tested directly
 * (__tests__/site-diary/schema.test.ts). The DB CHECK/typing in
 * 20260920000000_site_diary.sql is the source of truth; these mirror it.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format an ISO date ("2026-07-18") as "18 Jul 2026" — deterministic, no locale
 * or Date/timezone dependency (so it can't drift and is trivially testable).
 * Returns the input unchanged if it isn't a well-formed ISO date.
 */
export function formatDiaryDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const year = m[1];
  const month = MONTHS[Number(m[2]) - 1];
  const day = String(Number(m[3]));
  if (!month) return iso;
  return `${day} ${month} ${year}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Treat blank/whitespace as absent BEFORE validation (see lib/snags/schema.ts).
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const optionalUuid = z.preprocess(
  blankToUndefined,
  z.string().uuid().optional(),
);

// Headcount: a form sends "" (absent), "5", or garbage. Coerce, require a
// non-negative integer when present.
const optionalCount = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().min(0).max(100000).optional(),
);

const requiredDate = z
  .string()
  .trim()
  .regex(ISO_DATE, "Use the date picker — format must be YYYY-MM-DD");

export const createDiaryEntrySchema = z.object({
  entry_date: requiredDate,
  job_id: optionalUuid,
  weather: optionalText(200),
  labour_count: optionalCount,
  work_summary: optionalText(8000),
  delays: optionalText(4000),
  notes: optionalText(4000),
});
export type CreateDiaryEntryInput = z.infer<typeof createDiaryEntrySchema>;

export const updateDiaryEntrySchema = createDiaryEntrySchema.extend({
  id: z.string().uuid(),
});

export const diaryIdSchema = z.string().uuid();
