import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import type { WhatsAppMediaDescriptor } from "@/lib/comms/providers/meta-whatsapp";

/**
 * WhatsApp inbound MEDIA pipeline — fetch bytes from the Meta media API into the
 * tenant's private bucket, DARK-safe.
 *
 * REFUSE-BEFORE-FETCH is the load-bearing rule. Two switches must BOTH be on
 * before a single byte crosses the network:
 *   1. NEXT_PUBLIC_FEATURE_WHATSAPP === "true"  (the channel is live), and
 *   2. WHATSAPP_ACCESS_TOKEN present             (a Meta credential exists).
 * With either off, `downloadInboundWhatsAppMedia` records a `refused` row and
 * makes NO request — the same posture the outbound sender takes (it is only
 * constructed when creds exist). CI sets neither, so nothing here runs in CI.
 *
 * Idempotency: the Meta media id is the key. An at-least-once webhook that
 * re-delivers the same media finds the existing `whatsapp_inbound_media` row and
 * returns it without re-fetching or re-storing (the bytes are write-once).
 *
 * Storage discipline mirrors tenant_attachments / the storage-evidence wave: a
 * PRIVATE bucket, an org-first path, a service-role byte write, and a SHA-256
 * content_hash of the exact stored bytes (cross-checked against Meta's declared
 * sha256 when present). No signed URL is minted here.
 */

const MEDIA_BUCKET = "whatsapp-media";
const MEDIA_TABLE = "whatsapp_inbound_media";
const DEFAULT_GRAPH_VERSION = "v21.0";

/** Hard cap on a fetched object, defence against a hostile/huge media id. 25 MB. */
export const MAX_WHATSAPP_MEDIA_BYTES = 25 * 1024 * 1024;

export type MediaFetchRefusal =
  /** The WhatsApp channel feature flag is off. */
  | "feature_dark"
  /** No Meta access token is configured. */
  | "no_credential";

export type DownloadMediaResult =
  | {
      status: "stored";
      mediaRowId: string;
      storagePath: string;
      contentHash: string;
      sizeBytes: number;
      mimeType: string | null;
      /** The fetched bytes, kept in-memory so a caller (e.g. a job-photo action) can reuse them without a re-fetch. */
      bytes: Uint8Array;
    }
  | { status: "duplicate"; mediaRowId: string; storagePath: string | null }
  | { status: "refused"; reason: MediaFetchRefusal; mediaRowId: string | null }
  | { status: "failed"; error: string; mediaRowId: string | null };

/**
 * The refuse-before-fetch gate. Both switches must be on. Reads process.env
 * directly and CANNOT THROW — a gate must always answer.
 */
export function isWhatsAppMediaFetchConfigured(): boolean {
  return (
    process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true" &&
    typeof process.env.WHATSAPP_ACCESS_TOKEN === "string" &&
    process.env.WHATSAPP_ACCESS_TOKEN.trim().length > 0
  );
}

/** The specific refusal reason, or null when a fetch is permitted. */
export function whatsAppMediaRefusalReason(): MediaFetchRefusal | null {
  if (process.env.NEXT_PUBLIC_FEATURE_WHATSAPP !== "true") return "feature_dark";
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (typeof token !== "string" || token.trim().length === 0) return "no_credential";
  return null;
}

type MediaTable = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
  update: (row: unknown) => {
    eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
  };
};

function mediaTable(): MediaTable {
  const admin = createAdminClient();
  return admin.from(MEDIA_TABLE as never) as unknown as MediaTable;
}

/**
 * Download one inbound media object into the tenant's bucket, idempotently.
 *
 * Order: idempotency check → refuse-before-fetch → claim row → fetch (2-step Meta
 * media API) → verify size → store bytes → hash → finalise row. Any failure
 * leaves a `failed`/`refused` row (retryable) and never a half-stored object.
 */
