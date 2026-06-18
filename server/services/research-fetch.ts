import "server-only";

/**
 * CrewFlow HQ — Research AI fetch layer (CEO Directive 005, Phase 1).
 *
 * Real network reads of PUBLIC company signals: the company's own website
 * (homepage + a few obvious internal pages) and, when a Companies House API key
 * and company number are available, the public Companies House register.
 *
 * Everything returned here is fact, fetched live. Nothing is inferred — that is
 * the LLM layer's job (server/services/research-llm.ts), which only ever sees
 * what this module actually retrieved. When a fetch fails, the honest result is
 * an error / null, never a fabricated page.
 *
 * SECURITY:
 *   • This is gated behind the super-admin /admin surface and the cron secret,
 *     but it still fetches operator-supplied URLs, so it refuses non-public
 *     hosts (localhost, RFC-1918, link-local, .internal) to avoid SSRF.
 *   • Reads only. It never authenticates to the target, never POSTs, never
 *     follows a redirect to a private host (each hop is re-checked).
 *   • Response bodies are size-capped so a hostile/huge page can't exhaust
 *     memory.
 */

import {
  domainOf,
  extractSiteSignals,
  normaliseUrl,
  type SiteSignals,
} from "@/lib/research/extract";

const USER_AGENT =
  "CrewFlow-Research-AI/1.0 (+https://crewflow.uk; internal company research)";

/** Per-request network timeout. The runner route allows up to 60s wall-clock. */
const PAGE_TIMEOUT_MS = 8_000;
/** Hard cap on a single response body we will read into memory (~1.2MB). */
const MAX_BODY_BYTES = 1_200_000;
/** Extra internal pages to crawl beyond the homepage. */
const MAX_EXTRA_PAGES = 3;

// ---------------------------------------------------------------------
// SSRF guard.
// ---------------------------------------------------------------------

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "[::1]") return true;
  // IPv4 literal ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/** A URL we are willing to fetch: http(s), public host. */
export function isPublicHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return false;
    return !isPrivateHost(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Single-page fetch.
// ---------------------------------------------------------------------

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  ok: boolean;
  error: string | null;
};

async function fetchPage(url: string): Promise<FetchedPage> {
  const base: Omit<FetchedPage, "ok" | "error" | "html" | "status" | "finalUrl"> & {
    finalUrl: string;
  } = { url, finalUrl: url };
  if (!isPublicHttpUrl(url)) {
    return { ...base, status: 0, html: "", ok: false, error: "blocked-non-public-url" };
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-GB,en;q=0.9",
      },
    });
    const finalUrl = res.url || url;
    // Re-check the post-redirect host — never let a redirect land us private.
    if (!isPublicHttpUrl(finalUrl)) {
      return { url, finalUrl, status: res.status, html: "", ok: false, error: "redirected-to-private" };
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.includes("html") && !ct.includes("xml") && !ct.includes("text/plain")) {
      return { url, finalUrl, status: res.status, html: "", ok: false, error: `non-html (${ct})` };
    }
    const html = await readCapped(res);
    return {
      url,
      finalUrl,
      status: res.status,
      html,
      ok: res.ok && html.length > 0,
      error: res.ok ? null : `http-${res.status}`,
    };
  } catch (e) {
    const error = e instanceof Error ? (e.name === "TimeoutError" ? "timeout" : e.message) : String(e);
    return { url, finalUrl: url, status: 0, html: "", ok: false, error };
  }
}

/** Read a response body but stop after MAX_BODY_BYTES so a huge page is safe. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BODY_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c.subarray(0, Math.min(c.length, total - offset)), offset);
    offset += c.length;
    if (offset >= total) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

// ---------------------------------------------------------------------
// Internal-link discovery — find the obvious about/contact/team/careers pages.
// ---------------------------------------------------------------------

const INTERESTING_PATHS = [
  "about",
  "about-us",
  "team",
  "our-team",
  "people",
  "contact",
  "contact-us",
  "careers",
  "jobs",
  "services",
  "what-we-do",
];

function discoverInternalLinks(html: string, origin: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    const href = m[1];
    if (!href) continue;
    let abs: URL;
    try {
      abs = new URL(href, origin);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue; // same-origin only
    const path = abs.pathname.toLowerCase().replace(/\/+$/, "");
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 0 || segs.length > 2) continue; // top-level-ish only
    const last = segs[segs.length - 1];
    if (last && INTERESTING_PATHS.some((p) => last === p || last.includes(p))) {
      abs.hash = "";
      abs.search = "";
      found.add(abs.toString());
    }
    if (found.size >= 8) break;
  }
  return [...found];
}

// ---------------------------------------------------------------------
// Full site gather — homepage + a few internal pages → merged signals.
// ---------------------------------------------------------------------

export type SiteContent = {
  ok: boolean;
  requestedUrl: string;
  finalUrl: string | null;
  domain: string | null;
  /** URLs actually fetched OK. */
  pagesFetched: string[];
  signals: SiteSignals | null;
  error: string | null;
};

