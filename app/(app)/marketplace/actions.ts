"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { generateApiKey } from "@/lib/api-auth/keygen";
import { generateWebhookSecret } from "@/lib/webhooks/secret";
import { isMarketplaceEnabled } from "@/lib/marketplace/flag";
import { validateInstallConsent } from "@/lib/marketplace/registry";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * /marketplace tenant install/uninstall server actions (Phase 14).
 *
 * INSTALL is a consent event: the tenant admin consents to EXACTLY the scopes
 * the listing requests, and the install atomically mints an install-bound API
 * key (returned once), records entitlements, and — if the listing declares a
 * webhook — creates an org endpoint bound to the install. The plaintext key is
 * generated here (keygen) and shown ONCE, exactly like /settings/api-keys.
 *
 * The consent + review gates are enforced twice: once here (validateInstallConsent
 * against the listing the tenant is looking at) and again, authoritatively,
 * inside marketplace_install_with_consent (which reads requested_scopes from the
 * listing row, so the client can never lie about what was requested).
 *
 * DARK: refuses while FEATURE_MARKETPLACE is off.
 */

const FEATURE_OFF = "The marketplace isn't available yet.";
const NOT_ADMIN = "Only owners and admins can install or remove apps.";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export type InstallFormValues = {
  listing_id?: string;
  /** The one-time plaintext key reveal — present ONLY on a successful install. */
  plaintext?: string;
};

const installSchema = z.object({
  listing_id: z.string().uuid("Bad app reference"),
  // Explicit consent checkbox — the form cannot submit without it ticked.
  consent: z.literal("on", { errorMap: () => ({ message: "You must consent to the requested access." }) }),
});

type ListingRead = {
  select: (cols: string) => {
    eq: (c: string, v: string) => {
      maybeSingle: () => Promise<{
        data: { id: string; name: string; status: string; requested_scopes: string[] | null; webhook_url: string | null } | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

type InstallRpc = (
  fn: "marketplace_install_with_consent",
  args: {
    p_org_id: string;
    p_listing_id: string;
    p_consented_scopes: string[];
    p_key_name: string;
    p_key_prefix: string;
    p_key_hash: string;
    p_created_by: string;
    p_config: Record<string, unknown>;
    p_webhook_secret: string | null;
  },
) => Promise<{ data: { ok?: boolean; error?: string } | null; error: { message: string } | null }>;

export async function installApp(
  _prev: FormState<InstallFormValues>,
  formData: FormData,
): Promise<FormState<InstallFormValues>> {
  if (!isMarketplaceEnabled()) return formError(FEATURE_OFF);
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return formError(NOT_ADMIN);

  const result = validateFormData(formData, installSchema);
  if (!result.ok) return result.state as FormState<InstallFormValues>;
  const echo = { listing_id: result.data.listing_id };

  // Read the listing the tenant is consenting to (RLS admits approved listings).
  const supabase = await createClient();
  const { data: listing, error: listErr } = await (
    supabase.from("marketplace_listings" as never) as unknown as ListingRead
  )
    .select("id, name, status, requested_scopes, webhook_url")
    .eq("id", result.data.listing_id)
    .maybeSingle();
  if (listErr) {
    console.error("[marketplace] listing read failed", listErr.message);
    return formError("Couldn't load that app. Try again.", echo);
  }
  if (!listing) return formError("That app isn't available.", echo);

  const requested = listing.requested_scopes ?? [];
  // The tenant consents to EXACTLY the requested scopes (the consent contract).
  const consent = validateInstallConsent(listing.status, requested, requested);
  if (!consent.ok) {
    return formError(
      consent.reason === "not_installable"
        ? "That app isn't approved for install yet."
        : "This app's requested access has changed. Reload and try again.",
      echo,
    );
  }

  // Mint the install-bound key (plaintext shown once). Webhook secret only if
  // the listing declares a webhook URL.
  const key = generateApiKey();
  const webhookSecret = listing.webhook_url ? generateWebhookSecret() : null;

  const admin = createAdminClient();
  const { data, error } = await (admin.rpc.bind(admin) as unknown as InstallRpc)(
    "marketplace_install_with_consent",
    {
      p_org_id: ctx.org.id, // active-org pin
      p_listing_id: listing.id,
      p_consented_scopes: consent.scopes,
      p_key_name: `Marketplace: ${listing.name}`.slice(0, 100),
      p_key_prefix: key.keyPrefix,
      p_key_hash: key.keyHash,
      p_created_by: user.id,
      p_config: {},
      p_webhook_secret: webhookSecret,
    },
  );
  if (error) {
    console.error("[marketplace] install rpc failed", error.message);
    return formError("Couldn't install the app. Try again.", echo);
  }
  if (!data?.ok) {
    const reason = data?.error;
    const message =
      reason === "already_installed"
        ? "This app is already installed."
        : reason === "not_installable"
          ? "That app isn't approved for install yet."
          : reason === "scope_mismatch"
            ? "This app's requested access has changed. Reload and try again."
            : "Couldn't install the app. Try again.";
    return formError(message, echo);
  }

  revalidatePath("/marketplace");
  return formSuccess<InstallFormValues>({
    successMessage:
      "App installed. Copy its API key now — you won't see it again. The app authenticates with this key on the CrewFlow API.",
    values: { plaintext: key.plaintext },
  });
}

// ── Uninstall ───────────────────────────────────────────────────────────────
const uninstallSchema = z.object({ install_id: z.string().uuid("Bad install reference") });

type UninstallRpc = (
  fn: "marketplace_uninstall",
  args: { p_org_id: string; p_install_id: string },
) => Promise<{ data: { ok?: boolean; error?: string } | null; error: { message: string } | null }>;

export async function uninstallApp(
  _prev: FormState<Record<string, never>>,
  formData: FormData,
): Promise<FormState<Record<string, never>>> {
  if (!isMarketplaceEnabled()) return formError(FEATURE_OFF);
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return formError(NOT_ADMIN);

  const result = validateFormData(formData, uninstallSchema);
  if (!result.ok) return result.state as FormState<Record<string, never>>;

  // Admin proven above; the RPC is org-pinned to ctx.org.id and revokes the
  // entitlement rows + the install-bound key + pauses the webhook endpoint.
  const admin = createAdminClient();
  const { data, error } = await (admin.rpc.bind(admin) as unknown as UninstallRpc)(
    "marketplace_uninstall",
    { p_org_id: ctx.org.id, p_install_id: result.data.install_id },
  );
  if (error) {
    console.error("[marketplace] uninstall rpc failed", error.message);
    return formError("Couldn't remove the app. Try again.");
  }
  if (!data?.ok) {
    return formError("That app isn't installed, or was already removed.");
  }

  revalidatePath("/marketplace");
  return formSuccess<Record<string, never>>({
    successMessage: "App removed. Its API key is revoked and its access is gone.",
  });
}
