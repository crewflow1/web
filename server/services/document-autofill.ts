import "server-only";

/**
 * FEATURE 2 — the document-to-form autofill service.
 *
 * The one server-side owner of the import pipeline's side-effects: authorise the
 * operator, store the document in the tenant-scoped private bucket, run the
 * governed extraction, and record a `form_import_drafts` row of PROPOSED values.
 * It NEVER creates a domain record — a draft is only suggestions; the existing
 * create action, run after the operator reviews and edits, is the sole writer of
 * a real record.
 *
 * SECURITY SURFACE, stated plainly:
 *   - AUTH + TENANT: every entry calls requireOrgContext; the draft is written
 *     through the tenant client so its RLS (org + self) is the enforcement, and
 *     the storage object lands under the org's folder (bucket RLS).
 *   - CAPABILITY: the operator must be allowed to CREATE the target record — the
 *     same authorisation the create action enforces, read from the registry.
 *     This is what stops a member who cannot invite staff from extracting a CV.
 *   - FIELD SCOPING: the extraction schema is the allowlist; a staff import can
 *     only ever carry identity fields, never pay or emergency contacts, because
 *     those keys are not in its schema (lib/imports/autofill/schemas.ts).
 *   - FILE VALIDATION: type + size are checked here AND at the bucket.
 *   - NO BLOCKING: a storage or extraction failure degrades to an empty draft;
 *     the operator always reaches the create form.
 */

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { hasCapability, canManageStaff } from "@/server/auth/capabilities";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { autofillFormConfig, type AutofillFormConfig } from "@/lib/imports/autofill/registry";
import { extractForForm } from "@/lib/imports/autofill/extract";
import type { AutofillExtraction, AutofillFormType } from "@/lib/imports/autofill/types";
import {
  AUTOFILL_MAX_BYTES,
  extensionForMime,
  isAllowedAutofillMime,
} from "@/lib/imports/autofill/mime";

const BUCKET = "form-imports";
const DRAFTS = "form_import_drafts";
/** Documents + their drafts are purged after this many days (retention). */
export const AUTOFILL_RETENTION_DAYS = 7;

/** A `form_import_drafts` row is newer than the generated Supabase types, so
 *  queries cast through a narrow structural shape — the expense_drafts idiom. */
type DraftRow = {
  id: string;
  org_id: string;
  form_type: string;
  status: string;
  extracted: Record<string, string> | null;
  line_items: Record<string, string>[] | null;
  overall_confidence: number | null;
  uncertain_fields: string[] | null;
  missing_fields: string[] | null;
  extraction_engine: string | null;
  storage_path: string | null;
  created_by: string;
};

export type ImportStartResult =
  | {
      ok: true;
      draftId: string;
      formType: AutofillFormType;
      /** The proposed values + review metadata, for the review dialog. */
      extraction: AutofillExtraction;
    }
  | { ok: false; error: ImportError };

export type ImportError =
  | "forbidden"
  | "unknown_form"
  | "no_file"
  | "unsupported_file"
  | "file_too_large";

/** Authorise the operator for THIS form's create permission (mirrors the create
 *  action). Returns true when the import may proceed. */
async function authorizeImport(
  config: AutofillFormConfig,
  ctx: Awaited<ReturnType<typeof requireOrgContext>>["ctx"],
  user: Awaited<ReturnType<typeof requireOrgContext>>["user"],
): Promise<boolean> {
  const auth = config.auth;
  switch (auth.mode) {
    case "member":
      // Org membership is enough, and requireOrgContext established it.
      return true;
    case "capability":
      return hasCapability(ctx, user, auth.module, auth.action as never);
    case "orgAdmin":
      // owner/admin only — is_org_admin equivalent (site).
      return ctx.membership.role === "owner" || ctx.membership.role === "admin";
    case "manageStaff":
      return canManageStaff(ctx, user);
    default:
      // Exhaustiveness: an unhandled mode fails CLOSED.
      return false;
  }
}

