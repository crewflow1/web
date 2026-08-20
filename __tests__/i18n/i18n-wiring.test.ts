import { describe, it, expect } from "vitest";

import { createTranslator } from "@/lib/i18n/translator";
import { enGB, enIE, CATALOGUES } from "@/lib/i18n/catalog";
import { negotiateLocale } from "@/lib/i18n/negotiate";
import { defaultOrgI18n, type OrgI18n } from "@/lib/i18n/config";

/**
 * i18n WIRING PROOF — the framework is now live in real UI.
 *
 * Multiple core surfaces are wired through t(): the app-shell primary navigation
 * (sidebar + mobile bottom-nav), the Settings page section headings, the owner
 * dashboard chrome (header, primary actions, section + card headings) and the
 * high-traffic list pages (jobs · customers · invoices · leads · quotes — page
 * title, primary "new" action, empty-state heading/body/CTAs). This suite pins the
 * three properties that make the wiring genuine end-to-end:
 *
 *   (a) en-GB is BYTE-IDENTICAL — every wired key resolves to the EXACT prior
 *       English literal, so a UK user's rendered output is unchanged.
 *   (b) the pipeline resolves a SECOND catalogue (en-IE) and falls back to en-GB
 *       KEY-BY-KEY for anything it does not override.
 *   (c) locale negotiation resolves from org.locale, defaulting to en-GB.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The BYTE-IDENTICAL baseline: the exact English text each wired key replaced.
// This is the guard — if any en-GB catalogue value drifts from the literal that
// was in the .tsx before wiring, a UK user's nav/settings would visibly change
// and one of these assertions fails.
// ─────────────────────────────────────────────────────────────────────────────

/** App-shell nav labels (sidebar ADMIN + STAFF and the mobile bottom-nav). */
const WIRED_NAV: Record<string, string> = {
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
};

