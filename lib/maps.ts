/**
 * Map / navigation link builders. Server/client-safe.
 *
 * Given an address (object or string), produce deep links that open the
 * native maps app on each platform. No API key required — these are public
 * URL schemes.
 */

import { formatAddressOneLine, type Address } from "@/lib/address";

function toQuery(input: Address | string | null | undefined): string {
  const s = typeof input === "string" ? input : formatAddressOneLine(input);
  return s.trim();
}

/** Google Maps search link (works on web, Android, iOS). */
export function googleMapsUrl(input: Address | string | null | undefined): string | null {
  const q = toQuery(input);
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Apple Maps link (opens Maps on iOS/macOS, falls back to web elsewhere). */
export function appleMapsUrl(input: Address | string | null | undefined): string | null {
  const q = toQuery(input);
  if (!q) return null;
  return `https://maps.apple.com/?q=${encodeURIComponent(q)}`;
}
