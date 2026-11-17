import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, inflateSync } from "node:zlib";

/**
 * Restricted-font guard (licence compliance, not a style rule).
 *
 * Clash Display and Satoshi are licensed under the ITF Free Font License, whose
 * section 02 forbids making the font files available through a public
 * repository. The repo is public, so those files must never be committed: they
 * are supplied at build time from a private source by
 * scripts/fonts/provision-marketing-fonts.mjs into the gitignored
 * app/_marketing/fonts/active/ folder. This test fails if any of them (or any
 * other ITF / Fontshare font) is tracked again, under any name.
 *
 * Detection is by content, not only by file name: every tracked font binary is
 * decoded (WOFF2 brotli / WOFF zlib / raw sfnt) and searched for the foundry's
 * marks, and every tracked file of a matching size is hashed against the
 * pinned sha256 of the licensed files. See docs/compliance/FONT-LICENCE-RESOLUTION.md.
 */

const ROOT = path.resolve(__dirname, "../..");
const FONT_DIR = "app/_marketing/fonts";
const FONT_EXT = /\.(woff2?|ttf|otf|ttc|eot)$/i;
const RESTRICTED_NAME = /(clash[\s_-]*(display|grotesk)|satoshi)/i;
/** Strings ITF puts in the name table of every Fontshare font. */
const FOUNDRY_MARKS = ["indian type foundry", "fontshare"];

type Entry = { family: string; file: string; bytes: number; sha256: string };
const manifest = JSON.parse(readFileSync(path.join(ROOT, FONT_DIR, "manifest.json"), "utf8")) as {
  slots: Record<string, { licensed: Entry; fallback: Entry }>;
};
const slots = Object.values(manifest.slots);
const licensed = slots.map((s) => s.licensed);
const fallbacks = slots.map((s) => s.fallback);

/** Font binaries that are allowed in git: the OFL fallback set only. */
const APPROVED_FONT_FILES = new Set(fallbacks.map((f) => `${FONT_DIR}/fallback/${f.file}`));

function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    // No git (unusual): walk the tree, skipping build output and generated fonts.
    const skip = new Set(["node_modules", ".git", ".next", `${FONT_DIR}/active`]);
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(path.join(ROOT, rel))) {
        const child = rel ? `${rel}/${name}` : name;
        if (skip.has(child) || skip.has(name)) continue;
        const st = statSync(path.join(ROOT, child));
        if (st.isDirectory()) walk(child);
        else out.push(child);
      }
    };
    walk("");
    return out;
  }
}

function readBase128(buf: Buffer, pos: { i: number }): number {
  let value = 0;
  for (let n = 0; n < 5; n++) {
    const b = buf[pos.i++];
    if (b === undefined) throw new Error("truncated UIntBase128");
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return value;
  }
  throw new Error("invalid UIntBase128");
}

/** Decompressed font tables (or raw bytes for sfnt/eot) so name strings are visible. */
function fontTableBytes(buf: Buffer): Buffer {
  const sig = buf.subarray(0, 4).toString("latin1");
  if (sig === "wOF2") {
    if (buf.readUInt32BE(4) === 0x74746366) throw new Error("WOFF2 collections are not supported");
    const numTables = buf.readUInt16BE(12);
    const compressedSize = buf.readUInt32BE(20);
    const pos = { i: 48 };
    for (let t = 0; t < numTables; t++) {
      const flags = buf[pos.i++]!;
      const tagIndex = flags & 0x3f;
      const version = (flags >> 6) & 0x03;
      if (tagIndex === 63) pos.i += 4;
      readBase128(buf, pos); // origLength
      const isGlyfOrLoca = tagIndex === 10 || tagIndex === 11;
      if (isGlyfOrLoca ? version === 0 : version !== 0) readBase128(buf, pos); // transformLength
    }
    return brotliDecompressSync(buf.subarray(pos.i, pos.i + compressedSize));
  }
  if (sig === "wOFF") {
    const numTables = buf.readUInt16BE(12);
    const parts: Buffer[] = [];
    for (let t = 0; t < numTables; t++) {
      const at = 44 + t * 20;
      const offset = buf.readUInt32BE(at + 4);
      const compLength = buf.readUInt32BE(at + 8);
      const origLength = buf.readUInt32BE(at + 12);
      const data = buf.subarray(offset, offset + compLength);
      parts.push(compLength < origLength ? inflateSync(data) : data);
    }
    return Buffer.concat(parts);
  }
  return buf; // TTF / OTF / TTC / EOT: name strings are stored uncompressed
}

