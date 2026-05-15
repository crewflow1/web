import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Job photos — upload + list.
 *
 *   POST /api/jobs/[id]/photos   multipart upload(s) → stored at
 *                                <org_id>/<job_id>/<filename> and the path
 *                                is appended to jobs.photos.
 *   GET  /api/jobs/[id]/photos   returns each stored path with a short-lived
 *                                signed URL for in-browser display.
 *
 * RLS posture:
 *   - storage.objects writes are open to any org member.
 *   - Mutations to jobs.photos go through the SECURITY DEFINER RPCs
 *     append_job_photo() / remove_job_photo() so any org member can
 *     attach/detach photos. All other jobs columns remain admin-only
 *     to update (the broader "jobs: admins can update" policy stands).
 *   - The RPCs verify org membership against the caller's auth.uid()
 *     before touching the row.
 */

const MAX_FILES_PER_REQUEST = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type Ctx = { params: Promise<{ id: string }> };

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "photo";
}

export async function GET(_request: NextRequest, { params }: Ctx) {
  await requireOrgContext();
  const { id } = await params;

  const supabase = await createClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, photos")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[job photos] load failed", error);
    return NextResponse.json({ error: "Failed to load job" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const paths = job.photos ?? [];
  if (paths.length === 0) return NextResponse.json({ photos: [] });

  const { data: signed, error: signErr } = await supabase.storage
    .from("job-photos")
    .createSignedUrls(paths, 60 * 60); // 1 hour
  if (signErr) {
    console.error("[job photos] sign failed", signErr);
    return NextResponse.json({ error: "Failed to sign URLs" }, { status: 500 });
  }

  return NextResponse.json({
    photos: (signed ?? []).map((s) => ({
      path: s.path ?? "",
      url: s.signedUrl,
      error: s.error,
    })),
  });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id: jobId } = await params;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 415 },
    );
  }

  const form = await request.formData();
  const files: File[] = [];
  for (const v of form.getAll("photos")) {
    if (v instanceof File && v.size > 0) files.push(v);
  }
  if (files.length === 0) {
    return NextResponse.json({ error: "No files" }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Max ${MAX_FILES_PER_REQUEST} files per upload` },
      { status: 400 },
    );
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `${f.name} exceeds ${MAX_FILE_BYTES} bytes` },
        { status: 413 },
      );
    }
    if (!ALLOWED_MIME.has(f.type)) {
      return NextResponse.json(
        { error: `Unsupported type for ${f.name}: ${f.type}` },
        { status: 415 },
      );
    }
  }

  // Verify the job exists in the caller's org via the user-context client.
  // RLS will return null if not visible, so this is the org check too.
  const supabase = await createClient();
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, photos")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const uploaded: string[] = [];
  for (const f of files) {
    const path = `${ctx.org.id}/${jobId}/${Date.now()}-${safeFilename(f.name)}`;
    const buf = await f.arrayBuffer();
    const { error: upErr } = await admin.storage
      .from("job-photos")
      .upload(path, buf, { contentType: f.type, upsert: false });
    if (upErr) {
      console.error("[job photos] upload failed", upErr);
      // Roll back already-uploaded ones from this batch so we don't leave
      // orphan files when the batch fails mid-way.
      if (uploaded.length > 0) {
        await admin.storage.from("job-photos").remove(uploaded);
      }
      return NextResponse.json(
        { error: `Upload failed: ${f.name}` },
        { status: 500 },
      );
    }
    uploaded.push(path);
  }

  // Append each uploaded path via the SECURITY DEFINER RPC so any org
  // member (not just admins) can attach. If any append fails, roll back
  // both the storage uploads from this batch AND the prior appends that
  // succeeded in this batch — leaves no orphans and no partial-state
  // photos array.
  const appended: string[] = [];
  for (const path of uploaded) {
    const { error: rpcErr } = await supabase.rpc("append_job_photo", {
      target_job_id: jobId,
      photo_path: path,
    });
    if (rpcErr) {
      console.error("[job photos] append RPC failed", rpcErr);
      // Best-effort rollback of paths already appended in this batch.
      for (const a of appended) {
        await supabase.rpc("remove_job_photo", {
          target_job_id: jobId,
          photo_path: a,
        });
      }
      // Clean every uploaded object from storage.
      await admin.storage.from("job-photos").remove(uploaded);
      const forbidden = rpcErr.code === "42501";
      return NextResponse.json(
        {
          error: forbidden
            ? "Not a member of this org"
            : "Failed to attach photos to job",
        },
        { status: forbidden ? 403 : 500 },
      );
    }
    appended.push(path);
  }

  return NextResponse.json({ uploaded }, { status: 201 });
}