/**
 * Begin an import: validate, store, extract, draft. Returns a serializable
 * result the client review dialog renders. Never throws for an expected
 * condition (bad file, no permission) — those are returned as `{ ok: false }`.
 */
export async function startDocumentImport(
  formTypeRaw: string,
  file: File | null,
): Promise<ImportStartResult> {
  const config = autofillFormConfig(formTypeRaw);
  if (!config) return { ok: false, error: "unknown_form" };
  const formType = config.type;

  const { ctx, user } = await requireOrgContext();

  if (!(await authorizeImport(config, ctx, user))) {
    return { ok: false, error: "forbidden" };
  }

  if (!file || file.size === 0) return { ok: false, error: "no_file" };
  if (file.size > AUTOFILL_MAX_BYTES) return { ok: false, error: "file_too_large" };
  const mime = file.type || "";
  if (!isAllowedAutofillMime(mime)) return { ok: false, error: "unsupported_file" };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const draftId = crypto.randomUUID();
  // Path: `{org}/{draft}/document.{ext}`. The filename is synthesised, never the
  // user's — a crafted filename can neither traverse the path nor change the org
  // segment the bucket RLS pins on.
  const storagePath = `${ctx.org.id}/${draftId}/document.${extensionForMime(mime)}`;

  // Store the original in the private, tenant-scoped bucket. The admin client is
  // used only because the upload must set the object's content type; the bucket
  // RLS + limits still apply to it. A failure is NON-FATAL: extraction runs from
  // the in-memory bytes regardless, so manual entry is never blocked.
  let storedPath: string | null = storagePath;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (upErr) {
    console.error("[autofill] storage upload failed (continuing)", upErr);
    storedPath = null;
  }

  // The governed extraction. Dark provider / over ceiling / duplicate / parse
  // failure all yield an empty extraction — the operator fills the form by hand.
  const extraction = await extractForForm({
    formType,
    bytes,
    mimeType: mime,
    actor: { orgId: ctx.org.id, userId: user.id },
  });

  // Record the draft through the TENANT client — RLS (org + self) is the
  // enforcement. Only the structured proposed VALUES are stored, never the
  // document's raw text (see the migration's privacy note).
  const supabase = await createClient();
  const { error: insErr } = await (
    supabase.from(DRAFTS as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    id: draftId,
    org_id: ctx.org.id,
    form_type: formType,
    status: "extracted",
    extracted: extraction.fields,
    line_items: extraction.lineItems ?? null,
    overall_confidence: extraction.overallConfidence,
    uncertain_fields: extraction.uncertainFields,
    missing_fields: extraction.missingFields,
    extraction_engine: extraction.engine,
    storage_path: storedPath,
    source_filename: file.name || `document.${extensionForMime(mime)}`,
    source_mime: mime,
    source_bytes: file.size,
    created_by: user.id,
  });
  if (insErr) {
    console.error("[autofill] draft insert failed", insErr);
    // The row is the carrier for prefill; without it there is nothing to carry.
    // Clean up the stored object so we don't leak an orphan, then report.
    if (storedPath) await admin.storage.from(BUCKET).remove([storedPath]).catch(() => {});
    return { ok: false, error: "no_file" };
  }

  // AUDIT the extraction event — WITHOUT the document contents. Only that an
  // extraction happened, for which form, with what engine + confidence. The AI
  // spend itself is in the governor ledger; this is the operator-facing trail.
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "document_import.extracted",
    targetTable: DRAFTS,
    targetId: draftId,
    metadata: {
      form_type: formType,
      engine: extraction.engine,
      confidence: extraction.overallConfidence,
      field_count: Object.keys(extraction.fields).length,
    },
  }).catch((e) => console.error("[autofill] audit failed (non-fatal)", e));

  return { ok: true, draftId, formType, extraction };
}

/**
 * Load a draft's proposed values to PREFILL a create form, scoped to the caller
 * (RLS: org + self). Pure READ — a server component may call it during render.
 * Returns null when the draft is absent, belongs to someone else, or is not for
 * the requested form type.
 */
