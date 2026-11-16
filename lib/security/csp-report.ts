/**
 * CSP violation-report parsing + sanitisation for app/api/csp-report.
 *
 * Browsers send two shapes:
 *   - `report-uri` (legacy):  Content-Type application/csp-report,
 *       body {"csp-report": {"document-uri", "blocked-uri", "effective-directive", …}}
 *   - `report-to` (Reporting API): Content-Type application/reports+json,
 *       body [{"type":"csp-violation","body":{"documentURL","blockedURL","effectiveDirective",…}}]
 *
 * A raw report can carry personal data or secrets: document URLs hold portal /
 * quote capability tokens in the PATH and auth codes in the QUERY, `sample`
 * holds the first 40 chars of the offending code, `original-policy` holds the
 * nonce, `referrer` holds the previous page. So nothing raw is ever kept: each
 * report is reduced to an allow-listed, bounded shape — directive, the blocked
 * resource's CLASS or ORIGIN, a token-masked document path, the script origin +
 * masked path, line/column and disposition. Query strings, fragments, samples,
 * policies, referrers and user agents are dropped. Pure (no I/O) so it is
 * unit-tested directly (`__tests__/security/csp-report.test.ts`).
 */

/** Hard cap on an accepted report body (bytes). */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
/** At most this many reports are processed from one (batched) delivery. */
export const CSP_REPORT_MAX_ITEMS = 10;

export type SanitisedCspReport = {
  directive: string;
  blocked: string;
  documentPath: string;
  sourceFile: string | null;
  line: number | null;
  column: number | null;
  disposition: "enforce" | "report" | "unknown";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Routes whose next path segment is a bearer capability token. */
const TOKEN_ROUTES = new Set(["customer-portal", "worker-portal", "q", "l"]);
const KEYWORD_SOURCES = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "data",
  "blob",
  "trusted-types-policy",
  "trusted-types-sink",
]);

/**
 * Mask every path segment that could identify a record or carry a secret:
 * UUIDs, numbers, long opaque strings, and the segment after a token route.
 */
export function maskPath(pathname: string): string {
  const segments = pathname.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i] ?? "";
    try {
      seg = decodeURIComponent(seg);
    } catch {
      // keep the raw segment; it is classified below like any other
    }
    const prev = i > 0 ? segments[i - 1] : undefined;
    if (seg === "") out.push("");
    else if (prev !== undefined && TOKEN_ROUTES.has(prev) && i === 2) out.push(":token");
    else if (UUID.test(seg)) out.push(":uuid");
    else if (/^\d+$/.test(seg)) out.push(":n");
    else if (seg.length > 48) out.push(":long");
    else if (seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_.~-]+$/.test(seg)) out.push(":token");
    else if (!/^[A-Za-z0-9_.~()[\]-]+$/.test(seg)) out.push(":seg");
    else out.push(seg);
  }
  return out.join("/").slice(0, 200);
}

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Origin + masked path; query and fragment always dropped. */
function originAndMaskedPath(u: URL): string {
  return `${u.origin}${maskPath(u.pathname)}`;
}

function classifyBlocked(raw: unknown, documentOrigin: string | null): string {
  if (typeof raw !== "string" || raw === "") return "unknown";
  const keyword = raw.trim().toLowerCase();
  if (KEYWORD_SOURCES.has(keyword)) return keyword;
  const u = parseUrl(raw);
  if (!u) return "other";
  if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol.slice(0, -1);
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
    return `${u.protocol}`.slice(0, 20);
  }
  // Same-origin: the masked path is useful for debugging (which chunk / route).
  // Third-party: origin only.
  return documentOrigin && u.origin === documentOrigin ? originAndMaskedPath(u) : u.origin;
}

function directiveOf(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[a-z-]{1,40}$/.test(first) ? first : "unknown";
}

function intOf(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : null;
}

function dispositionOf(raw: unknown): SanitisedCspReport["disposition"] {
  return raw === "enforce" || raw === "report" ? raw : "unknown";
}

type Fields = {
  documentUrl: unknown;
  blocked: unknown;
  effective: unknown;
  violated: unknown;
  sourceFile: unknown;
  line: unknown;
  column: unknown;
  disposition: unknown;
};

function sanitise(f: Fields): SanitisedCspReport {
  const doc = parseUrl(f.documentUrl);
  const src = parseUrl(f.sourceFile);
  return {
    directive: directiveOf(f.effective ?? f.violated),
    blocked: classifyBlocked(f.blocked, doc?.origin ?? null),
    documentPath: doc ? maskPath(doc.pathname) : "unknown",
    sourceFile: src && (src.protocol === "https:" || src.protocol === "http:") ? originAndMaskedPath(src) : null,
    line: intOf(f.line),
    column: intOf(f.column),
    disposition: dispositionOf(f.disposition),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse a report delivery into sanitised reports. Malformed / unrecognised
 * input yields an empty list (never throws).
 */
export function parseCspReports(contentType: string, body: string): SanitisedCspReport[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const ct = contentType.toLowerCase();
  const out: SanitisedCspReport[] = [];

  if (ct.includes("application/reports+json") || Array.isArray(json)) {
    if (!Array.isArray(json)) return [];
    for (const item of json.slice(0, CSP_REPORT_MAX_ITEMS)) {
      if (!isObject(item) || item.type !== "csp-violation" || !isObject(item.body)) continue;
      const b = item.body;
      out.push(
        sanitise({
          documentUrl: b.documentURL,
          blocked: b.blockedURL,
          effective: b.effectiveDirective,
          violated: undefined,
          sourceFile: b.sourceFile,
          line: b.lineNumber,
          column: b.columnNumber,
          disposition: b.disposition,
        }),
      );
    }
    return out;
  }

  if (isObject(json) && isObject(json["csp-report"])) {
    const r = json["csp-report"];
    out.push(
      sanitise({
        documentUrl: r["document-uri"],
        blocked: r["blocked-uri"],
        effective: r["effective-directive"],
        violated: r["violated-directive"],
        sourceFile: r["source-file"],
        line: r["line-number"],
        column: r["column-number"],
        disposition: r["disposition"],
      }),
    );
  }
  return out;
}
