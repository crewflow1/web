import { z } from "zod";

/**
 * Blueprint Centre — drawing register domain (Phase 2 WOW). Pure + server/client
 * safe. Everything here is customer-INTERNAL job information (operator-only).
 */

export const DISCIPLINES = [
  "architectural", "structural", "civil", "mechanical", "electrical", "plumbing", "other",
] as const;
export type Discipline = (typeof DISCIPLINES)[number];
export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  architectural: "Architectural", structural: "Structural", civil: "Civil",
  mechanical: "Mechanical", electrical: "Electrical", plumbing: "Plumbing", other: "Other",
};

export const BLUEPRINT_STATUSES = ["preliminary", "for_construction", "as_built", "superseded"] as const;
export type BlueprintStatus = (typeof BLUEPRINT_STATUSES)[number];
export const BLUEPRINT_STATUS_LABELS: Record<BlueprintStatus, string> = {
  preliminary: "Preliminary", for_construction: "For construction", as_built: "As built", superseded: "Superseded",
};
export const BLUEPRINT_STATUS_STYLES: Record<BlueprintStatus, string> = {
  preliminary: "bg-amber-100 text-amber-700",
  for_construction: "bg-emerald-100 text-emerald-700",
  as_built: "bg-blue-100 text-blue-700",
  superseded: "bg-slate-100 text-slate-500",
};

/** Drawings render inline natively, so we accept only what a browser can show. */
export const BLUEPRINT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type BlueprintMime = (typeof BLUEPRINT_MIME_TYPES)[number];
export const MAX_BLUEPRINT_BYTES = 52_428_800; // 50 MB — must mirror the bucket file_size_limit.
export const blueprintIdSchema = z.string().uuid();

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(max).optional());

/** Create a new drawing register entry (with its first revision's metadata). */
export const createBlueprintSchema = z.object({
  drawing_number: z.string().trim().min(1, "Drawing number is required").max(60),
  title: z.string().trim().min(1, "Title is required").max(200),
  discipline: z.enum(DISCIPLINES).optional(),
  revision: z.string().trim().min(1, "Revision is required (e.g. Rev A / P01)").max(30),
  revision_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  notes: optionalText(2000),
});
export type CreateBlueprintInput = z.infer<typeof createBlueprintSchema>;

/** Add a new revision to an existing drawing. */
export const addRevisionSchema = z.object({
  revision: z.string().trim().min(1, "Revision is required").max(30),
  revision_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  notes: optionalText(2000),
});

export function isAllowedBlueprintMime(mime: string): mime is BlueprintMime {
  return (BLUEPRINT_MIME_TYPES as readonly string[]).includes(mime);
}

export type FileValidation = { ok: true } | { ok: false; message: string };

/** Server-side upload validation: size + declared MIME. Magic bytes checked separately. */
export function validateBlueprintFile(input: { mime: string; size: number }): FileValidation {
  if (!isAllowedBlueprintMime(input.mime)) return { ok: false, message: "Upload a PDF or an image (JPEG/PNG/WebP)." };
  if (input.size <= 0) return { ok: false, message: "The file is empty." };
  if (input.size > MAX_BLUEPRINT_BYTES) return { ok: false, message: "The drawing exceeds the 50 MB limit." };
  return { ok: true };
}

/**
 * Magic-byte sniff (F4): the browser-declared MIME is untrusted, so confirm the
 * real bytes match one of our allowed types before storing. Returns the detected
 * type or null.
 */
export function sniffBlueprintType(bytes: Uint8Array): BlueprintMime | null {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"; // %PDF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50                    // WEBP
  ) return "image/webp";
  return null;
}

/** Server-built storage key — org_id FIRST segment (path RLS scopes on it), no user input. */
export function blueprintStorageKey(orgId: string, jobId: string, blueprintId: string, fileId: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "bin";
  return `${orgId}/${jobId}/${blueprintId}/${fileId}.${safeExt}`;
}

export const extForMime: Record<BlueprintMime, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};

/** Is this version the drawing's current (live) revision? */
export function isCurrentVersion(currentVersion: number | null | undefined, version: number): boolean {
  return currentVersion != null && currentVersion === version;
}
