import { z } from "zod";

/**
 * Toolbox Talks — shared input validation.
 *
 * Pure module (no I/O): imported by the server actions AND unit-tested directly
 * (__tests__/toolbox-talks/schema.test.ts). Mirrors the DB in
 * 20260921000000_toolbox_talks.sql and the lifecycle evolution in
 * 20261025000000_health_safety_toolbox_talks.sql (status/reference/key_points/
 * location/ppe/risk_assessment_id/permit_to_work_id).
 *
 * Draft fields are permissive (a talk is captured on a phone, mid-site); the
 * issue-gate — topic + key points — is enforced server-side (canIssue) and again
 * at the DB (tg_tt_a_lifecycle). Shape validation never substitutes for that gate.
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

/**
 * PPE arrives from the form as one comma-separated field ("Hard hat, Harness").
 * Normalise to a trimmed, de-duplicated, bounded string[] — the DB column is
 * text[]. Empty input becomes an empty array (never null), matching the column
 * default and the snapshot builder's contract.
 */
const ppeList = z.preprocess((v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  const items = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(items)].slice(0, 20);
}, z.array(z.string().trim().min(1).max(80)).max(20));

/** The lifecycle-aware fields common to create + edit (draft-mutable). */
const talkFields = {
  talk_date: requiredDate,
  topic: z.string().trim().min(1, "Give the talk a topic").max(200),
  key_points: optionalText(8000), // the briefing substance; required only to issue
  location: optionalText(200),
  job_id: optionalUuid,
  risk_assessment_id: optionalUuid,
  permit_to_work_id: optionalUuid,
  presenter: optionalText(200),
  ppe: ppeList,
  attendees: optionalText(4000),
  attendee_count: optionalCount,
  notes: optionalText(4000),
};

export const createToolboxTalkSchema = z.object(talkFields);
export type CreateToolboxTalkInput = z.infer<typeof createToolboxTalkSchema>;

export const updateToolboxTalkSchema = z.object({
  id: z.string().uuid(),
  ...talkFields,
});
export type UpdateToolboxTalkInput = z.infer<typeof updateToolboxTalkSchema>;

/** Issue ("deliver") + terminal transitions carry only the id; the gate is server-side. */
export const toolboxTalkIdObjectSchema = z.object({ id: z.string().uuid() });

export const toolboxTalkIdSchema = z.string().uuid();
