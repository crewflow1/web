import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWhatsAppReadiness } from "@/lib/comms/readiness";
import {
  voiceInboundFeatureEnabled,
  isVoiceProviderResolvable,
  selectedVoiceProvider,
} from "@/lib/telephony/config";
import type { ChecklistRow } from "./launch-readiness";

/**
 * ACTIVATION PREFLIGHT — the DB-aware "last mile" the credential readiness skips.
 *
 * `lib/comms/readiness.ts` and `lib/telephony/config.ts` report CREDENTIAL +
 * FLAG readiness (env only). But a channel can be fully credentialled, flag ON,
 * and STILL silently process nothing because the per-org ACTIVATION ROW is
 * absent: WhatsApp attributes inbound via a `whatsapp_number_routes` row and
 * only runs a turn when a live `ai_receptionist_setups` row exists; voice
 * attributes a call via an active `phone_numbers` row. That is exactly the shape
 * behind the prior WhatsApp activation that received "0 POSTs" — switched on,
 * but with nothing for inbound to resolve against.
 *
 * This module composes credential/flag readiness WITH those DB-row checks and
 * flags the dangerous middle state — switched ON but no activation row — RED,
 * so a blind activation becomes a verified one. It makes NO provider calls and
 * reads NO secret values (only presence booleans + row counts). The remaining
 * check after GREEN is the provider-side webhook handshake, which can only be
 * confirmed in the provider's own dashboard (noted in the row).
 *
 * Service-role only; surfaced on the HQ-gated /admin/launch-checklist page.
 */

export type ActivationRowReq = { label: string; present: boolean };

export type ActivationState = "green" | "amber" | "red";

/**
 * Pure decision logic (unit-tested). Given whether the flag is on, whether the
 * credentials are present (with the exact missing list), and the set of required
 * activation rows, decide the status + operator message. No IO.
 */
export function composeActivationRow(opts: {
  id: string;
  label: string;
  flagOn: boolean;
  flagHint: string;
  credsPresent: boolean;
  credsMissing: readonly string[];
  activationRows: readonly ActivationRowReq[];
  providerHandshakeNote: string;
}): ChecklistRow {
  const { id, label, flagOn, flagHint, credsPresent, credsMissing, activationRows, providerHandshakeNote } = opts;
  const switchedOn = flagOn && credsPresent;
  const missingRows = activationRows.filter((r) => !r.present).map((r) => r.label);
  const rowsAllPresent = missingRows.length === 0;

  // The dangerous middle: switched ON + credentialled, but an activation row is
  // missing → inbound resolves nothing and fails SILENTLY. This is the bug the
  // preflight exists to catch.
  if (switchedOn && !rowsAllPresent) {
    return {
      id,
      label,
      status: "red",
      summary: `MISCONFIGURED — flag on + credentials present, but missing ${missingRows.join(" + ")}. Inbound will attribute nothing (the silent "0 POSTs"/no-route failure). Add the row(s) before going live.`,
      detail: `Required activation rows: ${activationRows.map((r) => `${r.label}=${r.present ? "present" : "MISSING"}`).join(", ")}.`,
    };
  }

  if (switchedOn && rowsAllPresent) {
    return {
      id,
      label,
      status: "green",
      summary: `Activated: flag on, credentials present, activation rows present. Remaining: confirm the provider-side webhook handshake — ${providerHandshakeNote}`,
      detail: `Rows: ${activationRows.map((r) => r.label).join(", ")}. This check makes no provider call; verify the live handshake with one real smoke test.`,
    };
  }

  // Not switched on → dark by design (AMBER, not RED). Say exactly what's needed.
  const todo: string[] = [];
  if (!flagOn) todo.push(flagHint);
  if (!credsPresent) todo.push(...credsMissing);
  if (missingRows.length) todo.push(...missingRows);
  return {
    id,
    label,
    status: "amber",
    summary: `Dark (not yet activated). To activate: ${todo.join(" + ")}.`,
    detail: `Credentials ${credsPresent ? "present" : "missing"}; flag ${flagOn ? "on" : "off"}; rows [${activationRows
      .map((r) => `${r.label}:${r.present ? "yes" : "no"}`)
      .join(", ")}].`,
  };
}

type CountFn = (table: string, filter?: (b: unknown) => unknown) => Promise<number>;

/** Row-count helper against the service-role client (head/count, no row data). */
function makeCounter(admin: ReturnType<typeof createAdminClient>): CountFn {
  return async (table, filter) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (admin as any).from(table).select("id", { count: "exact", head: true });
      if (filter) q = filter(q);
      const { count, error } = await q;
      if (error) return -1; // unknown — treated as "not confirmed present"
      return typeof count === "number" ? count : 0;
    } catch {
      return -1;
    }
  };
}

/**
 * The live preflight rows for the comms/voice channels, composed from env
 * readiness + DB activation-row counts. A count of -1 (read failed) is treated
 * as "not present" so the preflight fails safe (never a false green).
 */
export async function getActivationPreflightRows(
  admin = createAdminClient(),
): Promise<ChecklistRow[]> {
  const count = makeCounter(admin);

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  const wa = getWhatsAppReadiness();
  const waFlagOn = process.env.NEXT_PUBLIC_FEATURE_WHATSAPP === "true";
  // Inbound credentials = app secret + verify token (the flag is handled separately).
  const waCredsMissing = wa.inboundBlockers.filter((b) => b !== "NEXT_PUBLIC_FEATURE_WHATSAPP=true");
  const waRoutes = await count("whatsapp_number_routes");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waLiveSetups = await count("ai_receptionist_setups", (b: any) =>
    b.eq("enabled", true).eq("status", "live"),
  );
  const whatsapp = composeActivationRow({
    id: "activation-whatsapp",
    label: "WhatsApp activation",
    flagOn: waFlagOn,
    flagHint: "NEXT_PUBLIC_FEATURE_WHATSAPP=true",
    credsPresent: waCredsMissing.length === 0,
    credsMissing: waCredsMissing.length ? waCredsMissing : ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"],
    activationRows: [
      { label: "a whatsapp_number_routes row", present: waRoutes > 0 },
      { label: "a live ai_receptionist_setups row", present: waLiveSetups > 0 },
    ],
    providerHandshakeNote:
      "in Meta: subscribe the app to the number's webhook and confirm the verify-token GET handshake succeeds.",
  });

  // ── Voice (telephone receptionist) ─────────────────────────────────────────
  const voiceFlagOn = voiceInboundFeatureEnabled();
  const voiceProviderOk = isVoiceProviderResolvable();
  const activePhones = await count("phone_numbers", (b: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b as any).eq("active", true),
  );
  const voice = composeActivationRow({
    id: "activation-voice",
    label: "Telephone receptionist activation",
    flagOn: voiceFlagOn,
    flagHint: "NEXT_PUBLIC_FEATURE_VOICE_INBOUND=true",
    credsPresent: voiceProviderOk,
    credsMissing: ["Twilio (TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN) or Vapi (VAPI_WEBHOOK_SECRET) credentials"],
    activationRows: [{ label: "an active phone_numbers row", present: activePhones > 0 }],
    providerHandshakeNote: `point the ${selectedVoiceProvider() ?? "provider"}'s voice webhook at the call routes and place one real test call.`,
  });

  return [whatsapp, voice];
}
