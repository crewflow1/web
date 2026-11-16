import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { _resetForTests } from "@/lib/security/rate-limit";
import {
  CSP_REPORT_MAX_BYTES,
  CSP_REPORT_MAX_ITEMS,
  maskPath,
  parseCspReports,
} from "@/lib/security/csp-report";
import { POST } from "@/app/api/csp-report/route";

/**
 * CSP violation sink (app/api/csp-report + lib/security/csp-report.ts).
 *
 * A raw violation report carries capability tokens (portal / quote URLs),
 * auth codes (query strings), code samples and the nonce. These tests pin
 * that NONE of that survives sanitisation, and that the public endpoint is
 * size-capped, type-checked and rate-limited.
 */

// Synthetic capability-token-shaped value, assembled at runtime so no high-entropy
// literal sits in source (secret scanners flag those; this is not a credential).
const TOKEN = ["q9ZkV2mW", "7xYbR4tL", "p0sNcE8h", "Jd3fGa1u"].join("");
const UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

const legacy = (over: Record<string, unknown> = {}) => ({
  "csp-report": {
    "document-uri": `https://crewflow.uk/customer-portal/${TOKEN}/invoices/${UUID}?code=secret-auth-code#frag`,
    referrer: "https://crewflow.uk/jobs/123?q=private",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "script-src 'self' 'nonce-AAECAwQFBgcICQoLDA0ODw=='",
    disposition: "enforce",
    "blocked-uri": "https://evil.example/x.js?session=abc",
    "line-number": 12,
    "column-number": 34,
    "source-file": `https://crewflow.uk/_next/static/chunks/app.js?token=${TOKEN}`,
    "status-code": 200,
    "script-sample": "alert(document.cookie)",
    ...over,
  },
});

describe("maskPath", () => {
  it("masks capability tokens, UUIDs, numeric ids and long opaque segments", () => {
    expect(maskPath(`/customer-portal/${TOKEN}/invoices/${UUID}`)).toBe("/customer-portal/:token/invoices/:uuid");
    expect(maskPath("/q/short")).toBe("/q/:token");
    expect(maskPath(`/worker-portal/${TOKEN}`)).toBe("/worker-portal/:token");
    expect(maskPath("/jobs/12345/blueprints")).toBe("/jobs/:n/blueprints");
    expect(maskPath(`/x/${"a".repeat(60)}`)).toBe("/x/:long");
    expect(maskPath("/invite/abcDEF123456ghiJKL")).toBe("/invite/:token");
    expect(maskPath("/dashboard")).toBe("/dashboard");
    expect(maskPath("/_next/static/chunks/main-app.js")).toBe("/_next/static/chunks/main-app.js");
  });
  it("masks segments with unexpected characters (e.g. an encoded email)", () => {
    expect(maskPath("/staff/jane%40example.com")).toBe("/staff/:seg");
    expect(maskPath("/search/hello%20world")).toBe("/search/:seg");
  });
});

describe("parseCspReports — legacy report-uri body", () => {
  it("keeps only the allow-listed, masked fields", () => {
    const [r, ...rest] = parseCspReports("application/csp-report", JSON.stringify(legacy()));
    expect(rest).toHaveLength(0);
    expect(r).toEqual({
      directive: "script-src-elem",
      blocked: "https://evil.example",
      documentPath: "/customer-portal/:token/invoices/:uuid",
      sourceFile: "https://crewflow.uk/_next/static/chunks/app.js",
      line: 12,
      column: 34,
      disposition: "enforce",
    });
    const flat = JSON.stringify(r);
    for (const secret of [TOKEN, UUID, "secret-auth-code", "session=abc", "nonce-", "alert(", "private", "frag"]) {
      expect(flat, secret).not.toContain(secret);
    }
  });

  it("classifies keyword blocked sources and keeps same-origin paths masked", () => {
    const kw = (b: string) =>
      parseCspReports("application/csp-report", JSON.stringify(legacy({ "blocked-uri": b })))[0]?.blocked;
    expect(kw("inline")).toBe("inline");
    expect(kw("eval")).toBe("eval");
    expect(kw("data")).toBe("data");
    expect(kw(`https://crewflow.uk/q/${TOKEN}?x=1`)).toBe("https://crewflow.uk/q/:token");
    expect(kw("javascript:alert(1)")).toBe("javascript:");
  });

  it("rejects junk directives / numbers instead of echoing them", () => {
    const [r] = parseCspReports(
      "application/csp-report",
      JSON.stringify(legacy({ "effective-directive": "<script>", "line-number": -1, "column-number": "9e99" })),
    );
    expect(r?.directive).toBe("unknown");
    expect(r?.line).toBeNull();
    expect(r?.column).toBeNull();
  });
});

