import { z } from "zod";

/**
 * Sites — the company's own physical locations. Shared domain constants +
 * input validation (pure module, no I/O, unit-tested directly).
 *
 * `supabase/migrations/20261061000000_sites.sql` is the source of truth for
 * allowed values and bounds; everything here mirrors it so a user sees a
 * sentence instead of a Postgres error. Where the DB is deliberately lenient
 * (a postcode carries a length bound and no regex) so is this.
 *
 * A SITE IS NOT A CUSTOMER JOB SITE. Job addresses live on `jobs.site_address_*`
 * (20260601000000) and belong to the customer; these are the depots, yards and
 * lock-ups the COMPANY owns. `SITE_KINDS` therefore has no `job_site` member —
 * see the migration header for the full reasoning.
 */

export const SITE_KINDS = [
  "depot",
  "yard",
  "warehouse",
  "office",
  "storage_container",
  "lock_up",
] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

/** UK construction language — a lock-up is not a "storage unit". */
export const SITE_KIND_LABELS: Record<SiteKind, string> = {
  depot: "Depot",
  yard: "Yard",
  warehouse: "Warehouse",
  office: "Office",
  storage_container: "Storage container",
  lock_up: "Lock-up",
};

/** One line of plain English per kind, shown beside the picker on the form. */
export const SITE_KIND_HINTS: Record<SiteKind, string> = {
  depot: "A base vans run from and kit is drawn from.",
  yard: "Open ground for plant, materials and skips.",
  warehouse: "Covered storage, usually racked and stock-controlled.",
  office: "Where the paperwork and the people are.",
  storage_container: "A container on site or at a yard.",
  lock_up: "A rented garage or unit holding tools.",
};

export function siteKindLabel(kind: string): string {
  return SITE_KIND_LABELS[kind as SiteKind] ?? kind;
}

/** The name bound matches `fleet_vehicles.home_depot` so a later backfill fits. */
export const SITE_NAME_MAX = 160;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/**
 * The add / edit form, validated as one shape so create and edit can never
 * drift into accepting different fields.
 *
 * `active` is NOT here: activation is its own deliberate act with its own
 * button and its own confirmation copy, not a checkbox someone can flip by
 * accident while fixing a postcode.
 */
export const siteFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the site a name — what people actually call it")
    .max(SITE_NAME_MAX, `Keep the name under ${SITE_NAME_MAX} characters`),
  kind: z.enum(SITE_KINDS, {
    errorMap: () => ({ message: "Choose what kind of place this is" }),
  }),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(120),
  county: optionalText(120),
  // Uppercased and single-spaced, the way a UK postcode is written. NOT
  // regex-pinned: the register also holds BFPO and Crown-dependency codes, and
  // an over-tight rule on an externally-issued identifier is a support trap.
  postcode: z.preprocess((v) => {
    const cleaned =
      typeof v === "string" ? v.trim().replace(/\s+/g, " ").toUpperCase() : v;
    return blankToUndefined(cleaned);
  }, z.string().max(16, "That doesn't look like a postcode").optional()),
  country: optionalText(80),
  notes: optionalText(2000),
});

export type SiteFormInput = z.infer<typeof siteFormSchema>;

export const siteIdSchema = z.string().uuid();

/**
 * Translate a Postgres refusal into a sentence. The DB is the enforcement
 * boundary (20261061000000); this only decides wording, so an unmapped code
 * still fails loudly with the generic message rather than silently.
 *
 *   23505 — the (org_id, lower(name)) unique index: a duplicate depot name.
 *   23001 — restrict_violation, raised by tg_sites_delete_guard.
 *   23514 — check_violation: a bad kind, or a bound overrun.
 */
export function friendlySiteError(
  code: string | undefined,
  message: string | undefined,
): string {
  if (code === "23505") {
    return "You already have a site with that name. Names are matched ignoring capitals, so “Wakefield Yard” and “wakefield yard” count as the same place.";
  }
  if (code === "23001" || (message && /deactivate it instead/.test(message))) {
    return "That site is still used by vehicles or kit that’s signed out. Deactivate it instead — it stays on old records and stops appearing in the pickers.";
  }
  if (code === "23514" || code === "check_violation") {
    return "That site isn’t allowed as entered. Check the kind and the field lengths.";
  }
  return "Couldn’t save the site. Try again.";
}

/** Sort for every list and picker: active first, then by name, case-insensitively. */
export function compareSites<T extends { name: string; active: boolean }>(
  a: T,
  b: T,
): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" });
}

/** One-line address for a list row. Empty string when nothing was recorded. */
export function formatSiteAddress(site: {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  county?: string | null;
  postcode?: string | null;
}): string {
  return [
    site.address_line1,
    site.address_line2,
    site.city,
    site.county,
    site.postcode,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join(", ");
}
