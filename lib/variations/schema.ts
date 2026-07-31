/**
 * Variation Order schema + live-preview math.
 *
 * Server/client-safe — no server-only imports.
 *
 * Storage model: variations are quotes with quotes.job_id and
 * quotes.variation_number set. The operator-facing form captures the
 * cost breakdown so margin / revenue can be auto-calculated. We
 * persist the resulting revenue via the existing quote subtotal /
 * vat_total / total columns, and store the cost breakdown as line items
 * (one row per non-zero cost bucket) so the existing PDF + portal flow
 * renders without changes.
 *
 * The cost breakdown is ALSO persisted as-is on the variation row
 * (quotes.cost_labour / cost_materials / cost_subcontractors / cost_misc,
 * migration 20261073) because the apportioned line items only preserve the
 * cost RATIOS — the absolute cost, and therefore the margin the business
 * priced the variation at, used to be thrown away the moment it was created.
 *
 * The completion date this form captures is an EXTENSION OF TIME REQUEST. It
 * is stored in quotes.eot_requested_completion_date, never in
 * quotes.valid_until (the quote-expiry column it used to be written into —
 * see 20261073 for what that cost).
 */

import { z } from "zod";

const nonNegMoney = z.coerce
  .number()
  .min(0, "Cannot be negative")
  .max(1_000_000, "Unrealistic value");

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
);

export const VARIATION_VAT_RATES = [0, 5, 20] as const;
export type VariationVatRate = (typeof VARIATION_VAT_RATES)[number];

export const variationFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: optionalString(5000),
  labour_cost: nonNegMoney,
  materials_cost: nonNegMoney,
  subcontractor_cost: nonNegMoney,
  misc_cost: nonNegMoney,
  margin_pct: z.coerce
    .number()
    .min(-50, "Margin cannot be below -50%")
    .max(95, "Margin cannot exceed 95%"),
  vat_rate: z.coerce.number().refine(
    (v): v is VariationVatRate =>
      (VARIATION_VAT_RATES as readonly number[]).includes(v),
    { message: "VAT must be 0, 5, or 20" },
  ),
  note: optionalString(2000),
  /**
   * Extension-of-time REQUEST: the completion date this variation asks for.
   *
   * Deliberately NOT validated as "must be in the future". EoT claims are
   * routinely made retrospectively in construction (you claim the extension
   * after the delay has happened), so a past date is legitimate data, not a
   * typo. It is also NOT a quote expiry — see the module docblock.
   */
  eot_requested_completion_date: optionalDate,
});

export type VariationFormInput = z.infer<typeof variationFormSchema>;

/**
 * Recording the AGREED extension of time — a separate, later, contractual act.
 *
 * A variation is accepted (money agreed) before an extension is determined, so
 * this is its own action rather than part of the create form. It records ONLY
 * the agreed date; it never moves the job's programme. Whether an agreed EoT
 * re-dates a job is a product decision that has not been made, and guessing it
 * would silently re-date live jobs.
 */
export const variationEotAgreementSchema = z.object({
  eot_agreed_completion_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
});

export type VariationEotAgreementInput = z.infer<typeof variationEotAgreementSchema>;

/**
 * Live-preview math. Given costs + margin %, derive revenue +VAT.
 *
 * Revenue formula:
 *   subtotal (revenue net) = total_cost / (1 - margin/100)
 * This yields the correct margin: profit/revenue × 100 == margin_pct.
 *
 * Edge case: margin >= 100 would divide by zero; the form schema caps at 95.
 * Edge case: margin == 0 → subtotal == total_cost (zero profit). Allowed.
 * Edge case: negative margin → revenue < cost (loss-leader). Allowed.
 */
export type VariationComputation = {
  total_cost: number;
  cost_breakdown: {
    labour: number;
    materials: number;
    subcontractors: number;
    misc: number;
  };
  subtotal: number;
  vat_total: number;
  total: number;
  gross_profit: number;
  margin_pct: number;
};

export function computeVariation(
  input: Pick<
    VariationFormInput,
    | "labour_cost"
    | "materials_cost"
    | "subcontractor_cost"
    | "misc_cost"
    | "margin_pct"
    | "vat_rate"
  >,
): VariationComputation {
  const labour = Math.max(0, Number(input.labour_cost) || 0);
  const materials = Math.max(0, Number(input.materials_cost) || 0);
  const subs = Math.max(0, Number(input.subcontractor_cost) || 0);
  const misc = Math.max(0, Number(input.misc_cost) || 0);
  const total_cost = labour + materials + subs + misc;
  const margin = Number(input.margin_pct) || 0;
  const vat = Number(input.vat_rate) || 0;
  // Guard against division-by-zero or near-zero — clamp denominator.
  const denominator = 1 - margin / 100;
  const subtotal =
    denominator <= 0
      ? Math.round((total_cost * 1.95) * 100) / 100 // fallback at margin>=95 (shouldn't reach via form)
      : Math.round((total_cost / denominator) * 100) / 100;
  const vat_total = Math.round(subtotal * (vat / 100) * 100) / 100;
  const total = Math.round((subtotal + vat_total) * 100) / 100;
  const gross_profit = Math.round((subtotal - total_cost) * 100) / 100;
  const margin_pct =
    subtotal === 0 ? 0 : Math.round((gross_profit / subtotal) * 100);
  return {
    total_cost,
    cost_breakdown: {
      labour,
      materials,
      subcontractors: subs,
      misc,
    },
    subtotal,
    vat_total,
    total,
    gross_profit,
    margin_pct,
  };
}

/** Render `Variation #003` for a numeric. */
export function formatVariationLabel(n: number): string {
  return `Variation #${String(n).padStart(3, "0")}`;
}
