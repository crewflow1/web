import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadJobForOrg } from "@/lib/jobs/load";
import { guardPublicJobsRequest } from "@/lib/public-api/guard";
import {
  JOB_DTO_SELECT,
  toPublicJobDto,
  type JobRowForDto,
} from "@/lib/public-api/jobs";

/**
 * GET /api/v1/jobs/[id] — public, key-authenticated single-job READ (Train K).
 *
 * Same gate as the list route (flag → 404 dark, auth → 401, read:jobs → 403,
 * rate limit → 429) and the same explicit public DTO.
 *
 * NO CROSS-ORG ORACLE: the read goes through loadJobForOrg, which pins BOTH the
 * id AND key.orgId, so a job that exists in a DIFFERENT org is INDISTINGUISH-
 * ABLE from one that does not exist — both return 404, never a 403 that would
 * confirm the id is real. A guessed id from another tenant reveals nothing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicJobsRequest(request);
  if (!guard.ok) return guard.response;

  const { id } = await context.params;

  const admin = createAdminClient();
  // Org-pinned by-id load — service-role read scoped to the KEY'S org. null on
  // missing OR other-org (deliberately indistinguishable) ⇒ 404, no oracle.
  const row = await loadJobForOrg<JobRowForDto>(
    admin,
    id,
    guard.key.orgId,
    JOB_DTO_SELECT,
  );
  if (!row) return notFound();

  return NextResponse.json({ data: toPublicJobDto(row) });
}
