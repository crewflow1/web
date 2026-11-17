import { describe, it, expect } from "vitest";
import { scrubEvent, scrubText, redactPathTokens, REDACTED } from "@/lib/monitoring/scrub";

/**
 * Error-monitoring scrubbing — the parts key-name redaction cannot reach.
 *
 * Sentry carries three things verbatim that the original scrubber left intact:
 *   1. the URL PATH — and on /q/<token>, /customer-portal/<token>,
 *      /worker-portal/<token> and /a/<token> the path segment IS a live bearer
 *      credential;
 *   2. exception / log MESSAGES — Postgres writes the offending value into the
 *      text (`Key (email)=(a@b.com) already exists`);
 *   3. BREADCRUMBS — console output and navigations leading up to the error.
 *
 * Shipping any of those to a third party is disclosure CrewFlow does not need to
 * fix a bug. All values below are synthetic.
 */

const PORTAL_TOKEN = "SYNTHETIC-PORTAL-TOKEN-0123456789abcdef";
const QUOTE_TOKEN = "SYNTHETIC-QUOTE-TOKEN-fedcba9876543210";
const EMAIL = "jane.synthetic@example.co.uk";
const PHONE = "+447700900123";

describe("bearer tokens in URL paths never leave the process", () => {
  it("masks the token segment on every public token route, keeps the rest of the URL", () => {
    expect(redactPathTokens(`https://crewflow.uk/q/${QUOTE_TOKEN}`)).toBe(
      `https://crewflow.uk/q/${REDACTED}`,
    );
    expect(redactPathTokens(`https://crewflow.uk/q/${QUOTE_TOKEN}/pdf?x=1`)).toBe(
      `https://crewflow.uk/q/${REDACTED}/pdf?x=1`,
    );
    expect(redactPathTokens(`/customer-portal/${PORTAL_TOKEN}/invoices/abc`)).toBe(
      `/customer-portal/${REDACTED}/invoices/abc`,
    );
    expect(redactPathTokens(`/worker-portal/${PORTAL_TOKEN}`)).toBe(`/worker-portal/${REDACTED}`);
    expect(redactPathTokens(`/a/${PORTAL_TOKEN}`)).toBe(`/a/${REDACTED}`);
  });

  it("leaves parameterised route names and unrelated paths alone", () => {
    for (const s of ["/q/[token]", "/q/:token", "/customer-portal/[token]/invoices", "/quotes/123", "/dashboard"]) {
      expect(redactPathTokens(s)).toBe(s);
    }
  });

  it("scrubEvent applies it to request.url, breadcrumbs and span data/description", () => {
    const out = scrubEvent({
      request: { url: `https://crewflow.uk/customer-portal/${PORTAL_TOKEN}/invoices?page=2&token=abc` },
      transaction: "/q/[token]",
      breadcrumbs: [
        { category: "navigation", data: { from: `/q/${QUOTE_TOKEN}`, to: `/q/${QUOTE_TOKEN}/pdf` } },
        { category: "fetch", data: { url: `https://crewflow.uk/customer-portal/${PORTAL_TOKEN}/chat` } },
      ],
      spans: [{ description: `GET /q/${QUOTE_TOKEN}`, data: { "http.url": `https://crewflow.uk/q/${QUOTE_TOKEN}?a=1` } }],
    } as Record<string, unknown>)!;

    const wire = JSON.stringify(out);
    expect(wire).not.toContain(PORTAL_TOKEN);
    expect(wire).not.toContain(QUOTE_TOKEN);
    // Still diagnosable: the route, the benign query param and the route name survive.
    expect(wire).toContain(`/customer-portal/${REDACTED}/invoices?page=2&token=${REDACTED}`);
    expect((out as { transaction: string }).transaction).toBe("/q/[token]");
  });
});

describe("identifiers inside free text never leave the process", () => {
  it("scrubText masks emails and +E.164 phone numbers, nothing else", () => {
    expect(scrubText(`duplicate key value violates unique constraint — Key (email)=(${EMAIL}) already exists`)).toBe(
      "duplicate key value violates unique constraint — Key (email)=([email]) already exists",
    );
    expect(scrubText(`sms to ${PHONE} failed`)).toBe("sms to [phone] failed");
    // ids, timings and ordinary numbers are untouched — the error stays diagnosable.
    const benign = "job 3f2b1c9e-0000-4000-8000-000000000001 took 1794610375874ms (attempt 12, 0800 rows)";
    expect(scrubText(benign)).toBe(benign);
  });

  it("scrubEvent applies it to message, logentry, exception values and breadcrumb text", () => {
    const out = scrubEvent({
      message: `insert failed for ${EMAIL}`,
      logentry: { message: `could not notify ${PHONE}` },
      exception: { values: [{ type: "PostgrestError", value: `Key (email)=(${EMAIL}) already exists` }] },
      breadcrumbs: {
        values: [
          { category: "console", message: `[customers] delete failed for ${EMAIL} ${PHONE}` },
          { category: "ui.click", data: { label: `Email ${EMAIL}` } },
        ],
      },
    } as Record<string, unknown>)!;

    const wire = JSON.stringify(out);
    expect(wire).not.toContain(EMAIL);
    expect(wire).not.toContain(PHONE);
    expect(wire).toContain("insert failed for [email]");
    // The exception TYPE (what broke) is kept.
    expect(wire).toContain("PostgrestError");
  });

  it("is deterministic and never drops the event", () => {
    const make = () => ({ message: `x ${EMAIL}`, request: { url: `/q/${QUOTE_TOKEN}` } }) as Record<string, unknown>;
    expect(scrubEvent(make())).toEqual(scrubEvent(make()));
    expect(scrubEvent(make())).not.toBeNull();
  });
});
