/**
 * Site Reports — portal photo projection (pure).
 *
 * The ONLY photos a portal customer may see are the ones staff explicitly
 * published to them: the `photo_attachment_ids` frozen inside a site report
 * snapshot whose report passed `isPortalVisible` (issued/superseded + published
 * + not withdrawn). There is no other portal photo surface — jobs.photos and
 * un-snapshotted attachments are internal.
 *
 * The PRODUCER is the staff report photo picker
 * (app/(app)/site-reports/[id]/_photo-picker.tsx → updateReportPhotos), which
 * re-verifies every selected id against the job's own image attachments, and
 * issueReport re-verifies again at freeze time — so an id arriving here has
 * been double-checked twice on the staff side and is checked a third time by
 * the portal loader. Reports issued before that picker existed carry
 * `photo_attachment_ids: []` and simply contribute no photos.
 *
 * This module is pure: id extraction from an untrusted snapshot blob, and the
 * explicit customer-safe projection. All I/O (the customer-scoped queries, the
 * signed URLs) lives in app/customer-portal/_photos.ts.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard cap on photos per portal page — bounds the signing fan-out. */
export const MAX_PORTAL_PHOTOS = 100;

/**
 * Pull the photo attachment ids out of a report snapshot WITHOUT trusting its
 * shape. The snapshot is jsonb written by staff tooling, but this runs on a
 * customer-facing surface, so every id is re-validated as a UUID (a corrupted
 * or hand-edited snapshot must not smuggle a storage path or filter fragment
 * into the attachment query) and the list is deduped + capped.
 */
export function extractSnapshotPhotoIds(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const content = (snapshot as { content?: unknown }).content;
  if (!content || typeof content !== "object") return [];
  const sources = (content as { sources?: unknown }).sources;
  if (!sources || typeof sources !== "object") return [];
  const ids = (sources as { photo_attachment_ids?: unknown })
    .photo_attachment_ids;
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_PORTAL_PHOTOS) break;
  }
  return out;
}

/**
 * The declared, exhaustive customer-facing shape. `storage_path`, `org_id`,
 * `uploaded_by`, `target_id` and the staff-chosen `filename` (which can carry
 * internal wording) exist on the attachment row and are DELIBERATELY absent —
 * the projection below rebuilds field by field, never spreads.
 */
export const PHOTO_PORTAL_KEYS = [
  "id",
  "url",
  "report_id",
  "report_title",
  "report_number",
  "published_on",
] as const;

export type PortalPhotoView = {
  /** The attachment id — already public to this customer via the snapshot. */
  id: string;
  /** Short-lived signed URL, derived server-side from the attachment row. */
  url: string;
  report_id: string;
  report_title: string;
  report_number: string | null;
  /** YYYY-MM-DD portion of the report's portal_published_at. */
  published_on: string | null;
};

export function buildPortalPhotoView(input: {
  attachmentId: string;
  signedUrl: string;
  reportId: string;
  reportTitle: string;
  reportNumber: string | null;
  portalPublishedAt: string | null;
}): PortalPhotoView {
  return {
    id: input.attachmentId,
    url: input.signedUrl,
    report_id: input.reportId,
    report_title: input.reportTitle,
    report_number: input.reportNumber,
    published_on: input.portalPublishedAt
      ? input.portalPublishedAt.slice(0, 10)
      : null,
  };
}
