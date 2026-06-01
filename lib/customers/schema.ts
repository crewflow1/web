/**
 * Shared validation for the customers form.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));
}

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
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(100),
  county: optionalText(100),
  postcode: optionalText(20),
  country: optionalText(100),
});

export type CustomerFormInput = z.infer<typeof customerFormSchema>;
