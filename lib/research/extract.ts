/**
 * CrewFlow HQ — Research AI deterministic extraction layer (CEO Directive 005,
 * Phase 1 + 2). Pure, server/client-safe, no Supabase, no network.
 *
 * Everything here is a *deterministic read of real fetched HTML*: emails and
 * phone numbers the site actually publishes, social profiles it actually links,
 * technologies whose signatures are actually present, the title/meta it actually
 * declares. There is no inference and no fabrication — if the HTML does not
 * contain a signal, the honest output is an empty array / null (Directive 005:
 * "Never invent data. Unknown is acceptable.").
 *
 * The runner (server/services/hq-research.ts) fetches the page, runs these
 * extractors to get hard signals, then hands the bounded plain text + signals to
 * the LLM for the *interpretive* analysis. Keeping the hard extraction here —
 * pure and unit-tested — means the model never has to be trusted for a fact the
 * page states outright (a contact email, a detected CMS), and the two scores
 * below are reproducible rather than a black box.
 */

// ---------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------

export type TechCategory =
  | "cms"
  | "ecommerce"
  | "framework"
  | "analytics"
  | "marketing"
  | "chat"
  | "payments"
  | "cdn"
  | "fonts"
  | "other";

export type DetectedTech = { name: string; category: TechCategory };

export type SocialLinks = {
  linkedin: string | null;
  instagram: string | null;
  facebook: string | null;
  twitter: string | null;
  youtube: string | null;
};

/** The complete deterministic signal set lifted from one page of HTML. */
export type SiteSignals = {
  title: string | null;
  metaDescription: string | null;
  emails: string[];
  phones: string[];
  socials: SocialLinks;
  technologies: DetectedTech[];
  /** Bounded, tag-stripped plain text — what the LLM actually reads. */
  text: string;
  /** Original visible-text length before bounding (a richness signal). */
  textLength: number;
  hasViewport: boolean;
  hasFavicon: boolean;
  hasOpenGraph: boolean;
  https: boolean;
  /** True when the page advertises recruitment (careers / "we're hiring"). */
  hiring: boolean;
  /** 0–100 deterministic quality of the page itself. */
  websiteQualityScore: number;
  /** 0–100 deterministic digital maturity from the detected stack. */
  digitalMaturityScore: number;
};

/** Hard cap on extracted text so the LLM prompt stays bounded and cheap. */
export const MAX_EXTRACT_TEXT = 12_000;

// ---------------------------------------------------------------------
// Title + meta.
// ---------------------------------------------------------------------

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m && m[1] ? decodeEntities(m[1].trim()) || null : null;
}

export function extractTitle(html: string): string | null {
  return firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

export function extractMetaDescription(html: string): string | null {
  return (
    firstMatch(
      html,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    ) ??
    firstMatch(
      html,
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
    ) ??
    firstMatch(
      html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    )
  );
}

// ---------------------------------------------------------------------
// Contact channels — emails + phones the page actually publishes.
// ---------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Junk that looks like an email but never is — placeholders, asset hashes,
 *  vendor noise. Filtered so we never report a fake contact. */
const EMAIL_NOISE = [
  "example.",
  "yourdomain",
  "domain.com",
  "email@",
  "name@",
  "your@",
  "sentry.",
  "wixpress.",
  "@2x",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  "@sentry",
];

export function extractEmails(html: string): string[] {
  const out = new Set<string>();
  // Prefer mailto: hrefs, then bare matches across the whole document.
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = m[1]?.toLowerCase().trim();
    if (e) out.add(e);
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    out.add(m[0].toLowerCase());
  }
  return [...out]
    .filter((e) => !EMAIL_NOISE.some((n) => e.includes(n)))
    .slice(0, 25);
}

/** UK-leaning phone extraction. tel: hrefs first (authoritative), then a
 *  conservative bare-number pass. Normalised by stripped spacing for dedupe. */
