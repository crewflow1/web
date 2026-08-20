import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import type { OrgContext } from "@/server/auth/session";
import {
  ALLOWED_ATTACHMENT_MIME,
  ATTACHMENT_TARGET_TABLES,
  MAX_ATTACHMENT_BYTES,
  type AttachmentTargetTable,
} from "@/server/services/tenant-attachments";

/**
 * OFFLINE PHOTO / FILE CAPTURE — the server side.
 *
 * This is the binary sibling of server/services/offline-writes.ts, kept in its own
 * module for one deliberate reason: a photo upload legitimately needs the
 * service-role client for the STORAGE byte write (the online photo path,
 * uploadTenantAttachment, uses it too), whereas offline-writes.ts is pinned by the
 * security suite to be entirely free of any service-role / RPC surface. Separating
 * them lets each keep the contract it needs — the JSON write path stays provably
 * tenant-only, and the photo path matches the ONLINE photo path VERBATIM.
 *
 * The security argument mirrors the JSON queue's "a queued write is not a special
 * write", specialised for binary:
 *   - the ROW insert goes through the TENANT (user-JWT) client under RLS — never a
 *     service-role insert — so a stolen capture cannot land a row it could not
 *     have posted online;
 *   - the STORAGE byte write uses the service role EXACTLY as the online
 *     uploadTenantAttachment does (storage writes are locked to service-role by
 *     the storage-evidence wave), into an ORG-FIRST path so a stray object is
 *     always attributable to a tenant;
 *   - the org is read from the caller's SESSION and the capture is REFUSED, never
 *     re-homed, if it names another org;
 *   - the target row is verified to belong to the active org (tenant client,
 *     org-pinned read) before anything is written, so a capture cannot be attached
 *     to another company's job;
 *   - a SHA-256 content_hash of the exact bytes is frozen on the row (evidence
 *     discipline), and idempotency is enforced on (org_id, client_write_key) —
 *     migration 20261194000000 — so a replay yields ONE attachment.
 *
 * `ctx`/`user` come from the CALLER's requireOrgContext(); this function never
 * resolves an identity itself.
 */

export type OfflinePhotoOutcome =
  | { status: "accepted"; id: string }
  | { status: "duplicate"; id: string }
  | { status: "rejected"; reason: OfflinePhotoRejectReason }
  | { status: "retry"; reason: string };

export type OfflinePhotoRejectReason =
  | "unknown_target" // target table not an allowed attachment target
  | "bad_target_id" // target id not a uuid
  | "bad_file_type" // MIME not whitelisted
  | "empty_file"
  | "file_too_large"
  | "org_mismatch" // authored in a different org — refused, never re-homed
  | "target_missing" // the target row is gone, or belongs to another org
  | "not_permitted" // RLS refused the row insert
  | "malformed_item";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

/** The untrusted envelope the sync action hands over. */
export type QueuedPhotoEnvelope = {
  clientKey: string;
  orgId: string;
  targetTable: string;
  targetId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  authoredAt: string;
};

type PgError = { message: string; code?: string } | null;
type TargetLookupChain = {
  select: (cols: string) => {
    eq: (
      k: string,
      v: unknown,
    ) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{ data: { id: string } | null; error: PgError }>;
      };
    };
  };
};

function isAttachmentTarget(t: unknown): t is AttachmentTargetTable {
  return (
    typeof t === "string" &&
    (ATTACHMENT_TARGET_TABLES as readonly string[]).includes(t)
  );
}

function mimeToExt(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  if (mime === "image/webp") return "webp";
  if (mime === "application/pdf") return "pdf";
  return "bin";
}

