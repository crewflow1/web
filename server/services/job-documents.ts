import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";

/**
 * P4 — Job Documents service layer.
 *
 * Two document areas per job, discriminated by job_documents.visibility:
 *   - 'staff'   → owner/admin/staff may view, edit, version, complete.
 *   - 'private' → owner/admin only. Staff may UPLOAD (a write-only drop box)
 *                 but must never list / view / download / edit / delete.
 *
 * The private boundary is enforced at THREE layers; this module is the third:
 *   1. Table RLS  (20260704010000_job_documents.sql)
 *   2. Storage RLS + a physically separate `job-docs-private` bucket
 *      (20260704010100_job_docs_buckets.sql)
 *   3. Client selection here.
 *
 * Client-selection rules (the load-bearing invariants):
 *   - STAFF-area writes  → tenant (user-JWT) client, so RLS scopes them.
 *   - PRIVATE-area writes → service-role client. A staff JWT is *blocked* by
 *     the version INSERT policy ("staff or admin"), which is exactly the
 *     drop-box requirement: staff write, can't read. Because the service-role
 *     client BYPASSES RLS, every private write re-checks org ownership in code
 *     (org_id === ctx.org.id) and only ever runs for a verified org member.
 *   - ALL reads + complete + delete → tenant client, so RLS is the gate. Staff
 *     reading a private row get nothing; staff completing/deleting a private
 *     row are refused by the UPDATE/DELETE policies.
 *   - Audit → ALWAYS the tenant client's `_record_activity` RPC so auth.uid()
 *     is captured as the actor. Private events use the action prefix
 *     'job_document.private.' so migration 3's activity_log filter hides them
 *     from staff.
 */

export type JobDocVisibility = "staff" | "private";

export const JOB_DOC_TYPES = [
  "eicr",
  "test_sheet",
  "risk_assessment",
  "method_statement",
  "completion_cert",
  "checklist",
  "site_report",
  "timesheet",
  "commissioning",
  "custom",
] as const;
export type JobDocType = (typeof JOB_DOC_TYPES)[number];

export const JOB_DOC_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
]);

export const JOB_DOC_MAX_BYTES = 25 * 1024 * 1024;

export function bucketForVisibility(visibility: JobDocVisibility): string {
  return visibility === "private" ? "job-docs-private" : "job-docs";
}

