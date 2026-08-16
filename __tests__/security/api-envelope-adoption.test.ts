import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * STANDARDS — internal `/api/*` routes that have ADOPTED the unified responder
 * (lib/api/respond.ts) must route EVERY response through it, so the
 * x-request-id correlation header + envelope are guaranteed and a future edit
 * can't silently re-introduce a bare NextResponse.json (which would drop the id
 * on that path).
 *
 * These are the coherent CRM read/write JSON subset (see the PR body for the
 * documented deferrals: webhooks, cron, PDF/CSV, OAuth redirects, etc.).
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");

const ADOPTED = [
  "app/api/search/route.ts",
  "app/api/activity/route.ts",
  "app/api/reports/route.ts",
  "app/api/finances/route.ts",
  "app/api/finances/[id]/route.ts",
  "app/api/invoices/route.ts",
  "app/api/invoices/[id]/route.ts",
  "app/api/schedule/route.ts",
  "app/api/schedule/[id]/route.ts",
];

describe("adopted internal /api routes route through lib/api/respond", () => {
  for (const rel of ADOPTED) {
    const src = read(rel);
    it(`${rel} imports the unified responder`, () => {
      expect(src).toContain('from "@/lib/api/respond"');
    });
    it(`${rel} has NO bare NextResponse.json (all responses carry the request id)`, () => {
      expect(src).not.toContain("NextResponse.json");
      expect(src).not.toContain('NextResponse } from "next/server"');
      expect(src).not.toContain("NextResponse, type NextRequest");
    });
    it(`${rel} actually emits via respond.json / respond.ok / respond.error`, () => {
      expect(src).toMatch(/respond\.(json|ok|error)\(/);
    });
  }
});

describe("respond module contract", () => {
  const src = read("lib/api/respond.ts");
  it("exports the three responders + the header name", () => {
    for (const sym of ["export async function json", "export async function ok", "export async function error"]) {
      expect(src).toContain(sym);
    }
    expect(src).toContain("REQUEST_ID_HEADER");
  });
  it("error() preserves the machine error code (behaviour-preserving)", () => {
    expect(src).toMatch(/error: code/);
  });
  it("json() only ADDS request_id, never overwrites an existing key", () => {
    expect(src).toContain('!("request_id" in body)');
  });
});

describe("middleware emits + forwards the correlation id", () => {
  const mw = read("middleware.ts");
  const supa = read("lib/supabase/middleware.ts");
  it("top-level middleware resolves an id and tags Sentry (dark-safe)", () => {
    expect(mw).toContain("resolveRequestId");
    expect(mw).toMatch(/setTag\(\s*"request_id"/);
  });
  it("session helper forwards the id onto the request AND stamps the response", () => {
    expect(supa).toContain("REQUEST_ID_HEADER");
    expect(supa).toContain("requestHeaders.set(REQUEST_ID_HEADER");
    expect(supa).toMatch(/res\.headers\.set\(REQUEST_ID_HEADER/);
  });
});
