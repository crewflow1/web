/**
 * Server-side removal of embedded metadata (EXIF / XMP / IPTC — GPS position,
 * device make/model/serial numbers, timestamps, editing-software history) from
 * user-uploaded raster images BEFORE they reach storage. PD-4 / G-24 / M-6.
 *
 * Rules
 *  - Detection is by MAGIC BYTES, never by the declared MIME type or filename
 *    (browsers send empty / wrong types; a renamed file must not skip the strip).
 *  - Non-images (PDF, CSV, XLSX, SVG, ...) are returned untouched.
 *  - JPEG / PNG / WebP / GIF / TIFF / AVIF: decode, apply the EXIF orientation to
 *    the pixels, then re-encode WITHOUT metadata. The ICC colour profile is kept
 *    (it is colour data, not personal data; dropping it shifts Display-P3 phones).
 *  - If the image carries no EXIF/XMP/IPTC at all, the ORIGINAL bytes are returned
 *    (no needless re-encode, no quality loss).
 *  - FAIL CLOSED: bytes that sniff as one of those formats but cannot be decoded
 *    throw `ImageMetadataError` — they are never stored with their metadata.
 *  - HEIC / HEIF: the prebuilt sharp has no HEVC decoder, so these cannot be
 *    stripped here. They are returned unchanged with `stripped: false,
 *    reason: "heic_unsupported"` (documented residual gap, PD-4 follow-up).
 */
import sharp from "sharp";

export class ImageMetadataError extends Error {
  readonly code = "image_undecodable";
  constructor(message = "Image could not be processed") {
    super(message);
    this.name = "ImageMetadataError";
  }
}

export type StripResult = {
  bytes: Uint8Array;
  /** True when metadata was found and removed. */
  stripped: boolean;
  /** Sniffed format, or null for non-images. */
  format: ImageFormat | null;
  /** Set when an image could not be stripped but is passed through. */
  reason?: "heic_unsupported";
};

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "tiff" | "avif" | "heic";

const JPEG_QUALITY = 92;

export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)
  ) {
    return "tiff";
  }
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

export async function stripImageMetadata(
  input: Uint8Array | ArrayBuffer,
): Promise<StripResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = sniffImageFormat(bytes);
  if (!format) return { bytes, stripped: false, format: null };
  if (format === "heic") {
    return { bytes, stripped: false, format, reason: "heic_unsupported" };
  }

  try {
    const animated = format === "gif" || format === "webp";
    const base = () => sharp(bytes, { animated, failOn: "error" });
    const meta = await base().metadata();
    const hasPersonalMeta = Boolean(meta.exif || meta.xmp || meta.iptc || meta.tifftagPhotoshop);
    // A bare orientation flag with no other metadata cannot leak anything.
    if (!hasPersonalMeta) return { bytes, stripped: false, format };

    // rotate() with no argument bakes the EXIF orientation into the pixels and
    // resets the tag; without withMetadata()/withExif(), sharp drops the rest.
    let pipe = base().rotate().keepIccProfile();
    switch (format) {
      case "jpeg":
        pipe = pipe.jpeg({ quality: JPEG_QUALITY });
        break;
      case "png":
        pipe = pipe.png();
        break;
      case "webp":
        pipe = pipe.webp({ quality: JPEG_QUALITY });
        break;
      case "gif":
        pipe = pipe.gif();
        break;
      case "tiff":
        pipe = pipe.tiff({ quality: JPEG_QUALITY });
        break;
      case "avif":
        pipe = pipe.avif({ quality: 80 });
        break;
    }
    const out = await pipe.toBuffer();
    return { bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), stripped: true, format };
  } catch {
    throw new ImageMetadataError();
  }
}

/** Convenience for upload sites that must not store metadata. */
export async function cleanUploadBytes(input: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return (await stripImageMetadata(input)).bytes;
}
