import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  validateBlueprintFile, sniffBlueprintType, blueprintStorageKey, extForMime,
  type CreateBlueprintInput, type Discipline, type BlueprintMime,
} from "@/lib/blueprints/schema";

/**
 * Blueprint Centre service — the drawing register (Phase 2 WOW).
 *
 * Mirrors the job-documents storage discipline exactly:
 *   - bytes go to a PRIVATE bucket via the service-role (admin) client with
 *     upsert:false + an org-scoped, server-built key (no user input in the key);
 *   - the row goes in via the TENANT client so RLS scopes it (the DB trigger
 *     derives org_id + allocates the version — client values are ignored);
 *   - downloads mint a 60s signed URL only AFTER an RLS-gated tenant read;
 *   - on any failure the orphan storage object / shell is cleaned up;
 *   - every service-role path re-checks org ownership.
 * Extra hardening the reviews required: magic-byte sniff of the real bytes
 * (declared MIME is untrusted) + a sha256 content hash (evidence). Audit uses
 * `recordAdminActivity` (the working path; job-documents' tenant `_record_activity`
 * call is dead since its EXECUTE grant was revoked).
 */

const BUCKET = "blueprints";

type UploadFile = { bytes: Uint8Array; mime: string; fileName: string };
export type BlueprintResult<T = { id: string }> = { ok: true; data: T } | { ok: false; error: string };

function checkBytes(file: UploadFile): { ok: true; mime: BlueprintMime; hash: string } | { ok: false; error: string } {
  const v = validateBlueprintFile({ mime: file.mime, size: file.bytes.byteLength });
  if (!v.ok) return { ok: false, error: v.message };
  const sniffed = sniffBlueprintType(file.bytes);
  if (!sniffed) return { ok: false, error: "That file isn't a valid PDF or image." };
  if (sniffed !== file.mime) return { ok: false, error: "The file content doesn't match its type." };
  const hash = createHash("sha256").update(file.bytes).digest("hex");
  return { ok: true, mime: sniffed, hash };
}

type BpFilter = {
  eq: (k: string, v: unknown) => BpFilter;
  in: (k: string, v: unknown[]) => BpFilter;
  order: (k: string, o: { ascending: boolean }) => Promise<{ data: Record<string, unknown>[] | null }>;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null }>;
};
type BpClient = {
  from: (t: string) => {
    insert: (r: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
    delete: (opts?: { count?: string }) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }> };
    select: (c: string) => BpFilter;
  };
};
const bp = (c: Awaited<ReturnType<typeof createClient>>) => c as unknown as BpClient;

/** Create a drawing register entry + upload its first revision. Any member. */
export async function createBlueprint(input: {
  jobId: string;
  meta: CreateBlueprintInput;
  file: UploadFile;
}): Promise<BlueprintResult> {
  const { ctx, user } = await requireOrgContext();
  const checked = checkBytes(input.file);
  if (!checked.ok) return { ok: false, error: checked.error };

  const tenant = await createClient();
  // Confirm the job is in the caller's org (RLS-gated read) before anything.
  const { data: job } = await tenant.from("jobs").select("id").eq("id", input.jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  // 1. Shell (tenant → RLS).
  const { data: shell, error: sErr } = await bp(tenant).from("blueprints").insert({
    org_id: ctx.org.id, job_id: input.jobId,
    drawing_number: input.meta.drawing_number, title: input.meta.title,
    discipline: (input.meta.discipline ?? null) as Discipline | null, created_by: user.id,
  }).select("id").single();
  if (sErr || !shell) {
    return { ok: false, error: /duplicate|unique/i.test(sErr?.message ?? "") ? "A drawing with that number already exists on this job." : "Couldn't create the drawing." };
  }

  const admin = createAdminClient();
  const key = blueprintStorageKey(ctx.org.id, input.jobId, shell.id, randomUUID(), extForMime[checked.mime]);
  const up = await admin.storage.from(BUCKET).upload(key, input.file.bytes, { contentType: checked.mime, upsert: false });
  if (up.error) {
    await bp(tenant).from("blueprints").delete().eq("id", shell.id);
    return { ok: false, error: "Couldn't store the drawing file." };
  }

  const { error: vErr } = await bp(tenant).from("blueprint_versions").insert({
    blueprint_id: shell.id, org_id: ctx.org.id, revision: input.meta.revision,
    revision_date: input.meta.revision_date ?? null, storage_bucket: BUCKET, storage_path: key,
    file_name: input.file.fileName, mime_type: checked.mime, size_bytes: input.file.bytes.byteLength,
    content_hash: checked.hash, notes: input.meta.notes ?? null, uploaded_by: user.id,
  } as unknown as { id: string }).select("id").single();
  if (vErr) {
    await admin.storage.from(BUCKET).remove([key]);
    await bp(tenant).from("blueprints").delete().eq("id", shell.id);
    return { ok: false, error: "Couldn't record the drawing revision." };
  }

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.created",
    targetTable: "blueprints", targetId: shell.id,
    metadata: { drawing_number: input.meta.drawing_number, revision: input.meta.revision, job_id: input.jobId },
  });
  return { ok: true, data: { id: shell.id } };
}

