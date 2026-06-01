import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvFile, parseXlsxBuffer, type ParsedSheet } from "@/lib/imports/parsers";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { expandZips, type UploadItem } from "@/lib/imports/zip";
import { isOcrFile } from "@/lib/imports/ocr";

/**
 * Migration OS — "ingests every supported file type" contract.
 *
 * The import wizard advertises (and the UI `accept=` lists) a broad set of
 * formats: CSV, TSV/TXT, Excel (xlsx/xlsm/xlsb/xls), OpenDocument (ODS), Apple
 * Numbers, PDF/photo OCR, and ZIP archives of any of these. This suite proves
 * end-to-end ingestion with REAL fixture files (committed under ./fixtures),
 * driven through the SAME parse/detect path the upload server action uses:
 *
 *   .csv                         → parseCsvFile
 *   tsv/txt/xls/xlsx/xlsb/ods/…  → parseXlsxBuffer (SheetJS sniffs delimiter/format)
 *   zip                          → expandZips → re-dispatch inner files
 *   pdf / image                  → isOcrFile → ocrFileToSheet (vision)
 *
 * Each deterministic fixture stamps its source format into the customer name
 * ("Acme XLSX Ltd", …) so a parsed row self-identifies which file — and which
 * code path — produced it.
 *
 * It also regression-pins the storage-upload fix: the `imports` bucket enforces
 * an allowed_mime_types whitelist (CSV/XLS/XLSX/octet-stream only). Uploading
 * each parsed file with its real browser MIME (file.type) made Supabase Storage
 * reject TSV/TXT/ODS/PDF/PNG/… *after* a successful parse — surfacing as
 * upload_failed for everything except CSV/XLS/XLSX. The fix normalises the
 * stored content-type to the always-allowed octet-stream; these pins stop it
 * silently regressing.
 */

const fx = (name: string) => readFileSync(resolve(__dirname, "fixtures", name));
const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

// The 50% bar must match REVIEW_THRESHOLD in app/(app)/imports/actions.ts.
const REVIEW_THRESHOLD = 50;

// Mirror the real upload dispatch: .csv → parseCsvFile, everything else
// spreadsheet/delimited → parseXlsxBuffer.
function parseLikeUpload(name: string, bytes: Uint8Array): ParsedSheet[] {
  if (name.toLowerCase().endsWith(".csv")) {
    return [parseCsvFile(new TextDecoder().decode(bytes), name)];
  }
  return parseXlsxBuffer(bytes);
}

const flat = (sheets: ParsedSheet[]): string =>
  sheets
    .flatMap((s) => s.rows.flat())
    .map((c) => String(c ?? ""))
    .join(" | ");

// [fixture file, format-stamped name it must decode to]
const DETERMINISTIC: Array<[string, string]> = [
  ["customers.csv", "Acme CSV Ltd"],
  ["customers.tsv", "Acme TSV Ltd"],
  ["customers.txt", "Acme TXT Ltd"],
  ["customers.xls", "Acme XLS Ltd"],
  ["customers.xlsx", "Acme XLSX Ltd"],
  ["customers.xlsm", "Acme XLSM Ltd"],
  ["customers.xlsb", "Acme XLSB Ltd"],
  ["customers.ods", "Acme ODS Ltd"],
];

// Spreadsheet/delimited dispatch (mirrors actions.ts): a file routes to a
// parser purely by extension here — these are every extension SheetJS/CSV own.
const SPREADSHEET_OR_DELIMITED =
  /\.(xlsx|xlsm|xlsb|xls|xlt|xltx|xltm|ods|fods|numbers|dif|prn|slk|dbf|csv|tsv|tab|txt|psv)$/i;

