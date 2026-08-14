import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { recordWhatsAppDeliveryReceipt } from "@/server/services/receptionist";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  normalizeMetaMessages,
  normalizeMetaStatuses,
  type MetaWebhookEnvelope,
  type NormalizedWhatsAppMessage,
  type NormalizedWhatsAppStatus,
} from "@/lib/comms/providers/meta-whatsapp";
import { downloadInboundWhatsAppMedia } from "@/server/services/whatsapp-media-pipeline";
import {
  resolveJobForCaller,
  runWhatsAppAssistantActions,
} from "@/server/services/whatsapp-assistant-actions";

/**
 * WhatsApp inbound webhook handler — claim → route → hand off.
 *
 * Meta delivers at-least-once and retries on any non-2xx, so each message/status
 * is CLAIMED before it is acted on, using the billing_events / automation_runs
 * claim protocol VERBATIM (the #353/#355 correction): an atomic INSERT is the
 * claim; a concurrent/retry loser reclaims ONLY a row that is processed_at NULL
 * and (failed OR its 15-minute lease expired); `processed_at` — never row
 * existence — is the sole proof of completion, so a crash mid-dispatch stays
 * retryable rather than being silently dropped. Every Supabase { error } is
 * checked explicitly.
 *
 * A message whose phone_number_id has no active route is ACK-DROPPED (claimed +
 * completed + an HQ notification), never processed against a guessed org — an
 * unattributable webhook must not touch tenant data. Handing off to the UNCHANGED
 * processInboundEnquiry keeps WhatsApp on the exact same ingestion path as phone
 * and SMS; this handler adds routing + the ingress claim, nothing more.
 */

/** How long a claimed-but-unprocessed ingress row is honoured before it's orphaned. */
export const WHATSAPP_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type ProcessWhatsAppResult = {
  messages: number;
  statuses: number;
  dispatched: number;
  duplicates: number;
  unrouted: number;
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
    kind: "message" | "status";
    wamid: string;
    status?: string | null;
    phone_number_id: string | null;
    org_id: string | null;
    payload: unknown;
  },
): Promise<ClaimOutcome> {
  const nowIso = new Date().toISOString();
  const ins = await adminTable("whatsapp_webhook_events").insert({
    event_key: eventKey,
    kind: fields.kind,
    wamid: fields.wamid,
    status: fields.status ?? null,
    phone_number_id: fields.phone_number_id,
    org_id: fields.org_id,
    payload: fields.payload,
    claimed_at: nowIso,
  });

  if (!ins.error) return { ok: true, won: true };
  const isDup =
    ins.error.code === "23505" || ins.error.message?.includes("duplicate");
  if (!isDup) {
    console.error("[whatsapp-webhook] claim insert failed", {
      event_key: eventKey,
      code: ins.error.code,
      message: ins.error.message,
    });
    return { ok: false, won: false, error: `claim_failed: ${ins.error.message}` };
  }

  const leaseCutoff = new Date(Date.now() - WHATSAPP_CLAIM_LEASE_MS).toISOString();
  const upd = await adminTable("whatsapp_webhook_events")
    .update({ claimed_at: nowIso, error_message: null })
    .eq("event_key", eventKey)
    .is("processed_at", null)
    .or(`error_message.not.is.null,claimed_at.lt.${leaseCutoff}`)
    .select("id");
  if (upd.error) {
    console.error("[whatsapp-webhook] claim reclaim failed", {
      event_key: eventKey,
      message: upd.error.message,
    });
    return { ok: false, won: false, error: `reclaim_failed: ${upd.error.message}` };
  }
  return { ok: true, won: (upd.data?.length ?? 0) > 0 };
}

async function markProcessed(eventKey: string): Promise<void> {
  const res = await adminTable("whatsapp_webhook_events")
    .update({ processed_at: new Date().toISOString(), error_message: null })
    .eq("event_key", eventKey);
  if (res.error) {
    console.error("[whatsapp-webhook] markProcessed failed", {
      event_key: eventKey,
      message: res.error.message,
    });
  }
}

