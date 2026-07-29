import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { storagePathBelongsToOrg } from "@/lib/storage/owned-path";
import {
  validateBlueprintFile, sniffBlueprintType, blueprintStorageKey, extForMime,
  type CreateBlueprintInput, type Discipline, type BlueprintMime,
} from "@/lib/blueprints/schema";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

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
  order: (
    k: string,
    o: { ascending: boolean },
  ) => Promise<{ data: Record<string, unknown>[] | null; error: SupabaseReadError | null }>;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: SupabaseReadError | null }>;
};
/**
 * A DELETE filter. `.eq()` is chainable AND awaitable so a call site can scope
 * by id alone (the create/rollback cleanup paths, which already hold a row they
 * just inserted) or by id AND org (deleteBlueprint's active-org pin).
 */
type BpDelete = PromiseLike<{ error: { message: string } | null; count: number | null }> & {
  eq: (k: string, v: unknown) => BpDelete;
};
type BpClient = {
  from: (t: string) => {
    insert: (r: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
    delete: (opts?: { count?: string }) => BpDelete;
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
  // Confirm the job is in the ACTIVE org. RLS is not enough: `current_org_ids()`
  // admits every org the viewer belongs to, so an RLS-only check let a dual-org
  // member hang a drawing stamped `org_id: ctx.org.id` off the OTHER org's job.
  const { data: job, error: jobError } = await tenant
    .from("jobs")
    .select("id")
    .eq("id", input.jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError) throw readFailure("blueprints: job gate", jobError);
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
  const { data: shell, error: shellError } = await bp(tenant).from("blueprints").select("id, org_id, job_id, drawing_number").eq("id", input.blueprintId).maybeSingle();
  if (shellError) throw readFailure("blueprints: drawing gate", shellError);
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

/**
 * The register for a job (bounded — one row per drawing; current version
 * resolved separately).
 *
 * Every read below is pinned to the ACTIVE org as well as running under RLS.
 * These functions used to call `requireOrgContext()` purely as an auth gate and
 * throw the context away, leaving `current_org_ids()` (which admits EVERY org
 * the viewer belongs to) as the only scope — so a dual-org member's drawing
 * register, revision history and signed-download path all reached across orgs.
 * Same class as the job domain (#456) and suppliers (#463).
 */
export async function listBlueprints(jobId: string): Promise<BlueprintRow[]> {
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await bp(tenant).from("blueprints")
    .select("id, drawing_number, title, discipline, status, current_version, updated_at")
    .eq("job_id", jobId).eq("org_id", ctx.org.id).order("drawing_number", { ascending: true });
  if (error) throw readFailure("blueprints: register", error);
  return (data ?? []) as unknown as BlueprintRow[];
}

/** Full immutable revision history for one drawing (lazy, per-blueprint). */
export async function listBlueprintVersions(blueprintId: string): Promise<BlueprintVersionRow[]> {
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await bp(tenant).from("blueprint_versions")
    .select("id, version, revision, revision_date, file_name, mime_type, size_bytes, notes, uploaded_at")
    .eq("blueprint_id", blueprintId).eq("org_id", ctx.org.id).order("version", { ascending: false });
  if (error) throw readFailure("blueprints: versions", error);
  return (data ?? []) as unknown as BlueprintVersionRow[];
}

/** Revisions for many drawings in ONE query (no N+1) — grouped by blueprint_id. */
export async function listBlueprintVersionsForBlueprints(
  blueprintIds: string[],
): Promise<Record<string, (BlueprintVersionRow & { mime_type: string })[]>> {
  const out: Record<string, (BlueprintVersionRow & { mime_type: string })[]> = {};
  if (blueprintIds.length === 0) return out;
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await bp(tenant).from("blueprint_versions")
    .select("id, blueprint_id, version, revision, revision_date, file_name, mime_type, size_bytes, notes, uploaded_at")
    .eq("org_id", ctx.org.id)
    .in("blueprint_id", blueprintIds)
    .order("version", { ascending: false });
  if (error) throw readFailure("blueprints: versions batch", error);
  for (const row of (data ?? []) as unknown as (BlueprintVersionRow & { blueprint_id: string; mime_type: string })[]) {
    (out[row.blueprint_id] ??= []).push(row);
  }
  return out;
}

/** 60s signed URL — RLS-gated tenant read first, then admin-signs the row's own path. */
export async function getBlueprintVersionUrl(versionId: string): Promise<BlueprintResult<{ url: string; mime: string; fileName: string }>> {
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();
  // ACTIVE-org pin. `storagePathBelongsToOrg` below proves the path is under the
  // ROW's own org (an anti-poisoning check from the storage-evidence wave); it
  // does NOT prove the row is in the org the viewer is currently working in.
  const { data: version, error: versionError } = await bp(tenant).from("blueprint_versions")
    .select("id, org_id, storage_path, mime_type, file_name").eq("id", versionId).eq("org_id", ctx.org.id).maybeSingle();
  if (versionError) throw readFailure("blueprints: version url", versionError);
  if (!version) return { ok: false, error: "not_found" };
  // Refuse to sign a path not under the row's own org (poisoned cross-tenant pointer).
  if (!storagePathBelongsToOrg(String(version.storage_path), String(version.org_id))) return { ok: false, error: "not_found" };

  const admin = createAdminClient();
  const signed = await admin.storage.from(BUCKET).createSignedUrl(String(version.storage_path), 60);
  if (signed.error || !signed.data?.signedUrl) return { ok: false, error: "sign_failed" };
  return { ok: true, data: { url: signed.data.signedUrl, mime: String(version.mime_type), fileName: String(version.file_name) } };
}

/** Delete a drawing + all revisions + storage bytes. Admin-only (RLS), audited. */
export async function deleteBlueprint(blueprintId: string): Promise<BlueprintResult> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();
  const admin = createAdminClient();

  // ACTIVE-org pin, on BOTH halves of the pair. `blueprints_delete` is
  // `is_org_admin(org_id)`, which an owner/admin of two orgs satisfies for
  // BOTH — so without these predicates a dual-org owner working in org A could
  // delete org B's drawing and wipe its storage bytes.
  //
  // The two predicates MUST move together. Pinning only the DELETE would leave
  // the path-gathering read reaching across orgs; pinning only the read is
  // worse — the wrong-org read returns no paths while the unpinned DELETE
  // still removes the row, ORPHANING every stored byte of that drawing with
  // nothing left in the database pointing at it. Both, or neither.
  //
  // Gather paths (RLS + org pin) BEFORE the delete so we can clean storage.
  const { data: versions } = await bp(tenant).from("blueprint_versions").select("storage_path").eq("blueprint_id", blueprintId).eq("org_id", ctx.org.id).order("version", { ascending: true });
  const paths = (versions ?? []).map((v) => String(v.storage_path)).filter(Boolean);

  // Tenant delete — RLS refuses non-admins (0 rows). Only clean storage when a
  // row was ACTUALLY deleted, so a non-admin's denied delete never removes bytes.
  const { error, count } = await bp(tenant).from("blueprints").delete({ count: "exact" }).eq("id", blueprintId).eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: "Couldn't delete the drawing." };
  // Zero rows has three causes, deliberately treated alike: not an admin, the
  // drawing is gone, or it belongs to a DIFFERENT org the caller happens to
  // belong to. A non-active org's drawing must be indistinguishable from one
  // the caller may not delete — and in all three cases NOTHING was deleted, so
  // the storage cleanup below is correctly skipped and the bytes stay intact.
  if (!count) return { ok: false, error: "Only owners/admins can delete a drawing." };
  if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);

  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.deleted",
    targetTable: "blueprints", targetId: blueprintId, metadata: {},
  });
  return { ok: true, data: { id: blueprintId } };
}