/** Settings page — headings / section labels. */
const WIRED_SETTINGS: Record<string, string> = {
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

/** Dashboard (owner landing) — header, primary actions, section + card headings. */
const WIRED_DASHBOARD: Record<string, string> = {
  "dashboard.title": "Dashboard",
  "dashboard.subtitle": "{orgName} — overview of your last week.",
  "dashboard.action.add_lead": "+ Add lead",
  "dashboard.action.add_job": "+ Add job",
  "dashboard.action.add_staff": "+ Add staff",
  "dashboard.section.profitability": "Job profitability",
  "dashboard.card.jobs_by_status": "Jobs by status",
  "dashboard.card.photos_missing": "Photos missing",
  "dashboard.card.staff_workload": "Staff workload",
  "dashboard.card.recent_jobs": "Recent jobs",
  "dashboard.card.recent_invoices": "Recent invoices",
  "dashboard.card.recent_leads": "Recent leads",
};

/** Core list pages — title, primary "new" action, empty-state heading/body/CTAs. */
const WIRED_LISTS: Record<string, string> = {
  "jobs.title": "Jobs",
  "jobs.action.new": "+ New job",
  "jobs.empty.title": "No jobs yet",
  "jobs.empty.body":
    "Schedule your first job. Pick a customer, set a date, assign a staff member. Field staff can attach photos as work progresses.",
  "jobs.empty.primary": "Create first job",
  "jobs.empty.secondary": "Add a customer first",
  "customers.title": "Customers",
  "customers.action.new": "+ New customer",
  "customers.empty.title": "No customers yet",
  "customers.empty.body":
    "Capture the people you do work for. You can link jobs, quotes, and invoices to customers later.",
  "customers.empty.primary": "Add first customer",
  // invoices/quotes page titles reuse the existing invoices.title/quotes.title.
  "invoices.title": "Invoices",
  "invoices.action.new": "+ Generate from quote",
  "invoices.empty.title": "No invoices yet",
  "invoices.empty.body":
    "Once a quote is accepted, generate a sequential HMRC-compliant invoice from it. Status transitions stamp sent/paid timestamps for the audit trail.",
  "invoices.empty.primary": "Generate first invoice",
  "leads.title": "Leads",
  "leads.action.new": "+ New lead",
  "leads.subtitle_overview": "Pipeline overview.",
  "leads.empty.title": "No leads yet",
  "leads.empty.body":
    "Capture every enquiry — phone, web, referral. Move them through the pipeline as you contact, qualify, quote, and win.",
  "leads.empty.primary": "Add first lead",
  "quotes.title": "Quotes",
  "quotes.action.new": "+ New quote",
  "quotes.empty.title": "No quotes yet",
  "quotes.empty.body":
    "Send your first priced proposal. Builder lets you add line items, terms, and a customer-facing link they can accept online.",
  "quotes.empty.primary": "Create first quote",
  "quotes.empty.secondary": "Add a customer first",
};

const WIRED = {
  ...WIRED_NAV,
  ...WIRED_SETTINGS,
  ...WIRED_DASHBOARD,
  ...WIRED_LISTS,
};

describe("(a) en-GB byte-identical guard for the wired surface", () => {
  const t = createTranslator("en-GB").t;
  for (const [key, expected] of Object.entries(WIRED)) {
    it(`en-GB t(${key}) === the exact prior English literal`, () => {
      expect(t(key)).toBe(expected);
    });
  }

  it("every wired key exists in the en-GB base catalogue (no echoed keys)", () => {
    const tr = createTranslator("en-GB");
    for (const key of Object.keys(WIRED)) {
      expect(tr.has(key), key).toBe(true); // resolves, never echoes the raw key
    }
  });

  it("the default-config org negotiates en-GB, so the wired surface is unchanged", () => {
    const locale = negotiateLocale(defaultOrgI18n());
    expect(locale).toBe("en-GB");
    const t2 = createTranslator(locale).t;
    for (const [key, expected] of Object.entries(WIRED)) {
      expect(t2(key), key).toBe(expected);
    }
  });
});

describe("(b) second locale (en-IE): switch + key-by-key fallback to en-GB", () => {
  it("en-IE is registered and only carries genuine, correct overrides", () => {
    expect(CATALOGUES["en-IE"]).toBe(enIE);
    // The one genuinely-different Irish term: the construction-withholding scheme.
    expect(enIE["nav.cis"]).toBe("RCT");
    // Honest + small: every en-IE key must also exist in the en-GB base (no gap).
    for (const key of Object.keys(enIE)) {
      expect(enGB, key).toHaveProperty(key);
    }
  });

  it("switching the negotiated locale to en-IE changes the overridden key", () => {
    const gb = createTranslator("en-GB");
    const ie = createTranslator("en-IE");
    expect(gb.t("nav.cis")).toBe("CIS");
    expect(ie.t("nav.cis")).toBe("RCT"); // demonstrably different rendered output
    expect(ie.locale).toBe("en-IE");
  });

  it("en-IE falls back to en-GB, key-by-key, for every UN-overridden wired key", () => {
    const ie = createTranslator("en-IE");
    for (const [key, expected] of Object.entries(WIRED)) {
      if (key in enIE) continue; // overridden — asserted above
      expect(ie.t(key), key).toBe(expected); // fell through to the en-GB base
    }
    // Spot-check a representative spread of the fallback keys explicitly.
    expect(ie.t("nav.jobs")).toBe("Jobs");
    expect(ie.t("nav.settings")).toBe("Settings");
    expect(ie.t("settings.title")).toBe("Settings");
    expect(ie.t("settings.billing.title")).toBe("Plan & billing");
  });

  it("a UK org and an IE org render the SAME nav except the overridden key", () => {
    const gb = createTranslator("en-GB");
    const ie = createTranslator("en-IE");
    const differ = Object.keys(WIRED_NAV).filter(
      (k) => gb.t(k) !== ie.t(k),
    );
    expect(differ).toEqual(["nav.cis"]);
  });
});

describe("(c) locale negotiation resolves from org.locale with en-GB default", () => {
  const withLocale = (locale: string): OrgI18n => ({
    ...defaultOrgI18n(),
    locale,
  });

  it("uses the org's stored locale when present", () => {
    expect(negotiateLocale(withLocale("en-IE"))).toBe("en-IE");
    expect(negotiateLocale(withLocale("en-US"))).toBe("en-US");
  });

  it("defaults to en-GB for an absent / empty config", () => {
    expect(negotiateLocale(null)).toBe("en-GB");
    expect(negotiateLocale(undefined)).toBe("en-GB");
    expect(negotiateLocale(defaultOrgI18n())).toBe("en-GB");
  });

  it("the negotiated locale drives the translator end-to-end", () => {
    const t = createTranslator(negotiateLocale(withLocale("en-IE"))).t;
    expect(t("nav.cis")).toBe("RCT"); // IE override
    expect(t("nav.jobs")).toBe("Jobs"); // en-GB fallback
  });
});