describe("parseCspReports — Reporting API (report-to) body", () => {
  const item = {
    type: "csp-violation",
    age: 10,
    url: `https://crewflow.uk/q/${TOKEN}`,
    user_agent: "Mozilla/5.0 private",
    body: {
      documentURL: `https://crewflow.uk/q/${TOKEN}?accept=1`,
      blockedURL: "inline",
      effectiveDirective: "script-src-attr",
      disposition: "report",
      sample: "fetch('/steal')",
      originalPolicy: "script-src 'nonce-xyz'",
      lineNumber: 1,
      columnNumber: 2,
      sourceFile: `https://crewflow.uk/q/${TOKEN}`,
    },
  };

  it("sanitises each csp-violation item and ignores other report types", () => {
    const out = parseCspReports(
      "application/reports+json",
      JSON.stringify([item, { type: "deprecation", body: {} }]),
    );
    expect(out).toEqual([
      {
        directive: "script-src-attr",
        blocked: "inline",
        documentPath: "/q/:token",
        sourceFile: "https://crewflow.uk/q/:token",
        line: 1,
        column: 2,
        disposition: "report",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("Mozilla");
  });

  it(`processes at most ${CSP_REPORT_MAX_ITEMS} items from one delivery`, () => {
    const many = Array.from({ length: 50 }, () => item);
    expect(parseCspReports("application/reports+json", JSON.stringify(many))).toHaveLength(CSP_REPORT_MAX_ITEMS);
  });

  it("never throws on malformed input", () => {
    for (const body of ["", "not json", "null", "42", "{}", '{"csp-report":null}', "[null,1,{}]"]) {
      expect(parseCspReports("application/reports+json", body), body).toEqual([]);
      expect(parseCspReports("application/csp-report", body), body).toEqual([]);
    }
  });
});

describe("POST /api/csp-report", () => {
  beforeEach(() => {
    _resetForTests();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  const post = (body: string, headers: Record<string, string> = {}, ip = "203.0.113.7") =>
    POST(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        body,
        headers: { "content-type": "application/csp-report", "x-forwarded-for": ip, ...headers },
      }),
    );

  it("accepts a report, logs + forwards ONLY the sanitised shape, answers 204 empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(JSON.stringify(legacy()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[1]);
    expect(logged).toContain("script-src-elem");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("secret-auth-code");
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0])).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it("rejects other content types (415)", async () => {
    const res = await post(JSON.stringify(legacy()), { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("rejects an oversized body by declared length AND while streaming (413)", async () => {
    const big = JSON.stringify(legacy({ pad: "x".repeat(CSP_REPORT_MAX_BYTES) }));
    expect((await post(big)).status).toBe(413);
    // No/false Content-Length: the streaming cap still applies.
    const streamed = new Request("http://localhost/api/csp-report", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      // @ts-expect-error -- Node fetch requires duplex for stream bodies
      duplex: "half",
      headers: { "content-type": "application/csp-report", "x-forwarded-for": "198.51.100.2" },
    });
    expect((await POST(streamed)).status).toBe(413);
  });

  it("rate-limits per IP (20/min) without touching other callers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify(legacy());
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await post(body)).status);
    expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    expect((await post(body, {}, "192.0.2.99")).status).toBe(204);
    warn.mockRestore();
  });

  it("answers 204 (and logs nothing) for a well-typed but meaningless body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post("{}")).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
