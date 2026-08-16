"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { generateApiKey } from "@/lib/api-auth/keygen";
import { validateScopes } from "@/lib/api-auth/scopes";
import { orgHasEntitlement } from "@/server/services/entitlements";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * /settings/api-keys server actions (Train 9 substrate).
 *
 *   createApiKey — mints a key, stores ONLY hash + display prefix, and
 *                  returns the plaintext ONCE in the FormState for the
 *                  one-time reveal. The plaintext is never logged and never
 *                  persisted anywhere; after this response it is gone.
 *   revokeApiKey — stamps revoked_at. There is no delete action AT ALL:
 *                  revoke, never erase (audit trail), matching the DB, which
 *                  has no tenant delete policy and no DELETE grant.
 *
 * Both actions run on the USER client so the admin-only RLS policies are the
 * authority; the role check here exists so a non-admin gets a sentence
 * instead of a raw refusal. Errors returned to the form are generic on
 * purpose — raw Postgres text never reaches the user (house rule).
 */

const GENERIC_CREATE_ERROR = "Couldn't create the key. Try again.";

export type ApiKeyFormValues = {
  name?: string;
  /** The one-time plaintext reveal. Present ONLY on the create response. */
  plaintext?: string;
};

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(100),
  expires_in_days: z
    .enum(["never", "30", "90", "365"])
    .default("never"),
});

type InsertChain = {
  insert: (row: {
    org_id: string;
    name: string;
    key_prefix: string;
    key_hash: string;
    scopes: string[];
    created_by: string;
    expires_at: string | null;
  }) => PromiseLike<{ error: { message: string } | null }>;
};

type RevokeChain = {
  update: (row: { revoked_at: string }) => {
    eq: (c: string, v: string) => {
      eq: (c: string, v: string) => {
        is: (c: string, v: null) => {
          select: (cols: string) => PromiseLike<{
            data: Array<{ id: string }> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function createApiKey(
  _prevState: FormState<ApiKeyFormValues>,
  formData: FormData,
): Promise<FormState<ApiKeyFormValues>> {
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return formError("Only owners and admins can create API keys.");
  }

  // Plan entitlement gate (self-serve billing) — EXAMPLE WIRING. While the
  // billing feature is dark, orgHasEntitlement() always returns true, so this
  // is inert in production; once billing is live, 'api_access' is a Pro+ feature.
  if (!(await orgHasEntitlement(ctx.org.id, "api_access"))) {
    return formError(
      "API access isn't included on your current plan. Upgrade in Settings → Billing.",
    );
  }

  const result = validateFormData(formData, createSchema);
  if (!result.ok) return result.state as FormState<ApiKeyFormValues>;

  // Scopes arrive as repeated checkbox values; validated against the
  // build-fact SCOPES registry — an unknown scope string is refused here and
  // can never reach the row.
  const requested = formData
    .getAll("scopes")
    .filter((v): v is string => typeof v === "string");
  const scopeCheck = validateScopes(requested);
  if (!scopeCheck.ok) {
    return formError(
      scopeCheck.invalid.length > 0
        ? "One of the selected scopes is not recognised."
        : "Select at least one scope — a key with no scopes can do nothing.",
      { name: result.data.name },
    );
  }

  const expiresAt =
    result.data.expires_in_days === "never"
      ? null
      : new Date(
          Date.now() + Number(result.data.expires_in_days) * 86_400_000,
        ).toISOString();

  // Mint. The plaintext lives in this function scope and the returned state,
  // and NOWHERE else — not in a log line, not in a DB column, not in a
  // redirect. The row stores the sha256 hash + an 8-char display prefix.
  const key = generateApiKey();

  const supabase = await createClient();
  const { error } = await (
    supabase.from("api_keys" as never) as unknown as InsertChain
  ).insert({
    org_id: ctx.org.id, // org pinning — the ACTIVE org, not "any org I belong to"
    name: result.data.name,
    key_prefix: key.keyPrefix,
    key_hash: key.keyHash,
    scopes: scopeCheck.scopes,
    created_by: user.id,
    expires_at: expiresAt,
  });
  // Deliberately NO .select() readback: key_hash is column-level excluded
  // from the authenticated role, and nothing here needs the row back.
  if (error) {
    console.error("[api-keys] create failed", error.message);
    return formError(GENERIC_CREATE_ERROR, { name: result.data.name });
  }

  revalidatePath("/settings/api-keys");
  return formSuccess<ApiKeyFormValues>({
    successMessage:
      "API key created. Copy it now — you will not see it again.",
    values: { plaintext: key.plaintext },
  });
}

const revokeSchema = z.object({
  key_id: z.string().uuid("Bad key reference"),
});

export async function revokeApiKey(
  _prevState: FormState<ApiKeyFormValues>,
  formData: FormData,
): Promise<FormState<ApiKeyFormValues>> {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return formError("Only owners and admins can revoke API keys.");
  }

  const result = validateFormData(formData, revokeSchema);
  if (!result.ok) return result.state as FormState<ApiKeyFormValues>;

  const supabase = await createClient();
  // org-pinned write: id AND org_id, and only a not-yet-revoked key — the
  // trigger makes revocation final, so re-stamping is refused at the DB too.
  const { data, error } = await (
    supabase.from("api_keys" as never) as unknown as RevokeChain
  )
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", result.data.key_id)
    .eq("org_id", ctx.org.id)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    console.error("[api-keys] revoke failed", error.message);
    return formError("Couldn't revoke the key. Try again.");
  }
  if (!data || data.length === 0) {
    // Loud, not silent: zero rows means "not yours, not found, or already
    // revoked" — never a fake success.
    return formError("That key wasn't found, or it is already revoked.");
  }

  revalidatePath("/settings/api-keys");
  return formSuccess<ApiKeyFormValues>({
    successMessage: "Key revoked. Anything still using it now gets 401.",
  });
}