async function markFailed(eventKey: string, error: string): Promise<void> {
  const res = await adminTable("whatsapp_webhook_events")
    .update({ error_message: error })
    .eq("event_key", eventKey);
  if (res.error) {
    console.error("[whatsapp-webhook] markFailed failed", {
      event_key: eventKey,
      message: res.error.message,
    });
  }
}

/** Resolve an active org route for a phone_number_id, or null (→ ack-drop). */
async function resolveOrgForNumber(
  phoneNumberId: string | null,
): Promise<string | null> {
  if (!phoneNumberId) return null;
  const res = await adminTable("whatsapp_number_routes")
    .select("org_id")
    .eq("phone_number_id", phoneNumberId)
    .eq("active", true)
    .maybeSingle();
  if (res.error) {
    console.error("[whatsapp-webhook] route lookup failed", {
      phone_number_id: phoneNumberId,
      message: res.error.message,
    });
    return null;
  }
  return (res.data?.org_id as string | undefined) ?? null;
}

async function handleMessage(
  msg: NormalizedWhatsAppMessage,
  result: ProcessWhatsAppResult,
): Promise<void> {
  const orgId = await resolveOrgForNumber(msg.phone_number_id);
  const eventKey = `msg:${msg.wamid}`;

  const claim = await claimEvent(eventKey, {
    kind: "message",
    wamid: msg.wamid,
    phone_number_id: msg.phone_number_id,
    org_id: orgId,
    payload: msg,
  });
  if (!claim.ok) {
    result.failed++;
    return;
  }
  if (!claim.won) {
    result.duplicates++;
    return;
  }

  // Unrouted number → ack-drop: mark done + record an HQ audit event, never
  // touch tenant data. An unattributable webhook has no org, so this goes to the
  // org-less admin activity log (recordAdminActivity) — NOT the notifications
  // table, whose org_id is NOT NULL and would silently reject a null-org insert.
  if (!orgId) {
    result.unrouted++;
    await recordAdminActivity({
      actorId: null,
      actorEmail: null,
      action: "whatsapp.unrouted_number",
      targetTable: "whatsapp_webhook_events",
      targetId: msg.wamid,
      metadata: { phone_number_id: msg.phone_number_id, wamid: msg.wamid },
    }).catch(() => undefined);
    await markProcessed(eventKey);
    return;
  }

  try {
    // Hand off to the UNCHANGED ingestion core — same path as phone/SMS. The wamid is BOTH
    // the outbound dedup_key (repeated deliveries fold to one reply) AND the inbound message
    // identity `provider_message_id` (Part 11) — the partial-unique DB backstop to the ingress
    // claim. provider_timestamp + has_media are persisted on the enquiry (metadata only in v1).
    // (contact_name is captured in the normalized message + the webhook_events payload, but
    // InboundEnquiryInput does not accept it today — a deliberate follow-up.)
    const dispatch = await processInboundEnquiry({
      org_id: orgId,
      channel: "whatsapp_msg",
      raw_text: msg.raw_text,
      caller: msg.caller,
      dedup_key: msg.wamid,
      provider_message_id: msg.wamid,
      provider_timestamp: msg.provider_timestamp,
      has_media: msg.has_media,
    });
    result.dispatched++;

    // MEDIA + ASSISTANT AUTO-ACTIONS — best-effort, AFTER the durable enquiry is
    // recorded. This is the P2 assistant layer: fetch inbound media bytes (dark
    // ⇒ refuse-before-fetch, no network) and turn the message into the right
    // entity (evidence auto-created; commitments queued for review). It NEVER
    // affects the ingestion contract: a failure here is logged and swallowed, the
    // enquiry is already durable, and the event is marked processed regardless.
    // Idempotent throughout (media id + (org,wamid,action_type)), so a retry that
    // reaches here again cannot double-act.
    await runAssistantLayer(orgId, msg, dispatch.enquiry_id).catch((e) => {
      console.error("[whatsapp-webhook] assistant layer failed (swallowed)", {
        wamid: msg.wamid,
        message: e instanceof Error ? e.message : String(e),
      });
    });

    await markProcessed(eventKey);
  } catch (e) {
    // Leave processed_at NULL so a retry re-runs — never a silent drop.
    result.failed++;
    await markFailed(eventKey, e instanceof Error ? e.message : String(e));
  }
}

