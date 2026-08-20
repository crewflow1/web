/**
 * i18n MESSAGE CATALOGUE — the base (en-GB) catalogue + the catalogue type.
 *
 * This is deliberately dependency-free (no next-intl / react-intl / i18next): the
 * CSP forbids new script origins, and the app's UI is overwhelmingly English
 * literals today. The goal of THIS wave is the INFRASTRUCTURE, not a full
 * translation — so en-GB is the base catalogue and the only complete one, and the
 * framework supports ADDING locales incrementally (a partial locale falls back to
 * en-GB key-by-key; see translator.ts).
 *
 * A message key is a dotted path (`invoices.status.paid`). Values may contain
 * `{name}` placeholders interpolated at render time. Keys are stable identifiers,
 * never user-facing text, so a missing translation can fall back deterministically.
 *
 * SCOPE NOTE: the catalogue below is a REPRESENTATIVE SLICE — common money/date/
 * status/action strings — proving the wiring end-to-end. The rest of the UI keeps
 * its English literals working (they simply aren't keyed yet); new/translated
 * surfaces add their keys here.
 */

/** A flat map of dotted message-key → template string. */
export type MessageCatalogue = Record<string, string>;

/**
 * The base (en-GB) catalogue. Every key the app can translate MUST exist here —
 * en-GB is the fallback of last resort, so a key present in another locale but
 * missing here would be a latent gap. Tests pin this invariant.
 */
export const enGB: MessageCatalogue = {
  // ── Generic actions ────────────────────────────────────────────────────
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.delete": "Delete",
  "action.edit": "Edit",
  "action.send": "Send",
  "action.download": "Download",
  "action.confirm": "Confirm",

  // ── Common labels ──────────────────────────────────────────────────────
  "label.total": "Total",
  "label.subtotal": "Subtotal",
  "label.vat": "VAT",
  "label.due": "Due",
  "label.date": "Date",
  "label.amount": "Amount",
  "label.customer": "Customer",
  "label.status": "Status",

  // ── Invoice / quote lifecycle ──────────────────────────────────────────
  "invoices.title": "Invoices",
  "invoices.status.draft": "Draft",
  "invoices.status.sent": "Sent",
  "invoices.status.paid": "Paid",
  "invoices.status.overdue": "Overdue",
  "invoices.number": "Invoice {number}",
  "invoices.balance_due": "Balance due: {amount}",
  "quotes.title": "Quotes",
  "quotes.status.draft": "Draft",
  "quotes.status.accepted": "Accepted",
  "quotes.status.declined": "Declined",

  // ── Money / tax phrasing (jurisdiction-neutral wording; the LABEL for the
  //    tax line is jurisdiction-supplied — see lib/tax/jurisdiction.ts) ────
  "money.tax_inclusive": "Includes {taxName}",
  "money.tax_exclusive": "Plus {taxName}",

  // ── Portal greetings (representative customer-facing slice) ─────────────
  "portal.greeting": "Hello {name}",
  "portal.invoice_ready": "Your invoice is ready to view.",
  "portal.thanks": "Thank you for your business.",
};

/**
 * Locale → catalogue registry. en-GB is the only complete catalogue today; the
 * map is the extension point — add `"fr-FR": frFR` (partial is fine, it falls
 * back to en-GB per key). Keys are matched exactly, then by the base language
 * subtag (see translator.ts resolveCatalogue), then en-GB.
 */
export const CATALOGUES: Record<string, MessageCatalogue> = {
  "en-GB": enGB,
};

/** The base catalogue every locale falls back to, key-by-key. */
export const BASE_CATALOGUE = enGB;
export const BASE_LOCALE = "en-GB";
