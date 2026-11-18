import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  ImageMetadataError,
  cleanUploadBytes,
  sniffImageFormat,
  stripImageMetadata,
} from "@/lib/uploads/strip-image-metadata";

const EXIF = {
  IFD0: { Make: "AcmeCam", Model: "Phone9" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "54/1 35/1 0/1",
    GPSLongitudeRef: "W",
    GPSLongitude: "5/1 55/1 0/1",
  },
};

/** 40x20 image: left half red, right half blue; EXIF orientation 6 (rotate 90deg CW). */
async function fixtureJpeg(opts: { exif?: boolean } = { exif: true }): Promise<Buffer> {
  const left = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const right = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#0000ff" } }).png().toBuffer();
  const base = sharp({ create: { width: 40, height: 20, channels: 3, background: "#000" } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: 20, top: 0 },
    ])
    .jpeg({ quality: 95 });
  return (opts.exif ? base.withMetadata({ orientation: 6, exif: EXIF }) : base).toBuffer();
}

describe("stripImageMetadata (PD-4)", () => {
  it("fixture really carries GPS EXIF and an orientation", async () => {
    const f = await fixtureJpeg();
    const m = await sharp(f).metadata();
    expect(m.orientation).toBe(6);
    expect(m.exif?.length).toBeGreaterThan(50);
    expect(f.includes(Buffer.from("AcmeCam"))).toBe(true);
    expect(f.includes(Buffer.from("Exif\0\0"))).toBe(true);
  });

  it("removes EXIF/GPS and bakes the orientation into the pixels", async () => {
    const f = await fixtureJpeg();
    const r = await stripImageMetadata(f);
    expect(r.stripped).toBe(true);
    expect(r.format).toBe("jpeg");
    const out = Buffer.from(r.bytes);
    expect(out.includes(Buffer.from("AcmeCam"))).toBe(false);
    expect(out.includes(Buffer.from("Exif\0\0"))).toBe(false);
    const m = await sharp(out).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(m.iptc).toBeUndefined();
    expect(m.orientation ?? 1).toBe(1);
    // orientation 6 swaps the axes: 40x20 -> 20x40
    expect(m.width).toBe(20);
    expect(m.height).toBe(40);
    // rotate 90deg CW: the red LEFT half becomes the TOP half
    const raw = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * raw.info.width + x) * raw.info.channels;
      return [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
    };
    const top = px(10, 5);
    const bottom = px(10, 35);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  });

  it("returns the original bytes when there is nothing to strip", async () => {
    const f = await fixtureJpeg({ exif: false });
    const r = await stripImageMetadata(f);
    expect(r.stripped).toBe(false);
    expect(Buffer.from(r.bytes).equals(f)).toBe(true);
  });

  it("strips metadata from PNG and WebP too", async () => {
    const base = sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } });
    const png = await base.clone().png().withMetadata({ exif: EXIF }).toBuffer();
    const webp = await base.clone().webp().withMetadata({ exif: EXIF }).toBuffer();
    for (const [buf, fmt] of [[png, "png"], [webp, "webp"]] as const) {
      expect((await sharp(buf).metadata()).exif).toBeDefined();
      const r = await stripImageMetadata(buf);
      expect(r.format).toBe(fmt);
      expect(r.stripped).toBe(true);
      expect((await sharp(Buffer.from(r.bytes)).metadata()).exif).toBeUndefined();
    }
  });

  it("leaves non-images untouched (PDF, CSV, SVG)", async () => {
    for (const s of ["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "a,b,c\n1,2,3\n4,5,6\n", "<svg xmlns='http://www.w3.org/2000/svg'/>      "]) {
      const b = new TextEncoder().encode(s);
      const r = await stripImageMetadata(b);
      expect(r.format).toBeNull();
      expect(r.stripped).toBe(false);
      expect(r.bytes).toBe(b);
    }
  });

  it("detects by magic bytes, not by name or declared type", async () => {
    const f = await fixtureJpeg();
    // a JPEG delivered as 'application/octet-stream' / '.bin' is still stripped
    expect(sniffImageFormat(new Uint8Array(f))).toBe("jpeg");
    const out = await cleanUploadBytes(new Uint8Array(f));
    expect((await sharp(Buffer.from(out)).metadata()).exif).toBeUndefined();
  });

  it("fails closed on a truncated/corrupt image that sniffs as JPEG", async () => {
    const f = await fixtureJpeg();
    const corrupt = Buffer.concat([f.subarray(0, 24), Buffer.alloc(40, 0x55)]);
    await expect(stripImageMetadata(corrupt)).rejects.toBeInstanceOf(ImageMetadataError);
  });

  it("passes HEIC through unchanged and says so (documented gap)", async () => {
    const heic = new Uint8Array(32);
    heic.set([0, 0, 0, 0x18], 0);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    const r = await stripImageMetadata(heic);
    expect(r.format).toBe("heic");
    expect(r.stripped).toBe(false);
    expect(r.reason).toBe("heic_unsupported");
  });
});
