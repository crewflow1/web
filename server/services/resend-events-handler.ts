import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseResendEventPayload,
  normalizeResendEvent,
  type NormalizedResendEvent,
} from "@/lib/comms/providers/resend-events";

/**
 * Resend delivery-EVENTS webhook handler — attribute -> record (MP Wave R4).
 *
 * Resend delivers AT-LEAST-ONCE and retries on any non-2xx, so each event is
 * recorded IDEMPOTENTLY: the INSERT into `comm_events` is keyed by
 * (provider, provider_event_id) — the Svix message id — so a redelivery hits the
 * UNIQUE index and the 23505 is treated as a benign duplicate, never a second
 * row. `comm_events` is append-only (a DB trigger refuses UPDATE/DELETE for every
 * role), so there is nothing to mutate; the ledger only ever grows.
 *
 * ORG ATTRIBUTION is by content, not by trust: the provider's message id
 * (`data.email_id`) is matched against an OUTBOUND `messages.provider_id`. A hit
 * stamps the event with that message's org_id + id (the composite FK then pins
 * the event to the same org). A miss (a transactional invoice/quote email that
 * never created a `messages` row) is still recorded, org-less — and the member
 * SELECT policy makes a NULL-org row invisible to every tenant, so an
 * unattributable event can never leak.
 *
 * Best-effort and non-throwing per event: the route acks a VERIFIED delivery
 * 200 regardless (the claim/dup key makes a retry safe); only a genuinely
 * unparseable body is surfaced (null) so the route can log it.
 */

export type ProcessResendEventResult = {
  event_type: string;
  recorded: boolean;
  duplicate: boolean;
  attributed: boolean;
  rejected: boolean;
};

type AdminChain = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          order: (k: string, o: { ascending: boolean }) => {
            limit: (n: number) => Promise<{
              data: Array<{ id: string; org_id: string }> | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
    insert: (row: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
  };
};

function admin(): AdminChain {
  return createAdminClient() as unknown as AdminChain;
}

/**
 * Resolve the outbound message an event concerns by its provider message id.
 * Reads the newest matching OUTBOUND message so a (org_id, provider_id) pair
 * resolves deterministically. Returns null on no match or error (the event is
 * still recorded, org-less).
 */
async function resolveMessage(
  providerMessageId: string | null,
): Promise<{ id: string; org_id: string } | null> {
  if (!providerMessageId) return null;
  const res = await admin()
    .from("messages")
    .select("id, org_id")
    .eq("provider_id", providerMessageId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  if (res.error) {
    console.error("[resend-events] message lookup failed", res.error);
    return null;
  }
  return res.data?.[0] ?? null;
}

async function recordEvent(
  providerEventId: string,
  event: NormalizedResendEvent,
  match: { id: string; org_id: string } | null,
): Promise<{ recorded: boolean; duplicate: boolean }> {
  const res = await admin()
    .from("comm_events")
    .insert({
      org_id: match?.org_id ?? null,
      message_id: match?.id ?? null,
      provider: "resend",
      provider_event_id: providerEventId,
      provider_message_id: event.provider_message_id,
      event_type: event.event_type,
      recipient: event.recipient,
      occurred_at: event.occurred_at ?? new Date().toISOString(),
      payload: event,
    });
  if (!res.error) return { recorded: true, duplicate: false };
  const isDup = res.error.code === "23505" || res.error.message?.includes("duplicate");
  if (isDup) return { recorded: false, duplicate: true };
  console.error("[resend-events] insert failed", res.error);
  return { recorded: false, duplicate: false };
}

/**
 * Process one verified Resend delivery event. `providerEventId` is the Svix
 * message id from the `svix-id` header — the idempotency key. Returns null when
 * the body is unparseable so the route can log it; otherwise a result summary.
 */
export async function processResendEvent(input: {
  rawBody: string;
  providerEventId: string;
}): Promise<ProcessResendEventResult | null> {
  const parsed = parseResendEventPayload(input.rawBody);
  if (!parsed) return null;

  const event = normalizeResendEvent(parsed);

  // An event with no id or type cannot be deduped or interpreted — reject it
  // (recorded=false) rather than write an unusable row. Never touches tenant data.
  if (!event.event_type || !event.provider_message_id) {
    return {
      event_type: event.event_type || "unknown",
      recorded: false,
      duplicate: false,
      attributed: false,
      rejected: true,
    };
  }

  const match = await resolveMessage(event.provider_message_id);
  const { recorded, duplicate } = await recordEvent(input.providerEventId, event, match);

  return {
    event_type: event.event_type,
    recorded,
    duplicate,
    attributed: match !== null,
    rejected: false,
  };
}

/**
 * Resend delivery-events ingestion is DARK unless BOTH switches are set: the
 * feature flag AND the signing secret. The flag alone opens no door — with no
 * secret the webhook cannot verify any request and would reject everything — so
 * requiring the secret here makes the route 404 (feature-absent) rather than 401
 * (rejecting) in that half-configured state, matching isInboundEmailLive().
 */
export function isResendEventsLive(): boolean {
  return (
    process.env.NEXT_PUBLIC_FEATURE_RESEND_EVENTS === "true" &&
    typeof process.env.RESEND_WEBHOOK_SECRET === "string" &&
    process.env.RESEND_WEBHOOK_SECRET !== ""
  );
}
