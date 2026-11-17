import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  expandZips,
  ZipLimitError,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_TOTAL_BYTES,
  type UploadItem,
} from "@/lib/imports/zip";

/**
 * INJ-04 — decompression bomb in the import ZIP path.
 *
 * expandZips inflated every supported entry fully into memory with no bound on
 * entry count, per-entry size or archive total. A few-hundred-KB upload of
 * zeros inflates to hundreds of MB; the bucket's 50 MB cap allows tens of GB.
 * The limits are now enforced on the ACTUAL inflated bytes while streaming.
 */

async function zipOf(files: Record<string, Uint8Array | string>): Promise<UploadItem> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  return {
    name: "upload.zip",
    type: "application/zip",
    size: buf.byteLength,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

describe("expandZips enforces decompression limits", () => {
  it("rejects a single entry that inflates past the per-entry cap (tiny upload, huge output)", async () => {
    const bomb = await zipOf({ "customers.csv": new Uint8Array(ZIP_MAX_ENTRY_BYTES + 1024) });
    // The whole point of a bomb: the upload itself is small.
    expect(bomb.size).toBeLessThan(1024 * 1024);
    await expect(expandZips([bomb])).rejects.toMatchObject({ name: "ZipLimitError", reason: "entry_too_large" });
  }, 60_000);

  it("rejects an archive whose entries together exceed the total cap", async () => {
    const each = 45 * 1024 * 1024; // each is under the per-entry cap
    const count = Math.floor(ZIP_MAX_TOTAL_BYTES / each) + 1;
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) files[`part-${i}.csv`] = new Uint8Array(each);
    const bomb = await zipOf(files);
    expect(bomb.size).toBeLessThan(2 * 1024 * 1024);
    await expect(expandZips([bomb])).rejects.toMatchObject({ name: "ZipLimitError", reason: "archive_too_large" });
  }, 120_000);

  it("rejects an archive with an excessive number of entries before inflating any", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= ZIP_MAX_ENTRIES; i++) files[`f${i}.csv`] = "a,b\n1,2\n";
    await expect(expandZips([await zipOf(files)])).rejects.toBeInstanceOf(ZipLimitError);
  }, 60_000);

  it("an ordinary archive still expands byte-for-byte", async () => {
    const csv = "name,email\nAda,ada@example.test\n";
    const out = await expandZips([await zipOf({ "export/customers.csv": csv, "__MACOSX/._x": "junk", ".hidden.csv": "x" })]);
    expect(out.map((f) => f.name)).toEqual(["customers.csv"]);
    expect(new TextDecoder().decode(await out[0]!.arrayBuffer())).toBe(csv);
    expect(out[0]!.size).toBe(csv.length);
  });

  it("flattens entry paths on BOTH separators (no traversal segment survives as a name)", async () => {
    const out = await expandZips([
      await zipOf({ "../../etc/evil.csv": "a\n1\n", "..\\..\\windows\\evil2.csv": "a\n1\n" }),
    ]);
    for (const f of out) {
      expect(f.name).not.toMatch(/[\\/]/);
      expect(f.name).not.toContain("..");
    }
    expect(out.map((f) => f.name).sort()).toEqual(["evil.csv", "evil2.csv"]);
  });
});