// OCR fixtures: [filename, browser MIME, magic-byte assertion on the real file].
// Proves each is a genuine file of its type AND that the upload dispatch routes
// it to the vision extractor (by MIME and by extension) — never to the
// spreadsheet/delimited parser. (Actual text extraction is exercised live.)
const OCR_FIXTURES: Array<[string, string, (b: Buffer) => void]> = [
  ["invoice.pdf", "application/pdf", (b) =>
    expect(b.subarray(0, 4).toString("latin1")).toBe("%PDF")],
  ["invoice-photo.png", "image/png", (b) =>
    expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])],
  ["invoice-photo.jpg", "image/jpeg", (b) =>
    expect([...b.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])],
  ["invoice-photo.webp", "image/webp", (b) => {
    expect(b.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(b.subarray(8, 12).toString("latin1")).toBe("WEBP");
  }],
  ["invoice-photo.gif", "image/gif", (b) =>
    expect(b.subarray(0, 4).toString("latin1")).toBe("GIF8")],
  ["invoice-photo.heic", "image/heic", (b) => {
    expect(b.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(b.subarray(8, 12).toString("latin1")).toMatch(/heic|heif|mif1|hevc/);
  }],
];

describe("Migration OS ingests every supported deterministic file format", () => {
  for (const [file, stamp] of DETERMINISTIC) {
    it(`${file} → parses to a confident, detectable row (${stamp})`, () => {
      const sheets = parseLikeUpload(file, fx(file));
      expect(sheets.length).toBeGreaterThan(0);
      const sheet = sheets[0]!;
      expect(sheet.rows.length).toBeGreaterThan(0);

      // Byte-level proof: the decoded cells carry the format-stamped name, so
      // the right file produced the right data through the right parser.
      expect(flat(sheets)).toContain(stamp);

      // Detection proof: recognised (not 'unknown') with commit-grade
      // confidence, so the row routes to `pending`, not the review queue.
      const detected = detectEntityType(sheet);
      expect(detected.entity_type).not.toBe("unknown");
      const mapped = mapRow(detected, sheet.rows[0]!);
      expect(mapped.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    });
  }
});

describe("ZIP archives expand and each inner file parses (expandZips)", () => {
  it("mixed.zip → unpacks zip-inner.csv + zip-inner.xlsx, both parse", async () => {
    const bytes = fx("mixed.zip");
    const item: UploadItem = {
      name: "mixed.zip",
      type: "application/zip",
      size: bytes.byteLength,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
    };

    const inner = await expandZips([item]);
    expect(inner.map((f) => f.name).sort()).toEqual([
      "zip-inner.csv",
      "zip-inner.xlsx",
    ]);

    let blob = "";
    for (const f of inner) {
      const b = new Uint8Array(await f.arrayBuffer());
      blob += " | " + flat(parseLikeUpload(f.name, b));
    }
    expect(blob).toContain("Acme ZIP-CSV Ltd");
    expect(blob).toContain("Acme ZIP-XLSX Ltd");
  });
});

describe("OCR formats (PDF / image) route to the vision extractor", () => {
  for (const [file, mime, magic] of OCR_FIXTURES) {
    it(`${file} is a real ${mime} file and routes to OCR (MIME + extension)`, () => {
      // Byte-level proof it's a genuine file of its type.
      magic(fx(file));
      // Routes to OCR by its real browser MIME…
      expect(isOcrFile({ type: mime, name: file })).toBe(true);
      // …and by extension fallback when the browser sends an empty type.
      expect(isOcrFile({ type: "", name: file })).toBe(true);
      // …and is NEVER claimed by the spreadsheet/delimited dispatch.
      expect(SPREADSHEET_OR_DELIMITED.test(file)).toBe(false);
    });
  }

  it(".heif extension also routes to OCR (Apple's other still format)", () => {
    expect(isOcrFile({ type: "image/heif", name: "scan.heif" })).toBe(true);
    expect(isOcrFile({ type: "", name: "scan.heif" })).toBe(true);
  });
});

describe("Apple Numbers routes to the SheetJS spreadsheet parser (dispatch)", () => {
  // SheetJS 0.18.5 can READ .numbers but can't synthesise one (it only writes
  // by patching a real template), so we pin the dispatch + allowlist contract
  // rather than a parsed fixture: a .numbers upload is classified as a
  // spreadsheet (→ parseXlsxBuffer), never OCR, never unknown.
  it("classifies .numbers as spreadsheet/delimited, not OCR", () => {
    expect(SPREADSHEET_OR_DELIMITED.test("export.numbers")).toBe(true);
    expect(isOcrFile({ type: "application/vnd.apple.numbers", name: "export.numbers" })).toBe(false);
    expect(isOcrFile({ type: "", name: "export.numbers" })).toBe(false);
  });
});

describe("storage upload normalises content-type so non-CSV formats aren't rejected", () => {
  const actions = read("app/(app)/imports/actions.ts");

  it("uploads to the imports bucket with a constant octet-stream type, not file.type", () => {
    // Regression: the imports bucket's allowed_mime_types admits only
    // CSV/XLS/XLSX/octet-stream. Uploading with the real file MIME made storage
    // reject every other parsed format (upload_failed). Pin the normalisation.
    expect(actions).toMatch(
      /\.from\("imports"\)[\s\S]*?contentType: "application\/octet-stream"/,
    );
    expect(actions).not.toMatch(/contentType: file\.type/);
  });

  it("the imports bucket migration whitelists octet-stream (so the constant is accepted)", () => {
    const mig = read("supabase/migrations/20260526000000_migration_os.sql");
    expect(mig).toMatch(/'application\/octet-stream'/);
  });
});

describe("the widening migration admits every supported format's real MIME (defense-in-depth)", () => {
  const mig = read(
    "supabase/migrations/20260703000000_widen_imports_bucket_mime.sql",
  );

  it("targets the imports bucket idempotently (insert … on conflict do update)", () => {
    expect(mig).toMatch(/insert into storage\.buckets/i);
    expect(mig).toMatch(/'imports'/);
    expect(mig).toMatch(/on conflict \(id\) do update/i);
    expect(mig).toMatch(/allowed_mime_types = excluded\.allowed_mime_types/);
  });

  // Every format the wizard accepts must have at least one admitting MIME.
  const REQUIRED_MIMES = [
    // delimited / text
    "text/csv",
    "application/csv",
    "text/tab-separated-values",
    "text/plain",
    // excel family (xls, xlsx, xltx, xlsm, xltm, xlsb)
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.ms-excel.template.macroEnabled.12",
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    // opendocument (+ flat-xml fods)
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/xml",
    "text/xml",
    // apple numbers
    "application/vnd.apple.numbers",
    "application/x-iwork-numbers-sffnumbers",
    // pdf + images (OCR)
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
    // zip archives
    "application/zip",
    "application/x-zip-compressed",
    // catch-all (also the constant the upload action stores)
    "application/octet-stream",
  ];

  for (const mime of REQUIRED_MIMES) {
    it(`whitelists ${mime}`, () => {
      expect(mig).toContain(`'${mime}'`);
    });
  }
});
