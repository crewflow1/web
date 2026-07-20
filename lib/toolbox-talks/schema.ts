import { z } from "zod";

/**
 * Toolbox Talks — shared input validation.
 *
 * Pure module (no I/O): imported by the server actions AND unit-tested directly
 * (__tests__/toolbox-talks/schema.test.ts). Mirrors the DB in
 * 20260921000000_toolbox_talks.sql.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const optionalUuid = z.preprocess(
  blankToUndefined,
  z.string().uuid().optional(),
);

const optionalCount = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().min(0).max(100000).optional(),
);

const requiredDate = z
  .string()
  .trim()
  .regex(ISO_DATE, "Use the date picker — format must be YYYY-MM-DD");

export const createToolboxTalkSchema = z.object({
  talk_date: requiredDate,
  topic: z.string().trim().min(1, "Give the talk a topic").max(200),
  job_id: optionalUuid,
  presenter: optionalText(200),
  attendees: optionalText(4000),
  attendee_count: optionalCount,
  notes: optionalText(4000),
});
export type CreateToolboxTalkInput = z.infer<typeof createToolboxTalkSchema>;

export const toolboxTalkIdSchema = z.string().uuid();
