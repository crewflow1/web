import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  parseInboundEmailPayload,
  normalizeInboundEmail,
  normalizeEmailAddress,
  type NormalizedInboundEmail,
} from "@/lib/comms/providers/inbound-email";

/**
 * Inbound EMAIL webhook handler — claim → route → hand off (P2 Communications).
 *
 * Mail providers deliver AT-LEAST-ONCE and retry on any non-2xx, so each message
 * is CLAIMED before it is acted on, using the whatsapp_webhook_events /
 * billing_events / automation_runs claim protocol VERBATIM: an atomic INSERT is
 * the claim; a concurrent/retry loser reclaims ONLY a row that is processed_at
 * NULL and (failed OR its 15-minute lease expired); `processed_at` — never row
 * existence — is the sole proof of completion, so a crash mid-dispatch stays
 * retryable rather than being silently dropped. Every Supabase { error } is
 * checked explicitly.
 *
 * A message whose destination address has no active route is ACK-DROPPED (claimed
 * + completed + an HQ audit event), never processed against a guessed org — an
 * unattributable webhook must not touch tenant data. Handing off to the UNCHANGED
 * processInboundEnquiry keeps email on the exact same ingestion path as phone,
 * SMS and WhatsApp; this handler adds routing + the ingress claim, nothing more.
 */

/** How long a claimed-but-unprocessed ingress row is honoured before it's orphaned. */
export const EMAIL_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type ProcessInboundEmailResult = {
  messages: number;
  dispatched: number;
  duplicates: number;
  unrouted: number;
  rejected: number;
  failed: number;
};

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    insert: (row: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => {
        is: (k: string, v: unknown) => {
          or: (f: string) => {
            select: (cols: string) => Promise<{
              data: Array<{ id: string }> | null;
              error: { message: string } | null;
            }>;
          };
        };
      } & Promise<{ error: { message: string } | null }>;
    };
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: Record<string, unknown> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
}

type ClaimOutcome =
  | { ok: true; won: boolean }
  | { ok: false; won: false; error: string };

/**
 * Atomically claim one ingress event before it is acted on. INSERT is the claim;
 * on the UNIQUE(event_key) collision, reclaim ONLY a releasable row (processed_at
 * NULL AND (error_message set OR lease expired)). No row returned → completed, or
 * an active lease is held → run nothing. A DB error is surfaced, not swallowed.
 */
async function claimEvent(
  eventKey: string,
  fields: {
    provider_message_id: string;
    from_address: string | null;
    to_address: string | null;
    org_id: string | null;
    payload: unknown;
  },
): Promise<ClaimOutcome> {
  const nowIso = new Date().toISOString();
  const ins = await adminTable("email_webhook_events").insert({
    event_key: eventKey,
    provider_message_id: fields.provider_message_id,
    from_address: fields.from_address,
    to_address: fields.to_address,
    org_id: fields.org_id,
    payload: fields.payload,
    claimed_at: nowIso,
  });

  if (!ins.error) return { ok: true, won: true };
  const isDup =
    ins.error.code === "23505" || ins.error.message?.includes("duplicate");
  if (!isDup) {
    console.error("[email-webhook] claim insert failed", {
      event_key: eventKey,
      code: ins.error.code,
      message: ins.error.message,
    });
    return { ok: false, won: false, error: `claim_failed: ${ins.error.message}` };
  }

  const leaseCutoff = new Date(Date.now() - EMAIL_CLAIM_LEASE_MS).toISOString();
  const upd = await adminTable("email_webhook_events")
    .update({ claimed_at: nowIso, error_message: null })
    .eq("event_key", eventKey)
    .is("processed_at", null)
    .or(`error_message.not.is.null,claimed_at.lt.${leaseCutoff}`)
    .select("id");
  if (upd.error) {
    console.error("[email-webhook] claim reclaim failed", {
      event_key: eventKey,
      message: upd.error.message,
    });
    return { ok: false, won: false, error: `reclaim_failed: ${upd.error.message}` };
  }
  return { ok: true, won: (upd.data?.length ?? 0) > 0 };
}

async function markProcessed(eventKey: string): Promise<void> {
  const res = await adminTable("email_webhook_events")
    .update({ processed_at: new Date().toISOString(), error_message: null })
    .eq("event_key", eventKey);
  if (res.error) {
    console.error("[email-webhook] markProcessed failed", {
      event_key: eventKey,
      message: res.error.message,
    });
  }
}

async function markFailed(eventKey: string, error: string): Promise<void> {
  const res = await adminTable("email_webhook_events")
    .update({ error_message: error })
    .eq("event_key", eventKey);
  if (res.error) {
    console.error("[email-webhook] markFailed failed", {
      event_key: eventKey,
      message: res.error.message,
    });
  }
}

