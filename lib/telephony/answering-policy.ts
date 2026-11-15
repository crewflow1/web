/**
 * AI receptionist ANSWERING POLICY — the pure decision of WHO takes an inbound
 * call: ring the company's staff first, hand to the AI receptionist, or leave it
 * to a human. The directive's three modes (§2) made deterministic and testable.
 *
 * This is intentionally a PURE function (no I/O, no DB, no `Date.now()` inside —
 * `now` is injected) so the Twilio voice webhook and the dial-status callback can
 * both consume it and the full matrix is unit-testable without a live call. The
 * free-text `ai_receptionist_setups.business_hours` stays as AI *context* only;
 * this module is the STRUCTURED gate that the (forthcoming) settings columns feed.
 */

export const ANSWERING_MODES = ["missed_only", "out_of_hours", "both"] as const;
export type AnsweringMode = (typeof ANSWERING_MODES)[number];

/** Mon..Sun keys — stable, locale-independent (not numeric, to avoid Sun=0 confusion). */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A day's opening window as local "HH:MM" (24h). `null` = closed that day. */
export type DayHours = { open: string; close: string } | null;

export type AnsweringConfig = {
  /** AI receptionist master switch (ai_receptionist_setups.enabled). */
  enabled: boolean;
  mode: AnsweringMode;
  /** IANA timezone, e.g. "Europe/London". Drives hours + closure evaluation. */
  timezone: string;
  /** Per-weekday opening window; a missing/`null` day is closed. */
  weekly: Partial<Record<Weekday, DayHours>>;
  /** Local YYYY-MM-DD dates treated as closed (bank holidays + exceptional closures). */
  closures?: readonly string[];
  /** Seconds to ring staff before the AI takes a missed/busy call (modes that ring first). */
  ringTimeoutSeconds: number;
  /** Whether any staff destination numbers are configured; if none, there is nobody to ring. */
  hasStaffNumbers: boolean;
};

/** What the telephony layer observed about the staff leg so far. */
export type StaffOutcome = "no_attempt_yet" | "answered" | "no_answer" | "busy" | "failed";

export type AnsweringDecision =
  | { action: "ring_staff"; ringSeconds: number; reason: string }
  | { action: "ai_answer"; reason: string }
  /**
   * Nobody should be answered LIVE on this call, but the caller must not be
   * dropped: take a message deterministically (no AI turn) and let the
   * missed-call text-back engine follow up. This is the `out_of_hours`-mode
   * edge where staff missed the call DURING open hours — the AI is scoped to
   * out-of-hours only, so it must stay out, yet a lead must still be captured.
   */
  | { action: "take_message"; reason: string }
  | { action: "human_handled"; reason: string }
  | { action: "disabled"; reason: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The local {weekday, HH:MM, YYYY-MM-DD} for an instant in a given IANA zone — pure, Intl-based. */
export function localParts(now: Date, timezone: string): { weekday: Weekday; minutes: number; date: string } {
  // en-GB + the target zone → deterministic 24h parts regardless of the host locale.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const wdMap: Record<string, Weekday> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
  const weekday = wdMap[parts.weekday as string] ?? "mon";
  // en-GB formats midnight as "24" in some engines; normalise to 00.
  const hh = parts.hour === "24" ? 0 : Number(parts.hour);
  const minutes = hh * 60 + Number(parts.minute);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { weekday, minutes, date };
}

function toMinutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Is the business OPEN at `now`, per weekly hours + closures + timezone? Pure. */
export function isWithinBusinessHours(cfg: AnsweringConfig, now: Date): boolean {
  const { weekday, minutes, date } = localParts(now, cfg.timezone);
  if (cfg.closures?.includes(date)) return false; // bank holiday / exceptional closure
  const day = cfg.weekly[weekday];
  if (!day) return false;
  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null || close <= open) return false; // malformed → treat as closed (fail-safe)
  return minutes >= open && minutes < close;
}

/**
 * Decide who handles the call. `staff` carries what the telephony layer has seen:
 * `no_attempt_yet` on the initial inbound webhook, then the dial-status outcome on
 * the dial callback. FAIL-SAFE: an unparseable/edge config never silently routes a
 * caller to a dead end — it falls through to the AI (capture the lead) rather than
 * dropping the call.
 */
export function decideAnswering(cfg: AnsweringConfig, now: Date, staff: StaffOutcome = "no_attempt_yet"): AnsweringDecision {
  if (!cfg.enabled) return { action: "disabled", reason: "AI receptionist disabled for this org" };

  // A human already took it — nothing for the AI to do.
  if (staff === "answered") return { action: "human_handled", reason: "staff answered the call" };

  const open = isWithinBusinessHours(cfg, now);

  // Should staff be rung first on THIS call? `missed_only` always tries staff
  // first (its whole purpose is "AI only takes what we miss"); `both` and
  // `out_of_hours` ring staff during OPEN hours (outside hours there is no point
  // ringing a closed office — the AI / message path takes it directly).
  const ringsStaffFirst =
    cfg.hasStaffNumbers && (cfg.mode === "missed_only" || open);

  if (staff === "no_attempt_yet" && ringsStaffFirst) {
    return {
      action: "ring_staff",
      ringSeconds: Math.max(5, cfg.ringTimeoutSeconds | 0),
      reason: `mode=${cfg.mode}, ${open ? "within" : "outside"} hours → ring staff first`,
    };
  }

  // From here: either there is no staff leg to ring, or the staff leg already
  // missed / was busy / failed. Decide the AI's role by mode.
  switch (cfg.mode) {
    case "missed_only":
      // AI covers EVERY unanswered call, in or out of hours.
      return { action: "ai_answer", reason: `missed_only mode, staff ${staff} → AI answers` };
    case "both":
      // AI covers both the miss AND the closed office.
      return { action: "ai_answer", reason: `both mode, ${open ? `staff ${staff}` : "outside hours"} → AI answers` };
    case "out_of_hours":
      // AI is scoped to the CLOSED office only. Outside hours it answers; inside
      // hours (staff missed, or no staff at all) it must stay out — but the
      // caller is not dropped: take a message deterministically and let the
      // missed-call text-back follow up.
      return open
        ? { action: "take_message", reason: `out_of_hours mode, within hours, staff ${staff} → take a message (AI stays out)` }
        : { action: "ai_answer", reason: "out_of_hours mode and outside hours → AI answers" };
    default:
      return { action: "ai_answer", reason: "unknown mode → fail safe to AI capture" };
  }
}

/** A sensible default per the directive: both modes, 20s staff ring, Europe/London, Mon–Fri 9–5. */
export function defaultAnsweringConfig(): AnsweringConfig {
  const nineToFive: DayHours = { open: "09:00", close: "17:00" };
  return {
    enabled: false,
    mode: "both",
    timezone: "Europe/London",
    weekly: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive, sat: null, sun: null },
    closures: [],
    ringTimeoutSeconds: 20,
    hasStaffNumbers: false,
  };
}
