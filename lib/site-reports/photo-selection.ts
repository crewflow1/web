import { z } from "zod";

/**
 * Site Reports — photo selection for the customer-facing snapshot (pure).
 *
 * Staff pick photos from the JOB'S OWN image attachments; the selected ids are
 * saved into content.sources.photo_attachment_ids and frozen into the snapshot
 * at issue, which is the portal photos tab's ONLY publication gate
 * (lib/site-reports/portal-photos.ts).
 *
 * Everything here is pure so the security property — "an id only survives if
 * it is an image attachment of THAT job" — is one testable function, mirroring
 * the double-pin the portal read side applies (org in SQL, job binding in
 * code). The I/O around it lives in app/(app)/site-reports/actions.ts.
 */

/** Hard cap per report — stated in the picker UI and enforced in zod. */
export const MAX_REPORT_PHOTOS = 12;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the RAW form submission (formData.getAll → unknown[]): every entry
 * must be a uuid, the deduped list must fit the cap. Returns null on any
 * malformed entry — a crafted checkbox value is rejected, never coerced.
 */
export const reportPhotoIdsSchema = z
  .array(z.string().regex(UUID_RE, "bad photo id"))
  .max(MAX_REPORT_PHOTOS * 4); // absolute parse bound; the cap below is on the deduped set

export function parsePhotoSelection(raw: unknown): string[] | null {
  const parsed = reportPhotoIdsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const deduped = [...new Set(parsed.data)];
  if (deduped.length > MAX_REPORT_PHOTOS) return null;
  return deduped;
}

/** The attachment fields the verification needs — nothing more is read. */
export type VerifiablePhotoAttachment = {
  id: string;
  target_id: string | null;
  mime_type: string | null;
};

/**
 * Keep only the candidate ids that are PROVEN to be an image attachment of the
 * given job. `rows` must already be org-scoped by the caller's query (tenant
 * RLS or an explicit org filter); this function re-checks the JOB binding and
 * the image mime in code regardless, so a wrong-job or non-image row slipping
 * into `rows` still cannot admit its id.
 */
export function filterVerifiedPhotoIds(
  candidateIds: string[],
  rows: VerifiablePhotoAttachment[],
  jobId: string,
): string[] {
  const verified = new Set<string>();
  for (const row of rows) {
    if (row.target_id !== jobId) continue;
    if (!(row.mime_type ?? "").startsWith("image/")) continue;
    verified.add(row.id);
  }
  return candidateIds.filter((id) => verified.has(id)).slice(0, MAX_REPORT_PHOTOS);
}
