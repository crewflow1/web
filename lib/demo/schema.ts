/**
 * Demo-request form schema. Used by the landing-page modal + server action.
 * Trim + lowercase the email; collapse blank optionals to undefined.
 */

import { z } from "zod";

const trimmed = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().min(1, "Required").max(max),
  );

const optionalTrimmed = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const STAFF_COUNT_OPTIONS = [
  "Just me",
  "2-5",
  "6-10",
  "11-25",
  "26-50",
  "50+",
] as const;
export type StaffCountOption = (typeof STAFF_COUNT_OPTIONS)[number];

export const demoRequestSchema = z.object({
  name: trimmed(120),
  company: trimmed(160),
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string().email("Enter a valid email"),
  ),
  phone: trimmed(40),
  staff_count: z.enum(STAFF_COUNT_OPTIONS, {
    errorMap: () => ({ message: "Pick a team size" }),
  }),
  current_systems: optionalTrimmed(500),
  preferred_demo_time: optionalTrimmed(200),
});
export type DemoRequestInput = z.infer<typeof demoRequestSchema>;
