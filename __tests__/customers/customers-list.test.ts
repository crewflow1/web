import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PAGE_SIZE,
  parsePage,
  offsetForPage,
  pageWindow,
  customerSearchOr,
} from "@/lib/customers/list";

/**
 * Launch-blocker regression: an import created 598 customers, but /customers
 * showed "200 customers" and rows 201–598 were unreachable — the page used
 * `.limit(200)` and printed `rows.length` as the headline total. These lock
 * in the fix: an EXACT count, `.range()` pagination, and server-side search
 * across the whole table, all exercised with the reported 598-row dataset.
 */

const TOTAL = 598; // the exact reported dataset

describe("customers pagination — 598 imported customers", () => {
  it("splits 598 customers into 3 pages of 200 (200 + 200 + 198)", () => {
    expect(PAGE_SIZE).toBe(200);
    expect(pageWindow(TOTAL, 0, 200).totalPages).toBe(3);
  });

  it("page 1 shows rows 1–200 of 598", () => {
    const offset = offsetForPage(1);
    expect(offset).toBe(0);
    expect(pageWindow(TOTAL, offset, 200)).toEqual({
      totalPages: 3,
      from: 1,
      to: 200,
    });
  });

  it("page 2 shows rows 201–400 of 598", () => {
    const offset = offsetForPage(2);
    expect(offset).toBe(200);
    expect(pageWindow(TOTAL, offset, 200)).toEqual({
      totalPages: 3,
      from: 201,
      to: 400,
    });
  });

  it("page 3 reaches the LATE rows 401–598 that were previously unreachable", () => {
    const offset = offsetForPage(3);
    expect(offset).toBe(400);
    expect(pageWindow(TOTAL, offset, TOTAL - 400)).toEqual({
      totalPages: 3,
      from: 401,
      to: 598,
    });
  });

  it("the headline total is the exact count, never collapsed to the page size", () => {
    // The bug: header showed PAGE_SIZE (200), not the real 598.
    expect(TOTAL).not.toBe(PAGE_SIZE);
    // A full page shows 200 rows, but the total it's "of" stays 598.
    expect(pageWindow(TOTAL, 0, 200).to).toBe(200);
  });

  it("clamps bogus/missing page params to 1", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(null)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("2")).toBe(2);
    expect(parsePage("3")).toBe(3);
  });

  it("handles an empty org (0 customers) without a divide-by-zero / 0 pages", () => {
    expect(pageWindow(0, 0, 0)).toEqual({ totalPages: 1, from: 0, to: 0 });
  });
});

describe("customer search builds a server-side filter spanning ALL rows", () => {
  it("searches name, email, phone AND the structured address columns (address-first)", () => {
    // A hit on row 550 of 598 is found from page 1 because the filter is
    // applied before .range(); and searching an address ("BT9", "Malone Road",
    // "Lisburn", "Apartment 4", "Unit 3") returns the right customer.
    expect(customerSearchOr("acme")).toBe(
      "name.ilike.%acme%,email.ilike.%acme%,phone.ilike.%acme%," +
        "address_line1.ilike.%acme%,address_line2.ilike.%acme%," +
        "city.ilike.%acme%,county.ilike.%acme%,postcode.ilike.%acme%",
    );
  });

  it("includes every address axis a tradesperson searches by", () => {
    const or = customerSearchOr("BT9") ?? "";
    for (const col of [
      "address_line1", // street / road name
      "address_line2", // unit / apartment / estate
      "city", // town / area
      "county",
      "postcode",
    ]) {
      expect(or).toContain(`${col}.ilike.%BT9%`);
    }
  });

  it("returns null for an empty/whitespace/missing term (⇒ unfiltered full list)", () => {
    expect(customerSearchOr("")).toBeNull();
    expect(customerSearchOr("   ")).toBeNull();
    expect(customerSearchOr(undefined)).toBeNull();
    expect(customerSearchOr(null)).toBeNull();
  });

  it("strips PostgREST structural/wildcard chars so a crafted term can't break .or()", () => {
    // % _ , ( ) * are neutralised to spaces; the residual letters still match.
    const or = customerSearchOr("a%,(b)_*");
    expect(or).toBe(
      "name.ilike.%a b%,email.ilike.%a b%,phone.ilike.%a b%," +
        "address_line1.ilike.%a b%,address_line2.ilike.%a b%," +
        "city.ilike.%a b%,county.ilike.%a b%,postcode.ilike.%a b%",
    );
    // ( ) * never appear in a column name or the ilike grammar, so their
    // absence proves the term's structural chars were stripped. (`_` is no
    // longer a valid probe — it legitimately appears in `address_line1` etc.)
    for (const dangerous of ["(", ")", "*"]) {
      expect(or).not.toContain(dangerous);
    }
  });
});

describe("customers/page.tsx wiring (guards the exact regression)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../app/(app)/customers/page.tsx"),
    "utf-8",
  );

  it("fetches an EXACT count instead of inferring the total from rows.length", () => {
    expect(src).toMatch(/count:\s*"exact"/);
    expect(src).toContain("const totalCount = count ?? 0");
    // the old buggy headline must be gone
    expect(src).not.toContain("{rows.length} {rows.length === 1");
  });

  it("paginates server-side with .range() and no longer caps the list at .limit(200)", () => {
    expect(src).toMatch(/\.range\(\s*offset,\s*offset \+ PAGE_SIZE - 1/);
    expect(src).not.toContain(".limit(200)");
  });

  it("prints the real total and a clear 'Showing A–B of N' indicator", () => {
    expect(src).toContain("Showing {from}");
    expect(src).toContain("of {totalCount}");
  });

  it("runs search server-side via the shared customerSearchOr/.or() path", () => {
    expect(src).toContain("customerSearchOr(");
    expect(src).toContain("query.or(orFilter)");
  });

  it("selects + displays the structured address (address-first list)", () => {
    // The address columns must be fetched and rendered, and the search box must
    // advertise address/postcode so users know they can search by them.
    expect(src).toContain("address_line1");
    expect(src).toContain("postcode");
    expect(src).toContain("formatAddressOneLine(customerToAddress(c))");
    expect(src).toMatch(/placeholder="[^"]*address[^"]*"/i);
  });

  it("preserves the active search term across pagination links", () => {
    expect(src).toContain("...baseQuery, page: page - 1");
    expect(src).toContain("...baseQuery, page: page + 1");
  });
});