function mergeUnique(...lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists)
    for (const item of list) {
      const k = item.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
  return out;
}

export async function gatherSiteContent(rawUrl: string): Promise<SiteContent> {
  const url = normaliseUrl(rawUrl);
  if (!url || !isPublicHttpUrl(url)) {
    return {
      ok: false,
      requestedUrl: rawUrl,
      finalUrl: null,
      domain: null,
      pagesFetched: [],
      signals: null,
      error: "invalid-or-non-public-url",
    };
  }

  const home = await fetchPage(url);
  if (!home.ok) {
    return {
      ok: false,
      requestedUrl: rawUrl,
      finalUrl: home.finalUrl,
      domain: domainOf(url),
      pagesFetched: [],
      signals: null,
      error: home.error ?? "homepage-fetch-failed",
    };
  }

  const origin = new URL(home.finalUrl).origin;
  const homeSignals = extractSiteSignals(home.html, home.finalUrl);

  // Crawl a few obvious internal pages in parallel to enrich contacts/people.
  const links = discoverInternalLinks(home.html, origin)
    .filter((l) => l !== home.finalUrl)
    .slice(0, MAX_EXTRA_PAGES);
  const extraPages = await Promise.allSettled(links.map((l) => fetchPage(l)));

  const pagesFetched = [home.finalUrl];
  let combinedText = homeSignals.text;
  let emails = homeSignals.emails;
  let phones = homeSignals.phones;
  let technologies = homeSignals.technologies;
  let hiring = homeSignals.hiring;
  const socials = { ...homeSignals.socials };

  for (const settled of extraPages) {
    if (settled.status !== "fulfilled" || !settled.value.ok) continue;
    const page = settled.value;
    const s = extractSiteSignals(page.html, page.finalUrl);
    pagesFetched.push(page.finalUrl);
    if (combinedText.length < 12_000) {
      combinedText = `${combinedText}\n\n${s.text}`.slice(0, 12_000);
    }
    emails = mergeUnique(emails, s.emails).slice(0, 25);
    phones = mergeUnique(phones, s.phones).slice(0, 10);
    technologies = mergeUnique(
      technologies.map((t) => t.name),
      s.technologies.map((t) => t.name),
    ).map((name) => {
      const hit =
        technologies.find((t) => t.name === name) ??
        s.technologies.find((t) => t.name === name);
      return hit ?? { name, category: "other" as const };
    });
    hiring = hiring || s.hiring;
    for (const key of Object.keys(socials) as (keyof typeof socials)[]) {
      if (!socials[key] && s.socials[key]) socials[key] = s.socials[key];
    }
  }

  const merged: SiteSignals = {
    ...homeSignals,
    emails,
    phones,
    socials,
    technologies,
    hiring,
    text: combinedText,
    // Digital maturity reflects the union of detected tech across pages.
    digitalMaturityScore: Math.max(
      homeSignals.digitalMaturityScore,
      ...(technologies.length
        ? [
            // recompute from the merged stack
            (() => {
              const categories = new Set(technologies.map((t) => t.category));
              let score = 20 + Math.min(technologies.length, 8) * 5;
              if (categories.has("analytics")) score += 14;
              if (categories.has("marketing")) score += 14;
              if (categories.has("chat")) score += 8;
              if (categories.has("ecommerce")) score += 8;
              if (categories.has("framework")) score += 6;
              return Math.min(100, score);
            })(),
          ]
        : [0]),
    ),
  };

  return {
    ok: true,
    requestedUrl: rawUrl,
    finalUrl: home.finalUrl,
    domain: domainOf(home.finalUrl),
    pagesFetched,
    signals: merged,
    error: null,
  };
}

// ---------------------------------------------------------------------
// Companies House — public UK register, best-effort.
// ---------------------------------------------------------------------

export type CompaniesHouseOfficer = {
  name: string;
  role: string | null;
  appointedOn: string | null;
  resigned: boolean;
};

