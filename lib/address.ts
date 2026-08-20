/**
 * Shared address helpers for customers + jobs.
 *
 * Server/client-safe — no server-only imports. Used by the customer/job
 * UIs and by lib/maps.ts to build navigation links.
 */

export type Address = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  county?: string | null;
  /**
   * State / province / region — the international equivalent of `county`. Many
   * countries (US, CA, AU, …) file the sub-national division here rather than in
   * `county`. Optional and absent for UK addresses, so existing GB formatting is
   * unchanged (the legacy `parts()` path never reads it).
   */
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
};

/** True when at least one address part is filled in. */
export function hasAddress(a: Address | null | undefined): boolean {
  if (!a) return false;
  return Boolean(
    a.line1 || a.line2 || a.city || a.county || a.postcode || a.country,
  );
}

/** Ordered, non-empty address parts. */
function parts(a: Address): string[] {
  return [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
}

/** Single-line address, comma-separated (e.g. for display + map queries). */
export function formatAddressOneLine(a: Address | null | undefined): string {
  if (!a) return "";
  return parts(a).join(", ");
}

/** Multi-line address (newline-separated) for cards/labels. */
export function formatAddressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  return parts(a);
}

/**
 * Country-aware ordered address parts (multi-country readiness).
 *
 * Includes the international `state` field and orders parts by country
 * convention. For 'GB' (or unset country) the order is IDENTICAL to the legacy
 * `parts()` — line1, line2, city, county, postcode, country — so UK addresses are
 * byte-identical. Other countries place the sub-national `state` and the postcode
 * per their local convention (e.g. US: "city, STATE zip").
 */
export function formatAddressPartsForCountry(a: Address | null | undefined): string[] {
  if (!a) return [];
  const clean = (v: string | null | undefined) => (v ?? "").trim();
  const country = clean(a.country).toUpperCase();

  const line1 = clean(a.line1);
  const line2 = clean(a.line2);
  const city = clean(a.city);
  const county = clean(a.county);
  const state = clean(a.state);
  const postcode = clean(a.postcode);
  const countryName = clean(a.country);

  // US-style: "line1", "line2", "City, ST 90210", "United States".
  if (country === "US" || country === "CA" || country === "AU") {
    const cityLine = [city, [state, postcode].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");
    return [line1, line2, cityLine, countryName].filter(Boolean);
  }

  // Default (GB and everything else): the legacy order, plus `state` after county
  // when a non-UK address happens to use it. For a pure UK address (no state) this
  // is byte-identical to parts().
  return [line1, line2, city, county, state, postcode, countryName].filter(Boolean);
}

/** Country-aware single-line address. GB output is byte-identical to formatAddressOneLine. */
export function formatAddressOneLineForCountry(a: Address | null | undefined): string {
  return formatAddressPartsForCountry(a).join(", ");
}

type CustomerAddressCols = {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
};

/**
 * Map a customer row's `address_*` columns onto the generic {@link Address}
 * shape, so the customer list / search hits can reuse formatAddressOneLine.
 */
export function customerToAddress(
  c: Partial<CustomerAddressCols> | null | undefined,
): Address {
  return {
    line1: c?.address_line1,
    line2: c?.address_line2,
    city: c?.city,
    county: c?.county,
    postcode: c?.postcode,
    country: c?.country,
  };
}

type JobAddressCols = {
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
};

/**
 * Effective job address: the job's site-address override when any part is
 * set, otherwise the linked customer's address. Returns null if neither
 * has an address.
 */
export function resolveJobAddress(
  job: Partial<JobAddressCols> | null | undefined,
  customer: Partial<CustomerAddressCols> | null | undefined,
): Address | null {
  const site: Address = {
    line1: job?.site_address_line1,
    line2: job?.site_address_line2,
    city: job?.site_city,
    county: job?.site_county,
    postcode: job?.site_postcode,
    country: job?.site_country,
  };
  if (hasAddress(site)) return site;

  const cust: Address = {
    line1: customer?.address_line1,
    line2: customer?.address_line2,
    city: customer?.city,
    county: customer?.county,
    postcode: customer?.postcode,
    country: customer?.country,
  };
  return hasAddress(cust) ? cust : null;
}
