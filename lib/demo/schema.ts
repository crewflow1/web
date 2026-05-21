/**
 * Demo-request form schema. Lives at /lib/demo so it's importable by the
 * public landing-page form and the server action (no app-level coupling).
 */

import { z } from "zod";

const trimmed = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().min(1, "required").max(max),
  );

const optionalTrimmed = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const EMPLOYEE_RANGES = ["1", "2-5", "6-10", "11-25", "26-50", "50+"] as const;
export const TURNOVER_RANGES = [
  "under_100k",
  "100k_500k",
  "500k_1m",
  "1m_5m",
  "5m_plus",
  "prefer_not_say",
] as const;

export const TURNOVER_LABELS: Record<(typeof TURNOVER_RANGES)[number], string> = {
  under_100k: "Under £100k",
  "100k_500k": "£100k – £500k",
  "500k_1m": "£500k – £1m",
  "1m_5m": "£1m – £5m",
  "5m_plus": "£5m+",
  prefer_not_say: "Prefer not to say",
};

export const demoRequestSchema = z.object({
  name: trimmed(120),
  company: trimmed(160),
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string().email("Enter a valid email"),
  ),
  phone: optionalTrimmed(40),
  employees: z.enum(EMPLOYEE_RANGES, { errorMap: () => ({ message: "Pick an employee range" }) }),
  turnover_range: z.enum(TURNOVER_RANGES).optional(),
  current_systems: optionalTrimmed(500),
  preferred_demo_time: optionalTrimmed(200),
});

export type DemoRequestInput = z.infer<typeof demoRequestSchema>;
