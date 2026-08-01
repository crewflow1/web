/**
 * Derive UK postcode-district (outward code) centroids from the ONS Postcode
 * Directory (ONSPD) and emit `lib/weather/geo/district-centroids.ts`.
 *
 * OFFLINE, BY DESIGN. This script performs NO network I/O: it reads an ONSPD
 * release that a human has already downloaded from the ONS Open Geography
 * Portal, and it runs at build/derivation time only — never at runtime. The
 * weather feature's security suite pins `lib/weather/**` to zero network
 * egress; this script lives in `scripts/` precisely so the dataset it produces
 * is a checked-in artefact of a reviewed derivation, not a runtime fetch.
 *
 * USAGE
 *   1. Download the current ONSPD from the ONS Open Geography Portal
 *      (https://geoportal.statistics.gov.uk/ — search "ONS Postcode Directory").
 *   2. Unzip it, keeping the `Data/multi_csv/` directory.
 *   3. export PATH="/opt/homebrew/bin:$PATH"   # this machine's node lives there
 *      npx tsx scripts/derive-district-centroids.ts \
 *        <path to Data/multi_csv (dir) or the single ONSPD_*_UK.csv> \
 *        --release "May 2026" \
 *        --source-url "<the exact portal item URL the zip came from>" \
 *        --source-file "ONSPD_MAY_2026.zip"
 *   4. Commit the regenerated lib/weather/geo/district-centroids.ts and run
 *      the weather test suites — the dataset-integrity tests are the gate.
 *
 * METHOD (documented in the generated file's header as well):
 *   - Rows are LIVE postcodes only (`doterm` empty — terminated postcodes are
 *     excluded so a dissolved 1990s district cannot pull a centroid around).
 *   - Rows with no usable coordinate are excluded: the ONSPD marks "no grid
 *     reference" with lat 99.999999 (Channel Islands, Isle of Man and a
 *     handful of specials), which is also why GY/JE/IM districts do not appear
 *     in the output — the ONSPD carries no coordinates for them.
 *   - GIR (the former Girobank special) is excluded explicitly: it is not a
 *     geographic district and its postcodes are terminated anyway.
 *   - The outward code is the token before the space in `pcds`, validated
 *     against the same shape the weather schema's CHECK enforces.
 *   - The centroid is the UNWEIGHTED ARITHMETIC MEAN of the WGS84 lat/long of
 *     every live postcode unit in the district, rounded to 5 dp (~1.1 m).
 *     A mean in degrees is fine at district scale: no UK district spans
 *     anywhere near the longitudes where naive averaging breaks down.
 *
 * LICENSING of the output (rendered into the generated header):
 *   ONSPD is released under the Open Government Licence v3.0 and requires:
 *     Contains OS data © Crown copyright and database right <year>
 *     Contains Royal Mail data © Royal Mail copyright and database right <year>
 *     Contains GeoPlace data © Local Government Information House Limited
 *       copyright and database right <year>
 *     Source: Office for National Statistics licensed under the Open
 *       Government Licence v.3.0
 *   NI CAVEAT: Northern Ireland postcodes inside the ONSPD are additionally
 *   subject to Ordnance Survey of Northern Ireland / LPS licensing terms (see
 *   the ONSPD User Guide's "Northern Ireland postcodes" section). The BT
 *   centroids shipped here are heavily aggregated derivations, but the licence
 *   position for commercial redistribution should be confirmed before any
 *   surface REDISTRIBUTES them beyond displaying weather for a job.
 */

import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";

// The six real UK outward-code shapes — identical to lib/weather/postcode.ts
// and to the CHECK on weather_readings.postcode_district.
const OUTWARD = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;

// UK bounding box, generous, including Northern Ireland and the Northern
// Isles. Anything outside is a data error we refuse to ship.
const LAT_MIN = 49.8;
const LAT_MAX = 60.9;
const LON_MIN = -8.2;
const LON_MAX = 1.8;

