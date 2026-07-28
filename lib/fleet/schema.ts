import { z } from "zod";

/**
 * Fleet — shared domain constants + input validation (pure).
 *
 * Imported by the server actions AND unit-tested directly. The DB CHECK
 * constraints in 20261056000000_fleet_vehicles.sql and
 * 20261058000000_asset_fuel_logs.sql are the source of truth for allowed
 * values; these mirror them. Where the DB is deliberately lenient (an
 * externally-issued VIN, a free-text depot) so is this.
 *
 * A vehicle is an ASSET plus this extension, so a "create vehicle" input
 * carries BOTH halves: the asset fields (name, registration, make, model…)
 * validated against the asset schema's rules, and the vehicle-only fields
 * below. The action writes the two rows in one transactional RPC.
 */

export const FUEL_TYPES = [
  "diesel",
  "petrol",
  "electric",
  "hybrid",
  "plug_in_hybrid",
  "hydrogen",
  "lpg",
  "other",
] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  diesel: "Diesel",
  petrol: "Petrol",
  electric: "Electric",
  hybrid: "Hybrid",
  plug_in_hybrid: "Plug-in hybrid",
  hydrogen: "Hydrogen",
  lpg: "LPG",
  other: "Other",
};

/** UK construction fleet shapes — a tipper is not a "truck". */
export const VEHICLE_CLASSES = [
  "car",
  "van",
  "pickup",
  "tipper",
  "luton",
  "flatbed",
  "minibus",
  "hgv_rigid",
  "hgv_artic",
  "plant_transporter",
  "trailer",
  "other",
] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const VEHICLE_CLASS_LABELS: Record<VehicleClass, string> = {
  car: "Car",
  van: "Van",
  pickup: "Pickup",
  tipper: "Tipper",
  luton: "Luton",
  flatbed: "Flatbed",
  minibus: "Minibus",
  hgv_rigid: "HGV (rigid)",
  hgv_artic: "HGV (artic)",
  plant_transporter: "Plant transporter",
  trailer: "Trailer",
  other: "Other",
};

/**
 * Operational availability — NOT the asset lifecycle. Disposal (sold, written
 * off, retired, stolen) lives on `assets.status` and is never duplicated here;
 * see the 20261056000000 header.
 */
export const OPERATIONAL_STATUSES = ["in_service", "off_road", "in_workshop"] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export const OPERATIONAL_STATUS_LABELS: Record<OperationalStatus, string> = {
  in_service: "In service",
  off_road: "Off road",
  in_workshop: "In workshop",
};

/** Orthogonal to assets.ownership (owned|hired) — the agreement behind it. */
export const FINANCE_TYPES = [
  "none",
  "hire_purchase",
  "lease",
  "contract_hire",
  "daily_rental",
] as const;
export type FinanceType = (typeof FINANCE_TYPES)[number];

export const FINANCE_TYPE_LABELS: Record<FinanceType, string> = {
  none: "Owned outright / no agreement",
  hire_purchase: "Hire purchase",
  lease: "Lease",
  contract_hire: "Contract hire",
  daily_rental: "Daily rental",
};

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const optionalUuid = z.preprocess(blankToUndefined, z.string().uuid().optional());

const optionalDate = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD")
    .optional(),
);

const requiredDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD");

const optionalMoney = z.preprocess(
  blankToUndefined,
  z.coerce.number().min(0).max(1_000_000_000).optional(),
);

/** Odometer in miles. Same bound as the DB CHECK (0 … 3,000,000). */
const optionalOdometer = z.preprocess(
  blankToUndefined,
  z.coerce.number().int("Mileage must be a whole number").min(0).max(3_000_000).optional(),
);

/**
 * VIN — uppercased before validation because nobody types a V5C in caps.
 * Real VINs exclude I, O and Q. The bound is 11-17 (modern VINs are 17; older
 * and imported plant run shorter), matching the DB CHECK exactly.
 */