export function extractPhones(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw.replace(/[^\d+]/g, "");
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(raw.trim());
  };
  for (const m of html.matchAll(/tel:([+\d][\d\s().-]{7,})/gi)) {
    if (m[1]) push(m[1]);
  }
  // Bare UK numbers: +44… or 0… with 9–12 following digits/separators.
  for (const m of html.matchAll(
    /(?:\+44\s?|\b0)(?:\d[\s().-]?){8,11}\d/g,
  )) {
    push(m[0]);
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------------
// Social profiles.
// ---------------------------------------------------------------------

function firstHrefContaining(html: string, host: string): string | null {
  const re = new RegExp(
    `https?:\\/\\/(?:[\\w.-]*\\.)?${host.replace(/\./g, "\\.")}\\/[^"'\\s<>)]+`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return null;
  // Drop sharer/intent URLs — they point at the visitor's own profile flow,
  // not the company's page.
  const url = m[0];
  if (/\/(sharer|share|intent|dialog)\b/i.test(url)) return null;
  return url.replace(/[).,'"]+$/, "");
}

export function extractSocialLinks(html: string): SocialLinks {
  return {
    linkedin: firstHrefContaining(html, "linkedin.com"),
    instagram: firstHrefContaining(html, "instagram.com"),
    facebook: firstHrefContaining(html, "facebook.com"),
    twitter:
      firstHrefContaining(html, "twitter.com") ??
      firstHrefContaining(html, "x.com"),
    youtube: firstHrefContaining(html, "youtube.com"),
  };
}

// ---------------------------------------------------------------------
// Technology detection — signature table over the raw HTML.
// ---------------------------------------------------------------------

type TechSignature = {
  name: string;
  category: TechCategory;
  /** Case-insensitive substrings; ANY hit detects the technology. */
  needles: string[];
};

const TECH_SIGNATURES: ReadonlyArray<TechSignature> = [
  // CMS / site builders.
  { name: "WordPress", category: "cms", needles: ["wp-content", "wp-includes", "/wp-json", "content=\"wordpress"] },
  { name: "Wix", category: "cms", needles: ["wix.com", "_wixcss", "wixstatic.com"] },
  { name: "Squarespace", category: "cms", needles: ["squarespace.com", "static1.squarespace"] },
  { name: "Webflow", category: "cms", needles: ["webflow.com", "data-wf-", "wf-domain"] },
  { name: "Drupal", category: "cms", needles: ["/sites/default/files", "drupal.js", "content=\"drupal"] },
  { name: "Joomla", category: "cms", needles: ["/media/jui/", "content=\"joomla"] },
  { name: "GoDaddy Website Builder", category: "cms", needles: ["godaddy.com/websites", "img1.wsimg.com"] },
  { name: "Duda", category: "cms", needles: ["dudamobile", "irp-cdn.multiscreensite"] },
  { name: "Elementor", category: "cms", needles: ["elementor"] },
  // Ecommerce.
  { name: "Shopify", category: "ecommerce", needles: ["cdn.shopify.com", "myshopify.com", "shopify.theme"] },
  { name: "WooCommerce", category: "ecommerce", needles: ["woocommerce", "wc-ajax"] },
  { name: "Magento", category: "ecommerce", needles: ["mage/cookies", "magento"] },
  { name: "BigCommerce", category: "ecommerce", needles: ["bigcommerce.com"] },
  // Front-end frameworks.
  { name: "Next.js", category: "framework", needles: ["__next_data__", "/_next/static"] },
  { name: "React", category: "framework", needles: ["data-reactroot", "react-dom", "_reactlistening"] },
  { name: "Vue.js", category: "framework", needles: ["data-v-", "__vue__", "vue.runtime"] },
  { name: "Angular", category: "framework", needles: ["ng-version", "ng-app", "angular.js"] },
  { name: "jQuery", category: "framework", needles: ["jquery.min.js", "jquery.js", "/jquery-"] },
  { name: "Bootstrap", category: "framework", needles: ["bootstrap.min.css", "bootstrap.bundle"] },
  // Analytics.
  { name: "Google Analytics", category: "analytics", needles: ["google-analytics.com", "gtag(", "googletagmanager.com/gtag", "ga('create"] },
  { name: "Google Tag Manager", category: "analytics", needles: ["googletagmanager.com/gtm", "gtm.start"] },
  { name: "Hotjar", category: "analytics", needles: ["hotjar.com", "hjsv"] },
  { name: "Microsoft Clarity", category: "analytics", needles: ["clarity.ms"] },
  { name: "Plausible", category: "analytics", needles: ["plausible.io"] },
  // Marketing / CRM.
  { name: "HubSpot", category: "marketing", needles: ["hs-scripts.com", "js.hs-analytics", "hubspot"] },
  { name: "Mailchimp", category: "marketing", needles: ["mailchimp.com", "chimpstatic.com", "list-manage.com"] },
  { name: "Facebook Pixel", category: "marketing", needles: ["connect.facebook.net", "fbq("] },
  { name: "Marketo", category: "marketing", needles: ["marketo.com", "munchkin.js"] },
  { name: "ActiveCampaign", category: "marketing", needles: ["activehosted.com", "activecampaign"] },
  // Chat / support.
  { name: "Intercom", category: "chat", needles: ["intercom.io", "intercomcdn"] },
  { name: "Tawk.to", category: "chat", needles: ["tawk.to"] },
  { name: "Drift", category: "chat", needles: ["drift.com", "driftt.com"] },
  { name: "Zendesk", category: "chat", needles: ["zendesk.com", "zdassets.com"] },
  { name: "LiveChat", category: "chat", needles: ["livechatinc.com"] },
  { name: "WhatsApp", category: "chat", needles: ["wa.me/", "api.whatsapp.com"] },
  // Payments / booking.
  { name: "Stripe", category: "payments", needles: ["js.stripe.com"] },
  { name: "PayPal", category: "payments", needles: ["paypal.com/sdk", "paypalobjects.com"] },
  { name: "Calendly", category: "payments", needles: ["calendly.com"] },
  // CDN / infra.
  { name: "Cloudflare", category: "cdn", needles: ["cdnjs.cloudflare.com", "cloudflareinsights.com"] },
  { name: "Google Fonts", category: "fonts", needles: ["fonts.googleapis.com", "fonts.gstatic.com"] },
  { name: "Font Awesome", category: "fonts", needles: ["font-awesome", "fontawesome", "use.fontawesome.com"] },
];

export function detectTechnologies(html: string): DetectedTech[] {
  const haystack = html.toLowerCase();
  const out: DetectedTech[] = [];
  for (const sig of TECH_SIGNATURES) {
    if (sig.needles.some((n) => haystack.includes(n))) {
      out.push({ name: sig.name, category: sig.category });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Recruitment signal.
// ---------------------------------------------------------------------

const HIRING_NEEDLES = [
  "we're hiring",
  "we are hiring",
  "join our team",
  "join the team",
  "current vacancies",
  "job vacancies",
  "careers",
  "work for us",
  "now recruiting",
  "apply now",
  "view vacancies",
];

export function detectHiringSignal(html: string): boolean {
  const h = html.toLowerCase();
  return HIRING_NEEDLES.some((n) => h.includes(n));
}

// ---------------------------------------------------------------------
// Plain-text extraction.
// ---------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&pound;": "£",
  "&copy;": "©",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITY_MAP[e.toLowerCase()] ?? e)
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

/** Strip scripts/styles/comments/tags → collapsed plain text, bounded. */
export function extractText(html: string, max: number = MAX_EXTRACT_TEXT): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(stripped).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

// ---------------------------------------------------------------------
// Deterministic scores — reproducible, never a black box.
// ---------------------------------------------------------------------

type QualityInput = {
  title: string | null;
  metaDescription: string | null;
  hasViewport: boolean;
  hasOpenGraph: boolean;
  hasFavicon: boolean;
  https: boolean;
  textLength: number;
  emails: ReadonlyArray<string>;
  phones: ReadonlyArray<string>;
  socials: SocialLinks;
};

/** 0–100 quality of the page itself: does it present like a maintained,
 *  professional site? Each component is an observable fact, summed. */
export function assessWebsiteQuality(s: QualityInput): number {
  let score = 0;
  if (s.title) score += 14;
  if (s.metaDescription) score += 14;
  if (s.hasViewport) score += 12; // mobile-ready
  if (s.hasOpenGraph) score += 10; // social-ready
  if (s.hasFavicon) score += 6;
  if (s.https) score += 12;
  if (s.textLength >= 800) score += 10;
  if (s.textLength >= 2500) score += 8; // substantive content
  if (s.emails.length > 0) score += 6;
  if (s.phones.length > 0) score += 4;
  const socialCount = Object.values(s.socials).filter(Boolean).length;
  if (socialCount >= 1) score += 2;
  if (socialCount >= 3) score += 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 0–100 digital maturity from the detected stack: more categories present,
 *  and the presence of analytics/marketing/chat, signals a business investing
 *  in its digital channel. */
export function assessDigitalMaturity(tech: ReadonlyArray<DetectedTech>): number {
  if (tech.length === 0) return 0;
  const categories = new Set(tech.map((t) => t.category));
  let score = 20; // any detectable stack at all
  score += Math.min(tech.length, 8) * 5; // breadth, capped
  if (categories.has("analytics")) score += 14;
  if (categories.has("marketing")) score += 14;
  if (categories.has("chat")) score += 8;
  if (categories.has("ecommerce")) score += 8;
  if (categories.has("framework")) score += 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------
// One-shot: lift every signal from a page.
// ---------------------------------------------------------------------

export function extractSiteSignals(html: string, url: string): SiteSignals {
  const title = extractTitle(html);
  const metaDescription = extractMetaDescription(html);
  const emails = extractEmails(html);
  const phones = extractPhones(html);
  const socials = extractSocialLinks(html);
  const technologies = detectTechnologies(html);
  const full = extractText(html, Number.MAX_SAFE_INTEGER);
  const text = full.length > MAX_EXTRACT_TEXT ? full.slice(0, MAX_EXTRACT_TEXT) : full;

  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasFavicon = /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html);
  const hasOpenGraph = /<meta[^>]+property=["']og:/i.test(html);
  const https = url.toLowerCase().startsWith("https://");
  const hiring = detectHiringSignal(html);

  const websiteQualityScore = assessWebsiteQuality({
    title,
    metaDescription,
    hasViewport,
    hasOpenGraph,
    hasFavicon,
    https,
    textLength: full.length,
    emails,
    phones,
    socials,
  });
  const digitalMaturityScore = assessDigitalMaturity(technologies);

  return {
    title,
    metaDescription,
    emails,
    phones,
    socials,
    technologies,
    text,
    textLength: full.length,
    hasViewport,
    hasFavicon,
    hasOpenGraph,
    https,
    hiring,
    websiteQualityScore,
    digitalMaturityScore,
  };
}

// ---------------------------------------------------------------------
// URL + domain helpers — shared with the fetch service.
// ---------------------------------------------------------------------

/** Best-effort normalisation of an operator-typed company URL/domain into an
 *  absolute https URL, or null when it cannot possibly be a web address. */
export function normaliseUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes(".")) return null;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Bare registrable-ish domain for display/dedupe (drops www + path). */
export function domainOf(input: string): string | null {
  const url = normaliseUrl(input);
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}
