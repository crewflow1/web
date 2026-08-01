"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { generateWebhookSecret } from "@/lib/webhooks/secret";
import { validateWebhookEvents } from "@/lib/webhooks/events";
import { validateWebhookUrl } from "@/lib/webhooks/ssrf";
import { outboundWebhooksEnabled } from "@/lib/webhooks/flags";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * /settings/webhooks server actions (Train A).
 *
 *   createWebhookEndpoint — validates the URL (SSRF policy) + subscribed verbs,
 *     mints the signing secret SERVER-SIDE, stores it, and returns the plaintext
 *     secret ONCE for a one-time reveal. Enqueues a signed verification ping; the
 *     endpoint stays paused until that ping is acknowledged.
 *   pause / resume / reping / delete — lifecycle. All authorise through the
 *     admin-only RLS on webhook_endpoints (the user client is the authority); the
 *     role check here just turns a raw refusal into a sentence.
 *
 * The secret exists in the create response and NOWHERE else — never logged, never
 * read back (column-level excluded from the tenant grant). Errors are generic on
 * purpose; raw Postgres text never reaches the user (house rule).
 */

const SSRF_MESSAGES: Record<string, string> = {
  "not-https": "The URL must start with https://",
  "ip-literal": "Use a domain name, not an IP address.",
  "no-dot-host": "That doesn't look like a public domain.",
  "internal-tld": "Internal addresses (.local/.internal) can't receive webhooks.",
  "platform-host": "You can't send webhooks to a CrewFlow address.",
  "private-host": "That host is on a private network and can't be reached.",
  "invalid-url": "That isn't a valid URL.",
};

export type WebhookFormValues = {
  url?: string;
  description?: string;
  /** The one-time secret reveal — present ONLY on the create response. */
  secret?: string;
};

const createSchema = z.object({
  url: z.string().trim().min(1, "Enter the endpoint URL").max(2000),
  description: z.string().trim().max(200).optional(),
});

/** The write path is dark too: with the flag off, no action creates or mutates a
 *  row — a direct POST while dark is refused before any DB work. */
const FEATURE_OFF = "Webhooks aren't enabled for your account yet.";

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

type InsertChain = {
  insert: (row: Record<string, unknown>) => {
    select: (cols: string) => { single: () => PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> };
  };
};
type MutChain = {
  update: (row: Record<string, unknown>) => {
    eq: (c: string, v: string) => { eq: (c: string, v: string) => { select: (cols: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }> } };
  };
  delete: () => { eq: (c: string, v: string) => { eq: (c: string, v: string) => PromiseLike<{ error: { message: string } | null }> } };
  select: (cols: string) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: { id: string; verified_at: string | null } | null; error: { message: string } | null }> } } };
};
type PingRpc = (fn: "webhook_enqueue_ping", args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;

export async function createWebhookEndpoint(
  _prev: FormState<WebhookFormValues>,
  formData: FormData,
): Promise<FormState<WebhookFormValues>> {
  if (!outboundWebhooksEnabled()) return formError(FEATURE_OFF);
  const { user, ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return formError("Only owners and admins can create webhooks.");
  }

  const result = validateFormData(formData, createSchema);
  if (!result.ok) return result.state as FormState<WebhookFormValues>;

  const urlCheck = validateWebhookUrl(result.data.url);
  if (!urlCheck.ok) {
    return formError(SSRF_MESSAGES[urlCheck.reason] ?? "That URL can't be used.", {
      url: result.data.url,
      description: result.data.description,
    });
  }

  const requested = formData.getAll("events").filter((v): v is string => typeof v === "string");
  const eventCheck = validateWebhookEvents(requested);
  if (!eventCheck.ok) {
    return formError(
      eventCheck.invalid.length > 0
        ? "One of the selected events isn't recognised."
        : "Choose at least one event to send.",
      { url: result.data.url, description: result.data.description },
    );
  }

  const secret = generateWebhookSecret();
  const supabase = await createClient();
  const { data, error } = await (
    supabase.from("webhook_endpoints" as never) as unknown as InsertChain
  )
    .insert({
      org_id: ctx.org.id, // active-org pin
      url: urlCheck.url,
      description: result.data.description ?? null,
      secret,
      event_verbs: eventCheck.events,
      created_by: user.id,
      // status defaults to 'paused' — verify-before-first-event.
    })
    .select("id")
    .single();
  // No secret readback: it's column-excluded from the authenticated role.
  if (error || !data) {
    console.error("[webhooks] create failed", error?.message);
    return formError("Couldn't create the webhook. Try again.", {
      url: result.data.url,
      description: result.data.description,
    });
  }

  // Enqueue the verification ping via the service role (deliveries have no tenant
  // insert path). Admin + ownership already proven above; the RPC re-checks org.
  const admin = createAdminClient();
  const { error: pingErr } = await (admin.rpc.bind(admin) as unknown as PingRpc)(
    "webhook_enqueue_ping",
    { p_endpoint_id: data.id, p_org_id: ctx.org.id },
  );
  if (pingErr) console.error("[webhooks] ping enqueue failed", pingErr.message);

  revalidatePath("/settings/webhooks");
  return formSuccess<WebhookFormValues>({
    successMessage:
      "Webhook created. Copy the signing secret now — you won't see it again. We've sent a verification ping; the endpoint activates once it responds with a 2xx.",
    values: { secret },
  });
}

const idSchema = z.object({ endpoint_id: z.string().uuid("Bad webhook reference") });

async function authorise() {
  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) return null;
  return ctx;
}

