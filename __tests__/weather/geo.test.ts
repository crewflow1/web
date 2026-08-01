import { describe, it, expect } from "vitest";
import {
  resolveDistrictCoordinates,
  datasetInfo,
  DISTRICT_CENTROIDS,
  DISTRICT_CENTROID_COUNT,
  DISTRICT_CENTROID_SOURCE,
  DISTRICT_CENTROID_VERSION,
  DISTRICT_CENTROID_ATTRIBUTION,
} from "@/lib/weather/geo";
import { toPostcodeDistrict } from "@/lib/weather/postcode";
import type { PostcodeDistrict } from "@/lib/weather/types";

/**
 * District → coordinate resolution — dataset integrity and the no-guessing
 * contract.
 *
 * The dataset is a GENERATED artefact (scripts/derive-district-centroids.ts
 * over the ONS Postcode Directory), so these tests are the review a human
 * cannot do by reading 2,900 rows: they pin the dataset's shape (count,
 * uniqueness, ordering, precision, UK bounds) and sample its VALUES against
 * independently known geography. A regeneration that drifted — wrong column,
 * wrong filter, OSGB36 eastings mistaken for degrees, a truncated download —
 * fails here rather than shipping quietly.
 */

const d = (s: string): PostcodeDistrict => {
  // Route through the real normaliser where possible; fall back to a cast for
  // deliberately-invalid probes.
  return (toPostcodeDistrict(s) ?? (s as PostcodeDistrict)) as PostcodeDistrict;
};

// UK bounding box including Northern Ireland — same bounds the derivation
// enforces. Lat 49.8 (Scilly) to 60.9 (Unst); lon -8.2 (Fermanagh/west NI) to
// 1.8 (Lowestoft).
const LAT_MIN = 49.8;
const LAT_MAX = 60.9;
const LON_MIN = -8.2;
const LON_MAX = 1.8;

describe("dataset integrity — the shape a valid derivation must have", () => {
  it("carries a full UK's worth of districts (~2,900), and the exported count is the array's", () => {
    expect(DISTRICT_CENTROIDS.length).toBeGreaterThan(2500);
    expect(DISTRICT_CENTROIDS.length).toBeLessThan(3500);
    expect(DISTRICT_CENTROID_COUNT).toBe(DISTRICT_CENTROIDS.length);
  });

  it("has no duplicate districts", () => {
    const seen = new Set(DISTRICT_CENTROIDS.map(([district]) => district));
    expect(seen.size).toBe(DISTRICT_CENTROIDS.length);
  });

  it("is sorted by district — a stable, reviewable diff on regeneration", () => {
    for (let i = 1; i < DISTRICT_CENTROIDS.length; i++) {
      expect(
        DISTRICT_CENTROIDS[i - 1]![0] < DISTRICT_CENTROIDS[i]![0],
        `${DISTRICT_CENTROIDS[i - 1]![0]} must sort before ${DISTRICT_CENTROIDS[i]![0]}`,
      ).toBe(true);
    }
  });

  it("every district matches the outward-code shape the weather schema CHECKs, and GIR is absent", () => {
    const OUTWARD = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
    for (const [district] of DISTRICT_CENTROIDS) {
      expect(district, district).toMatch(OUTWARD);
    }
    expect(DISTRICT_CENTROIDS.some(([x]) => x === "GIR")).toBe(false);
  });

  it("every coordinate is inside the UK (incl. Northern Ireland), finite, 5 dp", () => {
    // The bounds catch the classic derivation failures wholesale: OSGB36
    // eastings read as degrees, lat/lon swapped, the 99.999999 sentinel leaking
    // through, or a stray 0,0.
    for (const [district, lat, lon] of DISTRICT_CENTROIDS) {
      expect(Number.isFinite(lat), district).toBe(true);
      expect(Number.isFinite(lon), district).toBe(true);
      expect(lat, `${district} lat`).toBeGreaterThanOrEqual(LAT_MIN);
      expect(lat, `${district} lat`).toBeLessThanOrEqual(LAT_MAX);
      expect(lon, `${district} lon`).toBeGreaterThanOrEqual(LON_MIN);
      expect(lon, `${district} lon`).toBeLessThanOrEqual(LON_MAX);
      expect(Number(lat.toFixed(5)), `${district} lat 5dp`).toBe(lat);
      expect(Number(lon.toFixed(5)), `${district} lon 5dp`).toBe(lon);
    }
  });

  it("covers Northern Ireland — the reason the ONSPD was chosen over Code-Point Open", () => {
    const bt = DISTRICT_CENTROIDS.filter(([x]) => /^BT\d/.test(x));
    expect(bt.length).toBeGreaterThan(60); // BT1–BT94, minus gaps
  });

  it("excludes the Crown dependencies — the ONSPD publishes no coordinates for them", () => {
    // GY/JE/IM postcodes exist in the ONSPD but carry the no-grid-reference
    // sentinel; shipping an invented coordinate for them would be guessing.
    expect(DISTRICT_CENTROIDS.some(([x]) => /^(GY|JE|IM)\d/.test(x))).toBe(false);
  });
});

