import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ANSWERING_MODES,
  WEEKDAYS,
  defaultAnsweringConfig,
  type AnsweringConfig,
  type AnsweringMode,
  type DayHours,
  type Weekday,
} from "./answering-policy";

/**
 * Twilio receptionist PR 2 — LOAD the per-org structured answering policy + the
 * call-routing extras the voice webhooks need, from `ai_receptionist_setups`.
 *
 * The pure decision lives in `answering-policy.ts` (decideAnswering); this is the
 * I/O half that feeds it. It mirrors `receptionist-profile.ts` exactly:
 *   - SERVICE-ROLE admin client (the webhook has no signed-in user),
 *   - org-pinned on `org_id` (defence-in-depth on the RLS-bypassing client),
 *   - BEST-EFFORT + DARK-SAFE: NEVER throws. Any failure (unconfigured admin
 *     client, DB error, no row, malformed JSON) degrades to a DISABLED default
 *     config with no staff leg, so the webhook falls back to the prior generic
 *     behaviour. An org that has never configured the receptionist is `enabled:
 *     false` ⇒ decideAnswering returns `disabled` ⇒ the caller sees no change.
 *
 * Every value from the row is RE-VALIDATED here (numbers normalised to E.164,
 * HH:MM windows shape-checked, mode constrained to the enum) so a bad stored
 * value can never reach the TwiML or the policy.
 */

/** The loaded policy: the pure-decision config PLUS the routing/recording extras. */
export type LoadedAnsweringPolicy = {
  config: AnsweringConfig;
  /** Normalised E.164 staff destination numbers, rung simultaneously. */
  staffNumbers: string[];
  /** Optional single fallback number (E.164), or null. */
  fallbackNumber: string | null;
  /** Optional urgent-escalation transfer number (E.164), or null. */
  urgentNumber: string | null;
  /** Custom spoken greeting override, or null (→ business-name greeting). */
  greeting: string | null;
  /** Call-recording controls (dark by default). */
  recordingEnabled: boolean;
  transcriptionEnabled: boolean;
  /** Spoken consent disclosure to play before recording, or null. */
  consentMessage: string | null;
};

const E164 = /^\+[1-9]\d{6,14}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise one phone value to strict E.164, or null. Strips spaces/dashes/parens. */
function toE164(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[\s()\-.]/g, "").trim();
  return E164.test(cleaned) ? cleaned : null;
}

/** Parse a jsonb value into a clean E.164 list (dedup, order-preserving). */
function parseNumberList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    const n = toE164(entry);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Parse the stored weekly_hours jsonb into a validated per-weekday map. */
function parseWeekly(v: unknown): Partial<Record<Weekday, DayHours>> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: Partial<Record<Weekday, DayHours>> = {};
  let any = false;
  for (const day of WEEKDAYS) {
    const raw = src[day];
    if (raw == null) {
      out[day] = null;
      any = true;
      continue;
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      const open = typeof o.open === "string" ? o.open : "";
      const close = typeof o.close === "string" ? o.close : "";
      if (HHMM.test(open) && HHMM.test(close)) {
        out[day] = { open, close };
        any = true;
        continue;
      }
    }
    out[day] = null; // malformed → closed (fail-safe)
    any = true;
  }
  return any ? out : null;
}

/** Parse the stored closures jsonb into a clean YYYY-MM-DD list. */
function parseClosures(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string" && YMD.test(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function asMode(v: unknown): AnsweringMode {
  return typeof v === "string" && (ANSWERING_MODES as readonly string[]).includes(v)
    ? (v as AnsweringMode)
    : "both";
}

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The disabled fallback returned on any failure / missing row — AI stays dark. */
function disabledPolicy(): LoadedAnsweringPolicy {
  return {
    config: { ...defaultAnsweringConfig(), enabled: false, hasStaffNumbers: false },
    staffNumbers: [],
    fallbackNumber: null,
    urgentNumber: null,
    greeting: null,
    recordingEnabled: false,
    transcriptionEnabled: false,
    consentMessage: null,
  };
}

type SetupRow = {
  enabled: boolean | null;
  answering_mode: string | null;
  timezone: string | null;
  weekly_hours: unknown;
  closures: unknown;
  ring_timeout_seconds: number | null;
  staff_numbers: unknown;
  fallback_number: string | null;
  urgent_escalation_number: string | null;
  greeting: string | null;
  recording_enabled: boolean | null;
  transcription_enabled: boolean | null;
  recording_consent_message: string | null;
};

/**
 * Load + validate the org's answering policy. Returns a DISABLED policy on any
 * failure or absence — never throws. Org-pinned, admin client, best-effort.
 */
export async function loadAnsweringPolicy(
  orgId: string | null | undefined,
): Promise<LoadedAnsweringPolicy> {
  if (!orgId || !orgId.trim()) return disabledPolicy();
  const id = orgId.trim();

  try {
    const admin = createAdminClient();
    const { data, error } = await (
      admin.from("ai_receptionist_setups" as never) as unknown as {
        select: (cols: string) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: SetupRow | null; error: { message: string } | null }>;
          };
        };
      }
    )
      .select(
        "enabled, answering_mode, timezone, weekly_hours, closures, ring_timeout_seconds, staff_numbers, fallback_number, urgent_escalation_number, greeting, recording_enabled, transcription_enabled, recording_consent_message",
      )
      .eq("org_id", id)
      .maybeSingle();

    if (error) {
      console.error("[telephony] answering policy read failed", { orgId: id, message: error.message });
      return disabledPolicy();
    }
    if (!data) return disabledPolicy();

    const staffNumbers = parseNumberList(data.staff_numbers);
    const weekly = parseWeekly(data.weekly_hours);
    const defaults = defaultAnsweringConfig();
    const ring = Number.isFinite(data.ring_timeout_seconds as number)
      ? Math.max(5, Math.min(120, Number(data.ring_timeout_seconds)))
      : defaults.ringTimeoutSeconds;

    const config: AnsweringConfig = {
      enabled: data.enabled === true,
      mode: asMode(data.answering_mode),
      timezone: cleanText(data.timezone) ?? defaults.timezone,
      weekly: weekly ?? defaults.weekly,
      closures: parseClosures(data.closures),
      ringTimeoutSeconds: ring,
      hasStaffNumbers: staffNumbers.length > 0,
    };

    return {
      config,
      staffNumbers,
      fallbackNumber: toE164(data.fallback_number),
      urgentNumber: toE164(data.urgent_escalation_number),
      greeting: cleanText(data.greeting),
      recordingEnabled: data.recording_enabled === true,
      transcriptionEnabled: data.transcription_enabled === true,
      consentMessage: cleanText(data.recording_consent_message),
    };
  } catch (e) {
    console.error("[telephony] answering policy load failed", {
      orgId: id,
      message: e instanceof Error ? e.message : String(e),
    });
    return disabledPolicy();
  }
}
