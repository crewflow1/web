import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { normaliseWaId } from "@/lib/receptionist/optout";

/**
 * WhatsApp opt-out ledger operations (activation-hardening P2-7) — the ONLY
 * writers and the suppression reader for `whatsapp_optouts`.
 *
 * The table is service-role-only for writes (RLS: zero write policies), so a
 * tenant can neither fabricate nor erase a customer's opt-out; org members can
 * SELECT their org's rows to see why a send was refused.
 *
 * Posture:
 *   • record  — idempotent upsert-shaped: a second STOP is a no-op, the ledger
 *     keeps the FIRST opt-out timestamp/provenance.
 *   • remove  — explicit START/UNSTOP only (lib/receptionist/optout.ts owns
 *     the keyword contract); removing a non-existent row is a no-op.
 *   • check   — THROWS on a read error. Fail closed is caller-specific: the
 *     drafting gate suppresses on a throw, the transport gate blocks the
 *     dispatch loudly — never "couldn't read, send anyway".
 */

type OptOutTable = {
  insert: (row: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
  delete: () => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        limit: (n: number) => Promise<{
          data: Array<{ wa_id: string }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

function optoutTable(): OptOutTable {
  const admin = createAdminClient();
  return admin.from("whatsapp_optouts" as never) as unknown as OptOutTable;
}

/**
 * Record one explicit opt-out. Idempotent: a duplicate (org, wa_id) collides on
 * the PK and is treated as success (first STOP wins the provenance). THROWS on
 * any other DB error — an opt-out that cannot be durably recorded must fail the
 * inbound event so the webhook retry records it, never silently proceed to
 * drafting a reply to someone who just said STOP.
 */
export async function recordWhatsAppOptOut(input: {
  orgId: string;
  waId: string;
  sourceWamid: string | null;
}): Promise<void> {
  const waId = normaliseWaId(input.waId);
  if (!waId) return; // no sender identity ⇒ nothing to suppress against
  const { error } = await optoutTable().insert({
    org_id: input.orgId,
    wa_id: waId,
    source_wamid: input.sourceWamid,
  });
  if (error) {
    const isDup = error.code === "23505" || error.message?.includes("duplicate");
    if (!isDup) {
      throw new Error(`whatsapp_optouts insert failed: ${error.message}`);
    }
    return; // already opted out — keep the original row
  }
  // Audit the suppression event (best-effort — the durable ledger row above is
  // the record of authority; the activity line is operator visibility).
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "whatsapp.opt_out_recorded",
    targetTable: "whatsapp_optouts",
    // target_id is uuid NOT NULL — the org uuid anchors the row (review P1-1:
    // a digits-only wa_id here failed the insert silently); wa_id is metadata.
    targetId: input.orgId,
    metadata: { org_id: input.orgId, wa_id: waId, source_wamid: input.sourceWamid },
  }).catch(() => undefined);
}

/**
 * Remove an opt-out on an EXPLICIT START/UNSTOP. No-op when no row exists.
 * THROWS on a DB error (retryable via the webhook claim, like record).
 */
export async function removeWhatsAppOptOut(input: {
  orgId: string;
  waId: string;
  sourceWamid: string | null;
}): Promise<void> {
  const waId = normaliseWaId(input.waId);
  if (!waId) return;
  const { error } = await optoutTable().delete().eq("org_id", input.orgId).eq("wa_id", waId);
  if (error) {
    throw new Error(`whatsapp_optouts delete failed: ${error.message}`);
  }
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "whatsapp.opt_out_removed",
    targetTable: "whatsapp_optouts",
    targetId: input.orgId,
    metadata: { org_id: input.orgId, wa_id: waId, source_wamid: input.sourceWamid },
  }).catch(() => undefined);
}

/**
 * Is this recipient opted out for this org? Identity is digits-only normalised
 * (wa_id or E.164 both resolve to the same key). THROWS on a read error —
 * callers decide their fail-closed shape (suppress drafting / block dispatch);
 * none may interpret a failed read as "not opted out".
 */
export async function isWhatsAppOptedOut(orgId: string, recipientRef: string | null): Promise<boolean> {
  const waId = normaliseWaId(recipientRef);
  if (!waId) return false; // no identity ⇒ nothing to match (undialable refs fail elsewhere)
  const { data, error } = await optoutTable()
    .select("wa_id")
    .eq("org_id", orgId)
    .eq("wa_id", waId)
    .limit(1);
  if (error) {
    throw new Error(`whatsapp_optouts read failed: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}
