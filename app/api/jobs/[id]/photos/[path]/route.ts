import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Delete a single job photo.
 *
 *   DELETE /api/jobs/[id]/photos/[path]
 *
 * `path` is the URL-encoded last segment of the storage path (the
 * filename within the <org_id>/<job_id>/ folder).
 *
 * Permission model:
 *   - jobs.photos mutation goes through remove_job_photo() SECURITY
 *     DEFINER RPC — any org member can detach. The RPC enforces org
 *     membership via auth.uid() before touching the row.
 *   - Storage object deletion uses the service-role admin client. We've
 *     already verified org membership via the RPC return, so this is
 *     a safe follow-up.
 */

type Ctx = { params: Promise<{ id: string; path: string }> };

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id: jobId, path: filename } = await params;
  const decoded = decodeURIComponent(filename);

  const supabase = await createClient();
  // ACTIVE-org pin, not merely RLS: `current_org_ids()` spans every org the
  // viewer belongs to, so `.eq("id", …)` alone would let a multi-org member
  // detach a photo from a job in their OTHER org. Mirrors the GET/POST handlers.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, photos")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const fullPath = `${ctx.org.id}/${jobId}/${decoded}`;
  const current = job.photos ?? [];
  if (!current.includes(fullPath)) {
    return NextResponse.json({ error: "Photo not on this job" }, { status: 404 });
  }

  // Detach from jobs.photos via the SECURITY DEFINER RPC (members allowed).
  const { error: rpcErr } = await supabase.rpc("remove_job_photo", {
    target_job_id: jobId,
    photo_path: fullPath,
  });
  if (rpcErr) {
    console.error("[job photos] remove RPC failed", rpcErr);
    const forbidden = rpcErr.code === "42501";
    return NextResponse.json(
      {
        error: forbidden ? "Not a member of this org" : "Failed to detach photo",
      },
      { status: forbidden ? 403 : 500 },
    );
  }

  // Remove the underlying storage object. Storage delete policy on the
  // bucket is admin-only; we use the service-role admin client so this
  // succeeds regardless of role (RPC already enforced membership above).
  const admin = createAdminClient();
  const { error: rmErr } = await admin.storage
    .from("job-photos")
    .remove([fullPath]);
  if (rmErr) {
    console.error("[job photos] storage delete failed", rmErr);
    // The row is already updated; surface partial success so the caller
    // can see the gallery item is gone but the underlying object lingered.
    return NextResponse.json({ ok: true, warning: "Object cleanup failed" });
  }

  return NextResponse.json({ ok: true });
}
