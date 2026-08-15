"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadSiteForOrg, type SitesClient } from "@/server/services/sites";
import { storeSignatureImage, deleteSignatureImage } from "@/server/services/signature-capture";
import { hashIp, getIpFromHeaders } from "@/lib/security/ip-hash";
import { inductionStatement, INDUCTION_STATEMENT_VERSION } from "@/lib/site-compliance/inductions";
import {
  recordInductionSchema,
  visitorSignInSchema,
  visitorIdSchema,
  siteIdSchema,
  friendlyComplianceError,
} from "@/lib/site-compliance/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * Site-compliance mutations. Tenant (user-JWT) client only → RLS scopes every
 * write; the DB triggers derive org_id from the site (spoof-proof), enforce
 * membership, append-only inductions, and immutable visitor identity.
 *
 * ACTIVE-ORG PINNING: RLS (`is_org_member(org_id)`) passes for EVERY org the
 * caller belongs to, so it does not express "the company I am working in". The
 * site is therefore re-read pinned to `ctx.org.id` before every write, and
 * by-id visitor writes carry `.eq("org_id", ctx.org.id)` and are COUNT-GATED —
 * a row in the caller's other org matches zero rows and is reported identically
 * to one that does not exist.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };
const base = "/site-compliance";

type CV = Record<string, unknown>;

// ── Record a site induction ───────────────────────────────────────────────
export async function recordInduction(
  _prev: FormState<CV>,
  formData: FormData,
): Promise<FormState<CV>> {
  const { user, ctx } = await requireOrgContext();
  const result = validateFormData(formData, recordInductionSchema);
  if (!result.ok) return result.state as FormState<CV>;
  const v = result.data;

  // The site must be in the ACTIVE org — this both scopes the write and gives us
  // the site name for the attestation statement.
  const supabase = await createClient();
  const site = await loadSiteForOrg<{ id: string; name: string }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    v.siteId,
    "id, name",
  );
  if (!site) return formError("That site isn't in this organisation.", result.data as CV);

  // Provenance — captured server-side so the client can't spoof/backdate it.
  const h = await headers();
  const ipHash = hashIp(getIpFromHeaders(h));
  const userAgent = h.get("user-agent");

  // Optional drawn signature: store the PNG first so we can reference its path on
  // the (append-only) induction row. Best-effort — a storage failure never blocks
  // the induction; the typed name still records. subjectId is the row id we mint.
  const inductionId = randomUUID();
  const drawn = v.signatureDataUrl
    ? await storeSignatureImage({
        orgId: ctx.org.id,
        scope: "site_inductions",
        subjectId: inductionId,
        dataUrl: v.signatureDataUrl,
      })
    : null;

  const { error } = await (supabase as unknown as FromChain).from("site_inductions").insert({
    id: inductionId,
    // org_id is authoritatively re-derived from the site by the DB trigger.
    org_id: ctx.org.id,
    site_id: v.siteId,
    user_id: v.userId ?? null,
    person_name: v.personName ?? null,
    person_company: v.personCompany ?? null,
    induction_version: v.inductionVersion,
    valid_until: v.validUntil ? new Date(`${v.validUntil}T23:59:59Z`).toISOString() : null,
    statement: inductionStatement(site.name),
    statement_version: INDUCTION_STATEMENT_VERSION,
    signed_name: v.signedName,
    ip_hash: ipHash,
    user_agent: userAgent,
    signature_image_bucket: drawn?.bucket ?? null,
    signature_image_path: drawn?.path ?? null,
    created_by: user.id,
  });

  // 23505 = this worker already inducted on this version → idempotent success;
  // the just-uploaded image is an orphan (the original stands) — clean it up.
  if (error && (error as { code?: string }).code === "23505") {
    await deleteSignatureImage(drawn);
  } else if (error) {
    await deleteSignatureImage(drawn);
    return formError(
      friendlyComplianceError((error as { code?: string }).code, error.message),
      result.data as CV,
    );
  }

  revalidatePath(`${base}/${v.siteId}`);
  return formSuccess({
    successMessage: "Induction recorded.",
    redirectTo: `${base}/${v.siteId}?saved=inducted`,
  });
}

// ── Sign a visitor in ─────────────────────────────────────────────────────
export async function signInVisitor(
  _prev: FormState<CV>,
  formData: FormData,
): Promise<FormState<CV>> {
  const { user, ctx } = await requireOrgContext();
  const result = validateFormData(formData, visitorSignInSchema);
  if (!result.ok) return result.state as FormState<CV>;
  const v = result.data;

  const supabase = await createClient();
  const site = await loadSiteForOrg<{ id: string }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    v.siteId,
    "id",
  );
  if (!site) return formError("That site isn't in this organisation.", result.data as CV);

  const { error } = await (supabase as unknown as FromChain).from("site_visitors").insert({
    // org_id re-derived from the site by the DB trigger.
    org_id: ctx.org.id,
    site_id: v.siteId,
    visitor_name: v.visitorName,
    company: v.company ?? null,
    purpose: v.purpose ?? null,
    host_user_id: v.hostUserId ?? null,
    vehicle_registration: v.vehicleRegistration ?? null,
    signed_in_by: user.id,
  });
  if (error) {
    return formError(
      friendlyComplianceError((error as { code?: string }).code, error.message),
      result.data as CV,
    );
  }

  revalidatePath(`${base}/${v.siteId}`);
  return formSuccess({
    successMessage: "Visitor signed in.",
    redirectTo: `${base}/${v.siteId}?saved=signed_in`,
  });
}

// ── Sign a visitor out ─────────────────────────────────────────────────────
// Returns FormState (navigated by the client via window.location.assign), NOT a
// redirect() — a same-route `?saved=` redirect() on this [siteId] page loses the
// Next 15.5 deep-swap commit race 100% of the time (StateForm's header).
export async function signOutVisitor(
  _prev: FormState<CV>,
  formData: FormData,
): Promise<FormState<CV>> {
  const { user, ctx } = await requireOrgContext();
  const visitorId = String(formData.get("visitorId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  if (!visitorIdSchema.safeParse(visitorId).success || !siteIdSchema.safeParse(siteId).success) {
    return formError("Invalid visitor.");
  }

  const supabase = await createClient();
  const { error, count } = await (supabase as unknown as FromChain)
    .from("site_visitors")
    .update(
      { signed_out_at: new Date().toISOString(), signed_out_by: user.id },
      { count: "exact" },
    )
    .eq("id", visitorId)
    // ACTIVE-ORG SCOPE — is_org_member passes for every org the caller belongs
    // to; without this pin a sign-out issued while working in company A could
    // land on company B's visitor row.
    .eq("org_id", ctx.org.id)
    // Only an on-site visitor can be signed out; a second click is a no-op.
    .is("signed_out_at", null);

  if (error) {
    console.error("[site-compliance] sign-out failed", error);
    return formError(friendlyComplianceError((error as { code?: string }).code, error.message));
  }
  // Count-gated: a refusal (wrong org / already out) returns no error and zero
  // rows — report it as a no-op rather than a false success.
  if (!count) return formError("That visitor is not on site.");

  revalidatePath(`${base}/${siteId}`);
  return formSuccess({ successMessage: "Visitor signed out.", redirectTo: `${base}/${siteId}?saved=signed_out` });
}
