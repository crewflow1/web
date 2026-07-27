"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import {
  createJobDocument,
  addJobDocumentVersion,
  completeJobDocument,
  deleteJobDocument,
  getJobDocumentDownloadUrl,
  JOB_DOC_TYPES,
  type JobDocType,
} from "@/server/services/job-documents";

/**
 * P4 Job Documents — UI server actions (PR-B).
 *
 * Thin adapters between the client controls and the PR-A service layer. They
 * carry NO business logic and NO direct DB / storage / RLS access: every
 * mutation is delegated to `@/server/services/job-documents`, so the service's
 * client-selection rules, org re-checks, completion lock and — critically —
 * the `_record_activity` audit trail all continue to apply unchanged.
 *
 * `requireOrgContext()` here is the auth gate (redirects guests); the service
 * re-derives org/role/actor itself, so these actions never widen access.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

const uuid = z.string().uuid();
const visibilitySchema = z.enum(["staff", "private"]);

function revalidateJob(jobId: string): void {
  if (uuid.safeParse(jobId).success) revalidatePath(`/jobs/${jobId}`);
}

function normaliseDocType(raw: string): JobDocType | undefined {
  return (JOB_DOC_TYPES as readonly string[]).includes(raw)
    ? (raw as JobDocType)
    : undefined;
}

/**
 * Create a document shell + add its first file in one step. Works for both
 * areas; for the private staff drop box the service routes the write through
 * the service-role client (a staff JWT can't read it back).
 */
export async function uploadJobDocument(
  formData: FormData,
): Promise<ActionResult> {
  await requireOrgContext();

  const jobId = String(formData.get("job_id") ?? "");
  if (!uuid.safeParse(jobId).success) return { ok: false, error: "bad_target" };

  const visibility = visibilitySchema.safeParse(formData.get("visibility"));
  if (!visibility.success) return { ok: false, error: "bad_target" };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "title_required" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no_file" };
  }

  const created = await createJobDocument({
    jobId,
    visibility: visibility.data,
    title,
    docType: normaliseDocType(String(formData.get("doc_type") ?? "")),
  });
  if (!created.ok) return { ok: false, error: created.error };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const added = await addJobDocumentVersion({
    documentId: created.document_id,
    filename: file.name,
    mimeType: file.type,
    bytes,
  });
  if (!added.ok) return { ok: false, error: added.error };

  revalidateJob(jobId);
  return { ok: true };
}

/** Add a new file version to an existing document. */
export async function uploadJobDocumentVersion(
  formData: FormData,
): Promise<ActionResult> {
  await requireOrgContext();

  const documentId = String(formData.get("document_id") ?? "");
  if (!uuid.safeParse(documentId).success) {
    return { ok: false, error: "bad_target" };
  }
  const jobId = String(formData.get("job_id") ?? "");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no_file" };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const added = await addJobDocumentVersion({
    documentId,
    filename: file.name,
    mimeType: file.type,
    bytes,
  });
  if (!added.ok) return { ok: false, error: added.error };

  revalidateJob(jobId);
  return { ok: true };
}

/** Mark a document completed (locks it against further versions). */
export async function completeJobDocumentAction(
  documentId: string,
  jobId: string,
): Promise<ActionResult> {
  await requireOrgContext();
  if (!uuid.safeParse(documentId).success) {
    return { ok: false, error: "bad_target" };
  }
  const res = await completeJobDocument(documentId);
  if (!res.ok) return { ok: false, error: res.error };
  revalidateJob(jobId);
  return { ok: true };
}

/** Delete a document + all its files. Owner/admin only (RLS-gated). */
export async function deleteJobDocumentAction(
  documentId: string,
  jobId: string,
): Promise<ActionResult> {
  await requireOrgContext();
  if (!uuid.safeParse(documentId).success) {
    return { ok: false, error: "bad_target" };
  }
  const res = await deleteJobDocument(documentId);
  if (!res.ok) return { ok: false, error: res.error };
  revalidateJob(jobId);
  return { ok: true };
}

/**
 * Mint a short-lived signed URL for a version. The RLS-gated row read inside
 * the service IS the access check — staff hitting a private version get
 * `not_found` and no URL is ever minted.
 */
export async function getJobDocumentDownloadUrlAction(
  versionId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requireOrgContext();
  if (!uuid.safeParse(versionId).success) {
    return { ok: false, error: "bad_target" };
  }
  return getJobDocumentDownloadUrl(versionId);
}
