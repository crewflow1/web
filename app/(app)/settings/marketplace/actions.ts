"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { isMarketplaceEnabled } from "@/lib/marketplace/flag";
import {
  LISTING_CATEGORIES,
  isValidSlug,
  validateRequestedScopes,
} from "@/lib/marketplace/registry";
import { validateWebhookEvents } from "@/lib/webhooks/events";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * /settings/marketplace developer-console server actions (Phase 14).
 *
 * The DEVELOPER surface: create the org's partner identity, create + submit
 * listings. All actions run on the USER client so the admin-only RLS on
 * marketplace_partners / marketplace_listings is the authority; the role check
 * gives a sentence instead of a raw refusal. Submission to review goes through
 * the marketplace_submit_listing RPC (draft → pending_review; a tenant can
 * never reach 'approved' — that is the service-role review gate).
 *
 * DARK: every action refuses while FEATURE_MARKETPLACE is off.
 */

const FEATURE_OFF = "The marketplace isn't available yet.";
const NOT_ADMIN = "Only owners and admins can manage marketplace listings.";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

// ── Partner ───────────────────────────────────────────────────────────────────
export type PartnerFormValues = { name?: string; slug?: string; contact_email?: string; website_url?: string };

const partnerSchema = z.object({
  name: z.string().trim().min(1, "Give your developer profile a name").max(120),
  slug: z.string().trim().min(3, "Slug is too short").max(63),
  contact_email: z.string().trim().email("Enter a valid email").max(200).optional().or(z.literal("")),
  website_url: z.string().trim().url("Enter a valid https URL").max(300).optional().or(z.literal("")),
});

type PartnerInsert = {
  insert: (row: {
    org_id: string;
    name: string;
    slug: string;
    contact_email: string | null;
    website_url: string | null;
    created_by: string;
  }) => PromiseLike<{ error: { message: string } | null }>;
};

export async function createPartner(
  _prev: FormState<PartnerFormValues>,
  formData: FormData,
): Promise<FormState<PartnerFormValues>> {
  if (!isMarketplaceEnabled()) return formError(FEATURE_OFF);
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return formError(NOT_ADMIN);

  const result = validateFormData(formData, partnerSchema);
  if (!result.ok) return result.state as FormState<PartnerFormValues>;

  if (!isValidSlug(result.data.slug)) {
    return formError("Slug must be lowercase letters, numbers and single hyphens.", {
      name: result.data.name,
      slug: result.data.slug,
    });
  }

  const website = result.data.website_url?.trim() || "";
  if (website && !website.startsWith("https://")) {
    return formError("Website must be an https URL.", { name: result.data.name, slug: result.data.slug });
  }

  const supabase = await createClient();
  const { error } = await (
    supabase.from("marketplace_partners" as never) as unknown as PartnerInsert
  ).insert({
    org_id: ctx.org.id, // active-org pin
    name: result.data.name,
    slug: result.data.slug,
    contact_email: result.data.contact_email?.trim() || null,
    website_url: website || null,
    created_by: user.id,
  });
  if (error) {
    console.error("[marketplace] partner create failed", error.message);
    return formError(
      /duplicate|unique/i.test(error.message)
        ? "That slug is taken. Pick another."
        : "Couldn't create the developer profile. Try again.",
      { name: result.data.name, slug: result.data.slug },
    );
  }

  revalidatePath("/settings/marketplace");
  return formSuccess<PartnerFormValues>({ successMessage: "Developer profile created." });
}

// ── Listing ────────────────────────────────────────────────────────────────────
export type ListingFormValues = {
  partner_id?: string;
  name?: string;
  slug?: string;
  short_description?: string;
  category?: string;
};

const listingSchema = z.object({
  partner_id: z.string().uuid("Pick a developer profile"),
  name: z.string().trim().min(1, "Name the app").max(120),
  slug: z.string().trim().min(3).max(63),
  short_description: z.string().trim().min(1, "Add a short description").max(200),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  category: z.enum(LISTING_CATEGORIES),
  webhook_url: z.string().trim().url("Enter a valid https URL").max(300).optional().or(z.literal("")),
});

type ListingInsert = {
  insert: (row: {
    partner_id: string;
    name: string;
    slug: string;
    short_description: string;
    description: string | null;
    category: string;
    requested_scopes: string[];
    webhook_url: string | null;
    webhook_events: string[];
    created_by: string;
  }) => PromiseLike<{ error: { message: string } | null }>;
};

