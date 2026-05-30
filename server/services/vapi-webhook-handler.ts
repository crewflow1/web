import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveOrgByNumber } from "@/server/services/phone-routing";
import {
  buildAssistantConfig,
  type VapiAssistantConfig,
} from "@/lib/receptionist/assistant-config";

/**
 * Vapi server-webhook handler.
 *
 * Vapi POSTs lifecycle events to /api/webhooks/vapi. We handle the
 * minimum set for "number → org → AI conversation → stored call record":
 *
 *   - assistant-request   : inbound call starting. Resolve the org from
 *                           the DIALLED number, open an in_progress call
 *                           row, and return the per-org assistant so Vapi
 *                           runs our receptionist.
 *   - end-of-call-report  : call finished. Persist transcript, summary,
 *                           duration, status, timestamps.
 *   - status-update       : best-effort status sync.
 *
 * Cross-tenant safety: org_id is ALWAYS derived from the dialled number
 * via phone_numbers — never read from the webhook body. A call to an
 * unprovisioned number gets no assistant and is never stored.
 *
 * Idempotency: every write is keyed on (provider, provider_call_id),
 * which is UNIQUE in the DB, so Vapi retries upsert rather than duplicate.
 */

// Vapi payloads vary by event; we read defensively from several paths.
type VapiMessage = Record<string, unknown>;

export type VapiHandlerResult =
  | { kind: "assistant"; assistant: VapiAssistantConfig }
  | { kind: "ok"; detail?: string }
  | { kind: "ignored"; reason: string };

const PROVIDER = "vapi";

