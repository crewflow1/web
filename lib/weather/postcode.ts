/**
 * Weather intelligence — deriving the cache key from data we already hold.
 *
 * PURE. No I/O, no `process.env`, no `server-only`, no network. This is the one
 * place a full postcode becomes a postcode district, which makes it the one
 * place the PII containment rule is enforced in TypeScript — the `CHECK` on both
 * weather tables enforces the same rule in SQL, so a caller that bypassed this
 * module would be refused by the database rather than silently storing a
 * customer's home address in a cross-tenant table.
 *
 * WHY A DISTRICT AND NOT A FULL POSTCODE is argued at length in
 * supabase/migrations/20261074000000_weather_intelligence.sql. In one line: it
 * is the finest key that is derivable from this schema today, meaningful at the
 * resolution UK forecast models run at, and free of customer-identifying detail.
 */

import type { Address } from "@/lib/address";
import type { PostcodeDistrict } from "./types";

/**
 * The six real UK outward-code shapes: A9, A99, A9A, AA9, AA99, AA9A.
 * (M1, M60, W1A, CR2, DN55, EC1A respectively.) Northern Ireland's BT codes fit
 * AA9 / AA99 and need no special case.
 */
const OUTWARD_ONLY = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

/**
 * A complete postcode: an outward code followed by an inward code, which is
 * ALWAYS exactly one digit and two letters. That fixed 3-character tail is what
 * makes splitting an unspaced postcode unambiguous.
 */
const FULL_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

/**
 * `GIR 0AA` — the Girobank special case, the one UK postcode that obeys none of
 * the shapes above. Handled explicitly rather than by widening the patterns,
 * which would have admitted malformed input.
 */
const GIR = "GIR";

/**
 * Derive the postcode district (outward code) from anything postcode-shaped.
 *
 * Accepts a full postcode ("LS1 4AP", "ls14ap"), an outward code already
 * ("LS1"), or junk. Returns `null` when no district can be derived — and `null`
 * is a first-class answer, not a failure: plenty of CrewFlow jobs have an
 * address with no postcode, and those simply have no weather. Callers must
 * report "location unknown" rather than guessing a neighbouring district.
 *
 * Ambiguity note: "LS14" is read as the DISTRICT LS14 (a real Leeds district),
 * not as the sector "LS1 4". Nothing in the string distinguishes them, and a
 * district is the interpretation this module is defined to produce.
 */
export function toPostcodeDistrict(input: string | null | undefined): PostcodeDistrict | null {
  if (typeof input !== "string") return null;

  // Strip everything that is not alphanumeric — spaces, hyphens, punctuation a
  // human typed — then uppercase. This is the normalisation the CHECK expects.
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length === 0) return null;

  if (cleaned === GIR || cleaned === `${GIR}0AA`) return GIR as PostcodeDistrict;

  // A full postcode: the district is everything before the fixed 3-char tail.
  if (FULL_POSTCODE.test(cleaned)) {
    return cleaned.slice(0, cleaned.length - 3) as PostcodeDistrict;
  }

  // Already a district.
  if (OUTWARD_ONLY.test(cleaned)) return cleaned as PostcodeDistrict;

  // Anything else — a truncated postcode, a sector, a foreign code, free text.
  // Refused rather than salvaged: a wrong district is a forecast for the wrong
  // place, which is worse than no forecast at all.
  return null;
}

/**
 * True when `value` is exactly the normalised form this module produces — the
 * predicate the database's CHECK mirrors. Use it to narrow untrusted input
 * (a URL segment, a form field) before it reaches a query.
 */
export function isPostcodeDistrict(value: unknown): value is PostcodeDistrict {
  return typeof value === "string" && (value === GIR || OUTWARD_ONLY.test(value));
}

/**
 * The district for a CrewFlow address, or null when it carries no postcode.
 *
 * Takes the shared {@link Address} shape from lib/address.ts rather than a
 * table row, so it serves a job's site address, a customer's address and a
 * `sites` row without knowing which columns any of them use. The caller
 * resolves WHICH address applies — for a job that is `resolveJobAddress()`,
 * which already encodes the site-override-else-customer inheritance rule.
 */
export function districtForAddress(address: Address | null | undefined): PostcodeDistrict | null {
  return toPostcodeDistrict(address?.postcode);
}

/**
 * Collapse many addresses onto the distinct districts they occupy, sorted.
 *
 * THIS FUNCTION IS THE ECONOMIC ARGUMENT MADE EXECUTABLE. It is what turns a
 * builder's forty live jobs into the five or six provider calls those jobs
 * actually cluster into, and a test asserts exactly that collapse. Addresses
 * with no derivable postcode drop out silently — they contribute no district
 * because they have no known location.
 */
export function distinctDistricts(
  addresses: ReadonlyArray<Address | null | undefined>,
): ReadonlyArray<PostcodeDistrict> {
  const seen = new Set<string>();
  for (const a of addresses) {
    const d = districtForAddress(a);
    if (d !== null) seen.add(d);
  }
  return [...seen].sort() as PostcodeDistrict[];
}
