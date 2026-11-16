import * as Sentry from "@sentry/nextjs";
import { check, identifyRequest, type RateLimitConfig } from "@/lib/security/rate-limit";
import {
  CSP_REPORT_MAX_BYTES,
  parseCspReports,
} from "@/lib/security/csp-report";

/**
 * POST /api/csp-report — Content-Security-Policy violation sink.
 *
 * Target of the policy's `report-uri` + `report-to` (lib/security/csp.ts).
 * Public by necessity (browsers send reports without a session; excluded from
 * the auth middleware matcher), so it is defensive end to end:
 *   - in-memory rate limits (per IP AND per instance) — a report flood never
 *     reaches a database or burns the Sentry quota; nothing is persisted;
 *   - a hard body cap (CSP_REPORT_MAX_BYTES), enforced while streaming, so a
 *     chunked body without Content-Length cannot exceed it either;
 *   - only the two report content types are accepted;
 *   - every report is reduced to an allow-listed, token-masked shape by
 *     lib/security/csp-report.ts (no query strings, samples, policies,
 *     referrers or user agents) before it is logged or forwarded.
 * Output: one structured `console.warn` line per report (Vercel logs) and a
 * Sentry warning (a no-op while monitoring is dark — no DSN). Always answers
 * 204/4xx with an empty body: nothing here is worth echoing back.
 */

export const dynamic = "force-dynamic";

const PER_IP: RateLimitConfig = { limit: 20, windowSeconds: 60 };
const PER_INSTANCE: RateLimitConfig = { limit: 300, windowSeconds: 60 };
const ACCEPTED = /^application\/(csp-report|reports\+json|json)\b/i;

const empty = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/** Read at most `max` bytes of the body; null when it is larger. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(req: Request): Promise<Response> {
  if (!check("csp_report", identifyRequest(req), PER_IP).allowed) return empty(429);
  if (!check("csp_report_instance", "all", PER_INSTANCE).allowed) return empty(429);

  const contentType = req.headers.get("content-type") ?? "";
  if (!ACCEPTED.test(contentType)) return empty(415);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) return empty(413);

  const body = await readCapped(req, CSP_REPORT_MAX_BYTES);
  if (body === null) return empty(413);

  for (const report of parseCspReports(contentType, body)) {
    console.warn("[csp-report]", JSON.stringify(report));
    try {
      Sentry.captureMessage(`CSP violation: ${report.directive}`, {
        level: "warning",
        fingerprint: ["csp-violation", report.directive, report.blocked],
        tags: { csp_directive: report.directive, csp_disposition: report.disposition },
        extra: { ...report },
      });
    } catch {
      // Monitoring must never break the sink.
    }
  }
  return empty(204);
}