const optionalVin = z.preprocess(
  (v) => {
    const cleaned = typeof v === "string" ? v.replace(/[\s-]/g, "").toUpperCase() : v;
    return blankToUndefined(cleaned);
  },
  z
    .string()
    .regex(
      /^[A-HJ-NPR-Z0-9]{11,17}$/,
      "A VIN is 11-17 letters and digits (no I, O or Q)",
    )
    .optional(),
);

/**
 * UK registration — normalised to uppercase with spaces stripped so
 * "ab12 cde" and "AB12CDE" are the same vehicle to a search. Deliberately NOT
 * regex-pinned to the current format: the register also holds pre-2001 plates,
 * Northern Irish plates, trailers and imports, and an over-tight CHECK on a
 * plate is a support trap. `assets.registration` is the storage column.
 */
export const registrationSchema = z.preprocess(
  (v) => {
    const cleaned = typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : v;
    return blankToUndefined(cleaned);
  },
  z.string().trim().min(2, "Enter the registration").max(20).optional(),
);

export function normaliseRegistration(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/\s+/g, "").toUpperCase();
  return cleaned.length === 0 ? null : cleaned;
}

/** The asset half + the vehicle half, validated as one form. */
export const vehicleFormSchema = z
  .object({
    // → public.assets
    name: z.string().trim().min(1, "Give the vehicle a name").max(200),
    registration: registrationSchema,
    manufacturer: optionalText(120),
    model: optionalText(120),
    supplier_id: optionalUuid,
    purchase_date: optionalDate,
    purchase_price: optionalMoney,
    notes: optionalText(4000),

    // → public.fleet_vehicles
    vin: optionalVin,
    variant: optionalText(120),
    year_of_manufacture: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1900).max(2100).optional(),
    ),
    first_registered_on: optionalDate,
    fuel_type: z.preprocess(blankToUndefined, z.enum(FUEL_TYPES).optional()),
    vehicle_class: z.preprocess(blankToUndefined, z.enum(VEHICLE_CLASSES).optional()),
    gross_weight_kg: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(100_000).optional(),
    ),
    mot_exempt: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
    operational_status: z.preprocess(
      blankToUndefined,
      z.enum(OPERATIONAL_STATUSES).default("in_service"),
    ),
    finance_type: z.preprocess(blankToUndefined, z.enum(FINANCE_TYPES).default("none")),
    finance_provider_id: optionalUuid,
    finance_agreement_ref: optionalText(120),
    finance_monthly_payment: optionalMoney,
    finance_end_date: optionalDate,
    home_depot: optionalText(160),
    odometer_miles: optionalOdometer,
  })
  /**
   * Mirrors fleet_vehicles_finance_coherence_check so the user sees a sentence
   * instead of a Postgres error. The DB remains the enforcement boundary —
   * this is the courtesy layer, never the control.
   */
  .refine(
    (d) =>
      d.finance_type !== "none" ||
      (!d.finance_provider_id &&
        !d.finance_agreement_ref &&
        d.finance_monthly_payment == null &&
        !d.finance_end_date),
    {
      message:
        "Agreement details need a finance type — pick one, or clear the provider, reference, payment and end date.",
      path: ["finance_type"],
    },
  );

export type VehicleFormInput = z.infer<typeof vehicleFormSchema>;

/** A fuel / charge entry. */
export const fuelLogSchema = z
  .object({
    asset_id: z.string().uuid(),
    filled_on: requiredDate,
    odometer_miles: optionalOdometer,
    litres: z.preprocess(
      blankToUndefined,
      z.coerce.number().positive("Litres must be more than zero").max(100_000).optional(),
    ),
    cost: z.coerce.number().min(0, "Cost cannot be negative").max(1_000_000),
    is_full_fill: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
    supplier_id: optionalUuid,
    station: optionalText(160),
    driver_id: optionalUuid,
    notes: optionalText(2000),
  })
  // Mirrors asset_fuel_logs_substance_check.
  .refine((d) => d.litres != null || d.cost > 0, {
    message: "Enter the litres, the cost, or both — an empty entry records nothing.",
    path: ["cost"],
  });

export type FuelLogInput = z.infer<typeof fuelLogSchema>;

export const vehicleIdSchema = z.string().uuid();