// ---------------------------------------------------------------------
// Payload extraction (defensive — Vapi nests these differently per event)
// ---------------------------------------------------------------------

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function firstString(msg: VapiMessage, paths: string[]): string | null {
  for (const p of paths) {
    const v = get(msg, p);
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** The number the caller dialled — i.e. OUR provisioned Vapi number. */
function dialledNumber(msg: VapiMessage): string | null {
  return firstString(msg, [
    "phoneNumber.number",
    "call.phoneNumber.number",
    "phoneNumber.twilioPhoneNumber",
    "call.phoneNumberId",
    "call.to",
  ]);
}

/** The caller's own number. */
function callerNumber(msg: VapiMessage): string | null {
  return firstString(msg, [
    "customer.number",
    "call.customer.number",
    "call.from",
  ]);
}

function providerCallId(msg: VapiMessage): string | null {
  return firstString(msg, ["call.id", "callId", "call.callId"]);
}

function mapEndedStatus(reason: string | null): string {
  if (!reason) return "completed";
  const r = reason.toLowerCase();
  if (r.includes("did-not-answer") || r.includes("no-answer")) return "no_answer";
  if (r.includes("error") || r.includes("failed")) return "failed";
  return "completed";
}

// ---------------------------------------------------------------------
// calls table accessor (phone_number_id isn't in the generated types yet)
// ---------------------------------------------------------------------

type ExistingCall = { id: string; org_id: string };

type CallsTable = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: ExistingCall | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
  update: (row: unknown) => {
    eq: (
      k: string,
      v: unknown,
    ) => Promise<{ error: { message: string } | null }>;
  };
};

function callsTable(admin: ReturnType<typeof createAdminClient>): CallsTable {
  return admin.from("calls" as never) as unknown as CallsTable;
}

async function findCallByProviderId(
  admin: ReturnType<typeof createAdminClient>,
  providerCallIdValue: string,
): Promise<ExistingCall | null> {
  const { data, error } = await callsTable(admin)
    .select("id, org_id")
    .eq("provider", PROVIDER)
    .eq("provider_call_id", providerCallIdValue)
    .maybeSingle();
  if (error) {
    console.error("[vapi] call lookup failed", error.message);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------
// Per-org assistant config (org name + receptionist setup → Vapi assistant)
// ---------------------------------------------------------------------

type SetupRow = {
  trade_type: string | null;
  business_hours: string | null;
  preferred_voice: string | null;
};

async function loadAssistantConfig(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<VapiAssistantConfig> {
  const { data: org } = await admin
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();

  const { data: setup } = await (
    admin.from("ai_receptionist_setups" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: SetupRow | null }>;
        };
      };
    }
  )
    .select("trade_type, business_hours, preferred_voice")
    .eq("org_id", orgId)
    .maybeSingle();

  return buildAssistantConfig({
    orgName: (org as { name?: string | null } | null)?.name ?? "the company",
    tradeType: setup?.trade_type ?? null,
    businessHours: setup?.business_hours ?? null,
    preferredVoice: setup?.preferred_voice ?? null,
  });
}

// ---------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------

async function handleAssistantRequest(
  msg: VapiMessage,
): Promise<VapiHandlerResult> {
  const dialled = dialledNumber(msg);
  const route = await resolveOrgByNumber(dialled);
  if (!route) {
    // Unknown / inactive number → serve no assistant, store nothing.
    return { kind: "ignored", reason: "unknown_number" };
  }

  const admin = createAdminClient();
  const assistant = await loadAssistantConfig(admin, route.org_id);

  // Open an in_progress call row (idempotent on provider_call_id).
  const callId = providerCallId(msg);
  if (callId) {
    const existing = await findCallByProviderId(admin, callId);
    if (!existing) {
      const { error } = await callsTable(admin).insert({
        org_id: route.org_id,
        phone_number_id: route.phone_number_id,
        provider: PROVIDER,
        provider_call_id: callId,
        direction: "inbound",
        status: "in_progress",
        caller_number: callerNumber(msg),
        receiver_number: dialled,
        started_at: new Date().toISOString(),
      });
      if (error) console.error("[vapi] open call row failed", error.message);
    }
  }

  return { kind: "assistant", assistant };
}

async function handleEndOfCallReport(
  msg: VapiMessage,
): Promise<VapiHandlerResult> {
  const callId = providerCallId(msg);
  if (!callId) return { kind: "ignored", reason: "no_call_id" };

  const admin = createAdminClient();
  const existing = await findCallByProviderId(admin, callId);

  // org_id MUST come from the number, never the payload. Prefer the
  // org already pinned on the open row; otherwise re-resolve from the
  // dialled number in the report. If neither yields an org, drop it —
  // we never create an orphaned / mis-tenanted call.
  let orgId = existing?.org_id ?? null;
  let phoneNumberId: string | null = null;
  if (!orgId) {
    const route = await resolveOrgByNumber(dialledNumber(msg));
    if (!route) return { kind: "ignored", reason: "unknown_number" };
    orgId = route.org_id;
    phoneNumberId = route.phone_number_id;
  }

  const endedReason = firstString(msg, ["endedReason", "call.endedReason"]);
  const transcript = firstString(msg, ["artifact.transcript", "transcript"]);
  const summary = firstString(msg, ["analysis.summary", "summary"]);
  const startedAt = firstString(msg, ["startedAt", "call.startedAt"]);
  const endedAt = firstString(msg, ["endedAt", "call.endedAt"]);
  const durationRaw = get(msg, "durationSeconds") ?? get(msg, "durationSec");
  const durationSec =
    typeof durationRaw === "number" && Number.isFinite(durationRaw)
      ? Math.round(durationRaw)
      : null;
  const transcriptJson =
    get(msg, "artifact.messages") ?? get(msg, "messages") ?? null;

  const patch = {
    status: mapEndedStatus(endedReason),
    ended_at: endedAt ?? new Date().toISOString(),
    duration_sec: durationSec,
    transcript: transcript,
    transcript_json: transcriptJson,
    ai_summary: summary,
  };

  if (existing) {
    const { error } = await callsTable(admin)
      .update(patch)
      .eq("id", existing.id);
    if (error) {
      console.error("[vapi] finalize call failed", error.message);
      throw new Error(`finalize call failed: ${error.message}`);
    }
    return { kind: "ok", detail: "updated" };
  }

  // assistant-request never landed (e.g. replay after a cold start) —
  // insert the full record now, still tenant-scoped by the number.
  const { error } = await callsTable(admin).insert({
    org_id: orgId,
    phone_number_id: phoneNumberId,
    provider: PROVIDER,
    provider_call_id: callId,
    direction: "inbound",
    caller_number: callerNumber(msg),
    receiver_number: dialledNumber(msg),
    started_at: startedAt,
    ...patch,
  });
  if (error) {
    console.error("[vapi] insert finalized call failed", error.message);
    throw new Error(`insert finalized call failed: ${error.message}`);
  }
  return { kind: "ok", detail: "inserted" };
}

async function handleStatusUpdate(
  msg: VapiMessage,
): Promise<VapiHandlerResult> {
  const callId = providerCallId(msg);
  if (!callId) return { kind: "ignored", reason: "no_call_id" };
  const status = firstString(msg, ["status", "call.status"]);
  if (!status) return { kind: "ignored", reason: "no_status" };

  const admin = createAdminClient();
  const existing = await findCallByProviderId(admin, callId);
  if (!existing) return { kind: "ignored", reason: "unknown_call" };

  // Map Vapi's in-flight statuses onto our column; ignore terminal ones
  // (the end-of-call-report owns the final state).
  const mapped =
    status === "in-progress" || status === "forwarding"
      ? "in_progress"
      : null;
  if (!mapped) return { kind: "ok", detail: "noop" };

  const { error } = await callsTable(admin)
    .update({ status: mapped })
    .eq("id", existing.id);
  if (error) console.error("[vapi] status update failed", error.message);
  return { kind: "ok", detail: "status_synced" };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export async function handleVapiEvent(
  message: VapiMessage,
): Promise<VapiHandlerResult> {
  const type = typeof message?.type === "string" ? message.type : null;
  switch (type) {
    case "assistant-request":
      return handleAssistantRequest(message);
    case "end-of-call-report":
      return handleEndOfCallReport(message);
    case "status-update":
      return handleStatusUpdate(message);
    default:
      return { kind: "ignored", reason: `unhandled:${type ?? "unknown"}` };
  }
}
