/**
 * Phone-number helpers.
 *
 * CrewFlow is a UK-only product (UK postcodes, VAT, construction SMBs),
 * so numbers are entered in whatever shape the operator/customer typed
 * them — most commonly UK national format ("07700 900000").
 *
 * WhatsApp's click-to-chat URL (https://wa.me/<number>) requires the
 * number in INTERNATIONAL format: country code + subscriber number,
 * with NO leading "+", NO leading "0", and no spaces, brackets or
 * dashes. A UK national number like "07700 900000" must therefore
 * become "447700900000" — otherwise wa.me opens to an error and the
 * customer can't be reached.
 *
 * The old inline pattern `wa.me/${phone.replace(/[^\d]/g, "")}` left UK
 * national numbers malformed (it produced "wa.me/07700900000"). Use the
 * helpers below everywhere instead.
 */

const UK_COUNTRY_CODE = "44";

/**
 * Convert a free-form phone number into the digits-only international
 * form wa.me expects. UK-first, but preserves already-international
 * input for any country.
 *
 *   "07700 900000"      -> "447700900000"  (UK national → +44)
 *   "+44 7700 900000"   -> "447700900000"  (E.164 → drop the +)
 *   "0044 7700 900000"  -> "447700900000"  (00 intl access code → drop)
 *   "447700900000"      -> "447700900000"  (already international)
 *   "(07700) 900-000"   -> "447700900000"  (punctuation stripped)
 *   "+1 (415) 555-0123" -> "14155550123"   (non-UK international kept)
 *
 * Returns null when there is nothing dial-able.
 */
export function toInternationalDigits(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A leading "+" signals the number already carries its country code —
  // we just strip the "+" and any formatting.
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (hadPlus) return digits; // "+44 7700 900000" -> "447700900000"
  if (digits.startsWith("00")) {
    // "00" is the international access prefix; the remainder is
    // already country-coded.
    return digits.slice(2) || null;
  }
  if (digits.startsWith("0")) {
    // UK national trunk prefix → swap the leading 0 for the UK code.
    return UK_COUNTRY_CODE + digits.slice(1);
  }
  if (digits.startsWith(UK_COUNTRY_CODE)) {
    // Already a UK international number written without the "+".
    return digits;
  }
  // No recognisable prefix. CrewFlow is UK-only, so assume a UK
  // subscriber number that was typed without its leading 0 rather than
  // emitting an unroutable link.
  return UK_COUNTRY_CODE + digits;
}

/**
 * Build a WhatsApp click-to-chat URL for a phone number, or null when
 * the number is empty/unusable. Always prefer this over hand-rolling
 * `wa.me/${phone.replace(...)}`.
 */
export function whatsAppHref(
  input: string | null | undefined,
): string | null {
  const digits = toInternationalDigits(input);
  return digits ? `https://wa.me/${digits}` : null;
}

/**
 * Convert a free-form phone number into E.164 (`+<country><subscriber>`), the
 * shape SMS providers (Twilio) require for a destination. Reuses
 * `toInternationalDigits` for all UK-first normalisation, then prefixes the "+".
 * Returns null when there is nothing dial-able — the transport turns that null
 * into a `failed`/invalid_destination attempt rather than calling a provider.
 *
 *   "07700 900000"      -> "+447700900000"
 *   "+44 7700 900000"   -> "+447700900000"
 *   "+1 (415) 555-0123" -> "+14155550123"
 *   ""                  -> null
 */
export function toE164(input: string | null | undefined): string | null {
  const digits = toInternationalDigits(input);
  return digits ? `+${digits}` : null;
}
