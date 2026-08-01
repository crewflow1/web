/**
 * Maintenance-reminders readiness — the ONE feature flag that decides whether
 * the proactive-send engine actually sends (Phase 7).
 *
 * Mirrors lib/comms/readiness.ts in posture: reads `process.env` DIRECTLY (not
 * the validated `env` object), imports no provider SDK, and CAN NEVER THROW, so
 * it is edge-safe and usable from `/api/health` if wired there. It reports a
 * fact — "is the send switched on" — and flips nothing.
 *
 * DARK BY DEFAULT. The flag is `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS`, and
 * it is OFF unless explicitly set to the string `"true"`. With it off — the
 * production default today — the drain records `skipped_dark` and sends NOTHING.
 * Turning reminders on is exactly this env flip PLUS a genuinely sendable email
 * provider (getEmailReadiness().outboundReady); neither alone is enough, the
 * same "no false-green" rule the comms readiness module enforces.
 */

import { getEmailReadiness } from "@/lib/comms/readiness";

/** The env flag name, in one place so callers and tests can't drift from it. */
export const MAINTENANCE_REMINDERS_FLAG = "NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS";

/**
 * Is proactive maintenance-reminder SENDING switched on for this deploy?
 *
 * Default OFF. Only the exact string `"true"` enables it — any other value
 * (unset, "1", "yes", "false") is treated as dark, so a typo fails SAFE (no
 * accidental customer emails) rather than open.
 *
 * This is the PRODUCT switch only. It says nothing about whether email can
 * actually send — the drain additionally requires `getEmailReadiness().
 * outboundReady` before a single message leaves the building.
 */
export function isMaintenanceRemindersLive(): boolean {
  return process.env[MAINTENANCE_REMINDERS_FLAG] === "true";
}

/**
 * Is proactive maintenance-reminder SENDING actually happening on this deploy?
 *
 * The ONE source of truth for "reminders will be sent", composed of BOTH
 * switches the drain requires: the product flag (`isMaintenanceRemindersLive`)
 * AND a genuinely-sendable email provider (`getEmailReadiness().outboundReady`).
 * Neither alone is enough — the same "no false-green" rule the comms readiness
 * module enforces.
 *
 * Exported so the drain's live decision and the customer-portal "we'll email
 * you" copy read the EXACT same predicate and can never disagree: while dark
 * (the default) both see `false`, so the portal keeps telling customers to
 * diarise. Edge-safe and cannot throw — `getEmailReadiness` reads `process.env`
 * directly and imports no provider SDK, so this stays as dependency-free as the
 * flag check it wraps.
 */
export function maintenanceRemindersSending(): boolean {
  return isMaintenanceRemindersLive() && getEmailReadiness().outboundReady;
}
