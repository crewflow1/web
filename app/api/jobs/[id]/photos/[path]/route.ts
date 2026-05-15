import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Delete a single job photo.
 *
 *   DELETE /api/jobs/[id]/photos/[path]
 *
 * `path` is the URL-encoded last segment of the storage path (the filename
 * within the <org_id>/<job_id>/ folder).
 *
 * RLS gates the jobs.photos update to admins/owners; storage delete on
 * `job-photos` is also admin-only. Non-admin requests get 403.
 */

type Ctx = { params: Promise<{ id: string; path: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id: jobId, path: filename } = await params;
  const decoded = decodeURIComponent(filename);

  const supabase = await createClient();
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, photos")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const fullPath = `${ctx.org.id}/${jobId}/${decoded}`;
  const current = job.photos ?? [];
  if (!current.includes(fullPath)) {
    return NextResponse.json({ error: "Photo not on this job" }, { status: 404 });
  }

  // Remove from array first under user JWT (admin-only via RLS).
  const next = current.filter((p) => p !== fullPath);
  const { error: updErr, count } = await supabase
    .from("jobs")
    .update({ photos: next }, { count: "exact" })
    .eq("id", jobId);

  if (updErr) {
    console.error("[job photos] update failed during delete", updErr);
    return NextResponse.json({ error: "Failed to update job" }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json(
      { error: "Only admins/owners can delete job photos" },
      { status: 403 },
    );
  }

  // Now remove the storage object. Use admin client since the storage-delete
  // policy is admin-only and we've already verified admin via the row update.
  const admin = createAdminClient();
  const { error: rmErr } = await admin.storage
    .from("job-photos")
    .remove([fullPath]);
  if (rmErr) {
    console.error("[job photos] storage delete failed", rmErr);
    // The row is already updated; the object may stay orphaned but the
    // user sees it gone from the gallery. Surface as warning.
    return NextResponse.json({ ok: true, warning: "Object cleanup failed" });
  }

  return NextResponse.json({ ok: true });
}
