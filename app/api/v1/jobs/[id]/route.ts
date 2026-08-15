import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadJobForOrg } from "@/lib/jobs/load";
import { verifyCustomerInOrg } from "@/lib/crm/reference-integrity";
import {
  guardPublicJobsRequest,
  guardPublicApiRequest,
} from "@/lib/public-api/guard";
import {
  JOB_DTO_SELECT,
  toPublicJobDto,
  type JobRowForDto,
} from "@/lib/public-api/jobs";
import { updateJobSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  okData,
  writeError,
  pickDefined,
} from "@/lib/public-api/write";

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

const idSchema = z.string().uuid();

/** The exact columns a PATCH may touch — the write allowlist (no org_id/id). */
const JOB_UPDATE_COLUMNS = [
  "status",
  "scheduled_date",
  "customer_id",
  "notes",
  "site_address_line1",
  "site_address_line2",
  "site_city",
  "site_county",
  "site_postcode",
  "site_country",
] as const;

/** Minimal typed surface for the org-pinned update + allowlisted readback. */
type JobUpdateWrite = {
  update: (row: Record<string, unknown>) => {
    eq: (
      c: string,
      v: string,
    ) => {
      eq: (
        c: string,
        v: string,
      ) => {
        select: (cols: string) => {
          maybeSingle: () => Promise<{
            data: JobRowForDto | null;
            error: { message?: string | null } | null;
          }>;
        };
      };
    };
  };
};

/**
 * PATCH /api/v1/jobs/[id] — update a job in the KEY'S org.
 *
 * Requires the DISTINCT `write:jobs` scope. Org-pinned on BOTH the read-back
 * predicate AND the write predicate (`.eq("id").eq("org_id", key.orgId)`), so a
 * forged id from another tenant updates ZERO rows and 404s — no cross-org
 * oracle, no cross-org write. Carries ONLY the fields the caller sent (true
 * PATCH), from a strict allowlisted set; an optional customer_id is verified
 * in-org first.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:jobs");
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return notFound();

  const body = await parseJsonBody(request, updateJobSchema);
  if (!body.ok) return body.response;

  const admin = createAdminClient();

  if (body.value.customer_id) {
    const ref = await verifyCustomerInOrg(
      admin as never,
      body.value.customer_id,
      guard.key.orgId,
    );
    if (!ref.ok) return writeError(422, "invalid_reference", ref.message);
  }

  const patch = pickDefined(
    body.value as Record<string, unknown>,
    JOB_UPDATE_COLUMNS,
  );

  const { data, error } = await (
    admin.from("jobs") as unknown as JobUpdateWrite
  )
    .update(patch)
    // ORG-PINNED WRITE: id AND the key's org — a foreign id updates 0 rows.
    .eq("id", id)
    .eq("org_id", guard.key.orgId)
    .select(JOB_DTO_SELECT)
    .maybeSingle();

  if (error) {
    console.error("[public-api] job update failed", error.message);
    return writeError(500, "write_failed", "Couldn't update the job.");
  }
  if (!data) return notFound();

  return okData(toPublicJobDto(data));
}