/**
 * The P2 assistant layer for ONE dispatched message: download any media (dark ⇒
 * refuse-before-fetch), resolve the job it concerns, then run the auto-actions.
 * Entirely best-effort — the caller has already made the enquiry durable.
 */
async function runAssistantLayer(
  orgId: string,
  msg: NormalizedWhatsAppMessage,
  enquiryId: string | null,
): Promise<void> {
  // 1. Media bytes. Only for messages that actually carry a fetchable media
  //    descriptor; the pipeline refuses-before-fetch when creds are dark.
  let media: { bytes: Uint8Array; mimeType: string | null } | null = null;
  if (msg.has_media && msg.media) {
    const dl = await downloadInboundWhatsAppMedia({
      orgId,
      wamid: msg.wamid,
      media: msg.media,
    });
    if (dl.status === "stored") {
      media = { bytes: dl.bytes, mimeType: dl.mimeType };
    }
  }

  // 2. Deterministic job resolution (caller → customer → most recent open job).
  const jobId = await resolveJobForCaller(orgId, msg.caller);

  // 3. Auto-actions.
  await runWhatsAppAssistantActions({
    orgId,
    wamid: msg.wamid,
    enquiryId,
    message: msg,
    jobId,
    media,
  });
}

async function handleStatus(
  st: NormalizedWhatsAppStatus,
  result: ProcessWhatsAppResult,
): Promise<void> {
  const orgId = await resolveOrgForNumber(st.phone_number_id);
  const eventKey = `status:${st.wamid}:${st.status}`;

  const claim = await claimEvent(eventKey, {
    kind: "status",
    wamid: st.wamid,
    status: st.status,
    phone_number_id: st.phone_number_id,
    org_id: orgId,
    payload: st,
  });
  if (!claim.ok) {
    result.failed++;
    return;
  }
  if (!claim.won) {
    result.duplicates++;
    return;
  }

  // A status transition (sent/delivered/read/failed) is CLAIMED, then correlated to its
  // outbound message via the WhatsApp receipt authority (PR3). recordWhatsAppDeliveryReceipt
  // is the DISTINCT WhatsApp writer (captive to this handler; the SMS writer stays captive to
  // the Twilio route) sharing the channel-agnostic core: it resolves the SENT transport by
  // this wamid and appends an idempotent receipt on channel='whatsapp', copying org/audit from
  // that row. An unknown wamid (EVERY wamid while outbound is dark — nothing was sent) records
  // nothing and is a benign no-op. Only a genuine WRITE error leaves the event retryable.
  try {
    if (st.receipt) {
      await recordWhatsAppDeliveryReceipt(st.receipt);
    }
    await markProcessed(eventKey);
  } catch (e) {
    result.failed++;
    await markFailed(eventKey, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Process one verified Meta webhook envelope: claim + route + hand off every
 * message, then every status. Best-effort per item — one failure never aborts the
 * batch, and a failed item stays retryable (processed_at NULL).
 */
export async function processMetaWhatsAppPayload(
  env: MetaWebhookEnvelope,
): Promise<ProcessWhatsAppResult> {
  const result: ProcessWhatsAppResult = {
    messages: 0,
    statuses: 0,
    dispatched: 0,
    duplicates: 0,
    unrouted: 0,
    failed: 0,
  };

  const messages = normalizeMetaMessages(env);
  const statuses = normalizeMetaStatuses(env);
  result.messages = messages.length;
  result.statuses = statuses.length;

  for (const msg of messages) await handleMessage(msg, result);
  for (const st of statuses) await handleStatus(st, result);

  return result;
}

/** Feature flag: WhatsApp inbound is DARK unless explicitly enabled. */
export function isWhatsAppInboundLive(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true";
}