describe("spot-checks against independently known geography (±0.05°)", () => {
  // Expected values are city-centre coordinates from published sources, NOT
  // from this dataset — that independence is the point. All are compact urban
  // districts, where the centroid must sit close to the recognised centre.
  const KNOWN: ReadonlyArray<readonly [string, number, number]> = [
    ["LS1", 53.797, -1.549], // Leeds city centre
    ["SW1A", 51.501, -0.13], // Whitehall / Buckingham Palace
    ["EC1A", 51.52, -0.102], // City of London, St Bartholomew's
    ["M1", 53.478, -2.236], // Manchester city centre
    ["B1", 52.479, -1.907], // Birmingham city centre
    ["EH1", 55.95, -3.19], // Edinburgh Old Town
    ["G1", 55.858, -4.248], // Glasgow Merchant City
    ["CF10", 51.475, -3.17], // Cardiff city centre
    ["BT1", 54.6, -5.928], // Belfast city centre — the NI coverage proof
    ["PL1", 50.371, -4.15], // Plymouth city centre
    ["ZE1", 60.153, -1.15], // Lerwick — the northern extremity works too
  ];

  for (const [district, lat, lon] of KNOWN) {
    it(`${district} resolves within 0.05° of its published centre`, () => {
      const r = resolveDistrictCoordinates(d(district));
      expect(r).not.toBeNull();
      expect(Math.abs(r!.lat - lat), `${district} lat ${r!.lat}`).toBeLessThan(0.05);
      expect(Math.abs(r!.lon - lon), `${district} lon ${r!.lon}`).toBeLessThan(0.05);
    });
  }
});

describe("resolution semantics — null is an answer, guessing is not", () => {
  it("a resolved district reports its provenance: source and centroid quality", () => {
    const r = resolveDistrictCoordinates(d("LS1"));
    expect(r).toEqual({
      lat: expect.any(Number),
      lon: expect.any(Number),
      source: "ons_onspd",
      quality: "centroid",
    });
  });

  it("resolution agrees byte-for-byte with the dataset row", () => {
    const [district, lat, lon] = DISTRICT_CENTROIDS[0]!;
    const r = resolveDistrictCoordinates(d(district));
    expect(r!.lat).toBe(lat);
    expect(r!.lon).toBe(lon);
  });

  it("an unknown district returns null — never a neighbour, never 0,0", () => {
    // Valid outward SHAPES that are not real districts. The caller must
    // surface "cannot resolve", and a test elsewhere pins that the decision
    // layer reads no-weather as `unknown`, never as `viable`.
    for (const probe of ["ZZ9", "XX1", "QQ1A"]) {
      expect(resolveDistrictCoordinates(probe as PostcodeDistrict), probe).toBeNull();
    }
  });

  it("GIR resolves to null — a payments artefact, not a place", () => {
    expect(toPostcodeDistrict("GIR 0AA")).toBe("GIR");
    expect(resolveDistrictCoordinates(toPostcodeDistrict("GIR 0AA")!)).toBeNull();
  });

  it("Crown-dependency districts resolve to null rather than to an invented point", () => {
    for (const probe of ["GY1", "JE2", "IM1"]) {
      expect(resolveDistrictCoordinates(d(probe)), probe).toBeNull();
    }
  });

  it("un-normalised input does not resolve — the branded type is load-bearing", () => {
    // A full postcode or lowercase junk must go through toPostcodeDistrict
    // first; the map is keyed on the normalised form only.
    for (const probe of ["ls1", "LS1 4AP", "LS1 ", ""]) {
      expect(resolveDistrictCoordinates(probe as PostcodeDistrict), probe).toBeNull();
    }
  });
});

describe("datasetInfo — the attribution surface", () => {
  it("reports source, version, count and the OGL attribution lines", () => {
    const info = datasetInfo();
    expect(info.source).toBe("ons_onspd");
    expect(info.source).toBe(DISTRICT_CENTROID_SOURCE);
    expect(info.version).toBe(DISTRICT_CENTROID_VERSION);
    expect(info.version).toMatch(/ONSPD/);
    expect(info.districtCount).toBe(DISTRICT_CENTROID_COUNT);
    expect(info.attribution).toBe(DISTRICT_CENTROID_ATTRIBUTION);
  });

  it("attribution carries the lines the licence requires, verbatim classes", () => {
    const joined = datasetInfo().attribution.join("\n");
    expect(joined).toMatch(/Contains OS data © Crown copyright and database right \d{4}/);
    expect(joined).toMatch(/Contains Royal Mail data © Royal Mail copyright and database right \d{4}/);
    expect(joined).toMatch(/Office for National Statistics/);
    expect(joined).toMatch(/Open Government Licence/);
  });
});