/**
 * Resolve an active org route for a destination address, or null (→ ack-drop).
 * The lookup is on the NORMALISED address (lower/trim), matching how routes are
 * stored — so casing/whitespace in the delivery can never miss (or forge) a route.
 */
async function resolveOrgForAddress(
  toAddress: string | null,
): Promise<string | null> {
  const normalized = normalizeEmailAddress(toAddress);
  if (!normalized) return null;
  const res = await adminTable("email_inbound_routes")
    .select("org_id")
    .eq("inbound_address", normalized)
    .eq("active", true)
    .maybeSingle();
  if (res.error) {
    console.error("[email-webhook] route lookup failed", {
      to_address: normalized,
      message: res.error.message,
    });
    return null;
  }
  return (res.data?.org_id as string | undefined) ?? null;
}

async function handleMessage(
  email: NormalizedInboundEmail,
  result: ProcessInboundEmailResult,
): Promise<void> {
  // A delivery with no stable message id cannot be deduped — reject it rather than
  // ingest an event a replay would double-process. Never touches tenant data.
  if (!email.message_id) {
    result.rejected++;
    console.warn("[email-webhook] delivery with no message id — rejected");
    return;
  }

  const orgId = await resolveOrgForAddress(email.to_address);
  const eventKey = `email:${email.message_id}`;

  const claim = await claimEvent(eventKey, {
    provider_message_id: email.message_id,
    from_address: email.from_address,
    to_address: email.to_address,
    org_id: orgId,
    payload: email,
  });
  if (!claim.ok) {
    result.failed++;
    return;
  }
  if (!claim.won) {
    result.duplicates++;
    return;
  }

  // Unrouted address → ack-drop: mark done + record an HQ audit event, never touch
  // tenant data. An unattributable webhook has no org, so this goes to the org-less
  // admin activity log (recordAdminActivity) — NOT the notifications table, whose
  // org_id is NOT NULL and would silently reject a null-org insert.
  if (!orgId) {
    result.unrouted++;
    await recordAdminActivity({
      actorId: null,
      actorEmail: email.from_address,
      action: "email.unrouted_address",
      targetTable: "email_webhook_events",
      targetId: email.message_id,
      metadata: { to_address: email.to_address, message_id: email.message_id },
    }).catch(() => undefined);
    await markProcessed(eventKey);
    return;
  }

  try {
    // Hand off to the UNCHANGED ingestion core — same path as phone/SMS/WhatsApp. The
    // message id is BOTH the outbound dedup_key (repeated deliveries fold to one turn)
    // AND the inbound message identity `provider_message_id` (the partial-unique DB
    // backstop to this ingress claim). The sender becomes the caller / conversation
    // contact_ref; attachments are metadata-only in v1 (has_media, no bytes fetched).
    await processInboundEnquiry({
      org_id: orgId,
      channel: "email",
      raw_text: email.raw_text,
      caller: email.from_address,
      dedup_key: email.message_id,
      provider_message_id: email.message_id,
      provider_timestamp: email.provider_timestamp,
      has_media: email.has_attachments,
    });
    result.dispatched++;
    await markProcessed(eventKey);
  } catch (e) {
    // Leave processed_at NULL so a retry re-runs — never a silent drop.
    result.failed++;
    await markFailed(eventKey, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Process one verified inbound-email delivery: normalise, claim, route and hand
 * off. Best-effort — a per-item failure never throws to the route (a verified
 * delivery is ack'd 200 and the claim ledger makes a retry safe); only an
 * unparseable body is surfaced so the caller can log it.
 */
export async function processInboundEmailPayload(
  rawBody: string,
): Promise<ProcessInboundEmailResult | null> {
  const parsed = parseInboundEmailPayload(rawBody);
  if (!parsed) return null;

  const result: ProcessInboundEmailResult = {
    messages: 1,
    dispatched: 0,
    duplicates: 0,
    unrouted: 0,
    rejected: 0,
    failed: 0,
  };

  const email = normalizeInboundEmail(parsed);
  await handleMessage(email, result);
  return result;
}

/**
 * Inbound email is DARK unless BOTH switches are set: the feature flag AND the
 * shared signing secret. The flag alone opens no door — a webhook with the flag on
 * but no secret cannot verify any request, so it would reject everything anyway;
 * requiring the secret here makes the route 404 (feature-absent) rather than 401
 * (rejecting) in that half-configured state, and keeps the two-switch contract
 * explicit. Both unset in prod, CI and dev.
 */
export function isInboundEmailLive(): boolean {
  return (
    process.env.NEXT_PUBLIC_FEATURE_INBOUND_EMAIL === "true" &&
    typeof process.env.INBOUND_EMAIL_WEBHOOK_SECRET === "string" &&
    process.env.INBOUND_EMAIL_WEBHOOK_SECRET !== ""
  );
}
