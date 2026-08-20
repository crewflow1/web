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

  // ── App-shell primary navigation (sidebar + mobile bottom-nav) ──────────
  // The full primary-navigation vocabulary. Values are the EXACT current labels
  // so the rendered nav is byte-identical for en-GB (pinned by the wiring test).
  "nav.dashboard": "Dashboard",
  "nav.home": "Home",
  "nav.cash": "Cash position",
  "nav.inbox": "Inbox",
  "nav.leads": "Leads",
  "nav.jobs": "Jobs",
  "nav.snagging": "Snagging",
  "nav.site_diary": "Site diary",
  "nav.toolbox": "Toolbox talks",
  "nav.health_safety": "Health & safety",
  "nav.quality": "Works quality",
  "nav.delays": "Delays & EOT",
  "nav.weather": "Weather",
  "nav.site_reports": "Site reports",
  "nav.drawings": "Drawings",
  "nav.documents": "Documents",
  "nav.customers": "Customers",
  "nav.quotes": "Quotes",
  "nav.price_book": "Price book",
  "nav.suppliers": "Suppliers",
  "nav.purchase_orders": "Purchase orders",
  "nav.expenses": "Expenses",
  "nav.finances": "Finances",
  "nav.invoices": "Invoices",
  "nav.payments": "Payments",
  "nav.payroll": "Payroll",
  "nav.cis": "CIS",
  "nav.tax": "Tax",
  "nav.staff": "Staff",
  "nav.operations": "Operations",
  "nav.assets": "Assets",
  "nav.fleet": "Fleet",
  "nav.stock": "Stock",
  "nav.material_requests": "Material requests",
  "nav.sites": "Sites",
  "nav.site_compliance": "Site compliance",
  "nav.compliance": "Compliance",
  "nav.reviews": "Reviews",
  "nav.migrate_data": "Migrate data",
  "nav.reports": "Reports",
  "nav.ai_insights": "AI insights",
  "nav.notifications": "Notifications",
  "nav.help": "Help",
  "nav.support": "Support",
  "nav.settings": "Settings",
  "nav.my_day": "My day",
  "nav.leave": "Leave",

  // ── Settings page — headings / section labels (real page surface) ────────
  "settings.title": "Settings",
  "settings.subtitle": "Your profile, your organisation, and the people in it.",
  "settings.read_only_badge": "Read only · ask an admin",
  "settings.profile.title": "Profile",
  "settings.org.title": "Organisation",
  "settings.ai.title": "AI Receptionist",
  "settings.api_keys.title": "API keys",
  "settings.security.title": "Security",
  "settings.webhooks.title": "Webhooks",
  "settings.integrations.title": "Integrations",
  "settings.automations.title": "Automations",
  "settings.data_retention.title": "Data retention",
  "settings.billing.title": "Plan & billing",
  "settings.members.title": "Members",
};

/**
 * en-IE (Ireland) — a REAL English locale variant, registered to prove the
 * pipeline resolves a second catalogue and falls back to en-GB key-by-key for
 * everything it does not override.
 *
 * HONESTY OVER VOLUME: British and Irish business English are near-identical
 * (same "-ise" / "-our" spelling, same everyday vocabulary), so this catalogue is
 * deliberately SMALL. It overrides ONLY where the Irish term is genuinely, factually
 * different — never a fabricated "translation":
 *
 *   nav.cis "CIS" → "RCT"  Ireland's construction-sector withholding scheme is
 *                          Relevant Contracts Tax (RCT, Revenue). "CIS" is the UK
 *                          (HMRC) name for the equivalent scheme.
 *
 * Every other wired label (Jobs, Invoices, Settings, …) is identical in Irish
 * English and is intentionally OMITTED so it falls through to the en-GB base — the
 * exact key-by-key fallback the wiring test asserts.
 */
export const enIE: MessageCatalogue = {
  "nav.cis": "RCT",
};

/**
 * Locale → catalogue registry. en-GB is the only complete catalogue today; the
 * map is the extension point — add `"fr-FR": frFR` (partial is fine, it falls
 * back to en-GB per key). Keys are matched exactly, then by the base language
 * subtag (see translator.ts resolveCatalogue), then en-GB.
 */
export const CATALOGUES: Record<string, MessageCatalogue> = {
  "en-GB": enGB,
  "en-IE": enIE,
};

/** The base catalogue every locale falls back to, key-by-key. */
export const BASE_CATALOGUE = enGB;
export const BASE_LOCALE = "en-GB";