export async function pauseWebhookEndpoint(
  _prev: FormState<WebhookFormValues>,
  formData: FormData,
): Promise<FormState<WebhookFormValues>> {
  if (!outboundWebhooksEnabled()) return formError(FEATURE_OFF);
  const ctx = await authorise();
  if (!ctx) return formError("Only owners and admins can manage webhooks.");
  const result = validateFormData(formData, idSchema);
  if (!result.ok) return result.state as FormState<WebhookFormValues>;

  const supabase = await createClient();
  const { data, error } = await (supabase.from("webhook_endpoints" as never) as unknown as MutChain)
    .update({ status: "paused" })
    .eq("id", result.data.endpoint_id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) return formError("Couldn't pause the webhook. Try again.");
  if (!data || data.length === 0) return formError("That webhook wasn't found.");
  revalidatePath("/settings/webhooks");
  return formSuccess<WebhookFormValues>({ successMessage: "Webhook paused." });
}

export async function resumeWebhookEndpoint(
  _prev: FormState<WebhookFormValues>,
  formData: FormData,
): Promise<FormState<WebhookFormValues>> {
  if (!outboundWebhooksEnabled()) return formError(FEATURE_OFF);
  const ctx = await authorise();
  if (!ctx) return formError("Only owners and admins can manage webhooks.");
  const result = validateFormData(formData, idSchema);
  if (!result.ok) return result.state as FormState<WebhookFormValues>;

  const supabase = await createClient();
  const chain = supabase.from("webhook_endpoints" as never) as unknown as MutChain;
  const existing = await chain
    .select("id, verified_at")
    .eq("id", result.data.endpoint_id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (existing.error || !existing.data) return formError("That webhook wasn't found.");

  // Never verified yet ⇒ re-verify with a ping instead of activating blindly.
  if (!existing.data.verified_at) {
    const admin = createAdminClient();
    await (admin.rpc.bind(admin) as unknown as PingRpc)("webhook_enqueue_ping", {
      p_endpoint_id: result.data.endpoint_id,
      p_org_id: ctx.org.id,
    });
    revalidatePath("/settings/webhooks");
    return formSuccess<WebhookFormValues>({
      successMessage: "Sent a fresh verification ping. The endpoint activates once it responds with a 2xx.",
    });
  }

  const { data, error } = await chain
    .update({ status: "active" })
    .eq("id", result.data.endpoint_id)
    .eq("org_id", ctx.org.id)
    .select("id");
  if (error) return formError("Couldn't resume the webhook. Try again.");
  if (!data || data.length === 0) return formError("That webhook wasn't found.");

  // Reset the circuit breaker on resume (service-role — not tenant-writable).
  const admin = createAdminClient();
  await (admin.from("webhook_endpoints" as never) as unknown as {
    update: (row: Record<string, unknown>) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => PromiseLike<{ error: unknown }> } };
  })
    .update({ consecutive_failures: 0 })
    .eq("id", result.data.endpoint_id)
    .eq("org_id", ctx.org.id);

  revalidatePath("/settings/webhooks");
  return formSuccess<WebhookFormValues>({ successMessage: "Webhook resumed." });
}

export async function repingWebhookEndpoint(
  _prev: FormState<WebhookFormValues>,
  formData: FormData,
): Promise<FormState<WebhookFormValues>> {
  if (!outboundWebhooksEnabled()) return formError(FEATURE_OFF);
  const ctx = await authorise();
  if (!ctx) return formError("Only owners and admins can manage webhooks.");
  const result = validateFormData(formData, idSchema);
  if (!result.ok) return result.state as FormState<WebhookFormValues>;

  const admin = createAdminClient();
  const { error } = await (admin.rpc.bind(admin) as unknown as PingRpc)("webhook_enqueue_ping", {
    p_endpoint_id: result.data.endpoint_id,
    p_org_id: ctx.org.id,
  });
  if (error) return formError("Couldn't send a ping. Try again.");
  revalidatePath("/settings/webhooks");
  return formSuccess<WebhookFormValues>({ successMessage: "Verification ping sent." });
}

export async function deleteWebhookEndpoint(
  _prev: FormState<WebhookFormValues>,
  formData: FormData,
): Promise<FormState<WebhookFormValues>> {
  if (!outboundWebhooksEnabled()) return formError(FEATURE_OFF);
  const ctx = await authorise();
  if (!ctx) return formError("Only owners and admins can manage webhooks.");
  const result = validateFormData(formData, idSchema);
  if (!result.ok) return result.state as FormState<WebhookFormValues>;

  const supabase = await createClient();
  const { error } = await (supabase.from("webhook_endpoints" as never) as unknown as MutChain)
    .delete()
    .eq("id", result.data.endpoint_id)
    .eq("org_id", ctx.org.id);
  if (error) return formError("Couldn't delete the webhook. Try again.");
  revalidatePath("/settings/webhooks");
  return formSuccess<WebhookFormValues>({ successMessage: "Webhook deleted." });
}
