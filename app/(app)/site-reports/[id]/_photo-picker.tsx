import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { MAX_REPORT_PHOTOS } from "@/lib/site-reports/photo-selection";
import { updateReportPhotos } from "../actions";

/**
 * Site report — customer-facing photo picker (server component, no client JS).
 *
 * Lists the JOB'S image attachments (tenant_attachments, target_table='jobs')
 * on the tenant RLS client, additionally pinned to the ACTIVE org and to this
 * report's job, and lets the author tick up to MAX_REPORT_PHOTOS of them into
 * content.sources.photo_attachment_ids via updateReportPhotos — which
 * re-verifies every submitted id server-side (this list is a convenience, not
 * the authority).
 *
 * Thumbnails are short-lived signed URLs (60s, the platform-wide TTL) built
 * from the RLS-verified rows' own storage paths. Ergonomics: 44px+ tap
 * targets, a grid that stays 3-up at 375px, selection visible without colour
 * alone (checkbox stays rendered).
 */

type AttachmentRow = {
  id: string;
  storage_path: string;
  mime_type: string | null;
  created_at: string;
};

type ListChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          order: (
            k: string,
            o: { ascending: boolean },
          ) => {
            limit: (n: number) => Promise<{
              data: AttachmentRow[] | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      };
    };
  };
};

export async function ReportPhotoPicker({
  reportId,
  jobId,
  orgId,
  selectedIds,
}: {
  reportId: string;
  jobId: string;
  orgId: string;
  selectedIds: string[];
}) {
  const tenant = await createClient();
  const { data, error } = await (
    (tenant as unknown as { from: (t: string) => unknown }).from(
      "tenant_attachments",
    ) as unknown as ListChain
  )
    .select("id, storage_path, mime_type, created_at")
    .eq("org_id", orgId)
    .eq("target_table", "jobs")
    .eq("target_id", jobId)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw readFailure("site report: job photos", error);

  const images = (data ?? []).filter((a) =>
    (a.mime_type ?? "").startsWith("image/"),
  );
  const selected = new Set(selectedIds);

  const urlByPath = new Map<string, string>();
  if (images.length > 0) {
    const admin = createAdminClient();
    const { data: signed, error: signError } = await admin.storage
      .from("tenant-attachments")
      .createSignedUrls(
        images.map((a) => a.storage_path),
        60,
      );
    if (signError) {
      throw readFailure("site report: job photos sign", { message: signError.message });
    }
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Customer photos</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Choose up to {MAX_REPORT_PHOTOS} of this job&apos;s photos to include in
        the report. They become visible in the customer portal once the report
        is issued and published.
      </p>

      {images.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          No photos are attached to this job yet. Add photos on the job&apos;s
          attachments panel and they&apos;ll appear here.
        </p>
      ) : (
        <form action={updateReportPhotos} className="mt-3 space-y-3">
          <input type="hidden" name="id" value={reportId} />
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((a, i) => {
              const url = urlByPath.get(a.storage_path);
              return (
                <li key={a.id}>
                  <label className="relative block min-h-[44px] cursor-pointer overflow-hidden rounded-lg border border-slate-200 focus-within:ring-2 focus-within:ring-slate-500">
                    {url ? (
                      // Signed URLs expire in seconds — next/image's cached
                      // optimiser would re-fetch after expiry and 400.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={url}
                        alt={`Job photo ${i + 1}`}
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    ) : (
                      <span className="flex aspect-square w-full items-center justify-center bg-slate-100 text-[11px] text-slate-500">
                        Preview unavailable
                      </span>
                    )}
                    <span className="absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-md bg-white/90">
                      <input
                        type="checkbox"
                        name="photo_ids"
                        value={a.id}
                        defaultChecked={selected.has(a.id)}
                        className="h-5 w-5 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                      />
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Save photo selection
            </button>
            <span className="text-xs text-slate-500">
              {selectedIds.length} of {MAX_REPORT_PHOTOS} selected
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
