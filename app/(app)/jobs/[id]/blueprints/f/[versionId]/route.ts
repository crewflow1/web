import { NextResponse, type NextRequest } from "next/server";
import { getBlueprintVersionUrl } from "@/server/services/blueprints";

/**
 * GET /jobs/[id]/blueprints/f/[versionId] — redirect to a fresh 60s signed URL
 * for a drawing revision. The service RLS-reads the version row first (a
 * cross-org/guessed id yields not_found → 404), then admin-signs the row's own
 * path — so this works as an <img>/<iframe> src AND an <a href download> without
 * exposing a durable link. requireOrgContext (inside the service) gates auth.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const res = await getBlueprintVersionUrl(versionId);
  if (!res.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.redirect(res.data.url, { status: 302 });
}