/** Minimal CSV field splitter: commas outside double quotes. ONSPD values
 * never contain escaped quotes, but we stay correct if they did ("" inside a
 * quoted field). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

type Acc = { latSum: number; lonSum: number; n: number };

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      flags.set(a.slice(2), argv[++i] ?? "");
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const input = positional[0];
  if (!input) {
    console.error(
      "usage: npx tsx scripts/derive-district-centroids.ts <multi_csv dir | ONSPD UK csv> " +
        '--release "May 2026" --source-url <url> --source-file <zip name> [--out <path>]',
    );
    process.exit(2);
  }
  const release = flags.get("release") ?? "UNKNOWN RELEASE — pass --release";
  const sourceUrl = flags.get("source-url") ?? "UNKNOWN — pass --source-url";
  const sourceFile = flags.get("source-file") ?? "UNKNOWN — pass --source-file";
  const outPath = resolve(
    process.cwd(),
    flags.get("out") ?? "lib/weather/geo/district-centroids.ts",
  );

  const inputPath = resolve(process.cwd(), input);
  const files = statSync(inputPath).isDirectory()
    ? readdirSync(inputPath)
        .filter((f) => f.toLowerCase().endsWith(".csv"))
        .sort()
        .map((f) => join(inputPath, f))
    : [inputPath];
  if (files.length === 0) {
    console.error(`no .csv files under ${inputPath}`);
    process.exit(2);
  }

  const acc = new Map<string, Acc>();
  let totalRows = 0;
  let liveRows = 0;
  let usedRows = 0;
  let noCoord = 0;
  let girRows = 0;
  let badShape = 0;
  let outOfBounds = 0;

  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    let iPcds = -1;
    let iDoterm = -1;
    let iLat = -1;
    let iLong = -1;
    for await (const line of rl) {
      if (line.length === 0) continue;
      if (header === null) {
        header = splitCsv(line).map((h) => h.trim().toLowerCase());
        iPcds = header.indexOf("pcds");
        iDoterm = header.indexOf("doterm");
        iLat = header.indexOf("lat");
        iLong = header.indexOf("long");
        if (iPcds < 0 || iDoterm < 0 || iLat < 0 || iLong < 0) {
          console.error(`${file}: missing pcds/doterm/lat/long in header`);
          process.exit(2);
        }
        continue;
      }
      totalRows++;
      const cols = splitCsv(line);
      if ((cols[iDoterm] ?? "").trim() !== "") continue; // terminated postcode
      liveRows++;

      const pcds = (cols[iPcds] ?? "").trim().toUpperCase();
      const outward = pcds.split(/\s+/)[0] ?? "";
      if (outward === "GIR") {
        girRows++;
        continue;
      }
      if (!OUTWARD.test(outward)) {
        badShape++;
        continue;
      }

      const lat = Number(cols[iLat]);
      const lon = Number(cols[iLong]);
      // 99.999999 is the ONSPD's "no grid reference" sentinel; 0,0 is a
      // defensive extra — neither is a UK coordinate.
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat > 90 || (lat === 0 && lon === 0)) {
        noCoord++;
        continue;
      }
      if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
        outOfBounds++;
        continue;
      }

      usedRows++;
      const a = acc.get(outward);
      if (a) {
        a.latSum += lat;
        a.lonSum += lon;
        a.n++;
      } else {
        acc.set(outward, { latSum: lat, lonSum: lon, n: 1 });
      }
    }
  }

  const districts = [...acc.entries()]
    .map(([district, a]) => ({
      district,
      lat: Number((a.latSum / a.n).toFixed(5)),
      lon: Number((a.lonSum / a.n).toFixed(5)),
      n: a.n,
    }))
    .sort((x, y) => (x.district < y.district ? -1 : x.district > y.district ? 1 : 0));

  const year = new Date().getUTCFullYear();
  const generatedOn = new Date().toISOString().slice(0, 10);

  const lines = districts.map(
    (d) => `  ["${d.district}", ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}],`,
  );

  const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: npx tsx scripts/derive-district-centroids.ts (see that
 * script's header for the full procedure). Edits here would silently diverge
 * from the source dataset; corrections belong in the derivation script.
 *
 * UK postcode-district (outward code) centroids, WGS84, 5 dp.
 *
 * SOURCE
 *   Product:        ONS Postcode Directory (ONSPD), ${release} release
 *   Publisher:      Office for National Statistics, Open Geography Portal
 *   Source URL:     ${sourceUrl}
 *   Source file:    ${sourceFile}
 *   Derived:        ${generatedOn} by scripts/derive-district-centroids.ts
 *
 * DERIVATION
 *   ${totalRows.toLocaleString("en-GB")} postcode rows read; ${liveRows.toLocaleString("en-GB")} live (doterm empty);
 *   ${usedRows.toLocaleString("en-GB")} carried a usable WGS84 coordinate and contributed to a centroid
 *   (${noCoord.toLocaleString("en-GB")} live rows had the ONSPD no-grid-reference sentinel — Channel
 *   Islands, Isle of Man and specials — ${girRows} were GIR, ${badShape} had a
 *   non-standard outward shape, ${outOfBounds} were out of UK bounds).
 *   Centroid = unweighted arithmetic mean of every live unit postcode's
 *   lat/long within the outward code, rounded to 5 dp. ${districts.length.toLocaleString("en-GB")} districts.
 *
 * LICENCE — Open Government Licence v3.0. Required attribution:
 *   Contains OS data © Crown copyright and database right ${year}
 *   Contains Royal Mail data © Royal Mail copyright and database right ${year}
 *   Contains GeoPlace data © Local Government Information House Limited
 *     copyright and database right ${year}
 *   Source: Office for National Statistics licensed under the Open Government
 *     Licence v.3.0
 *   NI caveat: Northern Ireland postcodes in the ONSPD carry additional
 *   Ordnance Survey of Northern Ireland / LPS terms — confirm before any
 *   surface redistributes BT-derived data beyond in-product display.
 *
 * PRECISION CAVEAT (the IV27 case): a centroid is not a site. In a compact
 * urban district (LS1) it sits within a couple of km of any address; in a
 * large rural district (IV27, Sutherland) it can be tens of km away. Callers
 * surface this via WeatherWindow.resolvedDistanceKm when known — the verdict
 * layer's caveat, not this table's problem to hide.
 */