export async function dispatchOfflinePhoto(args: {
  ctx: OrgContext;
  user: { id: string; email?: string | null };
  item: QueuedPhotoEnvelope;
}): Promise<OfflinePhotoOutcome> {
  const { item } = args;

  // 1. envelope shape. clientKey must be uuid-shaped (the column is uuid; a
  //    malformed key would 22P02 on the dedupe read and wedge the outbox).
  if (
    !item ||
    typeof item.clientKey !== "string" ||
    !UUID_RE.test(item.clientKey) ||
    typeof item.orgId !== "string" ||
    item.orgId.length === 0
  ) {
    return { status: "rejected", reason: "malformed_item" };
  }
  if (!isAttachmentTarget(item.targetTable)) {
    return { status: "rejected", reason: "unknown_target" };
  }
  if (typeof item.targetId !== "string" || !UUID_RE.test(item.targetId)) {
    return { status: "rejected", reason: "bad_target_id" };
  }
  if (!ALLOWED_ATTACHMENT_MIME.has(item.mimeType)) {
    return { status: "rejected", reason: "bad_file_type" };
  }
  if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength === 0) {
    return { status: "rejected", reason: "empty_file" };
  }
  if (item.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { status: "rejected", reason: "file_too_large" };
  }

  // 2. ACTIVE-ORG PIN — refuse, never re-home.
  const orgId = args.ctx.org.id;
  if (item.orgId !== orgId) {
    return { status: "rejected", reason: "org_mismatch" };
  }

  const tenant = await createClient();

  // 3. TARGET-ORG VERIFICATION. The storage write below uses the service role, so
  //    the only thing that scopes WHERE the capture lands is this org-pinned read
  //    of the target row under the tenant client. A target that is gone or belongs
  //    to another org is a clean permanent rejection, never an orphaned upload.
  const { data: target, error: targetErr } = await (
    tenant.from(item.targetTable as never) as unknown as TargetLookupChain
  )
    .select("id")
    .eq("id", item.targetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (targetErr) {
    return { status: "retry", reason: targetErr.code ?? "target_lookup_failed" };
  }
  if (!target) return { status: "rejected", reason: "target_missing" };

  // 4. IDEMPOTENCY. A re-delivered capture (lost response, reinstalled SW, two
  //    tabs) is recognised by (org_id, client_write_key) BEFORE a second upload.
  const existing = await findByClientKey(tenant, orgId, item.clientKey);
  if (existing.error) {
    return { status: "retry", reason: existing.error };
  }
  if (existing.id) return { status: "duplicate", id: existing.id };

  // 5. STORE THE BYTES (service role, org-first path) + FREEZE the content hash.
  const admin = createAdminClient();
  const contentHash = createHash("sha256").update(item.bytes).digest("hex");
  const id = randomUUID();
  const storagePath = `${orgId}/${item.targetTable}/${item.targetId}/${id}.${mimeToExt(item.mimeType)}`;

  const { error: uErr } = await admin.storage
    .from("tenant-attachments")
    .upload(storagePath, item.bytes, {
      contentType: item.mimeType,
      upsert: false,
    });
  if (uErr) {
    console.error("[offline-photo] storage upload failed", uErr);
    return { status: "retry", reason: "upload_failed" };
  }

  // 6. RECORD THE ROW (tenant client, RLS) with the idempotency key.
  const { error: insErr } = await tenant.from("tenant_attachments" as never).insert({
    id,
    org_id: orgId,
    target_table: item.targetTable,
    target_id: item.targetId,
    filename: item.filename,
    storage_path: storagePath,
    mime_type: item.mimeType,
    size_bytes: item.bytes.byteLength,
    content_hash: contentHash,
    uploaded_by: args.user.id,
    client_write_key: item.clientKey,
    offline_authored_at:
      typeof item.authoredAt === "string" ? item.authoredAt : null,
  } as never);

  if (insErr) {
    // Orphan cleanup — the bytes must not linger without a row.
    await admin.storage
      .from("tenant-attachments")
      .remove([storagePath])
      .catch(() => undefined);

    // THE IDEMPOTENCY BRANCH — a concurrent replay won the (org, key) unique
    // index. Report the row that already exists rather than a duplicate upload.
    if (insErr.code === UNIQUE_VIOLATION) {
      const dup = await findByClientKey(tenant, orgId, item.clientKey);
      if (dup.error) return { status: "retry", reason: dup.error };
      if (dup.id) return { status: "duplicate", id: dup.id };
      return { status: "rejected", reason: "not_permitted" };
    }
    if (insErr.code === "42501") {
      return { status: "rejected", reason: "not_permitted" };
    }
    console.error("[offline-photo] db insert failed", insErr);
    return { status: "retry", reason: insErr.code ?? "record_failed" };
  }

  await recordAdminActivity({
    actorId: args.user.id,
    actorEmail: args.user.email ?? null,
    action: "tenant_attachment.upload",
    targetTable: item.targetTable,
    targetId: item.targetId,
    metadata: {
      attachment_id: id,
      filename: item.filename,
      mime_type: item.mimeType,
      size_bytes: item.bytes.byteLength,
      offline: true,
    },
  });

  return { status: "accepted", id };
}

/** Look up an attachment by (org_id, client_write_key), org-pinned. */
async function findByClientKey(
  tenant: unknown,
  orgId: string,
  clientKey: string,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await (
    (tenant as { from: (t: never) => unknown }).from(
      "tenant_attachments" as never,
    ) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            maybeSingle: () => Promise<{
              data: { id: string } | null;
              error: PgError;
            }>;
          };
        };
      };
    }
  )
    .select("id")
    .eq("org_id", orgId)
    .eq("client_write_key", clientKey)
    .maybeSingle();
  if (error) return { id: null, error: error.code ?? "dedupe_lookup_failed" };
  return { id: data?.id ?? null, error: null };
}
