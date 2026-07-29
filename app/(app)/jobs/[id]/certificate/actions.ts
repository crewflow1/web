"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { certContentSchema, certIdSchema } from "@/lib/completion-certificates/schema";
import { buildCertificateSnapshot } from "@/lib/completion-certificates/snapshot";
import { resolveJobAddress, formatAddressLines } from "@/lib/address";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Completion certificate lifecycle actions (Phase 7).
 *
 * A completion certificate is a CONTRACTUAL instrument, so every write is
 * owner/admin-only (app-layer check + the tenant client's org-scoped RLS). The
 * DB additionally freezes an issued cert's snapshot + anchors. `completion_certificates`
 * is newer than the generated Supabase types, so queries cast through minimal
 * precise chain shapes — the established house idiom.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`.
 * A Server-Action redirect at this route depth (/jobs/[id]/certificate) loses
 * a race in the Next 15.5 client router: the row is written but the URL never
 * changes and no error surfaces. See components/forms/StateForm.tsx.
 * No revalidatePath, deliberately: this page renders per-request
 * (cookie-authed reads), so the post-success document load is always fresh.
 */

const jobIdSchema = z.string().uuid();

type CertRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  customer_id: string | null;
  certificate_number: string;
  status: string;
  content: Record<string, unknown> | null;
};
type FromChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: CertRow | null }> };
      maybeSingle: () => Promise<{ data: CertRow | null }>;
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
const certs = (supabase: Awaited<ReturnType<typeof createClient>>) =>
  supabase.from("completion_certificates" as never) as unknown as FromChain;

async function requireAdmin() {
  const { ctx, user } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  return { ctx, user, isAdmin };
}

/** Create a DRAFT certificate for a completed job (owner/admin). */
export async function createCertificate(jobId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!jobIdSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");
  if (!isAdmin) return formError("Only an admin can do this.");

  const parsed = certContentSchema.safeParse({
    completion_date: formData.get("completion_date"),
    works_description: formData.get("works_description"),
    defects_liability_months: formData.get("defects_liability_months"),
    retention_note: formData.get("retention_note"),
    handover_notes: formData.get("handover_notes"),
    statement: formData.get("statement"),
    signatory_name: formData.get("signatory_name"),
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the form");
  }

  const supabase = await createClient();
  // Load the job scoped to the ACTIVE org for the customer link; a cert needs a
  // completed job. RLS alone is not enough — it spans every org the caller
  // belongs to, and the certificate below is stamped with ctx.org.id while
  // copying this row's customer_id, so an unscoped read would bind another
  // org's job and customer into this org's certificate.
  const job = await loadJobForOrg<{
    id: string;
    status: string;
    customer_id: string | null;
  }>(supabase, jobId, ctx.org.id, "id, status, customer_id");
  if (!job) return formError("Job not found.");
  if ((job as { status: string }).status !== "completed") {
    return formError("The job must be completed first.");
  }

  const { data: number } = await supabase.rpc("next_certificate_number" as never, { target_org: ctx.org.id } as never);
  if (!number) return formError("Could not allocate a certificate number — try again.");

  const { data: created, error } = await certs(supabase)
    .insert({
      org_id: ctx.org.id,
      job_id: jobId,
      customer_id: (job as { customer_id: string | null }).customer_id,
      certificate_number: number as unknown as string,
      status: "draft",
      completion_date: (parsed.data as { completion_date: string }).completion_date,
      content: parsed.data,
      prepared_by: user.id,
    })
    .select("id")
    .single();
  if (error || !created) {
    console.error("[completion-cert] create failed", error);
    return formError("Something went wrong — try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "completion_certificate.created",
    targetTable: "completion_certificates",
    targetId: created.id,
    metadata: { number, job_id: jobId },
  });
  return formSuccess({ redirectTo: `/jobs/${jobId}/certificate?saved=created` });
}

/** Issue a draft — freeze the customer-safe snapshot (owner/admin). */
export async function issueCertificate(
  jobId: string,
  certId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  const { ctx, user, isAdmin } = await requireAdmin();
  if (!certIdSchema.safeParse(certId).success) return formError("That certificate link looks wrong — reload and try again.");
  if (!isAdmin) return formError("Only an admin can do this.");

  const supabase = await createClient();
  const { data: cert } = await certs(supabase).select("id, status, certificate_number, content, customer_id").eq("id", certId).maybeSingle();
  if (!cert) return formError("Certificate not found.");
  if (cert.status !== "draft") return formError("This certificate has already been issued.");

  const content = certContentSchema.safeParse(cert.content);
  if (!content.success) return formError("Fill in the certificate details first.");

  // Resolve customer-safe context for the frozen snapshot (no internal fields).
  // Active-org scoped: the snapshot is stamped with ctx.org.name as the
  // contractor, so an unscoped read would freeze another org's site address and
  // customer under this org's letterhead.
  const job = await loadJobForOrg<Record<string, unknown>>(
    supabase,
    jobId,
    ctx.org.id,
    "id, site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country, customer:customers ( name, address_line1, address_line2, city, county, postcode, country )",
  );
  const jobCustomer = (job as { customer?: Record<string, unknown> } | null)?.customer ?? null;
  const customerName = (jobCustomer as { name?: string } | null)?.name ?? null;
  const addr = job ? resolveJobAddress(job as never, jobCustomer as never) : null;
  const siteAddress = addr ? formatAddressLines(addr).join(", ") : null;

  const snapshot = buildCertificateSnapshot({
    certificateNumber: cert.certificate_number,
    content: content.data,
    contractorName: ctx.org.name,
    customerName,
    jobReference: jobId.slice(0, 8),
    siteAddress,
    issuedByName: user.email ? user.email.split("@")[0] ?? null : null,
    issuedOn: new Date().toISOString().slice(0, 10),
  });

  const { error, count } = await certs(supabase)
    .update({ status: "issued", snapshot, issued_by: user.id, issued_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", certId)
    .eq("status", "draft");
  if (error || !count) {
    console.error("[completion-cert] issue failed", error);
    return formError("Something went wrong — try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "completion_certificate.issued",
    targetTable: "completion_certificates",
    targetId: certId,
    metadata: { number: cert.certificate_number },
  });
  return formSuccess({ redirectTo: `/jobs/${jobId}/certificate?saved=issued` });
}

async function setPortal(jobId: string, certId: string, publish: boolean): Promise<FormState> {
  const { user, isAdmin } = await requireAdmin();
  if (!certIdSchema.safeParse(certId).success) return formError("That certificate link looks wrong — reload and try again.");
  if (!isAdmin) return formError("Only an admin can do this.");

  const supabase = await createClient();
  const { data: cert } = await certs(supabase).select("id, status, certificate_number").eq("id", certId).maybeSingle();
  if (!cert) return formError("Certificate not found.");
  if (cert.status !== "issued") return formError("The certificate isn't issued.");

  const patch = publish
    ? { portal_published_at: new Date().toISOString(), portal_published_by: user.id, portal_withdrawn_at: null }
    : { portal_withdrawn_at: new Date().toISOString() };
  const { error } = await certs(supabase).update(patch, { count: "exact" }).eq("id", certId).eq("status", "issued");
  if (error) {
    console.error("[completion-cert] portal toggle failed", error);
    return formError("Something went wrong — try again.");
  }
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: publish ? "completion_certificate.published" : "completion_certificate.withdrawn",
    targetTable: "completion_certificates",
    targetId: certId,
    metadata: { number: cert.certificate_number },
  });
  return formSuccess({ redirectTo: `/jobs/${jobId}/certificate?saved=${publish ? "published" : "withdrawn"}` });
}

export async function publishCertificate(
  jobId: string,
  certId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  return setPortal(jobId, certId, true);
}
export async function withdrawCertificate(
  jobId: string,
  certId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  return setPortal(jobId, certId, false);
}
