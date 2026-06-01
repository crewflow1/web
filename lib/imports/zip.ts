import "server-only";
import JSZip from "jszip";

/**
 * Minimal uploaded-item shape the import pipeline consumes. A browser `File`
 * already satisfies this; ZIP entries are adapted to it so the rest of the
 * importer treats archived files exactly like directly-uploaded ones.
 */
export type UploadItem = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const ZIP_EXT = /\.zip$/i;
const ZIP_MIME = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
]);

// Files we can parse downstream: delimited text, every common spreadsheet
// format SheetJS reads, PDF, and OCR-able images.
const SUPPORTED_INNER =
  /\.(csv|tsv|tab|txt|psv|xlsx|xlsm|xlsb|xls|ods|fods|numbers|dif|prn|slk|pdf|png|jpe?g|gif|heic|heif|webp)$/i;

function isZip(item: { name: string; type: string }): boolean {
  return ZIP_EXT.test(item.name) || ZIP_MIME.has(item.type);
}

function guessMime(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".tsv") || n.endsWith(".tab")) return "text/tab-separated-values";
  if (n.endsWith(".txt") || n.endsWith(".psv")) return "text/plain";
  if (n.endsWith(".xlsx") || n.endsWith(".xlsm") || n.endsWith(".xlsb"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".ods") || n.endsWith(".fods"))
    return "application/vnd.oasis.opendocument.spreadsheet";
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".heif")) return "image/heif";
  if (n.endsWith(".webp")) return "image/webp";
  // numbers, dif, prn, slk, dbf etc. — routed by extension downstream.
  return "application/octet-stream";
}

/**
 * Expand any ZIP archives in the upload set into their supported inner files,
 * leaving non-zip files untouched. Nested folders are flattened to the entry's
 * base name. Unsupported and hidden (__MACOSX, dotfile) entries are skipped.
 */
export async function expandZips(files: UploadItem[]): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  for (const file of files) {
    if (!isZip(file)) {
      out.push(file);
      continue;
    }
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const base = entry.name.split("/").pop() ?? entry.name;
      if (!base || base.startsWith(".")) continue;
      if (entry.name.startsWith("__MACOSX")) continue;
      if (!SUPPORTED_INNER.test(base)) continue;
      const bytes = await entry.async("uint8array");
      out.push({
        name: base,
        type: guessMime(base),
        size: bytes.byteLength,
        // Copy into a standalone ArrayBuffer so the slice isn't a view.
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
      });
    }
  }
  return out;
}
