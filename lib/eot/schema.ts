import { z } from "zod";
import { DELAY_CATEGORIES } from "./lifecycle";

/**
 * Delays & EOT — action input schemas.
 *
 * The database is the authority for tenant, lifecycle, immutability and
 * link-integrity invariants (20261084's triggers + composite FKs); these
 * validate shape/range at the trust boundary before a write is attempted
 * (the lib/quality/schema.ts convention). `delay_events` post-dates the
 * generated Supabase types, so queries cast through lib/eot/pack.ts row
 * shapes rather than pretending the generated types know about it.
 *
 * `workingDaysLost` is the recorder's CLAIM, typed in by hand. Nothing
 * anywhere derives it from the dates — see the migration header for why.
 */

const uuid = z.string().uuid();
const dayKey = z.string().date();

/** "" → null, for optional columns arriving from FormData. */
export function orNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Uppercased, whitespace-stripped outward code — the weather_readings CHECK's shape. */
const weatherDistrict = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase().replace(/\s+/g, ""))
  .refine((s) => s === "" || s === "GIR" || /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(s), {
    message: "Enter a UK postcode district, like LS1 or SW1A",
  });

export const createDelayEventSchema = z.object({
  jobId: uuid,
  category: z.enum(DELAY_CATEGORIES),
  startedOn: dayKey,
  endedOn: dayKey.optional().or(z.literal("")),
  workingDaysLost: z
    .union([z.literal(""), z.coerce.number().int().min(0).max(3650)])
    .optional(),
  description: z.string().trim().min(1, "Describe what happened").max(4000),
  diaryEntryId: uuid.optional().or(z.literal("")),
  variationQuoteId: uuid.optional().or(z.literal("")),
  weatherDistrict: weatherDistrict.optional().or(z.literal("")),
});
export type CreateDelayEventInput = z.infer<typeof createDelayEventSchema>;

export const updateDelayEventSchema = createDelayEventSchema.extend({ id: uuid });

export const delayEventIdSchema = z.object({ id: uuid });

/** Write-once completion of a RECORDED ongoing/unquantified event. */
export const closeDelayEventSchema = z.object({
  id: uuid,
  endedOn: dayKey.optional().or(z.literal("")),
  workingDaysLost: z
    .union([z.literal(""), z.coerce.number().int().min(0).max(3650)])
    .optional(),
});