/** Add a new immutable revision to an existing drawing. Any member. */
export async function addBlueprintRevision(input: {
  blueprintId: string;
  meta: { revision: string; revision_date?: string; notes?: string };
  file: UploadFile;
}): Promise<BlueprintResult> {
  const { ctx, user } = await requireOrgContext();
  const checked = checkBytes(input.file);
  if (!checked.ok) return { ok: false, error: checked.error };

  const tenant = await createClient();
  const { data: shell } = await bp(tenant).from("blueprints").select("id, org_id, job_id, drawing_number").eq("id", input.blueprintId).maybeSingle();
  if (!shell) return { ok: false, error: "Drawing not found." };
  if (shell.org_id !== ctx.org.id) return { ok: false, error: "Drawing not found." }; // service-role re-check invariant

  const admin = createAdminClient();
  const key = blueprintStorageKey(ctx.org.id, String(shell.job_id), input.blueprintId, randomUUID(), extForMime[checked.mime]);
  const up = await admin.storage.from(BUCKET).upload(key, input.file.bytes, { contentType: checked.mime, upsert: false });
  if (up.error) return { ok: false, error: "Couldn't store the drawing file." };

  const { error: vErr } = await bp(tenant).from("blueprint_versions").insert({
    blueprint_id: input.blueprintId, org_id: ctx.org.id, revision: input.meta.revision,
    revision_date: input.meta.revision_date ?? null, storage_bucket: BUCKET, storage_path: key,
    file_name: input.file.fileName, mime_type: checked.mime, size_bytes: input.file.bytes.byteLength,
    content_hash: checked.hash, notes: input.meta.notes ?? null, uploaded_by: user.id,
  } as unknown as { id: string }).select("id").single();
  if (vErr) {
    await admin.storage.from(BUCKET).remove([key]);
    return { ok: false, error: "Couldn't record the revision." };
  }

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.revision_added",
    targetTable: "blueprints", targetId: input.blueprintId,
    metadata: { drawing_number: shell.drawing_number, revision: input.meta.revision },
  });
  return { ok: true, data: { id: input.blueprintId } };
}

export type BlueprintRow = {
  id: string; drawing_number: string; title: string; discipline: string | null;
  status: string; current_version: number | null; updated_at: string;
};
export type BlueprintVersionRow = {
  id: string; version: number; revision: string; revision_date: string | null;
  file_name: string; mime_type: string; size_bytes: number; notes: string | null; uploaded_at: string;
};

