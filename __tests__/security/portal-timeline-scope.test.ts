import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPortalTimeline } from "@/lib/customers/portal-timeline";

/**
 * Portal completion R4 — unified customer activity timeline.
 *
 * One reverse-chronological feed woven from the customer's own quotes,
 * invoices, payments and published reports. The builder is pure and accepts only
 * narrow, customer-safe primitives (no internal notes / staff / cost basis field
 * exists), and the page reads are all customer + org scoped. Builder tested
 * behaviourally; the page scoping pinned on SOURCE.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const TIMELINE = read("lib/customers/portal-timeline.ts");
const PAGE = read("app/customer-portal/[token]/activity/page.tsx");

const sample = () =>
  buildPortalTimeline({
    token: "tok-1",
    quotes: [
      {
        id: "q1",
        number: "Q-1",
        status: "accepted",
        total: 1000,
        sent_at: "2026-01-01T00:00:00Z",
        accepted_at: "2026-01-05T00:00:00Z",
        public_token: "pt-1",
      },
    ],
    invoices: [
      { id: "i1", number: "INV-1", total: 1200, sent_at: "2026-02-01T00:00:00Z" },
    ],
    payments: [{ id: "p1", amount: 600, at: "2026-03-01" }],
    reports: [
      {
        id: "r1",
        title: "Week 1",
        report_number: "SR-1",
        portal_published_at: "2026-04-01T00:00:00Z",
      },
    ],
  });

describe("buildPortalTimeline — chronological, complete, safe", () => {
  it("emits one event per real occurrence across all sources", () => {
    const kinds = sample().map((e) => e.kind);
    expect(kinds).toContain("quote_sent");
    expect(kinds).toContain("quote_accepted");
    expect(kinds).toContain("invoice_issued");
    expect(kinds).toContain("payment_received");
    expect(kinds).toContain("report_published");
    expect(sample()).toHaveLength(5);
  });

  it("sorts strictly newest-first", () => {
    const events = sample();
    const ats = events.map((e) => e.at);
    const sorted = [...ats].sort((a, b) => (a < b ? 1 : -1));
    expect(ats).toEqual(sorted);
    // Report (Apr) is newest, quote-sent (Jan) is oldest.
    expect(events[0]?.kind).toBe("report_published");
    expect(events[events.length - 1]?.kind).toBe("quote_sent");
  });

  it("is deterministic — identical timestamps break ties stably", () => {
    const input = {
      token: "t",
      quotes: [],
      invoices: [
        { id: "b", number: "B", total: 1, sent_at: "2026-01-01T00:00:00Z" },
        { id: "a", number: "A", total: 1, sent_at: "2026-01-01T00:00:00Z" },
      ],
      payments: [],
      reports: [],
    };
    const first = buildPortalTimeline(input).map((e) => e.title);
    const second = buildPortalTimeline(input).map((e) => e.title);
    expect(first).toEqual(second);
  });

  it("skips occurrences with no timestamp (never invents dates)", () => {
    const events = buildPortalTimeline({
      token: "t",
      quotes: [
        {
          id: "q",
          number: "Q",
          status: "draft",
          total: 1,
          sent_at: null,
          accepted_at: null,
          public_token: null,
        },
      ],
      invoices: [],
      payments: [{ id: "p", amount: 1, at: null }],
      reports: [
        { id: "r", title: "x", report_number: null, portal_published_at: null },
      ],
    });
    expect(events).toHaveLength(0);
  });

  it("quote links use the public /q surface; portal events stay token-scoped", () => {
    const events = sample();
    expect(events.find((e) => e.kind === "quote_sent")?.href).toBe("/q/pt-1");
    expect(events.find((e) => e.kind === "report_published")?.href).toBe(
      "/customer-portal/tok-1/reports/r1",
    );
    expect(events.find((e) => e.kind === "invoice_issued")?.href).toBe(
      "/customer-portal/tok-1/invoices",
    );
  });

  it("exposes no internal-only fields on events", () => {
    for (const e of sample()) {
      expect(Object.keys(e).sort()).toEqual(["at", "href", "kind", "sub", "title"]);
    }
  });
});

describe("activity page — every read is customer + org scoped", () => {
  it("scopes quotes and invoices by org_id AND customer_id", () => {
    // Two producers (quotes, invoices) each pinned on both keys.
    const orgPins = PAGE.match(/\.eq\("org_id", customer\.org_id\)/g) ?? [];
    const custPins = PAGE.match(/\.eq\("customer_id", customer\.id\)/g) ?? [];
    expect(orgPins.length).toBeGreaterThanOrEqual(2);
    expect(custPins.length).toBeGreaterThanOrEqual(2);
  });

  it("scopes payments to THIS customer's own invoice ids", () => {
    expect(PAGE).toMatch(/const ids = invoices\.map\(\(i\) => i\.id\)/);
    expect(PAGE).toMatch(/\.in\("invoice_id", ids\)/);
  });

  it("reads reports through the single scoped portal authority", () => {
    expect(PAGE).toMatch(/listPortalReports\(customer\.id, customer\.org_id\)/);
  });

  it("loudly fails reads rather than showing a partial timeline", () => {
    expect(PAGE).toMatch(/throw readFailure\("portal activity: quotes"/);
    expect(PAGE).toMatch(/throw readFailure\("portal activity: invoices"/);
    expect(PAGE).toMatch(/throw readFailure\("portal activity: payments"/);
  });
});
