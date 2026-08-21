/**
 * Org configuration — pure schema, defaults + normalisers (server/client-safe).
 *
 * The single source of truth for the shape of `public.org_settings`:
 *   • working hours  — a structured per-weekday config other features read for
 *                      scheduling defaults (replacing the free-text hours that
 *                      only existed inside AI-receptionist setup);
 *   • tax & defaults — default VAT rate, CIS default rate, financial-year start
 *                      month, default payment terms.
 *
 * NO server-only imports (no Supabase, no `server-only`): the hermetic unit +
 * security tiers import this to prove the defaults / validation contracts, and
 * both the read service and the write actions share it so a form and a reader
 * can never disagree about the shape.
 */

import { z } from "zod";
import {
  VAT_STAGGERS,
  DEFAULT_VAT_STAGGER,
  VAT_SCHEMES,
  DEFAULT_VAT_SCHEME,
  DEFAULT_FLAT_RATE_CONFIG,
  type VatStagger,
  type VatScheme,
  type FlatRateSchemeConfig,
} from "@/lib/tax/compute";

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

/** Canonical weekday keys, Monday-first, as stored in the jsonb blob. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** A single working day's open/close window, in 24h "HH:MM". */
export type DayHours = { open: string; close: string };

/**
 * The working-hours config: one entry per weekday. `null` means the day is a
 * non-working / closed day; an object is the open→close window for that day.
 */
export type WorkingHours = Record<Weekday, DayHours | null>;

/** "HH:MM" 24-hour clock, 00:00 to 23:59. */
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeSchema = z.string().regex(TIME_RX, "Use a 24-hour time like 08:00");

/**
 * A day is EITHER closed (null) OR an { open, close } window where close is
 * strictly after open (a zero-length or inverted window is a data error, not a
 * silently-accepted empty day).
 */
const dayHoursSchema = z
  .object({ open: timeSchema, close: timeSchema })
  .refine((d) => d.open < d.close, {
    message: "Closing time must be after opening time",
    path: ["close"],
  });

export const workingHoursSchema = z.object(
  Object.fromEntries(
    WEEKDAYS.map((d) => [d, dayHoursSchema.nullable()]),
  ) as Record<Weekday, z.ZodNullable<typeof dayHoursSchema>>,
);

/** Default working hours — Mon–Fri 08:00 to 17:00, weekend closed. */
export function defaultWorkingHours(): WorkingHours {
  const weekday: DayHours = { open: "08:00", close: "17:00" };
  return {
    mon: { ...weekday },
    tue: { ...weekday },
    wed: { ...weekday },
    thu: { ...weekday },
    fri: { ...weekday },
    sat: null,
    sun: null,
  };
}

/**
 * Coerce an unknown jsonb value (a stored row, or an untrusted payload) into a
 * valid WorkingHours. Anything that does not parse — a scalar, a missing day, a
 * malformed window — falls back to the default so a reader ALWAYS gets a complete
 * 7-day config. Callers that need to REJECT bad input (the write action) use
 * `workingHoursSchema` directly instead; this is the lenient READ path.
 */
export function normalizeWorkingHours(value: unknown): WorkingHours {
  const parsed = workingHoursSchema.safeParse(value);
  return parsed.success ? (parsed.data as WorkingHours) : defaultWorkingHours();
}

// ---------------------------------------------------------------------------
// Tax & defaults
// ---------------------------------------------------------------------------

/** VAT rates the app recognises everywhere (the existing hardcoded 0/5/20). */
export const VAT_RATES = [0, 5, 20] as const;
export type VatRate = (typeof VAT_RATES)[number];

/** CIS deduction rates: 0 gross, 20 registered, 30 higher/unverified. */
export const CIS_RATES = [0, 20, 30] as const;
export type CisRate = (typeof CIS_RATES)[number];

export const CIS_RATE_LABEL: Record<CisRate, string> = {
  0: "0% — Gross payment status",
  20: "20% — Registered subcontractor",
  30: "30% — Unverified / higher rate",
};

export const MONTH_LABEL: Record<number, string> = {
  1: "January",
  2: "February",
  3: "March",
  4: "April",
  5: "May",
  6: "June",
  7: "July",
  8: "August",
  9: "September",
  10: "October",
  11: "November",
  12: "December",
};

/**
 * HMRC VAT return period cadence ("stagger"). The valid values + the period math
 * are owned by the single VAT authority (lib/tax/compute.ts); this module only
 * validates the stored org_settings column against that authority's list.
 */
export const VAT_STAGGER_LABEL: Record<VatStagger, string> = {
  group_1: "Quarterly — group 1 (periods end Mar / Jun / Sep / Dec)",
  group_2: "Quarterly — group 2 (periods end Apr / Jul / Oct / Jan)",
  group_3: "Quarterly — group 3 (periods end Feb / May / Aug / Nov)",
  monthly: "Monthly",
};

/**
 * VAT accounting SCHEME (output-VAT basis). The valid values + the branch math are
 * owned by the single VAT authority (lib/tax/compute.ts); this only validates the
 * stored org_settings column. `cash` is the DEFAULT — the existing behaviour, so no
 * org's numbers move until it opts in.
 */
export const VAT_SCHEME_LABEL: Record<VatScheme, string> = {
  cash: "Cash accounting — output VAT when paid (default)",
  standard: "Standard / accrual — output VAT at the invoice date",
};

export type TaxDefaults = {
  default_vat_rate: VatRate;
  cis_default_rate: CisRate;
  financial_year_start_month: number;
  default_payment_terms_days: number;
  vat_stagger: VatStagger;
  vat_scheme: VatScheme;
};