/** The register for a job (bounded — one row per drawing; current version resolved separately). */
export async function listBlueprints(jobId: string): Promise<BlueprintRow[]> {
  await requireOrgContext();
  const tenant = await createClient();
  const { data } = await bp(tenant).from("blueprints")
    .select("id, drawing_number, title, discipline, status, current_version, updated_at")
    .eq("job_id", jobId).order("drawing_number", { ascending: true });
  return (data ?? []) as unknown as BlueprintRow[];
}

/** Full immutable revision history for one drawing (lazy, per-blueprint). */
export async function listBlueprintVersions(blueprintId: string): Promise<BlueprintVersionRow[]> {
  await requireOrgContext();
  const tenant = await createClient();
  const { data } = await bp(tenant).from("blueprint_versions")
    .select("id, version, revision, revision_date, file_name, mime_type, size_bytes, notes, uploaded_at")
    .eq("blueprint_id", blueprintId).order("version", { ascending: false });
  return (data ?? []) as unknown as BlueprintVersionRow[];
}

/** Revisions for many drawings in ONE query (no N+1) — grouped by blueprint_id. */
export async function listBlueprintVersionsForBlueprints(
  blueprintIds: string[],
): Promise<Record<string, (BlueprintVersionRow & { mime_type: string })[]>> {
  const out: Record<string, (BlueprintVersionRow & { mime_type: string })[]> = {};
  if (blueprintIds.length === 0) return out;
  await requireOrgContext();
  const tenant = await createClient();
  const { data } = await bp(tenant).from("blueprint_versions")
    .select("id, blueprint_id, version, revision, revision_date, file_name, mime_type, size_bytes, notes, uploaded_at")
    .in("blueprint_id", blueprintIds)
    .order("version", { ascending: false });
  for (const row of (data ?? []) as unknown as (BlueprintVersionRow & { blueprint_id: string; mime_type: string })[]) {
    (out[row.blueprint_id] ??= []).push(row);
  }
  return out;
}

/** 60s signed URL — RLS-gated tenant read first, then admin-signs the row's own path. */
export async function getBlueprintVersionUrl(versionId: string): Promise<BlueprintResult<{ url: string; mime: string; fileName: string }>> {
  await requireOrgContext();
  const tenant = await createClient();
  const { data: version } = await bp(tenant).from("blueprint_versions")
    .select("id, storage_path, mime_type, file_name").eq("id", versionId).maybeSingle();
  if (!version) return { ok: false, error: "not_found" };

  const admin = createAdminClient();
  const signed = await admin.storage.from(BUCKET).createSignedUrl(String(version.storage_path), 60);
  if (signed.error || !signed.data?.signedUrl) return { ok: false, error: "sign_failed" };
  return { ok: true, data: { url: signed.data.signedUrl, mime: String(version.mime_type), fileName: String(version.file_name) } };
}

/** Delete a drawing + all revisions + storage bytes. Admin-only (RLS), audited. */
export async function deleteBlueprint(blueprintId: string): Promise<BlueprintResult> {
  const { user } = await requireOrgContext();
  const tenant = await createClient();
  const admin = createAdminClient();

  // Gather paths (RLS read) BEFORE the delete so we can clean storage.
  const { data: versions } = await bp(tenant).from("blueprint_versions").select("storage_path").eq("blueprint_id", blueprintId).order("version", { ascending: true });
  const paths = (versions ?? []).map((v) => String(v.storage_path)).filter(Boolean);

  // Tenant delete — RLS refuses non-admins (0 rows). Only clean storage when a
  // row was ACTUALLY deleted, so a non-admin's denied delete never removes bytes.
  const { error, count } = await bp(tenant).from("blueprints").delete({ count: "exact" }).eq("id", blueprintId);
  if (error) return { ok: false, error: "Couldn't delete the drawing." };
  if (!count) return { ok: false, error: "Only owners/admins can delete a drawing." };
  if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.deleted",
    targetTable: "blueprints", targetId: blueprintId, metadata: {},
  });
  return { ok: true, data: { id: blueprintId } };
}
