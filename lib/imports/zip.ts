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
//
// IMPORTANT: this allowlist MUST stay in sync with the direct-upload dispatch
// in app/(app)/imports/actions.ts (the `isSpreadsheet`/`isDelimited`/OCR sets)
// and the UI `accept=` attribute. If a format is accepted for direct upload
// but missing here, it gets silently dropped when the same file arrives inside
// a ZIP — which is exactly the xlt/xltx/xltm/dbf gap this list previously had.
const SUPPORTED_INNER =
  /\.(csv|tsv|tab|txt|psv|xlsx|xlsm|xlsb|xls|xlt|xltx|xltm|ods|fods|numbers|dif|prn|slk|dbf|pdf|png|jpe?g|gif|heic|heif|webp)$/i;

function isZip(item: { name: string; type: string }): boolean {
  return ZIP_EXT.test(item.name) || ZIP_MIME.has(item.type);
}

function guessMime(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".tsv") || n.endsWith(".tab")) return "text/tab-separated-values";
  if (n.endsWith(".txt") || n.endsWith(".psv")) return "text/plain";
  if (
    n.endsWith(".xlsx") ||
    n.endsWith(".xlsm") ||
    n.endsWith(".xlsb") ||
    n.endsWith(".xltx") ||
    n.endsWith(".xltm")
  )
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls") || n.endsWith(".xlt")) return "application/vnd.ms-excel";
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
 * DECOMPRESSION-BOMB LIMITS. An archive is attacker-shaped input: a 50 MB upload
 * (the bucket cap) of highly-compressible bytes inflates to tens of GB, and the
 * previous loop inflated EVERY supported entry fully into memory with no bound —
 * an out-of-memory kill of the function for one small request. All three limits
 * are enforced on the ACTUAL inflated byte count while streaming (a zip's
 * declared sizes are attacker-written), and breaching any of them rejects the
 * whole archive rather than importing a silently-truncated subset.
 *
 * The per-file cap mirrors the `imports` bucket's 50 MB object limit: an inner
 * file larger than that could not be stored as a direct upload either.
 */
export const ZIP_MAX_ENTRIES = 500;
export const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export class ZipLimitError extends Error {
  reason: "too_many_entries" | "entry_too_large" | "archive_too_large";
  constructor(reason: ZipLimitError["reason"]) {
    super(`zip rejected: ${reason}`);
    this.name = "ZipLimitError";
    this.reason = reason;
  }
}

/** Inflate one entry, aborting the moment it exceeds `cap` bytes. */
function inflateCapped(entry: JSZip.JSZipObject, cap: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const stream = entry.internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        if (done) return;
        total += chunk.byteLength;
        if (total > cap) {
          done = true;
          stream.pause();
          reject(new ZipLimitError("entry_too_large"));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (e: Error) => {
        if (!done) {
          done = true;
          reject(e);
        }
      })
      .on("end", () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}

/**
 * Expand any ZIP archives in the upload set into their supported inner files,
 * leaving non-zip files untouched. Nested folders are flattened to the entry's
 * base name. Unsupported and hidden (__MACOSX, dotfile) entries are skipped.
 * Throws {@link ZipLimitError} when an archive breaches a decompression limit.
 */
export async function expandZips(files: UploadItem[]): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  for (const file of files) {
    if (!isZip(file)) {
      out.push(file);
      continue;
    }
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files);
    if (entries.length > ZIP_MAX_ENTRIES) throw new ZipLimitError("too_many_entries");
    let archiveBytes = 0;
    for (const entry of entries) {
      if (entry.dir) continue;
      // Flatten on BOTH separators: a Windows-built (or hostile) archive can
      // carry `..\..\name.csv`, which must never survive as a "base name".
      const base = entry.name.split(/[\\/]/).pop() ?? entry.name;
      if (!base || base.startsWith(".")) continue;
      if (entry.name.startsWith("__MACOSX")) continue;
      if (!SUPPORTED_INNER.test(base)) continue;
      const remaining = ZIP_MAX_TOTAL_BYTES - archiveBytes;
      let bytes: Uint8Array;
      try {
        bytes = await inflateCapped(entry, Math.min(ZIP_MAX_ENTRY_BYTES, remaining));
      } catch (e) {
        if (e instanceof ZipLimitError && remaining < ZIP_MAX_ENTRY_BYTES) {
          throw new ZipLimitError("archive_too_large");
        }
        throw e;
      }
      archiveBytes += bytes.byteLength;
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
