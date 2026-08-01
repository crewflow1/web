import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPortalVisible } from "@/lib/site-reports/portal";
import {
  buildPortalPhotoView,
  extractSnapshotPhotoIds,
  MAX_PORTAL_PHOTOS,
  type PortalPhotoView,
} from "@/lib/site-reports/portal-photos";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Customer-portal photo reads.
 *
 * PUBLICATION GATE — a photo is portal-visible iff a site report that (a)
 * belongs to THIS customer and (b) passes `isPortalVisible` froze the photo's
 * attachment id into its snapshot. Nothing else on the platform publishes a
 * photo to a customer; jobs.photos and un-snapshotted attachments stay
 * internal.
 *
 * SCOPING (in code — the admin client bypasses RLS by design):
 *   1. reports:      .eq(customer_id) .eq(org_id) + isPortalVisible, exactly
 *                    like _reports.ts;
 *   2. attachments:  ids come ONLY from those snapshots (uuid-revalidated by
 *                    extractSnapshotPhotoIds), then the rows are re-verified
 *                    .eq(org_id) .eq(target_table, 'jobs') in SQL AND
 *                    target_id === the publishing report's job_id in code —
 *                    an attachment that was re-pointed at another job since
 *                    publication silently drops out;
 *   3. images only:  a non-image attachment id in a snapshot is ignored.
 *
 * SIGNED URLS — object-scoped and short-lived (60s, matching job-photos /
 * compliance-docs / tenant-attachments). The storage path is read from the
 * verified attachment ROW; no caller-supplied id or path ever reaches
 * createSignedUrls. The page takes NO photo/job/report parameter at all, so
 * there is nothing for an attacker to vary — unknown ids simply never enter
 * the query.
 *
 * PROJECTION — every row exits through buildPortalPhotoView; storage_path,
 * filename, uploaded_by, org_id and target_id never leave this module.
 */

type ReportRow = {
  id: string;
  job_id: string | null;
  title: string;
  report_number: string | null;
  status: string;
  snapshot: unknown;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
};

type AttachmentRow = {
  id: string;
  target_id: string;
  storage_path: string;
  mime_type: string | null;
};

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type ReportChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        in: (k: string, v: unknown[]) => {
          not: (k: string, op: string, v: unknown) => {
            is: (k: string, v: unknown) => {
              order: (
                k: string,
                o: { ascending: boolean },
              ) => { limit: (n: number) => PromiseLike<Res<ReportRow[]>> };
            };
          };
        };
      };
    };
  };
};
type AttachmentChain = {
  select: (c: string) => {
    in: (k: string, v: unknown[]) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => PromiseLike<Res<AttachmentRow[]>>;
      };
    };
  };
};

/** Photos grouped under the report that published them, newest report first. */
export type PortalPhotoGroup = {
  report_id: string;
  report_title: string;
  report_number: string | null;
  published_on: string | null;
  photos: PortalPhotoView[];
};

export async function listPortalPhotos(
  customerId: string,
  orgId: string,
): Promise<PortalPhotoGroup[]> {
  const admin = createAdminClient();

  // 1. This customer's PUBLISHED reports — the only publication gate.
  const { data: reportsRaw, error: reportsError } = await (
    admin.from("site_reports" as never) as unknown as ReportChain
  )
    .select(
      "id, job_id, title, report_number, status, snapshot, portal_published_at, portal_withdrawn_at",
    )
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .in("status", ["issued", "superseded"])
    .not("portal_published_at", "is", null)
    .is("portal_withdrawn_at", null)
    .order("portal_published_at", { ascending: false })
    .limit(50);
  if (reportsError) throw readFailure("portal photos: reports", reportsError);

  // Defence-in-depth: re-apply the visibility predicate in code.
  const reports = (reportsRaw ?? []).filter((r) =>
    isPortalVisible({
      status: r.status,
      portal_published_at: r.portal_published_at,
      portal_withdrawn_at: r.portal_withdrawn_at,
    }),
  );

  // 2. Attachment ids ONLY from those frozen snapshots (uuid-revalidated).
  //    First-published-wins on an id that appears in two reports.
  const reportByPhotoId = new Map<string, ReportRow>();
  for (const report of reports) {
    for (const id of extractSnapshotPhotoIds(report.snapshot)) {
      if (!reportByPhotoId.has(id)) reportByPhotoId.set(id, report);
      if (reportByPhotoId.size >= MAX_PORTAL_PHOTOS) break;
    }
    if (reportByPhotoId.size >= MAX_PORTAL_PHOTOS) break;
  }
  if (reportByPhotoId.size === 0) return [];

  // 3. Verify each id against the attachment table, org-pinned and job-typed.
  const { data: attachmentsRaw, error: attachmentsError } = await (
    admin.from("tenant_attachments" as never) as unknown as AttachmentChain
  )
    .select("id, target_id, storage_path, mime_type")
    .in("id", [...reportByPhotoId.keys()])
    .eq("org_id", orgId)
    .eq("target_table", "jobs");
  if (attachmentsError) {
    throw readFailure("portal photos: attachments", attachmentsError);
  }

  const verified = (attachmentsRaw ?? []).filter((a) => {
    const report = reportByPhotoId.get(a.id);
    // Object-level binding: the attachment must still hang off the SAME job
    // the publishing report covers, and must actually be an image.
    return (
      !!report &&
      report.job_id != null &&
      a.target_id === report.job_id &&
      (a.mime_type ?? "").startsWith("image/")
    );
  });
  if (verified.length === 0) return [];

  // 4. Sign the verified rows' paths — derived server-side, never from input.
  const { data: signed, error: signError } = await admin.storage
    .from("tenant-attachments")
    .createSignedUrls(
      verified.map((a) => a.storage_path),
      60,
    );
  if (signError) {
    throw readFailure("portal photos: sign", { message: signError.message });
  }
  const urlByPath = new Map<string, string>();
  for (const s of signed ?? []) {
    if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
  }

  // 5. Project + group under the publishing report, newest first.
  const groups = new Map<string, PortalPhotoGroup>();
  for (const report of reports) {
    groups.set(report.id, {
      report_id: report.id,
      report_title: report.title,
      report_number: report.report_number,
      published_on: report.portal_published_at
        ? report.portal_published_at.slice(0, 10)
        : null,
      photos: [],
    });
  }
  for (const a of verified) {
    const report = reportByPhotoId.get(a.id)!;
    const url = urlByPath.get(a.storage_path);
    if (!url) continue; // a path that failed to sign is dropped, not guessed at
    groups.get(report.id)?.photos.push(
      buildPortalPhotoView({
        attachmentId: a.id,
        signedUrl: url,
        reportId: report.id,
        reportTitle: report.title,
        reportNumber: report.report_number,
        portalPublishedAt: report.portal_published_at,
      }),
    );
  }
  return [...groups.values()].filter((g) => g.photos.length > 0);
}
