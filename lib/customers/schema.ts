/**
 * Shared validation for the customers form.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

export const customerFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z
    .string()
    .trim()
    .max(254)
    .email("Doesn't look like a valid email")
    .or(z.literal("").transform(() => undefined))
    .optional(),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type CustomerFormInput = z.infer<typeof customerFormSchema>;
