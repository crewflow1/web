import { z } from "zod";

/**
 * OPERATIONAL STOCK — input validation and Postgres-error translation. PURE.
 *
 * THE ACCOUNTING BOUNDARY (full statement in lib/stock/movements.ts): quantity
 * only. No form in this milestone collects a price, a cost or a VAT rate, and
 * nothing in `lib/stock` can reach `finances` — purchased materials are already
 * expensed by recordSupplierBill, so a stock movement posts no new cost.
 *
 * `supabase/migrations/20261063000000_stock_items.sql` and `…64…` are the
 * source of truth for bounds and allowed values; everything here mirrors them
 * so a user sees a sentence instead of a Postgres error. Where the DB is
 * deliberately lenient (a unit is free text, not an enum) so is this.
 */

export const STOCK_ITEM_NAME_MAX = 200;
export const STOCK_UNIT_MAX = 24;
export const STOCK_SKU_MAX = 64;
/** Manufacturer/EAN/UPC scannable code — its own identifier, not the sku. */
export const STOCK_BARCODE_MAX = 64;

/**
 * Units a UK builder actually says, offered as a datalist rather than a select.
 * NOT an allowlist — the column is free text on purpose (the registration/VIN
 * lesson: an over-tight rule on a vocabulary you do not control is a support
 * trap). Typing "lin m" or "pack of 100" must always work.
 */
export const COMMON_STOCK_UNITS = [
  "ea",
  "bag",
  "box",
  "pack",
  "roll",
  "sheet",
  "tub",
  "tube",
  "length",
  "m",
  "m2",
  "m3",
  "kg",
  "tonne",
  "litre",
] as const;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/** A quantity field: blank → undefined, otherwise a non-negative 2dp number. */
const optionalQuantity = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ invalid_type_error: "Use a number" })
    .nonnegative("A level can't be negative")
    .max(9_999_999, "That's too big")
    .optional(),
);

/**
 * A re-order BATCH field: blank → undefined, otherwise a strictly POSITIVE 2dp
 * number. Mirrors the DB CHECK (reorder_quantity > 0, 20261107000000): a reorder
 * level of 0 is meaningful ("flag at zero"), but re-ordering 0 units is not.
 */
const optionalPositiveQuantity = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ invalid_type_error: "Use a number" })
    .positive("How many to re-order must be above zero")
    .max(9_999_999, "That's too big")
    .optional(),
);

/**
 * The add / edit form for a catalogue item, validated as ONE shape so create
 * and edit can never drift into accepting different fields.
 *
 * `active` is NOT here: retiring an item is its own deliberate act with its own
 * button and its own copy, not a checkbox someone flips by accident while
 * fixing a unit.
 */
export const stockItemFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give the item a name — what people actually call it")
      .max(STOCK_ITEM_NAME_MAX, `Keep the name under ${STOCK_ITEM_NAME_MAX} characters`),
    description: optionalText(2000),
    sku: optionalText(STOCK_SKU_MAX),
    // The scannable code on the product. Distinct from `sku` (the company's own
    // code); scan-to-find matches either. Mirrors stock_items.barcode
    // (20261144000000): nullable, bounded, unique per org where present.
    barcode: optionalText(STOCK_BARCODE_MAX),
    unit: z
      .string()
      .trim()
      .min(1, "Say what it is counted in — bags, sheets, metres")
      .max(STOCK_UNIT_MAX, `Keep the unit under ${STOCK_UNIT_MAX} characters`),
    preferred_supplier_id: z.preprocess(
      blankToUndefined,
      z.string().uuid("Pick a supplier from the list").optional(),
    ),
    supplier_reference: optionalText(120),
    reorder_level: optionalQuantity,
    target_level: optionalQuantity,
    reorder_quantity: optionalPositiveQuantity,
    notes: optionalText(2000),
  })
  .refine(
    (d) =>
      d.reorder_level === undefined ||
      d.target_level === undefined ||
      d.target_level >= d.reorder_level,
    {
      // Not a database constraint: a target below the reorder level is odd but
      // never dangerous, and a CHECK would need a migration to relax if some
      // real workflow wanted it. Caught here, where it is a hint, not a wall.
      message: "The target level should be at least the reorder level",
      path: ["target_level"],
    },
  );

export type StockItemFormInput = z.infer<typeof stockItemFormSchema>;

export const stockIdSchema = z.string().uuid();

/** A movement quantity: strictly positive, matching the DB CHECK (qty > 0). */
export const movementQuantitySchema = z.coerce
  .number({ invalid_type_error: "Enter a quantity" })
  .positive("The quantity must be above zero")
  .max(9_999_999, "That's too big");

export const issueFormSchema = z.object({
  stock_item_id: z.string().uuid("Pick an item"),
  site_id: z.string().uuid("Pick where it is coming from"),
  qty: movementQuantitySchema,
  job_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  notes: optionalText(2000),
});