export async function createListing(
  _prev: FormState<ListingFormValues>,
  formData: FormData,
): Promise<FormState<ListingFormValues>> {
  if (!isMarketplaceEnabled()) return formError(FEATURE_OFF);
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return formError(NOT_ADMIN);

  const result = validateFormData(formData, listingSchema);
  if (!result.ok) return result.state as FormState<ListingFormValues>;
  const echo: Partial<ListingFormValues> = {
    partner_id: result.data.partner_id,
    name: result.data.name,
    slug: result.data.slug,
    short_description: result.data.short_description,
    category: result.data.category,
  };

  if (!isValidSlug(result.data.slug)) {
    return formError("Slug must be lowercase letters, numbers and single hyphens.", echo);
  }

  // Requested scopes — validated against the PUBLIC-API vocabulary (no new scope).
  const requestedScopes = formData.getAll("scopes").filter((v): v is string => typeof v === "string");
  const scopeCheck = validateRequestedScopes(requestedScopes);
  if (!scopeCheck.ok) {
    return formError(
      scopeCheck.invalid.length > 0
        ? "One of the requested scopes isn't recognised."
        : "Request at least one scope — an app with no scopes can't do anything.",
      echo,
    );
  }

  // Optional webhook: a URL requires at least one valid event, and vice-versa.
  const webhookUrl = result.data.webhook_url?.trim() || "";
  const requestedEvents = formData.getAll("events").filter((v): v is string => typeof v === "string");
  let webhookEvents: string[] = [];
  if (webhookUrl) {
    if (!webhookUrl.startsWith("https://")) return formError("Webhook URL must be https.", echo);
    const evCheck = validateWebhookEvents(requestedEvents);
    if (!evCheck.ok) {
      return formError("Pick at least one recognised webhook event for the webhook URL.", echo);
    }
    webhookEvents = evCheck.events;
  } else if (requestedEvents.length > 0) {
    return formError("Add a webhook URL to subscribe to events.", echo);
  }

  const supabase = await createClient();
  const { error } = await (
    supabase.from("marketplace_listings" as never) as unknown as ListingInsert
  ).insert({
    partner_id: result.data.partner_id,
    name: result.data.name,
    slug: result.data.slug,
    short_description: result.data.short_description,
    description: result.data.description?.trim() || null,
    category: result.data.category,
    requested_scopes: scopeCheck.scopes,
    webhook_url: webhookUrl || null,
    webhook_events: webhookEvents,
    created_by: user.id,
    // status defaults to 'draft'.
  });
  if (error) {
    console.error("[marketplace] listing create failed", error.message);
    return formError(
      /duplicate|unique/i.test(error.message)
        ? "That listing slug is taken. Pick another."
        : "Couldn't create the listing. Try again.",
      echo,
    );
  }

  revalidatePath("/settings/marketplace");
  return formSuccess<ListingFormValues>({
    successMessage: "Listing created as a draft. Submit it for review when you're ready.",
  });
}

// ── Submit for review ──────────────────────────────────────────────────────────
const submitSchema = z.object({ listing_id: z.string().uuid("Bad listing reference") });

type SubmitRpc = (
  fn: "marketplace_submit_listing",
  args: { p_listing_id: string; p_org_id: string },
) => Promise<{ data: boolean | null; error: { message: string } | null }>;

export async function submitListing(
  _prev: FormState<Record<string, never>>,
  formData: FormData,
): Promise<FormState<Record<string, never>>> {
  if (!isMarketplaceEnabled()) return formError(FEATURE_OFF);
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return formError(NOT_ADMIN);

  const result = validateFormData(formData, submitSchema);
  if (!result.ok) return result.state as FormState<Record<string, never>>;

  // Admin proven above; the RPC re-checks admin-of-owner-org and draft status.
  const admin = createAdminClient();
  const { data, error } = await (admin.rpc.bind(admin) as unknown as SubmitRpc)(
    "marketplace_submit_listing",
    { p_listing_id: result.data.listing_id, p_org_id: ctx.org.id },
  );
  if (error) {
    console.error("[marketplace] submit failed", error.message);
    return formError("Couldn't submit the listing. Try again.");
  }
  if (!data) {
    return formError("That listing can't be submitted (not yours, or not a draft).");
  }

  revalidatePath("/settings/marketplace");
  return formSuccess<Record<string, never>>({
    successMessage: "Submitted for review. You'll see the outcome in your activity feed.",
  });
}
