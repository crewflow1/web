"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { mintWorkerToken } from "@/lib/health-safety/worker-token";
import {
  issueWorkerLinkSchema,
  revokeWorkerLinkSchema,
} from "@/lib/health-safety/worker-signoff-schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import { abs } from "@/lib/seo/site";

/**
 * Staff surface for external-worker sign-off links. Tenant (user-JWT) client
 * only → RLS scopes every write. ACTIVE-ORG PINNING: RLS `is_org_member` passes
 * for EVERY org the caller belongs to, so the job is re-read pinned to
 * `ctx.org.id` before issuing, and the revoke is `.eq("org_id", ctx.org.id)`
 * count-gated — a link in the caller's other org matches zero rows and is
 * reported identically to one that does not exist.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };
const BASE = "/health-safety/worker-links";

type CV = Record<string, unknown>;

// ── Issue a worker link ────────────────────────────────────────────────────
// Returns the plaintext token ONCE in the success state (never navigates away,
// never stored in the clear, never placed in a URL) so staff can copy it. Only
// the SHA-256 hash is persisted.
export async function issueWorkerLink(
  _prev: FormState<CV>,
  formData: FormData,
): Promise<FormState<CV>> {
  const { user, ctx } = await requireOrgContext();
  const result = validateFormData(formData, issueWorkerLinkSchema);
  if (!result.ok) return result.state as FormState<CV>;
  const v = result.data;

  const supabase = await createClient();

  // The job must be in the ACTIVE org — this scopes the write and proves the
  // job exists before we mint a link that would otherwise be unreachable.
  const { data: job, error: jobErr } = await (supabase as unknown as FromChain)
    .from("jobs")
    .select("id")
    .eq("id", v.jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobErr) return formError("Couldn't check that job. Try again.", result.data as CV);
  if (!job) return formError("That job isn't in this organisation.", result.data as CV);

  const { token, tokenHash } = mintWorkerToken();
  const expiresAt = new Date(Date.now() + v.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await (supabase as unknown as FromChain).from("worker_signoff_tokens").insert({
    org_id: ctx.org.id,
    job_id: v.jobId,
    token_hash: tokenHash,
    worker_name: v.workerName,
    worker_company: v.workerCompany ?? null,
    expires_at: expiresAt,
    created_by: user.id,
  });
  if (error) {
    return formError((error as { message?: string }).message ?? "Couldn't create the link.", result.data as CV);
  }

  revalidatePath(BASE);
  return formSuccess<CV>({
    successMessage: "Link created. Copy it now — it won't be shown again.",
    values: {
      issuedUrl: abs(`/worker-portal/${token}`),
      workerName: v.workerName,
      expiresAt,
    },
  });
}

// ── Revoke a worker link ───────────────────────────────────────────────────
export async function revokeWorkerLink(
  _prev: FormState<CV>,
  formData: FormData,
): Promise<FormState<CV>> {
  const { user, ctx } = await requireOrgContext();
  const parsed = revokeWorkerLinkSchema.safeParse({ tokenId: formData.get("tokenId") });
  if (!parsed.success) return formError("Invalid link.");

  const supabase = await createClient();
  const { error, count } = await (supabase as unknown as FromChain)
    .from("worker_signoff_tokens")
    .update(
      { revoked_at: new Date().toISOString(), revoked_by: user.id },
      { count: "exact" },
    )
    .eq("id", parsed.data.tokenId)
    // ACTIVE-ORG SCOPE — is_org_admin passes for every org the caller admins;
    // without this pin a revoke issued while working in company A could land on
    // company B's link row.
    .eq("org_id", ctx.org.id)
    // Only a live link can be revoked; a second click is a no-op.
    .is("revoked_at", null);

  if (error) return formError((error as { message?: string }).message ?? "Couldn't revoke that link.");
  // Count-gated: a refusal (wrong org / already revoked) returns no error and
  // zero rows — report it as a no-op rather than a false success.
  if (!count) return formError("That link is already revoked or not in this organisation.");

  revalidatePath(BASE);
  return formSuccess({ successMessage: "Link revoked.", redirectTo: `${BASE}?saved=revoked` });
}