/** Lower-cased text of a font: NUL bytes dropped so UTF-16BE names read as ASCII. */
function fontText(buf: Buffer): string {
  const bytes = fontTableBytes(buf);
  return Buffer.from(bytes.filter((b) => b !== 0)).toString("latin1").toLowerCase();
}

function hasFoundryMark(buf: Buffer): boolean {
  const text = fontText(buf);
  return FOUNDRY_MARKS.some((m) => text.includes(m));
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const files = trackedFiles();
const fontFiles = files.filter((f) => FONT_EXT.test(f));

describe("restricted font binaries (ITF Free Font License)", () => {
  it("lists tracked files (sanity)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(`${FONT_DIR}/manifest.json`);
  });

  it("no tracked file is named like Clash Display / Satoshi", () => {
    const named = files.filter((f) => FONT_EXT.test(f) && RESTRICTED_NAME.test(path.basename(f)));
    expect(named).toEqual([]);
  });

  it("no tracked file is byte-identical to a licensed font (pinned sha256)", () => {
    const sizes = new Set(licensed.map((l) => l.bytes));
    const hashes = new Set(licensed.map((l) => l.sha256));
    const hits = files.filter((f) => {
      const abs = path.join(ROOT, f);
      if (!existsSync(abs)) return false;
      const st = statSync(abs);
      return st.isFile() && sizes.has(st.size) && hashes.has(sha256(readFileSync(abs)));
    });
    expect(hits).toEqual([]);
  });

  it("every tracked font binary is on the approved (OFL) list", () => {
    expect(fontFiles.filter((f) => !APPROVED_FONT_FILES.has(f))).toEqual([]);
  });

  it("no tracked font binary carries Indian Type Foundry / Fontshare marks", () => {
    const marked = fontFiles.filter((f) => {
      const abs = path.join(ROOT, f);
      return existsSync(abs) && hasFoundryMark(readFileSync(abs));
    });
    expect(marked).toEqual([]);
  });

  it("the decoder really reads WOFF2 name strings (positive controls)", () => {
    // Real committed WOFF2: the OFL copyright string must be readable.
    const bricolage = readFileSync(path.join(ROOT, FONT_DIR, "fallback", fallbacks[0]!.file));
    expect(fontText(bricolage)).toContain("bricolage grotesque project authors");
    // Synthetic WOFF2 whose single 'name'-tagged table holds an ITF copyright in UTF-16BE.
    const name = Buffer.from("\u0000Copyright 2021 Indian Type Foundry", "utf16le").swap16();
    const compressed = brotliCompressSync(name);
    const header = Buffer.alloc(48);
    header.write("wOF2", 0, "latin1");
    header.writeUInt32BE(0x00010000, 4);
    header.writeUInt16BE(1, 12);
    header.writeUInt32BE(compressed.length, 20);
    const dir = Buffer.from([5, name.length]); // tag index 5 = name, null transform
    expect(hasFoundryMark(Buffer.concat([header, dir, compressed]))).toBe(true);
  });

  it("each approved fallback font matches the manifest and ships its OFL text", () => {
    for (const f of fallbacks) {
      const buf = readFileSync(path.join(ROOT, FONT_DIR, "fallback", f.file));
      expect(sha256(buf), f.file).toBe(f.sha256);
      const ofl = path.join(ROOT, FONT_DIR, "fallback", `OFL-${f.family.replace(/\s+/g, "")}.txt`);
      expect(existsSync(ofl), `${ofl} missing`).toBe(true);
      expect(readFileSync(ofl, "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("restricted fonts and the generated folder are gitignored", () => {
    const probe = [
      `${FONT_DIR}/active/display-700.woff2`,
      `${FONT_DIR}/ClashDisplay-Bold.woff2`,
      `${FONT_DIR}/Satoshi-Regular.woff2`,
      "public/fonts/Satoshi-Variable.woff2",
    ];
    for (const p of probe) {
      let ignored = true;
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: ROOT });
      } catch {
        ignored = false;
      }
      expect(ignored, `${p} should be gitignored`).toBe(true);
    }
  });

  it("next/font only loads the generated files, never a committed licensed file", () => {
    const src = readFileSync(path.join(ROOT, "app/_marketing/fonts.ts"), "utf8");
    const paths = [...src.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBe(slots.length);
    for (const p of paths) expect(p).toMatch(/^\.\/fonts\/active\/(display|body)-\d{3}\.woff2$/);
  });
});