// ---------------------------------------------------------------------------
// Flat Rate Scheme (FRS) config
// ---------------------------------------------------------------------------

/** An optional YYYY-MM-DD date, or null. Empty string / bad input ⇒ null. */
const optionalIsoDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-01")
    .nullable()
    .default(null),
);

/**
 * The FRS config blob stored in org_settings.flat_rate_config (jsonb). Structurally
 * the engine's FlatRateSchemeConfig (lib/tax/compute.ts owns the computation). The
 * DB default is a DISABLED config, so FRS never applies until an org opts in and no
 * existing tenant's VAT numbers change.
 */
/**
 * HMRC FRS sector rates run from 4% up to 16.5% (limited-cost). We accept the
 * slightly wider 1%–16.5% band as valid WHEN FRS IS ENABLED (see the superRefine
 * below) — the 1% floor catches a first-year-discounted low sector rate, and 16.5%
 * is the highest possible flat rate. The bare field still allows 0 so a DISABLED
 * config keeps its 0 default; the cross-field rule only bites when enabled.
 */
const FRS_SECTOR_MIN = 1;
const FRS_SECTOR_MAX = 16.5;

export const flatRateConfigSchema = z
  .object({
    enabled: z.coerce.boolean().default(false),
    // Bare bound is generous (0 to 20); the enabled-only band is enforced below.
    sector_percent: z.coerce
      .number()
      .min(0, "Cannot be negative")
      .max(20, "FRS sector rates do not exceed 20%")
      .default(0),
    registration_date: optionalIsoDate,
    first_year_discount: z.coerce.boolean().default(false),
    effective_from: optionalIsoDate,
    effective_to: optionalIsoDate,
    // EXPLICIT limited-cost declaration — never auto-derived (see lib/tax/compute.ts).
    // 'unset' is the safe default and files the conservative 16.5%.
    limited_cost: z.enum(["yes", "no", "unset"]).default("unset"),
  })
  .strip()
  .superRefine((cfg, ctx) => {
    // CROSS-FIELD: an ENABLED FRS config must carry a plausible sector rate.
    // The schema default is 0, which would file box 1 = 0% × turnover = £0 — a
    // silent under-declaration for a user who turns FRS on without setting a rate.
    // Require 1%–16.5% when enabled; disabled/default (FRS off) is unaffected.
    if (cfg.enabled && !(cfg.sector_percent >= FRS_SECTOR_MIN && cfg.sector_percent <= FRS_SECTOR_MAX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sector_percent"],
        message: `Enter your FRS sector percentage (HMRC rates run from ${FRS_SECTOR_MIN}% to ${FRS_SECTOR_MAX}%).`,
      });
    }
  });

/** The disabled default (mirrors the engine's DEFAULT_FLAT_RATE_CONFIG). */
export function defaultFlatRateConfig(): FlatRateSchemeConfig {
  return { ...DEFAULT_FLAT_RATE_CONFIG };
}

/**
 * Lenient READ coercion — anything that does not parse degrades to the disabled
 * default rather than surfacing a broken FRS config to the VAT authority. The write
 * action uses `flatRateConfigSchema` directly to REJECT bad input.
 */
export function normalizeFlatRateConfig(value: unknown): FlatRateSchemeConfig {
  const parsed = flatRateConfigSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : defaultFlatRateConfig();
}

export const taxDefaultsSchema = z.object({
  default_vat_rate: z.coerce
    .number()
    .refine((v): v is VatRate => (VAT_RATES as readonly number[]).includes(v), {
      message: "VAT rate must be 0, 5 or 20",
    }),
  cis_default_rate: z.coerce
    .number()
    .refine((v): v is CisRate => (CIS_RATES as readonly number[]).includes(v), {
      message: "CIS rate must be 0, 20 or 30",
    }),
  financial_year_start_month: z.coerce
    .number()
    .int("Pick a month")
    .min(1, "Pick a month")
    .max(12, "Pick a month"),
  default_payment_terms_days: z.coerce
    .number()
    .int("Enter whole days")
    .min(0, "Cannot be negative")
    .max(365, "Use 365 days or fewer"),
  vat_stagger: z.enum(VAT_STAGGERS),
  vat_scheme: z.enum(VAT_SCHEMES),
});

/**
 * Default tax config — UK 20% VAT, 20% CIS, April FY start, 30-day terms,
 * calendar-quarter VAT stagger (group 1) and CASH-basis output VAT (= the existing
 * behaviour). Both VAT dimensions default to the pre-scheme behaviour.
 */
export function defaultTaxDefaults(): TaxDefaults {
  return {
    default_vat_rate: 20,
    cis_default_rate: 20,
    financial_year_start_month: 4,
    default_payment_terms_days: 30,
    vat_stagger: DEFAULT_VAT_STAGGER,
    vat_scheme: DEFAULT_VAT_SCHEME,
  };
}

// ---------------------------------------------------------------------------
// Combined settings
// ---------------------------------------------------------------------------

export type OrgSettings = TaxDefaults & {
  working_hours: WorkingHours;
  flat_rate_config: FlatRateSchemeConfig;
};

/** The full defaults an org falls back to when it has no org_settings row. */
export function defaultOrgSettings(): OrgSettings {
  return {
    ...defaultTaxDefaults(),
    working_hours: defaultWorkingHours(),
    flat_rate_config: defaultFlatRateConfig(),
  };
}
