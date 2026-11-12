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

// ---------------------------------------------------------------------------
// Region-aware normalisation (multi-country readiness)
// ---------------------------------------------------------------------------
//
// The helpers above are UK-first: a bare national number is assumed +44. For a
// non-UK org that is wrong (a French "06 12 34 56 78" would become +44…). The
// functions below take an org phone_region (ISO 3166-1 alpha-2, default 'GB')
// and parse accordingly using libphonenumber-js (already a dependency).
//
// DEFAULT-SAFETY: when region is 'GB' (the default for every existing org) the
// region-aware path DELEGATES to the hand-rolled UK helpers above, so an existing
// tenant's numbers are byte-identical. libphonenumber-js is used ONLY for non-GB
// regions and as a fallback, never on the GB path.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** ISO 3166-1 alpha-2 region used when the caller passes none. */
export const DEFAULT_PHONE_REGION: CountryCode = "GB";

function normalizeRegion(region: string | null | undefined): CountryCode {
  const r = (region || "").trim().toUpperCase();
  return (r.length === 2 ? (r as CountryCode) : DEFAULT_PHONE_REGION);
}

/**
 * Region-aware version of {@link toInternationalDigits} — digits-only
 * international form (no "+"). GB delegates to the UK helper (byte-identical);
 * other regions parse via libphonenumber-js, falling back to the UK helper only
 * when the number cannot be parsed for the region.
 */
export function toInternationalDigitsForRegion(
  input: string | null | undefined,
  region: string | null | undefined = DEFAULT_PHONE_REGION,
): string | null {
  const rc = normalizeRegion(region);
  if (rc === "GB") return toInternationalDigits(input);
  if (!input || !input.trim()) return null;
  const parsed = parsePhoneNumberFromString(input, rc);
  if (parsed && parsed.isValid()) {
    // number is E.164 with a leading "+"; drop it for wa.me digits form.
    return parsed.number.replace(/^\+/, "");
  }
  // Unparseable for the region — fall back to the generic UK-first normaliser
  // rather than dropping the number entirely.
  return toInternationalDigits(input);
}

/**
 * Region-aware E.164 (`+<country><subscriber>`). GB delegates to {@link toE164}
 * (byte-identical); other regions use libphonenumber-js.
 */
export function toE164ForRegion(
  input: string | null | undefined,
  region: string | null | undefined = DEFAULT_PHONE_REGION,
): string | null {
  const rc = normalizeRegion(region);
  if (rc === "GB") return toE164(input);
  if (!input || !input.trim()) return null;
  const parsed = parsePhoneNumberFromString(input, rc);
  if (parsed && parsed.isValid()) return parsed.number;
  return toE164(input);
}

/** Region-aware WhatsApp click-to-chat URL. GB is byte-identical to {@link whatsAppHref}. */
export function whatsAppHrefForRegion(
  input: string | null | undefined,
  region: string | null | undefined = DEFAULT_PHONE_REGION,
): string | null {
  const digits = toInternationalDigitsForRegion(input, region);
  return digits ? `https://wa.me/${digits}` : null;
}

/**
 * Is `input` a valid phone number for `region`? For GB this uses
 * libphonenumber-js validation (a NEW capability — the old code never validated),
 * so it is additive, not a behavioural change to any existing formatting path.
 */
export function isValidPhoneForRegion(
  input: string | null | undefined,
  region: string | null | undefined = DEFAULT_PHONE_REGION,
): boolean {
  if (!input || !input.trim()) return false;
  const parsed = parsePhoneNumberFromString(input, normalizeRegion(region));
  return Boolean(parsed && parsed.isValid());
}

// ---------------------------------------------------------------------------
// Caller-matching helpers (inbound recognition)
// ---------------------------------------------------------------------------

/**
 * The "significant digits" signature of a phone number, for EXACT caller
 * matching against `customers.phone_sig` / `leads.contact_phone_sig`.
 *
 * It MUST stay byte-identical to the SQL `generated always as` expression that
 * populates those columns (supabase/migrations/20261261000000_customer_search.sql
 * and the leads mirror), or a match computed here will never equal the stored
 * value. The rule: strip to digits, then drop a leading UK country code ("44") or
 * a national trunk "0", so "+44 7700 900123", "07700 900123" and "447700900123"
 * all reduce to the same "7700900123".
 *
 *   "+44 7700 900123" -> "7700900123"
 *   "07700 900123"    -> "7700900123"
 *   "447700900123"    -> "7700900123"
 *   "+1 415 555 0123" -> "14155550123"  (no UK prefix to strip)
 *   "anonymous" / ""  -> null
 */
export function phoneSignificantDigits(
  input: string | null | undefined,
): string | null {
  if (input == null) return null;
  const digits = String(input).replace(/[^0-9]/g, "");
  if (!digits) return null;
  let sig: string;
  if (digits.startsWith("44")) sig = digits.slice(2);
  else if (digits.startsWith("0")) sig = digits.slice(1);
  else sig = digits;
  return sig || null;
}

/**
 * Tokens Twilio (and other carriers) place in the `From` field when the caller
 * has WITHHELD their caller ID. These are NOT dial-able numbers and must never be
 * treated as a matchable identity. "266696687" / "7378742833" are the keypad
 * spellings of "anonymous" / "restricted" some carriers send as a numeric From.
 */
const WITHHELD_CALLER_TOKENS = new Set([
  "anonymous",
  "restricted",
  "unavailable",
  "unknown",
  "private",
  "blocked",
  "266696687",
  "7378742833",
]);

/**
 * True when the inbound caller ID is withheld / anonymous / unusable, so caller
 * recognition must NOT guess an identity (it requests clarification instead).
 * Fail-safe: anything that does not reduce to a plausible (>= 7 digit) signature
 * is treated as withheld.
 */
export function isWithheldCallerId(from: string | null | undefined): boolean {
  if (from == null) return true;
  const trimmed = String(from).trim();
  if (!trimmed) return true;
  const lowered = trimmed.toLowerCase().replace(/[\s+()-]/g, "");
  if (WITHHELD_CALLER_TOKENS.has(lowered)) return true;
  // Non-numeric caller id (letters) ⇒ a carrier label, not a number.
  if (!/[0-9]/.test(trimmed)) return true;
  const sig = phoneSignificantDigits(trimmed);
  if (!sig || sig.length < 7) return true;
  if (WITHHELD_CALLER_TOKENS.has(sig)) return true;
  return false;
}
