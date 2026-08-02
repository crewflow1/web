import "server-only";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  nextCallState,
  type CallStatus,
} from "@/lib/telephony/state-machine";
import type { CallEventType, NormalizedInboundCall } from "@/lib/telephony/types";
import { voiceInboundFeatureEnabled } from "@/lib/telephony/config";

/**
 * Voice Telephony (Wave 8) — the server-side persistence path.
 *
 * The ONLY writer of `calls` (origination) and `call_events` (append-only audit)
 * for inbound voice. Runs on the SERVICE-ROLE admin client (RLS-bypassing) — the
 * webhook has no signed-in user — so EVERY read and write pins `org_id`
 * explicitly (defence in depth: the admin client bypasses RLS, so the org filter
 * is the only tenant boundary left), and every Supabase `{ error }` is checked
 * loudly and reported to Sentry, mirroring whatsapp-webhook-handler.
 */

type AdminFrom = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  } & Promise<{ error: { message: string; code?: string } | null }>;
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
  update: (row: unknown) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};

function table(name: string): AdminFrom {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as AdminFrom;
}

const isDup = (err: { message?: string; code?: string } | null): boolean =>
  err?.code === "23505" || (err?.message?.includes("duplicate") ?? false);

export type RecordInboundCallResult = {
  callId: string;
  /** False when this was a redelivery of a call we already have. */
  created: boolean;
};

/**
 * Record (or resolve) the `calls` row for an inbound call. Idempotent on
 * (provider, provider_call_id): a redelivered origination resolves to the same
 * row rather than creating a second. Pins org_id on both the insert and the
 * dedup lookup. Throws loudly on an unexpected DB error.
 */
export async function recordInboundCall(
  orgId: string,
  call: NormalizedInboundCall,
): Promise<RecordInboundCallResult> {
  const ins = await table("calls")
    .insert({
      org_id: orgId,
      direction: "inbound",
      status: call.status,
      provider: call.provider,
      provider_call_id: call.providerCallId,
      caller_number: call.from,
      receiver_number: call.to,
      started_at: call.occurredAt,
    })
    .select("id")
    .single();

  if (!ins.error && ins.data?.id) return { callId: ins.data.id, created: true };

  if (!isDup(ins.error)) {
    const message = ins.error?.message ?? "unknown insert error";
    Sentry.captureException(new Error(`recordInboundCall insert failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] recordInboundCall insert failed", {
      org_id: orgId,
      provider_call_id: call.providerCallId,
      message,
    });
    throw new Error(`recordInboundCall failed: ${message}`);
  }

  // Redelivery — resolve the existing row, org-pinned.
  const existing = await table("calls")
    .select("id")
    .eq("provider_call_id", call.providerCallId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (existing.error) {
    const message = existing.error.message;
    Sentry.captureException(new Error(`recordInboundCall lookup failed: ${message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`recordInboundCall lookup failed: ${message}`);
  }
  const id = existing.data?.id as string | undefined;
  if (!id) {
    // The unique collision was on a row belonging to ANOTHER org — never
    // attribute it here. Loud, and refuse rather than guess.
    console.error("[telephony] recordInboundCall: provider_call_id exists under a different org", {
      org_id: orgId,
      provider_call_id: call.providerCallId,
    });
    throw new Error("recordInboundCall: provider_call_id belongs to a different org");
  }
  return { callId: id, created: false };
}

export type AppendCallEventResult = {
  /** False when this exact (call, provider_event) was already recorded. */
  appended: boolean;
  duplicate: boolean;
  /** The call's status after applying the reducer (unchanged on a duplicate). */
  status: CallStatus | null;
};

/**
 * Append one call event (append-only) and advance `calls.status` via the pure
 * reducer. Idempotent on (call_id, provider_event_id): a redelivered event is a
 * benign no-op. Pins org_id on every statement.
 */
export async function appendCallEvent(
  orgId: string,
  callId: string,
  event: { type: CallEventType; providerEventId: string | null; payload: unknown; occurredAt: string },
): Promise<AppendCallEventResult> {
  const ins = await table("call_events").insert({
    call_id: callId,
    org_id: orgId,
    event_type: event.type,
    provider_event_id: event.providerEventId,
    payload: event.payload,
    occurred_at: event.occurredAt,
  });

  if (ins.error) {
    if (isDup(ins.error)) {
      return { appended: false, duplicate: true, status: null };
    }
    const message = ins.error.message;
    Sentry.captureException(new Error(`appendCallEvent insert failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] appendCallEvent insert failed", {
      org_id: orgId,
      call_id: callId,
      event_type: event.type,
      message,
    });
    throw new Error(`appendCallEvent failed: ${message}`);
  }

  // Advance calls.status through the pure reducer (terminal states are absorbing).
  const current = await table("calls")
    .select("status")
    .eq("id", callId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (current.error) {
    Sentry.captureException(new Error(`appendCallEvent status read failed: ${current.error.message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`appendCallEvent status read failed: ${current.error.message}`);
  }
  const currentStatus = (current.data?.status as CallStatus | undefined) ?? event.type;
  const nextStatus = nextCallState(currentStatus, event.type);
  if (nextStatus !== currentStatus) {
    const upd = await table("calls")
      .update({ status: nextStatus })
      .eq("id", callId)
      .eq("org_id", orgId);
    if (upd.error) {
      Sentry.captureException(new Error(`appendCallEvent status update failed: ${upd.error.message}`), {
        tags: { service: "telephony" },
      });
      throw new Error(`appendCallEvent status update failed: ${upd.error.message}`);
    }
  }
  return { appended: true, duplicate: false, status: nextStatus };
}

/** Feature flag: inbound voice is DARK unless explicitly enabled. */
export function isVoiceInboundLive(): boolean {
  return voiceInboundFeatureEnabled();
}
