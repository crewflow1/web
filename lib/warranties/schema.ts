import { z } from "zod";

/**
 * Warranty form schema (Phase 7). Server/client-safe — no server-only imports.
 *
 * Mirrors the CHECK constraints in 20261079 so an invalid warranty is refused
 * twice: once with a sentence the operator can act on, once by Postgres. There
 * is deliberately no start-date or expiry field — both are derived from the
 * job's issued completion certificate (see lib/warranties/schedule.ts).
 */

export const WARRANTY_KINDS = [
  "workmanship",
  "product",
  "structural",
  "defects_liability",
  "other",
] as const;
export type WarrantyKind = (typeof WARRANTY_KINDS)[number];

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const warrantyFormSchema = z.object({
  title: z.string().trim().min(1, "Give the warranty a title").max(200),
  kind: z.enum(WARRANTY_KINDS),
  cover: z
    .string()
    .trim()
    .min(1, "Say what this warranty covers — the customer sees this")
    .max(4000),
  exclusions: optionalText(4000),
  provider: optionalText(200),
  reference: optionalText(120),
  period_months: z.coerce
    .number()
    .int("Whole months only")
    .min(1, "A warranty must run for at least one month")
    .max(600, "That's over 50 years — check the figure"),
  /** Empty = no servicing obligation. */
  service_interval_months: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce
      .number()
      .int("Whole months only")
      .min(1, "A servicing interval must be at least one month")
      .max(120, "That's over 10 years — check the figure")
      .optional(),
  ),
  service_notes: optionalText(2000),
});

export type WarrantyFormInput = z.infer<typeof warrantyFormSchema>;

export const warrantyVoidSchema = z.object({
  void_reason: z
    .string()
    .trim()
    .min(1, "Say why this warranty is being withdrawn")
    .max(1000),
});

export const warrantyIdSchema = z.string().uuid();
