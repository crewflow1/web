import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure, reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { storagePathBelongsToOrg } from "@/lib/storage/owned-path";
import {
  uploadTenantAttachment,
  deleteTenantAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/server/services/tenant-attachments";

/**
 * Blueprint Pin Photos service (P2 pins wave).
 *
 * Photos attached DIRECTLY to a pin, riding the universal tenant_attachments
 * pipeline with target_table='blueprint_pins' (added to the CHECK + the TS
 * target list in 20261122000001). This is deliberately a thin, PIN-AWARE seam
 * over tenant-attachments:
 *   - upload verifies the pin lives in the ACTIVE org before writing (so a
 *     foreign pin id can't have bytes hung off it), and accepts IMAGES ONLY;
 *   - list is pinned to the active org + this pin, filters to images, and mints
 *     short-lived (60s) signed URLs from the RLS-verified rows' own paths;
 *   - delete reuses tenant-attachments' owner/admin-gated delete verbatim.
 */

// Photos only — a pin marks a physical thing you photograph, not a document.
export const PIN_PHOTO_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

export type PinPhoto = {
  id: string;
  filename: string;
  created_at: string;
  /** Short-lived (60s) signed URL for inline preview, or null if signing failed. */
  url: string | null;
};

export type PinPhotoUpload =
  | { ok: true; attachment_id: string }
  | { ok: false; error: string };

type AttRow = { id: string; filename: string; storage_path: string; mime_type: string | null; org_id: string | null; created_at: string };

// Minimal structural view of the tenant client (tenant_attachments +
// blueprint_pins are not in the generated types). Mirrors the sibling services.
type Chain = {
  select: (c: string) => Chain;
  eq: (k: string, v: unknown) => Chain;
  order: (k: string, o: { ascending: boolean }) => Chain;
  limit: (n: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: SupabaseReadError | null }>;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: SupabaseReadError | null }>;
};
type Client = { from: (t: string) => Chain };
const pc = (c: Awaited<ReturnType<typeof createClient>>) => c as unknown as Client;

async function pinInActiveOrg(supabase: Client, pinId: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("blueprint_pins")
    .select("id")
    .eq("id", pinId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("blueprint-pin-photos: pin scope check", error);
  return !!data;
}

/** Every photo on a pin, with a short-lived signed URL for each. */
export async function listPinPhotos(pinId: string): Promise<PinPhoto[]> {
  const { ctx } = await requireOrgContext();
  const supabase = pc(await createClient());
  if (!(await pinInActiveOrg(supabase, pinId, ctx.org.id))) return [];

  const { data, error } = await supabase
    .from("tenant_attachments")
    .select("id, filename, storage_path, mime_type, org_id, created_at")
    .eq("org_id", ctx.org.id)
    .eq("target_table", "blueprint_pins")
    .eq("target_id", pinId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw readFailure("blueprint-pin-photos: list", error);

  const images = ((data ?? []) as unknown as AttRow[]).filter((a) =>
    (a.mime_type ?? "").startsWith("image/") &&
    // Anti-poisoning: never surface (or later sign) a path that doesn't live
    // under the row's own org. Mirrors the attachments signer guard (20261031).
    storagePathBelongsToOrg(a.storage_path, a.org_id),
  );
  if (images.length === 0) return [];

  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage
    .from("tenant-attachments")
    .createSignedUrls(images.map((a) => a.storage_path), 60);
  if (signError) {
    // Report, don't throw: the list is called from a viewer click handler; a
    // broken signer should degrade to "preview unavailable", not blank the pin.
    reportReadFailure("blueprint-pin-photos: sign", { message: signError.message });
  }
  const urlByPath = new Map<string, string>();
  for (const s of signed ?? []) {
    if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
  }

  return images.map((a) => ({
    id: a.id, filename: a.filename, created_at: a.created_at,
    url: urlByPath.get(a.storage_path) ?? null,
  }));
}

/** Attach a photo directly to a pin (images only, active-org-verified). */
export async function uploadPinPhoto(input: {
  pinId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<PinPhotoUpload> {
  if (!PIN_PHOTO_MIME.has(input.mimeType)) return { ok: false, error: "bad_file_type" };
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, error: "file_too_large" };

  const { ctx } = await requireOrgContext();
  const supabase = pc(await createClient());
  if (!(await pinInActiveOrg(supabase, input.pinId, ctx.org.id))) {
    return { ok: false, error: "pin_not_found" };
  }

  return uploadTenantAttachment({
    targetTable: "blueprint_pins",
    targetId: input.pinId,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
  });
}

/** Delete a pin photo (owner/admin-only, active-org-pinned — via tenant-attachments). */
export async function deletePinPhoto(attachmentId: string): Promise<PinPhotoUpload> {
  return deleteTenantAttachment(attachmentId);
}
