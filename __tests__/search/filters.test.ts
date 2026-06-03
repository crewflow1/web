import { describe, it, expect } from "vitest";
import {
  ilikeOrFilter,
  inIdsBranch,
  combineOr,
  UUID_RE,
  CUSTOMER_SEARCH_COLUMNS,
  JOB_SEARCH_COLUMNS,
  LEAD_SEARCH_COLUMNS,
} from "@/lib/search/filters";

/**
 * P3 Address-First Search — pure filter builders shared by the customers list,
 * jobs list, leads kanban and the global Cmd/K route. These exercise the exact
 * validation matrix the feature must satisfy:
 *   customer address · postcode · partial address · site address ·
 *   quote/invoice discovery via id chaining · sanitised malformed input ·
 *   no false negatives from caps.
 */

describe("column sets cover the address-first axes", () => {
  it("customers: name + every structured address column", () => {
    expect(CUSTOMER_SEARCH_COLUMNS).toEqual([
      "name",
      "email",
      "phone",
      "address_line1", // street / road name
      "address_line2", // unit / apartment / estate / site name
      "city", // town / area
      "county",
      "postcode",
    ]);
  });

  it("jobs: the site-address override columns", () => {
    expect(JOB_SEARCH_COLUMNS).toEqual([
      "site_address_line1",
      "site_address_line2",
      "site_city",
      "site_county",
      "site_postcode",
    ]);
  });

  it("leads: service/source + enquirer postcode/name/email", () => {
    expect(LEAD_SEARCH_COLUMNS).toEqual([
      "service",
      "source",
      "postcode",
      "contact_name",
      "contact_email",
    ]);
  });
});

describe("ilikeOrFilter — server-side substring match across columns", () => {
  it("customer address search: a town/street/postcode hits the address columns", () => {
    const or = ilikeOrFilter("Malone Road", CUSTOMER_SEARCH_COLUMNS) ?? "";
    expect(or).toContain("address_line1.ilike.%Malone Road%");
    expect(or).toContain("city.ilike.%Malone Road%");
    expect(or).toContain("postcode.ilike.%Malone Road%");
    // and still matches by name, so name search is not regressed
    expect(or).toContain("name.ilike.%Malone Road%");
  });

  it("postcode search: 'BT9' becomes a leading+trailing wildcard match", () => {
    expect(ilikeOrFilter("BT9", ["postcode"])).toBe("postcode.ilike.%BT9%");
  });

  it("partial address search: a fragment is wrapped in % … % (substring, not prefix)", () => {
    // "Malone" must match "12 Malone Road" — leading wildcard is essential.
    expect(ilikeOrFilter("Malone", ["address_line1"])).toBe(
      "address_line1.ilike.%Malone%",
    );
  });

  it("unit / apartment numbers search line2", () => {
    expect(ilikeOrFilter("Apartment 4", ["address_line2"])).toBe(
      "address_line2.ilike.%Apartment 4%",
    );
    expect(ilikeOrFilter("Unit 3", ["address_line2"])).toBe(
      "address_line2.ilike.%Unit 3%",
    );
  });

  it("site address search hits the job site_* columns", () => {
    const or = ilikeOrFilter("Lisburn", JOB_SEARCH_COLUMNS) ?? "";
    expect(or).toContain("site_city.ilike.%Lisburn%");
    expect(or).toContain("site_postcode.ilike.%Lisburn%");
    expect(or).toContain("site_address_line1.ilike.%Lisburn%");
  });

  it("sanitises malformed input — strips % _ , ( ) * so .or() can't be injected", () => {
    const or = ilikeOrFilter("x,email.ilike.*", ["name"]);
    // the comma (new-branch injector) and * are neutralised to spaces
    expect(or).toBe("name.ilike.%x email.ilike.%");
    expect(or).not.toContain(",email.ilike.*");
  });

  it("returns null for empty / whitespace / all-stripped term (⇒ no filter)", () => {
    expect(ilikeOrFilter("", CUSTOMER_SEARCH_COLUMNS)).toBeNull();
    expect(ilikeOrFilter("   ", CUSTOMER_SEARCH_COLUMNS)).toBeNull();
    expect(ilikeOrFilter(undefined, CUSTOMER_SEARCH_COLUMNS)).toBeNull();
    expect(ilikeOrFilter(null, CUSTOMER_SEARCH_COLUMNS)).toBeNull();
    expect(ilikeOrFilter("%_()*", CUSTOMER_SEARCH_COLUMNS)).toBeNull();
    expect(ilikeOrFilter("anything", [])).toBeNull();
  });
});

describe("inIdsBranch — id chaining for quote/invoice/job discovery", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";

  it("builds a `col.in.(…)` branch from valid UUIDs", () => {
    expect(inIdsBranch("customer_id", [A, B])).toBe(
      `customer_id.in.(${A},${B})`,
    );
  });

  it("works for the job_id / quote_id chains invoices use", () => {
    expect(inIdsBranch("job_id", [A])).toBe(`job_id.in.(${A})`);
    expect(inIdsBranch("quote_id", [A, B])).toBe(`quote_id.in.(${A},${B})`);
  });

  it("dedupes repeated ids", () => {
    expect(inIdsBranch("customer_id", [A, A, B])).toBe(
      `customer_id.in.(${A},${B})`,
    );
  });

  it("drops malformed / foreign / null ids (no grammar break, no over-match)", () => {
    expect(
      inIdsBranch("customer_id", [A, "not-a-uuid", null, undefined, ""]),
    ).toBe(`customer_id.in.(${A})`);
  });

  it("returns null when nothing valid remains (⇒ branch omitted, not match-all)", () => {
    expect(inIdsBranch("customer_id", [])).toBeNull();
    expect(inIdsBranch("customer_id", ["nope", null])).toBeNull();
  });
});

describe("combineOr — fold branches into a single .or() argument", () => {
  it("joins present branches with a comma", () => {
    expect(combineOr("a.ilike.%x%", "customer_id.in.(1)")).toBe(
      "a.ilike.%x%,customer_id.in.(1)",
    );
  });

  it("drops nulls/empties (a dependent search with no parents just narrows)", () => {
    expect(combineOr("a.ilike.%x%", null)).toBe("a.ilike.%x%");
    expect(combineOr(null, "b.ilike.%y%")).toBe("b.ilike.%y%");
    expect(combineOr("a.ilike.%x%", "", undefined)).toBe("a.ilike.%x%");
  });

  it("returns null when everything is empty", () => {
    expect(combineOr(null, undefined, "")).toBeNull();
    expect(combineOr()).toBeNull();
  });
});

describe("UUID_RE", () => {
  it("accepts canonical UUIDs and rejects everything else", () => {
    expect(UUID_RE.test("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
    // a smuggled `.in.()`-breaking payload must not pass
    expect(UUID_RE.test("1),name.ilike.*--")).toBe(false);
  });
});