/** [district, lat, lon] — sorted by district, unique, WGS84, 5 dp. */
export type DistrictCentroidRow = readonly [district: string, lat: number, lon: number];

export const DISTRICT_CENTROID_SOURCE = "ons_onspd" as const;
export const DISTRICT_CENTROID_VERSION = ${JSON.stringify(`ONSPD ${release}`)} as const;
export const DISTRICT_CENTROID_ATTRIBUTION = [
  "Contains OS data © Crown copyright and database right ${year}",
  "Contains Royal Mail data © Royal Mail copyright and database right ${year}",
  "Contains GeoPlace data © Local Government Information House Limited copyright and database right ${year}",
  "Source: Office for National Statistics licensed under the Open Government Licence v.3.0",
] as const;

export const DISTRICT_CENTROIDS: ReadonlyArray<DistrictCentroidRow> = [
${lines.join("\n")}
] as const;

/** The count, exported for the readiness derivation — never hard-code it. */
export const DISTRICT_CENTROID_COUNT = DISTRICT_CENTROIDS.length;
`;

  writeFileSync(outPath, out, "utf8");
  console.log(
    `wrote ${outPath}\n` +
      `  rows read:      ${totalRows}\n` +
      `  live:           ${liveRows}\n` +
      `  used:           ${usedRows}\n` +
      `  no coordinate:  ${noCoord}\n` +
      `  GIR:            ${girRows}\n` +
      `  bad shape:      ${badShape}\n` +
      `  out of bounds:  ${outOfBounds}\n` +
      `  districts:      ${districts.length}`,
  );
  const smallest = [...districts].sort((a, b) => a.n - b.n).slice(0, 5);
  console.log(
    "  smallest districts by contributing postcodes: " +
      smallest.map((d) => `${d.district}(${d.n})`).join(", "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
