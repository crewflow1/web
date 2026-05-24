import { z } from "zod";

/**
 * Phase D — Supplier + expense-draft schemas.
 *
 * Pure module — imported by both server actions and tests.
 */

export const supplierFormSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  phone: z.string().trim().max(50).optional().or(z.literal("").transform(() => undefined)),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email")
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  category: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
});

export type SupplierFormInput = z.infer<typeof supplierFormSchema>;

export const expenseDraftApproveSchema = z.object({
  draft_id: z.string().uuid(),
  supplier_id: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  amount: z.coerce.number().min(0).max(10_000_000),
  vat_rate: z.coerce.number().refine((v) => v === 0 || v === 5 || v === 20, "VAT rate must be 0, 5 or 20"),
  category: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
});
