import { describe, it, expect } from "vitest";
import {
  parseCsvLine,
  mapHeader,
  extractSicCode,
  sicCodesOf,
  matchedConstructionSic,
  isNorthernIrelandPostcode,
  isActiveStatus,
  classifyRecord,
  normalizeRecord,
  normaliseChDate,
  currentSnapshotDate,
  bulkOneFileUrl,
  REQUIRED_COLUMNS,
} from "@/lib/sourcing/companies-house-bulk";
import { CONSTRUCTION_SIC_CODES } from "@/lib/sourcing/construction-sic";

// A realistic Basic Company Data header (subset + the columns we consume).
const HEADER =
  'CompanyName,CompanyNumber,RegAddress.AddressLine1,RegAddress.PostTown,RegAddress.County,RegAddress.Country,RegAddress.PostCode,CompanyCategory,CompanyStatus,IncorporationDate,SICCode.SicText_1,SICCode.SicText_2,SICCode.SicText_3,SICCode.SicText_4';

function row(cells: Record<string, string>): string {
  // Build a CSV line in the HEADER's column order.
  const cols = parseCsvLine(HEADER);
  return cols.map((c) => `"${(cells[c] ?? "").replace(/"/g, '""')}"`).join(",");
}

describe("parseCsvLine", () => {
  it("splits simple fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });
  it("honours quoted fields with embedded commas", () => {
    expect(parseCsvLine('"Smith, Jones Ltd",BT1 1AA')).toEqual(["Smith, Jones Ltd", "BT1 1AA"]);
  });
  it("honours escaped double-quotes", () => {
    expect(parseCsvLine('"He said ""hi""",x')).toEqual(['He said "hi"', "x"]);
  });
  it("trims surrounding whitespace", () => {
    expect(parseCsvLine(" a , b ")).toEqual(["a", "b"]);
  });
  it("handles trailing empty field", () => {
    expect(parseCsvLine("a,")).toEqual(["a", ""]);
  });
});

describe("mapHeader", () => {
  it("maps required columns by name", () => {
    const idx = mapHeader(HEADER);
    for (const c of REQUIRED_COLUMNS) expect(idx[c]).toBeGreaterThanOrEqual(0);
  });
  it("THROWS loud when a required column is missing (schema drift)", () => {
    const broken = HEADER.replace("CompanyStatus", "CompanyStatusX");
    expect(() => mapHeader(broken)).toThrowError(/missing required column/i);
  });
});

describe("extractSicCode / sicCodesOf / matchedConstructionSic", () => {
  it("extracts the 5-digit code from 'CODE - description'", () => {
    expect(extractSicCode("41100 - Development of building projects")).toBe("41100");
  });
  it("returns null for blank / non-coded cells", () => {
    expect(extractSicCode("")).toBeNull();
    expect(extractSicCode("None Supplied")).toBeNull();
  });
  it("collects codes across all four SIC columns", () => {
    const idx = mapHeader(HEADER);
    const line = row({ "SICCode.SicText_1": "41100 - x", "SICCode.SicText_3": "43999 - y" });
    expect(sicCodesOf(parseCsvLine(line), idx)).toEqual(["41100", "43999"]);
  });
  it("matches only allowlisted construction codes", () => {
    expect(matchedConstructionSic(["41100", "62012", "43999"])).toEqual(["41100", "43999"]);
    expect(matchedConstructionSic(["62012"])).toEqual([]);
  });
  it("the allowlist is non-empty and 5-digit", () => {
    expect(CONSTRUCTION_SIC_CODES.length).toBeGreaterThan(20);
    for (const c of CONSTRUCTION_SIC_CODES) expect(c).toMatch(/^\d{5}$/);
  });
});

describe("isNorthernIrelandPostcode (documented BT-area rule)", () => {
  it("accepts BT-area registered-office postcodes", () => {
    expect(isNorthernIrelandPostcode("BT1 1AA")).toBe(true);
    expect(isNorthernIrelandPostcode("bt48 7df")).toBe(true);
    expect(isNorthernIrelandPostcode("BT947AA")).toBe(true);
  });
  it("rejects GB postcodes and blanks", () => {
    expect(isNorthernIrelandPostcode("M1 1AA")).toBe(false); // Manchester
    expect(isNorthernIrelandPostcode("EC1A 1BB")).toBe(false); // London
    expect(isNorthernIrelandPostcode("")).toBe(false);
    expect(isNorthernIrelandPostcode("BTX 1AA")).toBe(false); // BT must be followed by a digit
  });
});

describe("isActiveStatus", () => {
  it("only 'Active' is live-trading", () => {
    expect(isActiveStatus("Active")).toBe(true);
    expect(isActiveStatus("active")).toBe(true);
    expect(isActiveStatus("Dissolved")).toBe(false);
    expect(isActiveStatus("Liquidation")).toBe(false);
    expect(isActiveStatus("")).toBe(false);
  });
});

describe("classifyRecord — the three eligibility gates", () => {
  const idx = mapHeader(HEADER);
  const base = { CompanyName: "NI Builders Ltd", CompanyNumber: "NI123456", "RegAddress.PostCode": "BT1 1AA", CompanyStatus: "Active", "SICCode.SicText_1": "41100 - Development" };
  const classify = (over: Record<string, string>) => classifyRecord(parseCsvLine(row({ ...base, ...over })), idx);

  it("eligible when Active + NI + construction SIC", () => {
    const c = classify({});
    expect(c.eligible).toBe(true);
    expect(c.reasons).toEqual(["active", "ni_registered_office", "construction_sic"]);
    expect(c.matchedSic).toEqual(["41100"]);
  });
  it("rejects a dissolved company (inactive filter)", () => {
    const c = classify({ CompanyStatus: "Dissolved" });
    expect(c.eligible).toBe(false);
    expect(c.rejectedBecause).toBe("not_active");
  });
  it("rejects a GB (non-NI) registered office", () => {
    const c = classify({ "RegAddress.PostCode": "M1 1AA" });
    expect(c.eligible).toBe(false);
    expect(c.rejectedBecause).toBe("not_northern_ireland");
  });
  it("rejects a non-construction SIC", () => {
    const c = classify({ "SICCode.SicText_1": "62012 - Business and domestic software development" });
    expect(c.eligible).toBe(false);
    expect(c.rejectedBecause).toBe("no_construction_sic");
  });
  it("rejects a row with no company number", () => {
    const c = classify({ CompanyNumber: "" });
    expect(c.eligible).toBe(false);
    expect(c.rejectedBecause).toBe("no_company_number");
  });
  it("uppercases the company number (stable dedupe identity)", () => {
    expect(classify({ CompanyNumber: "ni999999" }).companyNumber).toBe("NI999999");
  });
});

describe("normalizeRecord — register facts only, no fabrication", () => {
  const idx = mapHeader(HEADER);
  it("maps only register-grounded fields", () => {
    const line = row({
      CompanyName: "Belfast Groundworks Ltd",
      CompanyNumber: "NI654321",
      "RegAddress.PostCode": "BT9 5AA",
      "RegAddress.Country": "United Kingdom",
      CompanyCategory: "Private Limited Company",
      CompanyStatus: "Active",
      IncorporationDate: "14/03/2019",
      "SICCode.SicText_1": "43999 - Other specialised construction",
      "SICCode.SicText_2": "41202 - Construction of commercial buildings",
    });
    const n = normalizeRecord(parseCsvLine(line), idx);
    expect(n).toMatchObject({
      company_number: "NI654321",
      name: "Belfast Groundworks Ltd",
      status: "Active",
      company_category: "Private Limited Company",
      postcode: "BT9 5AA",
      country: "United Kingdom",
      incorporation_date: "2019-03-14",
      sic_codes: ["43999", "41202"],
      matched_sic: ["43999", "41202"],
      geography: "northern_ireland",
      reason_codes: ["active", "ni_registered_office", "construction_sic"],
    });
  });
  it("leaves absent optional fields null (never invents)", () => {
    const line = row({ CompanyName: "X", CompanyNumber: "NI1", "RegAddress.PostCode": "BT1 1AA", CompanyStatus: "Active", "SICCode.SicText_1": "41100 - x" });
    const n = normalizeRecord(parseCsvLine(line), idx);
    expect(n.company_category).toBeNull();
    expect(n.incorporation_date).toBeNull();
  });
});

describe("normaliseChDate", () => {
  it("DD/MM/YYYY -> ISO", () => {
    expect(normaliseChDate("01/10/2026")).toBe("2026-10-01");
  });
  it("null for blank/garbage", () => {
    expect(normaliseChDate("")).toBeNull();
    expect(normaliseChDate("2026-10-01")).toBeNull();
  });
});

describe("snapshot + URL derivation", () => {
  it("currentSnapshotDate is YYYY-MM-01 in UTC", () => {
    expect(currentSnapshotDate(new Date(Date.UTC(2026, 9, 24)))).toBe("2026-10-01");
  });
  it("bulkOneFileUrl uses the official host + filename pattern", () => {
    expect(bulkOneFileUrl("2026-10-01")).toBe(
      "http://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-2026-10-01.zip",
    );
  });
});
