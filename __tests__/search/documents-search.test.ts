import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JOB_DOCUMENT_SEARCH_COLUMNS,
  SNAG_SEARCH_COLUMNS,
  PURCHASE_ORDER_SEARCH_COLUMNS,
  SITE_REPORT_SEARCH_COLUMNS,
  ilikeOrFilter,
  combineOr,
  inIdsBranch,
} from "@/lib/search/filters";
import { sortHitsByMatch, type SearchHit } from "@/lib/search/rank";

/**
 * Documents / operational-entity search coverage (P-… wave).
 *
 * The global search route was extended from 8 entity types to 12 — it now also
 * reaches job_documents, snags, purchase_orders and site_reports. These assert
 * the shared column sets, the pure filter composition, the ranking union, and
 * (on source) that the route actually wires each new entity through the shared
 * builders rather than a bespoke inline string.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");

describe("new search column sets", () => {
  it("job_documents searches its title + external reference", () => {
    expect([...JOB_DOCUMENT_SEARCH_COLUMNS]).toEqual(["title", "external_reference"]);
  });
  it("snags search what/where/trade + description", () => {
    expect([...SNAG_SEARCH_COLUMNS]).toEqual([
      "title",
      "description",
      "location",
      "trade",
    ]);
  });
  it("purchase_orders search number/supplier ref/notes", () => {
    expect([...PURCHASE_ORDER_SEARCH_COLUMNS]).toEqual([
      "number",
      "supplier_reference",
      "notes",
    ]);
  });
  it("site_reports search title + report number", () => {
    expect([...SITE_REPORT_SEARCH_COLUMNS]).toEqual(["title", "report_number"]);
  });
});

describe("pure filter composition for the new entities", () => {
  it("builds an own-column ILIKE branch per entity", () => {
    const f = ilikeOrFilter("boiler", SNAG_SEARCH_COLUMNS);
    expect(f).toBe(
      "title.ilike.%boiler%,description.ilike.%boiler%,location.ilike.%boiler%,trade.ilike.%boiler%",
    );
  });

  it("combines own columns with the matched-job id chain", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const combined = combineOr(
      ilikeOrFilter("po", PURCHASE_ORDER_SEARCH_COLUMNS),
      inIdsBranch("job_id", [jobId]),
    );
    expect(combined).toContain("number.ilike.%po%");
    expect(combined).toContain(`job_id.in.(${jobId})`);
  });

  it("site reports fold in BOTH the job-id and the customer-id chain", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const custId = "22222222-2222-4222-8222-222222222222";
    const combined = combineOr(
      ilikeOrFilter("survey", SITE_REPORT_SEARCH_COLUMNS),
      inIdsBranch("job_id", [jobId]),
      inIdsBranch("customer_id", [custId]),
    );
    expect(combined).toContain("title.ilike.%survey%");
    expect(combined).toContain(`job_id.in.(${jobId})`);
    expect(combined).toContain(`customer_id.in.(${custId})`);
  });

  it("a malformed id can't widen the chain (drops to own-columns only)", () => {
    const combined = combineOr(
      ilikeOrFilter("x1", JOB_DOCUMENT_SEARCH_COLUMNS),
      inIdsBranch("job_id", ["not-a-uuid", ""]),
    );
    expect(combined).toBe("title.ilike.%x1%,external_reference.ilike.%x1%");
    expect(combined).not.toContain("job_id.in");
  });
});

describe("ranking includes the new hit types", () => {
  it("orders the new types by their type priority on a tie", () => {
    const hits: SearchHit[] = [
      { type: "snag", id: "s", title: "Acme", subtitle: null, href: "/snags/s" },
      { type: "purchase_order", id: "p", title: "Acme", subtitle: null, href: "/purchase-orders/p" },
      { type: "site_report", id: "r", title: "Acme", subtitle: null, href: "/site-reports/r" },
      { type: "job_document", id: "d", title: "Acme", subtitle: null, href: "/jobs/j" },
    ];
    const sorted = sortHitsByMatch(hits, "acme").map((h) => h.type);
    // purchase_order (4) < site_report (5) < job_document (6) < snag (9)
    expect(sorted).toEqual([
      "purchase_order",
      "site_report",
      "job_document",
      "snag",
    ]);
  });
});

describe("the route wires the new entities through the shared builders", () => {
  const src = read("app/api/search/route.ts");

  it("imports every new column set", () => {
    expect(src).toContain("JOB_DOCUMENT_SEARCH_COLUMNS");
    expect(src).toContain("SNAG_SEARCH_COLUMNS");
    expect(src).toContain("PURCHASE_ORDER_SEARCH_COLUMNS");
    expect(src).toContain("SITE_REPORT_SEARCH_COLUMNS");
  });

  it("reads each new entity table", () => {
    for (const t of ["job_documents", "snags", "purchase_orders", "site_reports"]) {
      expect(src).toContain(`.from("${t}")`);
    }
  });

  it("emits a hit for each new entity type", () => {
    for (const t of ["job_document", "snag", "purchase_order", "site_report"]) {
      expect(src).toContain(`type: "${t}"`);
    }
  });

  it("documents WHY photos are omitted (no searchable text / no detail route)", () => {
    expect(src).toMatch(/PHOTOS/);
  });
});
