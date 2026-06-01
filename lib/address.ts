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

type CustomerAddressCols = {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
};

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