export async function downloadInboundWhatsAppMedia(input: {
  orgId: string;
  wamid: string;
  media: WhatsAppMediaDescriptor;
}): Promise<DownloadMediaResult> {
  const { orgId, wamid, media } = input;
  const table = mediaTable();

  // 1. IDEMPOTENCY — same (org, media_id) already handled? Return without re-fetching.
  const existing = await table
    .select("id, status, storage_path")
    .eq("org_id", orgId)
    .eq("media_id", media.media_id)
    .maybeSingle();
  if (existing.error) {
    console.error("[whatsapp-media] idempotency read failed", existing.error);
    return { status: "failed", error: `idempotency_read: ${existing.error.message}`, mediaRowId: null };
  }
  if (existing.data && existing.data.status === "stored") {
    return {
      status: "duplicate",
      mediaRowId: String(existing.data.id),
      storagePath: (existing.data.storage_path as string | null) ?? null,
    };
  }

  // 2. REFUSE-BEFORE-FETCH — record the intent WITHOUT any network call.
  const refusal = whatsAppMediaRefusalReason();
  if (refusal) {
    const rowId = await upsertMediaRow(table, existing.data, {
      orgId,
      wamid,
      media,
      status: "refused",
      refused_reason: refusal,
    });
    return { status: "refused", reason: refusal, mediaRowId: rowId };
  }

  // 3. CLAIM — a pending row exists before we touch the network, so a crash
  //    mid-fetch is a retryable pending row, never a silent drop.
  const rowId = await upsertMediaRow(table, existing.data, {
    orgId,
    wamid,
    media,
    status: "pending",
  });
  if (!rowId) {
    return { status: "failed", error: "claim_failed", mediaRowId: null };
  }

  // 4/5. FETCH + STORE.
  try {
    const bytes = await fetchMetaMediaBytes(media.media_id);
    if (bytes.byteLength > MAX_WHATSAPP_MEDIA_BYTES) {
      await table.update({ status: "failed", error_message: "media_too_large" }).eq("id", rowId);
      return { status: "failed", error: "media_too_large", mediaRowId: rowId };
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const ext = mimeToExt(media.mime_type);
    const storagePath = `${orgId}/${wamid}/${media.media_id}.${ext}`;

    const admin = createAdminClient();
    const { error: upErr } = await admin.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, bytes, {
        contentType: media.mime_type ?? "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      // Not an idempotency violation for us — the row is the idempotency guard —
      // but a genuine storage error leaves the row failed/retryable.
      console.error("[whatsapp-media] storage upload failed", upErr);
      await table.update({ status: "failed", error_message: "upload_failed" }).eq("id", rowId);
      return { status: "failed", error: "upload_failed", mediaRowId: rowId };
    }

    const { error: finErr } = await table
      .update({
        status: "stored",
        storage_path: storagePath,
        content_hash: contentHash,
        size_bytes: bytes.byteLength,
        stored_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", rowId);
    if (finErr) {
      console.error("[whatsapp-media] finalise row failed", finErr);
      // Orphan cleanup so a retry can re-store cleanly.
      await admin.storage.from(MEDIA_BUCKET).remove([storagePath]).catch(() => undefined);
      await table.update({ status: "failed", error_message: "finalise_failed" }).eq("id", rowId);
      return { status: "failed", error: "finalise_failed", mediaRowId: rowId };
    }

    return {
      status: "stored",
      mediaRowId: rowId,
      storagePath,
      contentHash,
      sizeBytes: bytes.byteLength,
      mimeType: media.mime_type,
      bytes,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[whatsapp-media] fetch/store threw", msg);
    await table.update({ status: "failed", error_message: msg.slice(0, 500) }).eq("id", rowId).catch(() => undefined);
    return { status: "failed", error: msg, mediaRowId: rowId };
  }
}

/**
 * Insert-or-refresh the media ledger row. On first sight it INSERTs; a re-seen
 * (org, media_id) that is not yet stored gets its status refreshed in place. The
 * evidence-immutability trigger keeps content_hash/storage_path write-once, so a
 * refresh can never rewrite a stored object.
 */
async function upsertMediaRow(
  table: MediaTable,
  existing: Record<string, unknown> | null,
  fields: {
    orgId: string;
    wamid: string;
    media: WhatsAppMediaDescriptor;
    status: "pending" | "refused" | "failed";
    refused_reason?: MediaFetchRefusal;
  },
): Promise<string | null> {
  if (existing?.id) {
    const id = String(existing.id);
    const { error } = await table
      .update({
        status: fields.status,
        refused_reason: fields.refused_reason ?? null,
      })
      .eq("id", id);
    if (error) {
      console.error("[whatsapp-media] row refresh failed", error);
      return null;
    }
    return id;
  }
  const ins = await table
    .insert({
      org_id: fields.orgId,
      wamid: fields.wamid,
      media_id: fields.media.media_id,
      message_type: fields.media.message_type,
      mime_type: fields.media.mime_type,
      filename: fields.media.filename,
      caption: fields.media.caption,
      declared_sha256: fields.media.declared_sha256,
      status: fields.status,
      refused_reason: fields.refused_reason ?? null,
      transcript_status: "none",
    })
    .select("id")
    .single();
  if (ins.error || !ins.data?.id) {
    // A concurrent claim may have inserted first (unique org+media_id). Re-read.
    const reread = await table
      .select("id")
      .eq("org_id", fields.orgId)
      .eq("media_id", fields.media.media_id)
      .maybeSingle();
    if (reread.data?.id) return String(reread.data.id);
    console.error("[whatsapp-media] row insert failed", ins.error);
    return null;
  }
  return ins.data.id;
}

/**
 * The 2-step Meta media fetch:
 *   1. GET graph.facebook.com/<ver>/<media-id>  → { url, mime_type, sha256, file_size }
 *   2. GET that url (Bearer)                     → the raw bytes
 * THROWS on any non-2xx or missing url — the caller records `failed` and retries.
 * The access token is only ever sent in a header, never logged.
 */
async function fetchMetaMediaBytes(mediaId: string): Promise<Uint8Array> {
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    // Defensive — the refuse-before-fetch gate already guaranteed this.
    throw new Error("whatsapp-media: missing WHATSAPP_ACCESS_TOKEN");
  }
  const version = env.WHATSAPP_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;

  const metaRes = await fetch(
    `https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) {
    const detail = await metaRes.text().catch(() => "");
    throw new Error(`whatsapp-media: metadata fetch failed (${metaRes.status}) ${detail.slice(0, 300)}`);
  }
  const meta = (await metaRes.json().catch(() => null)) as { url?: string } | null;
  const url = meta?.url;
  if (!url || typeof url !== "string") {
    throw new Error("whatsapp-media: metadata returned no url");
  }

  const bytesRes = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!bytesRes.ok) {
    const detail = await bytesRes.text().catch(() => "");
    throw new Error(`whatsapp-media: bytes fetch failed (${bytesRes.status}) ${detail.slice(0, 300)}`);
  }
  const buf = await bytesRes.arrayBuffer();
  return new Uint8Array(buf);
}

/** MIME → a stable file extension for the storage path. Unknown ⇒ `bin`. */
export function mimeToExt(mime: string | null): string {
  if (!mime) return "bin";
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
  };
  return map[base] ?? "bin";
}
