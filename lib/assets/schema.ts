import { z } from "zod";

/**
 * Asset Management — shared domain constants + input validation (pure).
 *
 * Imported by the server actions AND unit-tested directly. The DB CHECK
 * constraints in 20260924000000_assets.sql are the source of truth for the
 * allowed values; these mirror them.
 */

export const ASSET_OWNERSHIPS = ["owned", "hired"] as const;
export type AssetOwnership = (typeof ASSET_OWNERSHIPS)[number];

export const ASSET_STATUSES = [
  "active",
  "retired",
  "sold",
  "lost",
  "stolen",
  "written_off",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Disposed = no longer in the active fleet. */
export const DISPOSED_STATUSES = [
  "retired",
  "sold",
  "lost",
  "stolen",
  "written_off",
] as const;

export function isDisposed(status: AssetStatus): boolean {
  return (DISPOSED_STATUSES as readonly string[]).includes(status);
}

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  active: "Active",
  retired: "Retired",
  sold: "Sold",
  lost: "Lost",
  stolen: "Stolen",
  written_off: "Written off",
};

export const ASSET_OWNERSHIP_LABELS: Record<AssetOwnership, string> = {
  owned: "Owned",
  hired: "Hired",
};

/** Common starting categories (suggestions only — the column is free text). */
export const ASSET_CATEGORY_SUGGESTIONS = [
  "Vehicle",
  "Plant / machinery",
  "Power tool",
  "Access equipment",
  "Generator / power",
  "Survey equipment",
  "PPE",
  "Welfare / site setup",
  "Container / storage",
  "Other",
] as const;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const optionalUuid = z.preprocess(
  blankToUndefined,
  z.string().uuid().optional(),
);

const optionalDate = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD")
    .optional(),
);

// A money amount: coerces a numeric string, requires >= 0 when present.
const optionalMoney = z.preprocess(
  blankToUndefined,
  z.coerce.number().min(0).max(1_000_000_000).optional(),
);

export const createAssetSchema = z.object({
  name: z.string().trim().min(1, "Give the asset a name").max(200),
  category: optionalText(120),
  asset_ref: optionalText(120),
  manufacturer: optionalText(120),
  model: optionalText(120),
  serial_number: optionalText(120),
  registration: optionalText(60),
  ownership: z.preprocess(
    blankToUndefined,
    z.enum(ASSET_OWNERSHIPS).default("owned"),
  ),
  status: z.preprocess(blankToUndefined, z.enum(ASSET_STATUSES).default("active")),
  supplier_id: optionalUuid,
  purchase_date: optionalDate,
  purchase_price: optionalMoney,
  current_value: optionalMoney,
  warranty_expires_at: optionalDate,
  hire_start: optionalDate,
  hire_end: optionalDate,
  hire_rate: optionalMoney,
  notes: optionalText(4000),
});
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const assetIdSchema = z.string().uuid();
