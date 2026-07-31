"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { warrantyFormSchema, warrantyIdSchema, warrantyVoidSchema } from "@/lib/warranties/schema";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Job warranty lifecycle actions (Phase 7, migration 20261079).
 *
 * A warranty is a promise the contractor will be held to, so every write is
 * owner/admin-only (app check + the tenant client's org-scoped RLS), and the DB
 * freezes the published terms.
 *
 * ACTIVE-ORG PINNING. Every read that decides anything goes through
 * `loadJobForOrg(..., ctx.org.id, ...)` or carries `.eq("org_id", ctx.org.id)`.
 * RLS alone spans EVERY org the caller belongs to, and these writes stamp
 * `org_id = ctx.org.id`, so an unscoped read would let a member of two orgs bind
 * org B's job into org A's warranty. The DB's composite FK
 * (job_id, org_id) → jobs (id, org_id) refuses that too — this is the second
 * lock, not the only one.
 *
 * NOTHING IS SENT. Publishing a warranty makes it visible in the customer
 * portal. It does not email, text or notify anyone, here or anywhere else in
 * this module; the servicing schedule is computed for display only.
 *
 * `job_warranties` is newer than the generated Supabase types, so queries cast
 * through minimal precise chain shapes — the established house idiom.
 *
 * FormState + `redirectTo` (never `redirect()`): this route sits at
 * /jobs/[id]/warranties, the depth where the Next 15.5 deep-swap commit race
 * silently strands navigations. See components/forms/StateForm.tsx.
 */

const jobIdSchema = z.string().uuid();

type WarrantyRow = {
  id: string;
  org_id: string;
  job_id: string;
  title: string;
  status: string;
  portal_published_at: string | null;
};

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type FromChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<Res<WarrantyRow>>;
      };
    };
  };
  insert: (row: unknown) => {
    select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> };
  };
  update: (patch: unknown, opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
const warranties = (supabase: Awaited<ReturnType<typeof createClient>>) =>
  supabase.from("job_warranties" as never) as unknown as FromChain;

async function requireAdmin() {
  const { ctx, user } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  return { ctx, user, isAdmin };
}

/** Create a warranty against a job (owner/admin). */
export async function createWarranty(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!jobIdSchema.safeParse(jobId).success) {
    return formError("That job link looks wrong — reload and try again.");
  }
  if (!isAdmin) return formError("Only an admin can do this.");

  const parsed = warrantyFormSchema.safeParse({
    title: formData.get("title"),
    kind: formData.get("kind"),
    cover: formData.get("cover"),
    exclusions: formData.get("exclusions"),
    provider: formData.get("provider"),
    reference: formData.get("reference"),
    period_months: formData.get("period_months"),
    service_interval_months: formData.get("service_interval_months"),
    service_notes: formData.get("service_notes"),
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the form");
  }

  const supabase = await createClient();
  // Active-org scoped: the row below is stamped with ctx.org.id, so an unscoped
  // read would bind another org's job into this org's warranty.
  const job = await loadJobForOrg<{ id: string }>(supabase, jobId, ctx.org.id, "id");
  if (!job) return formError("Job not found.");

  const { data: created, error } = await warranties(supabase)
    .insert({
      org_id: ctx.org.id,
      job_id: jobId,
      title: parsed.data.title,
      kind: parsed.data.kind,
      cover: parsed.data.cover,
      exclusions: parsed.data.exclusions ?? null,
      provider: parsed.data.provider ?? null,
      reference: parsed.data.reference ?? null,
      period_months: parsed.data.period_months,
      // Never taken from the form: the only supported basis is the issued
      // completion certificate (20261079 §1).
      start_basis: "completion_certificate",
      service_interval_months: parsed.data.service_interval_months ?? null,
      service_notes: parsed.data.service_notes ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !created) {
    console.error("[warranties] create failed", error);
    return formError("Something went wrong — try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "job_warranty.created",
    targetTable: "job_warranties",
    targetId: created.id,
    metadata: { job_id: jobId, period_months: parsed.data.period_months },
  });
  return formSuccess({ redirectTo: `/jobs/${jobId}/warranties?saved=created` });
}

/** Load a warranty pinned to BOTH the id and the active org. */
async function loadWarranty(
  supabase: Awaited<ReturnType<typeof createClient>>,
  warrantyId: string,
  orgId: string,
) {
  const { data, error } = await warranties(supabase)
    .select("id, org_id, job_id, title, status, portal_published_at")
    .eq("id", warrantyId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("job warranties: warranty", error);
  return data;
}

async function setPortal(jobId: string, warrantyId: string, publish: boolean): Promise<FormState> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!warrantyIdSchema.safeParse(warrantyId).success) {
    return formError("That warranty link looks wrong — reload and try again.");
  }
  if (!isAdmin) return formError("Only an admin can do this.");

  const supabase = await createClient();
  const warranty = await loadWarranty(supabase, warrantyId, ctx.org.id);
  if (!warranty) return formError("Warranty not found.");
  if (warranty.status !== "active") return formError("This warranty has been withdrawn.");

  // First publish stamps the moment; a re-publish only clears the withdrawal, so
  // the DB's frozen portal_published_at is never rewritten.
  const patch = publish
    ? warranty.portal_published_at
      ? { portal_withdrawn_at: null }
      : {
          portal_published_at: new Date().toISOString(),
          portal_published_by: user.id,
          portal_withdrawn_at: null,
        }
    : { portal_withdrawn_at: new Date().toISOString() };

  const { error } = await warranties(supabase)
    .update(patch, { count: "exact" })
    .eq("id", warrantyId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[warranties] portal toggle failed", error);
    return formError("Something went wrong — try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: publish ? "job_warranty.published" : "job_warranty.withdrawn",
    targetTable: "job_warranties",
    targetId: warrantyId,
    metadata: { job_id: jobId, title: warranty.title },
  });
  return formSuccess({
    redirectTo: `/jobs/${jobId}/warranties?saved=${publish ? "published" : "withdrawn"}`,
  });
}

export async function publishWarranty(
  jobId: string,
  warrantyId: string,
  _prev: FormState,
  _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  return setPortal(jobId, warrantyId, true);
}

export async function withdrawWarrantyFromPortal(
  jobId: string,
  warrantyId: string,
  _prev: FormState,
  _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  return setPortal(jobId, warrantyId, false);
}

/**
 * Void a warranty, with a reason. This is the ONLY correction path for a
 * published warranty: the DB refuses to edit its term or its cover once the
 * customer has seen it, so a mistake is voided and reissued and both records
 * survive.
 */
export async function voidWarranty(
  jobId: string,
  warrantyId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!warrantyIdSchema.safeParse(warrantyId).success) {
    return formError("That warranty link looks wrong — reload and try again.");
  }
  if (!isAdmin) return formError("Only an admin can do this.");

  const parsed = warrantyVoidSchema.safeParse({ void_reason: formData.get("void_reason") });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Give a reason for withdrawing this warranty.");
  }

  const supabase = await createClient();
  const warranty = await loadWarranty(supabase, warrantyId, ctx.org.id);
  if (!warranty) return formError("Warranty not found.");
  if (warranty.status === "void") return formError("This warranty has already been withdrawn.");

  const { error } = await warranties(supabase)
    .update(
      {
        status: "void",
        void_reason: parsed.data.void_reason,
        voided_at: new Date().toISOString(),
        voided_by: user.id,
      },
      { count: "exact" },
    )
    .eq("id", warrantyId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[warranties] void failed", error);
    return formError("Something went wrong — try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "job_warranty.voided",
    targetTable: "job_warranties",
    targetId: warrantyId,
    metadata: { job_id: jobId, title: warranty.title },
  });
  return formSuccess({ redirectTo: `/jobs/${jobId}/warranties?saved=voided` });
}
