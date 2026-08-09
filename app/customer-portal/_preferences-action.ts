"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "./_helpers";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import {
  buildProfileUpdateTicketBody,
  portalPreferencesSchema,
  profileUpdateRequestSchema,
} from "@/lib/customers/portal-preferences";

/**
 * Train 4 — Portal profile actions. TWO deliberately different write models:
 *
 * savePortalPreferences — the customer's OWN communication preference, written
 * directly. Upsert on the natural key (org_id, customer_id), both values taken
 * from the token-resolved customer and NEVER from the form, so the write is
 * idempotent and can only ever address the caller's single row. Bounded by zod
 * here and by CHECK constraints in the DB (migration 20261082000000).
 *
 * requestProfileUpdate — name/email/phone are ORG-OWNED records (invoices,
 * quotes and this portal's own link delivery hang off them). The portal NEVER
 * writes public.customers: a change is a REQUEST — a support ticket in the
 * existing 'account' category with a structured current → requested body that
 * staff review and apply manually. Design decision, stated in the UI too: a
 * token holder silently rewriting the delivery email would turn a leaked
 * portal link into an account-takeover primitive.
 */

const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backTo(token: string, outcome: { saved?: string; error?: string }): never {
  const qs = outcome.saved
    ? `?saved=${encodeURIComponent(outcome.saved)}`
    : `?error=${encodeURIComponent(outcome.error ?? "unknown")}`;
  redirect(`/customer-portal/${token}/profile${qs}`);
}

export async function savePortalPreferences(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    // The token FAILED validation — encode it before it re-enters a path.
    redirect(`/customer-portal/${encodeURIComponent(token)}/profile?error=invalid_token`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, {
      error: "Too many changes. Please wait a moment and try again.",
    });
  }

  const parsed = portalPreferencesSchema.safeParse({
    preferred_channel: formData.get("preferred_channel"),
    contact_notes: formData.get("contact_notes"),
  });
  if (!parsed.success) {
    backTo(token, { error: parsed.error.issues[0]?.message ?? "invalid_input" });
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, { error: "invalid_token" });
  }
  const { customer } = loaded;

  const admin = createAdminClient();
  // Idempotent by construction: upsert on the natural key, identity from the
  // token-resolved customer only. Re-submitting the same form is a no-op
  // beyond updated_at.
  const { error: upsertError } = await (
    admin.from("customer_portal_preferences" as never) as unknown as {
      upsert: (
        row: unknown,
        opts: { onConflict: string },
      ) => Promise<{ error: { message: string } | null }>;
    }
  ).upsert(
    {
      org_id: customer.org_id,
      customer_id: customer.id,
      preferred_channel: parsed.data.preferred_channel,
      contact_notes: parsed.data.contact_notes ?? null,
    },
    { onConflict: "org_id,customer_id" },
  );
  if (upsertError) {
    console.error("[portal/preferences] upsert failed", upsertError);
    backTo(token, { error: "could_not_save" });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.preferences.saved",
    targetTable: "customer_portal_preferences",
    targetId: customer.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      preferred_channel: parsed.data.preferred_channel,
      source: "customer_portal",
    },
  });

  revalidatePath(`/customer-portal/${token}/profile`);
  backTo(token, { saved: "preferences" });
}

export async function requestProfileUpdate(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!TOKEN_RE.test(token)) {
    // The token FAILED validation — encode it before it re-enters a path.
    redirect(`/customer-portal/${encodeURIComponent(token)}/profile?error=invalid_token`);
  }

  const rl = await consume("portal_write", token, DEFAULT_LIMITS.portal_write);
  if (!rl.allowed) {
    backTo(token, {
      // A CODE, not prose — the page renders codes through an allowlist so
      // forged query text can never appear on a branded page.
      error: "rate_limited",
    });
  }

  const parsed = profileUpdateRequestSchema.safeParse({
    requested_name: formData.get("requested_name"),
    requested_email: formData.get("requested_email"),
    requested_phone: formData.get("requested_phone"),
  });
  if (!parsed.success) {
    backTo(token, { error: parsed.error.issues[0]?.message ?? "invalid_input" });
  }

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) {
    backTo(token, { error: "invalid_token" });
  }
  const { customer } = loaded;

  const admin = createAdminClient();

  // Same two-insert shape as sendPortalMessage: ticket first (the number
  // trigger runs on insert), then the structured first message.
  const { data: ticket, error: ticketError } = await (
    admin.from("support_tickets" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: customer.org_id,
      customer_id: customer.id,
      subject: "Contact details update request",
      status: "open",
      priority: "normal",
      // 'account' is an EXISTING support_tickets category (20260610000000) —
      // no schema change, and staff inboxes already render it.
      category: "account",
      created_by: null,
    })
    .select("id")
    .single();
  if (ticketError || !ticket?.id) {
    console.error("[portal/profile-request] ticket insert failed", ticketError);
    backTo(token, { error: "could_not_submit" });
  }

  const { error: messageError } = await admin
    .from("support_messages" as never)
    .insert({
      ticket_id: ticket.id,
      org_id: customer.org_id,
      author_id: null,
      author_kind: "customer",
      internal: false,
      body: buildProfileUpdateTicketBody({
        current: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        },
        requested: parsed.data,
      }),
    } as never);
  if (messageError) {
    console.error("[portal/profile-request] message insert failed", messageError);
    backTo(token, { error: "could_not_submit" });
  }

  await recordAdminActivity({
    actorId: null,
    actorEmail: customer.email ?? null,
    action: "portal.profile_update.requested",
    targetTable: "support_tickets",
    targetId: ticket.id,
    metadata: {
      org_id: customer.org_id,
      customer_id: customer.id,
      customer_name: customer.name,
      source: "customer_portal",
    },
  });

  // Automation OS — a portal profile-update request opens a NEW support ticket
  // (category "account"), the same `support.ticket.created` transition the enabled
  // "Support ticket opened" rule watches. Same shape and rationale as
  // sendPortalMessage: this path only ever INSERTs a fresh support_tickets row, so
  // the dispatch is unconditional and can never fire on a reply. Reached only
  // after the ticket insert succeeded (ticket.id known). Idempotent via
  // correlation support.ticket.created:support_tickets:<id>; org-pinned to the
  // customer's org; best-effort so a dispatch failure never derails the request.
  await dispatchAutomation({
    type: "support.ticket.created",
    org_id: customer.org_id,
    source_table: "support_tickets",
    source_id: ticket.id,
    payload: {
      via: "customer_portal",
      customer_name: customer.name,
      kind: "profile_update_request",
    },
    actor_email: customer.email ?? null,
  }).catch((e) => {
    console.error("[portal/profile-request] automation dispatch failed", e);
  });

  revalidatePath(`/customer-portal/${token}/profile`);
  revalidatePath(`/admin/support`);
  revalidatePath(`/support`);
  backTo(token, { saved: "requested" });
}
