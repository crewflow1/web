import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { emitNotifications } from "@/server/services/notifications-service";
import type { NotificationCreate } from "@/lib/notifications/types";

/**
 * Phase G — E-signatures (non-quote entities).
 *
 * Quotes already have their own `accept_signature` jsonb column —
 * left unchanged for back-compat. This service covers polymorphic
 * signatures on `contracts`, plus future entities (invoices etc).
 *
 * Recorded fields: signer name + signature_text (typed name) +
 * timestamp + ip + user-agent.
 *
 * Triggers:
 *   - `signature.created` notification to the org owner
 *   - automation dispatch `quote.accepted` when target is a quote
 *     (back-compat with existing automation rule)
 */

export const SIGNABLE_TARGET_TABLES = ["quotes", "contracts", "invoices"] as const;
export type SignableTarget = (typeof SIGNABLE_TARGET_TABLES)[number];

export async function recordSignature(input: {
  target_table: SignableTarget;
  target_id: string;
  signer_name: string;
  signer_email?: string | null;
  signature_text: string;
  ip_address?: string | null;
  user_agent?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { ctx, user } = await requireOrgContext();
  const tenant = await createClient();

  const { data, error } = await tenant
    .from("signatures" as never)
    .insert({
      org_id: ctx.org.id,
      target_table: input.target_table,
      target_id: input.target_id,
      signer_name: input.signer_name,
      signer_email: input.signer_email ?? null,
      signature_text: input.signature_text,
      signed_at: new Date().toISOString(),
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
    } as never)
    .select("id")
    .single();
  if (error || !data) {
    console.error("[signatures] insert failed", error);
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  const id = (data as { id: string }).id;

  // Notify the org owner.
  const note: NotificationCreate = {
    org_id: ctx.org.id,
    user_id: null,
    audience: "customer",
    type: `signature.signed_${input.target_table}`,
    category: "system",
    priority: "high",
    title: `${capitalise(input.target_table.replace(/s$/, ""))} signed by ${input.signer_name}`,
    body: `Signed at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    action_url:
      input.target_table === "quotes"
        ? `/quotes/${input.target_id}`
        : input.target_table === "invoices"
          ? `/invoices/${input.target_id}`
          : `/documents`,
    source_module: "signatures",
    source_id: input.target_id,
    metadata: {
      signature_id: id,
      target_table: input.target_table,
      signer_name: input.signer_name,
    },
  };
  await emitNotifications([note]).catch((e) =>
    console.error("[signatures] notify failed", e),
  );

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `signature.${input.target_table}_signed`,
    targetTable: input.target_table,
    targetId: input.target_id,
    metadata: {
      signature_id: id,
      signer_name: input.signer_name,
      signer_email: input.signer_email ?? null,
    },
  });

  // Dispatch automation if it's a quote (reuse the existing rule).
  if (input.target_table === "quotes") {
    await dispatchAutomation({
      type: "quote.accepted",
      org_id: ctx.org.id,
      source_table: "quotes",
      source_id: input.target_id,
      payload: {
        via: "signatures_service",
        signer_name: input.signer_name,
      },
    }).catch((e) => console.error("[signatures] automation dispatch failed", e));
  }

  return { ok: true, id };
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