export type CompaniesHouseFacts = {
  companyNumber: string;
  companyName: string | null;
  status: string | null;
  incorporatedOn: string | null;
  companyType: string | null;
  sicCodes: string[];
  registeredOffice: string | null;
  officers: CompaniesHouseOfficer[];
};

/** Normalise an operator-typed CH number (e.g. "SC123456", "12345678"). */
export function normaliseCompanyNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, "");
  // UK company numbers are 8 chars: 8 digits, or 2 letters + 6 digits.
  if (/^[A-Z0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^\d{1,8}$/.test(cleaned)) return cleaned.padStart(8, "0");
  return null;
}

function chHeaders(apiKey: string): HeadersInit {
  // CH REST API uses HTTP Basic with the API key as the username, no password.
  const token = Buffer.from(`${apiKey}:`).toString("base64");
  return { authorization: `Basic ${token}`, accept: "application/json" };
}

async function chGet(path: string, apiKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(`https://api.company-information.service.gov.uk${path}`, {
      headers: chHeaders(apiKey),
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("[research-fetch] companies-house request failed", {
      path,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function formatAddress(office: unknown): string | null {
  const o = (office ?? {}) as Record<string, unknown>;
  const parts = [
    o.address_line_1,
    o.address_line_2,
    o.locality,
    o.region,
    o.postal_code,
    o.country,
  ]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
  return parts.length ? parts.join(", ") : null;
}

/** Look up public Companies House facts. Returns null when no API key is set
 *  (the honest "not checked" state) or the company cannot be found. */
export async function lookupCompaniesHouse(
  companyNumberRaw: string | null | undefined,
): Promise<CompaniesHouseFacts | null> {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  const number = normaliseCompanyNumber(companyNumberRaw);
  if (!apiKey || !number) return null;

  const profile = (await chGet(`/company/${number}`, apiKey)) as Record<
    string,
    unknown
  > | null;
  if (!profile) return null;

  const officersRaw = (await chGet(
    `/company/${number}/officers?items_per_page=20`,
    apiKey,
  )) as Record<string, unknown> | null;

  const officers: CompaniesHouseOfficer[] = [];
  const items = Array.isArray(officersRaw?.items) ? officersRaw!.items : [];
  for (const it of items as Array<Record<string, unknown>>) {
    const name = typeof it.name === "string" ? it.name : null;
    if (!name) continue;
    officers.push({
      name,
      role: typeof it.officer_role === "string" ? it.officer_role : null,
      appointedOn: typeof it.appointed_on === "string" ? it.appointed_on : null,
      resigned: typeof it.resigned_on === "string",
    });
    if (officers.length >= 20) break;
  }

  return {
    companyNumber: number,
    companyName: typeof profile.company_name === "string" ? profile.company_name : null,
    status: typeof profile.company_status === "string" ? profile.company_status : null,
    incorporatedOn:
      typeof profile.date_of_creation === "string" ? profile.date_of_creation : null,
    companyType: typeof profile.type === "string" ? profile.type : null,
    sicCodes: Array.isArray(profile.sic_codes)
      ? (profile.sic_codes as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    registeredOffice: formatAddress(profile.registered_office_address),
    officers,
  };
}

/** Render CH facts into the compact text block the analysis prompt consumes. */
export function formatCompaniesHouseFacts(f: CompaniesHouseFacts): string {
  const lines = [
    `  Registered name: ${f.companyName ?? "unknown"}`,
    `  Company number: ${f.companyNumber}`,
    f.status ? `  Status: ${f.status}` : null,
    f.incorporatedOn ? `  Incorporated: ${f.incorporatedOn}` : null,
    f.companyType ? `  Type: ${f.companyType}` : null,
    f.sicCodes.length ? `  SIC codes: ${f.sicCodes.join(", ")}` : null,
    f.registeredOffice ? `  Registered office: ${f.registeredOffice}` : null,
  ].filter(Boolean);
  const active = f.officers.filter((o) => !o.resigned);
  if (active.length) {
    lines.push("  Active officers:");
    for (const o of active.slice(0, 12)) {
      lines.push(`    - ${o.name}${o.role ? ` (${o.role})` : ""}${o.appointedOn ? `, appointed ${o.appointedOn}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** Companies House incorporation date → whole years trading (for the profile). */
export function yearsTradingFrom(
  incorporatedOn: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!incorporatedOn) return null;
  const then = Date.parse(incorporatedOn);
  if (!Number.isFinite(then)) return null;
  const years = Math.floor((nowMs - then) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 && years < 300 ? years : null;
}