export const transferFormSchema = z
  .object({
    stock_item_id: z.string().uuid("Pick an item"),
    from_site_id: z.string().uuid("Pick where it is coming from"),
    to_site_id: z.string().uuid("Pick where it is going"),
    qty: movementQuantitySchema,
    notes: optionalText(2000),
  })
  .refine((d) => d.from_site_id !== d.to_site_id, {
    message: "Pick two different places",
    path: ["to_site_id"],
  });

/**
 * An adjustment. `delta` is SIGNED and may not be zero — the sign IS the
 * meaning ("found 12 more" vs "12 short"), and a reason is required here for
 * the same reason the database requires it: an adjustment is the one movement
 * with no counterparty, so the reason is the only record of why the number
 * changed.
 */
export const adjustmentFormSchema = z.object({
  stock_item_id: z.string().uuid("Pick an item"),
  site_id: z.string().uuid("Pick where you counted"),
  delta: z.coerce
    .number({ invalid_type_error: "Enter how far out it was" })
    .refine((n) => n !== 0, "An adjustment of zero changes nothing")
    .refine((n) => Math.abs(n) <= 9_999_999, "That's too big"),
  reason: z
    .string()
    .trim()
    .min(1, "Say why the number is changing — it is the only record of it")
    .max(2000, "Keep the reason under 2000 characters"),
});

export const receiveIntoStockSchema = z.object({
  grn_line_id: z.string().uuid(),
  stock_item_id: z.string().uuid("Pick which stock item this is"),
  site_id: z.string().uuid("Pick where it is being put"),
});

export const correctionFormSchema = z.object({
  movement_id: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Say why this movement is being reversed")
    .max(2000, "Keep the reason under 2000 characters"),
});

/**
 * Translate a Postgres refusal into a sentence.
 *
 * The DATABASE is the enforcement boundary (20261063 to 65); this only decides
 * wording, so an unmapped code still fails loudly with a generic message rather
 * than silently. The RAISE messages from the stock RPCs are written for the
 * person standing in the yard, so the ones we own are surfaced nearly as-is;
 * anything unrecognised falls back, because a raw driver error must never reach
 * a phone screen.
 */
export function friendlyStockError(
  code: string | undefined,
  message: string | undefined,
): string {
  const m = (message ?? "").trim();

  if (code === "23505" || /duplicate key/i.test(m)) {
    if (/stock_items_org_sku_unique/.test(m)) {
      return "You already have an item with that code. Codes are matched ignoring capitals.";
    }
    if (/stock_items_org_barcode_unique/.test(m)) {
      return "You already have an item with that barcode. Barcodes are matched ignoring capitals.";
    }
    if (/stock_movements_corrects_uniq/.test(m)) {
      return "That movement has already been corrected once. Record an adjustment instead.";
    }
    if (/stock_movements_grn_line_receipt_uniq/.test(m)) {
      return "That delivery line is already in stock.";
    }
    return "You already have an item with that name. Names are matched ignoring capitals, so “Cement 25kg” and “cement 25kg” count as the same thing.";
  }

  if (/not enough /.test(m)) {
    // The RPC's own message already names the item and both numbers.
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}. Book the delivery in first, or record an adjustment if the count is wrong.`;
  }
  if (/only an owner or admin/.test(m)) {
    return "Only an owner or admin can adjust stock. Ask one of them to record the count.";
  }
  if (/stock item not found/.test(m)) return "That item isn’t in the company you’re working in.";
  if (/site not found/.test(m)) return "That site isn’t in the company you’re working in.";
  if (/delivery line not found/.test(m)) return "That delivery line isn’t in the company you’re working in.";
  if (/stock movement not found/.test(m)) return "That movement isn’t in the company you’re working in.";
  if (/post it before taking it into stock/.test(m)) {
    return "Post the delivery before taking it into stock.";
  }
  if (/for a specific job/.test(m)) {
    return "This order is for a specific job — its materials are costed to that job when you record the supplier bill, so it isn’t taken into shared stock.";
  }
  if (/is in stock \(/.test(m)) {
    return "This delivery is already in stock. Correct the stock receipt first, then void the delivery.";
  }
  if (/needs a reason/.test(m)) return "Say why the number is changing.";
  if (/adjustment of zero/.test(m)) return "An adjustment of zero changes nothing.";
  if (/two different sites/.test(m)) return "Pick two different places.";
  if (/above zero/.test(m)) return "Enter a quantity above zero.";
  if (/already been used/.test(m)) {
    return "Some of that has already been used, so it can’t be reversed in full. Record an adjustment with a reason instead.";
  }
  if (/leg of a transfer/.test(m)) {
    return "That’s one leg of a transfer. Move it back with a transfer the other way — reversing a single leg would create stock at one site.";
  }
  if (/is immutable/.test(m) || /append-only/.test(m)) {
    return "Stock movements can’t be edited or deleted — record a correction instead.";
  }
  if (code === "23514" || code === "check_violation") {
    return "That isn’t allowed as entered. Check the quantity and try again.";
  }
  if (code === "23503") {
    return "Something this points at isn’t there any more. Refresh the page and try again.";
  }
  return "Couldn’t record that. Try again.";
}