export type JobDocumentRow = {
  id: string;
  job_id: string;
  visibility: JobDocVisibility;
  doc_type: JobDocType;
  title: string;
  status: "draft" | "in_progress" | "completed";
  assigned_to: string | null;
  external_reference: string | null;
  customer_shared_at: string | null;
  requires_staff_signature: boolean;
  requires_customer_signature: boolean;
  current_version: string | null;
  completed_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type JobDocumentVersionRow = {
  id: string;
  version_no: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

type MutationResult =
  | { ok: true; document_id: string }
  | { ok: false; error: string };

type SignedUrlResult = { ok: true; url: string } | { ok: false; error: string };

function privateAction(visibility: JobDocVisibility, verb: string): string {
  return visibility === "private"
    ? `job_document.private.${verb}`
    : `job_document.${verb}`;
}

/**
 * Create a document shell on a job. The first file is added via addVersion().
 *
 * Staff are allowed to create in either area (private creation is the start of
 * a drop-box upload). Private creation goes via the service-role client; the
 * job is validated against the caller's org first (the tenant read both gates
 * job_id ∈ org and prevents attaching to another tenant's job).
 */
export async function createJobDocument(input: {
  jobId: string;
  visibility: JobDocVisibility;
  title: string;
  docType?: JobDocType;
  assignedTo?: string | null;
  externalReference?: string | null;
  requiresStaffSignature?: boolean;
  requiresCustomerSignature?: boolean;
}): Promise<MutationResult> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();

  // Confirm the job exists and belongs to the caller's org (RLS-gated read).
  const { data: job } = await tenant
    .from("jobs")
    .select("id, org_id")
    .eq("id", input.jobId)
    .maybeSingle();
  const jobRow = job as { id: string; org_id: string } | null;
  if (!jobRow || jobRow.org_id !== ctx.org.id) {
    return { ok: false, error: "job_not_found" };
  }

  const id = crypto.randomUUID();
  const row = {
    id,
    org_id: ctx.org.id,
    job_id: input.jobId,
    visibility: input.visibility,
    doc_type: input.docType ?? "custom",
    title: input.title,
    status: "draft",
    assigned_to: input.assignedTo ?? null,
    external_reference: input.externalReference ?? null,
    requires_staff_signature: input.requiresStaffSignature ?? false,
    requires_customer_signature: input.requiresCustomerSignature ?? false,
    created_by: user.id,
    updated_by: user.id,
  };

  // Private rows can't be SELECTed back by staff, but we generate the id
  // client-side so no RETURNING is needed. Private writes use the service-role
  // client; org ownership is fixed to ctx.org.id above.
  const writer = input.visibility === "private" ? createAdminClient() : tenant;
  const { error } = await writer
    .from("job_documents" as never)
    .insert(row as never);
  if (error) {
    console.error("[job-documents] create insert failed", error);
    return { ok: false, error: "record_failed" };
  }

  await recordJobDocActivity(tenant, {
    orgId: ctx.org.id,
    action: privateAction(input.visibility, "created"),
    documentId: id,
    metadata: {
      title: input.title,
      visibility: input.visibility,
      doc_type: input.docType ?? "custom",
    },
  });

  return { ok: true, document_id: id };
}

/**
 * Add a new file version to a document. Staff-area versions go via the tenant
 * client (RLS); private-area versions via the service-role client (the drop
 * box — a staff JWT is refused by the version INSERT policy). The before-insert
 * trigger assigns version_no and the authoritative org_id/visibility.
 */
export async function addJobDocumentVersion(input: {
  documentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<MutationResult> {
  if (!JOB_DOC_ALLOWED_MIME.has(input.mimeType)) {
    return { ok: false, error: "bad_file_type" };
  }
  if (input.bytes.byteLength > JOB_DOC_MAX_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const { ctx, user } = await requireOrgContext();
  const admin = createAdminClient();

  // Read the parent via the SERVICE-ROLE client: a staff user adding to the
  // private drop box can't SELECT the parent under RLS, so we can't gate on a
  // tenant read here. Because this bypasses RLS, we re-check org ownership in
  // code — without it, a member could target another org's document by id.
  const { data: doc } = await admin
    .from("job_documents" as never)
    .select("id, org_id, job_id, visibility, status")
    .eq("id", input.documentId)
    .maybeSingle();
  const parent = doc as {
    id: string;
    org_id: string;
    job_id: string;
    visibility: JobDocVisibility;
    status: string;
  } | null;
  if (!parent || parent.org_id !== ctx.org.id) {
    return { ok: false, error: "not_found" };
  }
  if (parent.status === "completed") {
    return { ok: false, error: "locked" };
  }

  const visibility = parent.visibility;
  const bucket = bucketForVisibility(visibility);
  const ext = mimeToExt(input.mimeType);
  // version_no is owned by the DB (before-insert trigger); the storage object
  // is named by a random id to avoid racing on the version number.
  const fileId = crypto.randomUUID();
  const storagePath = `${ctx.org.id}/${parent.job_id}/${parent.id}/${fileId}.${ext}`;

  const { error: uErr } = await admin.storage.from(bucket).upload(storagePath, input.bytes, {
    contentType: input.mimeType,
    upsert: false,
  });
  if (uErr) {
    console.error("[job-documents] storage upload failed", uErr);
    return { ok: false, error: "upload_failed" };
  }

  const versionId = crypto.randomUUID();
  const versionRow = {
    id: versionId,
    document_id: parent.id,
    // org_id + visibility are overwritten by the before-insert trigger from the
    // parent; we pass the expected values so the row is valid pre-trigger too.
    org_id: ctx.org.id,
    visibility,
    storage_bucket: bucket,
    storage_path: storagePath,
    filename: input.filename,
    mime_type: input.mimeType,
    size_bytes: input.bytes.byteLength,
    uploaded_by: user.id,
  };

  // Staff-area version inserts go through RLS; private ones use service role
  // (the drop box). The DB enforces the same boundary either way.
  const tenant = await createClient();
  const writer = visibility === "private" ? admin : tenant;
  const { error: insErr } = await writer
    .from("job_document_versions" as never)
    .insert(versionRow as never);
  if (insErr) {
    console.error("[job-documents] version insert failed", insErr);
    await admin.storage
      .from(bucket)
      .remove([storagePath])
      .catch(() => undefined);
    return { ok: false, error: "record_failed" };
  }

  await recordJobDocActivity(tenant, {
    orgId: ctx.org.id,
    action: privateAction(visibility, "version_added"),
    documentId: parent.id,
    metadata: {
      version_id: versionId,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
    },
  });

  return { ok: true, document_id: parent.id };
}

/**
 * List documents in one area of a job. RLS does the gating: staff querying the
 * private area get an empty list. The explicit visibility filter keeps the two
 * tabs distinct for owner/admin too.
 */
export async function listJobDocuments(
  jobId: string,
  area: JobDocVisibility,
): Promise<JobDocumentRow[]> {
  await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await tenant
    .from("job_documents" as never)
    .select(
      "id, job_id, visibility, doc_type, title, status, assigned_to, external_reference, customer_shared_at, requires_staff_signature, requires_customer_signature, current_version, completed_at, created_by, updated_by, created_at, updated_at",
    )
    .eq("job_id", jobId)
    .eq("visibility", area)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[job-documents] list failed", error);
    return [];
  }
  return (data ?? []) as unknown as JobDocumentRow[];
}

/**
 * Version history for a document (newest first). RLS-gated: staff get [] for a
 * private document's versions.
 */
export async function listJobDocumentVersions(
  documentId: string,
): Promise<JobDocumentVersionRow[]> {
  await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await tenant
    .from("job_document_versions" as never)
    .select(
      "id, version_no, filename, mime_type, size_bytes, uploaded_by, created_at",
    )
    .eq("document_id", documentId)
    .order("version_no", { ascending: false });
  if (error) {
    console.error("[job-documents] versions failed", error);
    return [];
  }
  return (data ?? []) as unknown as JobDocumentVersionRow[];
}

/**
 * Mint a short-lived (60s) signed URL for a version's file. The RLS-gated read
 * of the version row IS the access check: staff get nothing for a private
 * version and never reach the signing step.
 */
export async function getJobDocumentDownloadUrl(
  versionId: string,
): Promise<SignedUrlResult> {
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();

  const { data, error } = await tenant
    .from("job_document_versions" as never)
    .select("document_id, visibility, storage_bucket, storage_path")
    .eq("id", versionId)
    .maybeSingle();
  if (error) {
    console.error("[job-documents] download lookup failed", error);
    return { ok: false, error: "lookup_failed" };
  }
  const version = data as {
    document_id: string;
    visibility: JobDocVisibility;
    storage_bucket: string;
    storage_path: string;
  } | null;
  if (!version) {
    // Either missing or RLS-denied (a staff user hitting a private version).
    return { ok: false, error: "not_found" };
  }

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from(version.storage_bucket)
    .createSignedUrl(version.storage_path, 60);
  if (signErr || !signed) {
    console.error("[job-documents] sign failed", signErr);
    return { ok: false, error: "sign_failed" };
  }

  await recordJobDocActivity(tenant, {
    orgId: ctx.org.id,
    action: privateAction(version.visibility, "downloaded"),
    documentId: version.document_id,
    metadata: { version_id: versionId },
  });

  return { ok: true, url: signed.signedUrl };
}

/**
 * Mark a document completed (locks it — the before-insert trigger then rejects
 * new versions). Tenant client: RLS allows staff to complete staff docs but
 * refuses private docs to non-admins.
 */
export async function completeJobDocument(
  documentId: string,
): Promise<MutationResult> {
  const { user } = await requireOrgContext();
  const tenant = await createClient();
  const { data, error } = await tenant
    .from("job_documents" as never)
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: user.id,
      updated_by: user.id,
    } as never)
    .eq("id", documentId)
    .select("id, org_id, visibility")
    .maybeSingle();
  if (error) {
    console.error("[job-documents] complete failed", error);
    return { ok: false, error: "update_failed" };
  }
  const updated = data as {
    id: string;
    org_id: string;
    visibility: JobDocVisibility;
  } | null;
  if (!updated) {
    // RLS refused (e.g. staff on a private doc) or no such row.
    return { ok: false, error: "forbidden" };
  }

  await recordJobDocActivity(tenant, {
    orgId: updated.org_id,
    action: privateAction(updated.visibility, "completed"),
    documentId,
    metadata: null,
  });

  return { ok: true, document_id: documentId };
}

/**
 * Delete a document and all its files. Owner/admin only (RLS DELETE policy is
 * admin-only for both areas). The row delete cascades version rows; storage
 * objects are removed via the service-role client afterwards.
 */
export async function deleteJobDocument(
  documentId: string,
): Promise<MutationResult> {
  const { ctx } = await requireOrgContext();
  const tenant = await createClient();
  const admin = createAdminClient();

  // Gather files before the cascade removes the version rows. RLS-gated, but
  // only admins reach a successful delete below regardless.
  const { data: versions } = await tenant
    .from("job_document_versions" as never)
    .select("storage_bucket, storage_path")
    .eq("document_id", documentId);

  const { data: deleted, error } = await tenant
    .from("job_documents" as never)
    .delete()
    .eq("id", documentId)
    .select("id, visibility")
    .maybeSingle();
  if (error) {
    console.error("[job-documents] delete failed", error);
    return { ok: false, error: "delete_failed" };
  }
  const deletedRow = deleted as {
    id: string;
    visibility: JobDocVisibility;
  } | null;
  if (!deletedRow) {
    // RLS refused (non-admin) or no such row — never touch storage.
    return { ok: false, error: "forbidden" };
  }

  const files = (versions ?? []) as unknown as {
    storage_bucket: string;
    storage_path: string;
  }[];
  const byBucket = new Map<string, string[]>();
  for (const f of files) {
    const paths = byBucket.get(f.storage_bucket) ?? [];
    paths.push(f.storage_path);
    byBucket.set(f.storage_bucket, paths);
  }
  for (const [bucket, paths] of byBucket) {
    await admin.storage
      .from(bucket)
      .remove(paths)
      .catch(() => undefined);
  }

  await recordJobDocActivity(tenant, {
    orgId: ctx.org.id,
    action: privateAction(deletedRow.visibility, "deleted"),
    documentId,
    metadata: null,
  });

  return { ok: true, document_id: documentId };
}

/**
 * Write a tenant audit row via the existing _record_activity RPC. Must use the
 * tenant (user-JWT) client so the SECURITY DEFINER function captures auth.uid()
 * as actor_id. Failures are swallowed — audit must never block the operation.
 */
async function recordJobDocActivity(
  tenant: Awaited<ReturnType<typeof createClient>>,
  input: {
    orgId: string;
    action: string;
    documentId: string;
    metadata: Record<string, unknown> | null;
  },
): Promise<void> {
  const { error } = await tenant.rpc("_record_activity" as never, {
    p_org_id: input.orgId,
    p_action: input.action,
    p_target_table: "job_documents",
    p_target_id: input.documentId,
    p_metadata: input.metadata,
  } as never);
  if (error) {
    console.error("[job-documents] activity log failed", input.action, error);
  }
}

function mimeToExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  if (mime === "image/webp") return "webp";
  if (mime === "text/csv") return "csv";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "xlsx";
  if (mime.includes("wordprocessing") || mime.includes("msword")) return "docx";
  return "bin";
}