export async function loadImportDraftDefaults(
  formType: AutofillFormType,
  draftId: string,
): Promise<{
  fields: Record<string, string>;
  lineItems: Record<string, string>[];
  overallConfidence: number;
  engine: string;
} | null> {
  if (!draftId) return null;
  const supabase = await createClient();
  const { data, error } = await (
    supabase.from(DRAFTS as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{ data: DraftRow | null; error: SupabaseReadError | null }>;
            };
          };
        };
      };
    }
  )
    .select("id, form_type, extracted, line_items, overall_confidence, extraction_engine")
    .eq("id", draftId)
    .eq("form_type", formType)
    // Only a live ('extracted') draft prefills a form — a draft the operator
    // DISCARDED must never be re-loadable via `?import=<id>`. (Drafts are not
    // yet marked 'consumed' on save, so 'extracted' is the normal live state;
    // this filter removes exactly the discarded ones.)
    .eq("status", "extracted")
    .maybeSingle();
  if (error) throw readFailure("document-autofill: load draft", error);
  if (!data) return null;
  return {
    fields: (data.extracted ?? {}) as Record<string, string>,
    lineItems: (data.line_items ?? []) as Record<string, string>[],
    overallConfidence: data.overall_confidence ?? 0,
    engine: data.extraction_engine ?? "none",
  };
}

/**
 * Mark a draft discarded (the operator rejected the suggestions). Tenant client
 * → RLS enforces org + self, so a member can only ever discard their OWN draft;
 * a foreign/absent id simply updates no rows. The stored document is left for
 * `purgeExpiredFormImports`, which sweeps discarded rows AND removes their
 * storage objects — so there is no pre-read here (no read whose failure could be
 * silently swallowed), and no immediate service-role storage call.
 */
export async function discardImportDraft(draftId: string): Promise<void> {
  if (!draftId) return;
  const { user } = await requireOrgContext();
  const supabase = await createClient();
  await (
    supabase.from(DRAFTS as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .update({ status: "discarded" })
    .eq("id", draftId)
    .eq("created_by", user.id);
}

/**
 * Retention sweep (service-role) — delete the stored documents and rows that are
 * past the window, and clear consumed/discarded drafts. Not yet wired to the
 * cron fleet (a stated Phase-2 follow-up); exported so a cron or an admin action
 * can call it and so the integration test can exercise it. Returns a small
 * summary for observability.
 */
export async function purgeExpiredFormImports(now: Date = new Date()): Promise<{
  objectsRemoved: number;
  rowsDeleted: number;
}> {
  const admin = createAdminClient();
  const cutoff = new Date(now.getTime() - AUTOFILL_RETENTION_DAYS * 86_400_000).toISOString();

  // Rows to purge: older than the window, OR already consumed/discarded.
  const { data, error } = await (
    admin.from(DRAFTS as never) as unknown as {
      select: (cols: string) => {
        or: (expr: string) => Promise<{ data: Array<{ id: string; storage_path: string | null }> | null; error: { message: string } | null }>;
      };
    }
  )
    .select("id, storage_path")
    .or(`created_at.lt.${cutoff},status.in.(consumed,discarded)`);
  if (error) {
    console.error("[autofill] purge select failed", error);
    return { objectsRemoved: 0, rowsDeleted: 0 };
  }
  const rows = data ?? [];
  if (rows.length === 0) return { objectsRemoved: 0, rowsDeleted: 0 };

  const paths = rows.map((r) => r.storage_path).filter((p): p is string => !!p);
  let objectsRemoved = 0;
  if (paths.length > 0) {
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(paths);
    if (rmErr) console.error("[autofill] purge storage remove failed", rmErr);
    else objectsRemoved = paths.length;
  }

  const ids = rows.map((r) => r.id);
  const { error: delErr } = await (
    admin.from(DRAFTS as never) as unknown as {
      delete: () => { in: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .delete()
    .in("id", ids);
  if (delErr) {
    console.error("[autofill] purge delete failed", delErr);
    return { objectsRemoved, rowsDeleted: 0 };
  }
  return { objectsRemoved, rowsDeleted: ids.length };
}
