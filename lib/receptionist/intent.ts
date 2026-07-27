/**
 * CrewFlow HQ — Voice Receptionist AI: booking-intent detection + proposal
 * composition (the AI Receptionist Programme, R2 — the harvest; employee #26).
 *
 * The pure layer behind the Receptionist's booking / callback handling. It
 * DETECTS that a caller asked to book or to be called back, and COMPOSES the
 * confirmation the AI would be PROPOSING — never a send, never a commitment. This
 * is the deterministic reducer half of the T3 contract: the Receptionist may
 * recognise "book me in for Tuesday" and draft the reply, but the reply is
 * phrased as a commitment BY CONSTRUCTION, so the guardrail
 * ({@link import("./policy").evaluateReply}) honestly returns `review` (category
 * `booking`) over it and a human owns the send. The customer's requested time is
 * captured only as a PHRASE ("Tuesday morning"); the actual scheduled date is the
 * human's to set on confirm.
 *
 * PROVENANCE. Harvested verbatim (behaviour-preserving) from the earlier
 * comms-platform booking layer (REC-26, `lib/channels/booking.ts`) and re-homed
 * onto the canonical receptionist domain. Only the detection + composition — the
 * pure half — re-homes here; the server booking seam, the `booking_requests`
 * store, and the confirm→job bridge are transport/persistence and are deferred to
 * a later increment. The ported unit test pins that the behaviour, and above all
 * the keystone (a composed confirmation is a guardrail `review`, never `allow`),
 * is identical to the harvested original.
 *
 * A shared, PURE module (NOT server-only, NO I/O, no clock, no RNG) — the same
 * discipline as {@link import("./policy")}: the same message always yields the
 * same intent, so what the Receptionist proposes is reconstructable from named
 * rules, never an opaque model sample.
 */

/** What the customer asked for. */
export const BOOKING_KINDS = ["appointment", "callback"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

/** Bounds — keep captured free text proportionate (and defend the columns). */
export const MAX_BOOKING_WINDOW = 120;
export const MAX_BOOKING_NOTES = 400;
export const MAX_BOOKING_SUMMARY = 200;

/** A detected booking / callback request. */
export type BookingIntent = {
  kind: BookingKind;
  /** The customer's requested time PHRASE, when present — never a committed date. */
  window: string | null;
  /** Which cues fired (for the audit metadata / debugging) — deterministic order. */
  signals: string[];
};

// ---------------------------------------------------------------------
// Detection — deterministic, conservative (catch a real request, not a hedge).
// ---------------------------------------------------------------------

/** Explicit "call me back" cues → a callback. */
const CALLBACK_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ["call_me_back", /\bcall\s+me\s+back\b/i],
  ["callback", /\bcall\s?back\b/i],
  ["call_me", /\bcall\s+me\b/i],
  ["give_me_a_call", /\bgive\s+me\s+a\s+(?:call|ring|bell)\b/i],
  ["ring_me", /\bring\s+me(?:\s+back)?\b/i],
  ["phone_me", /\bphone\s+me(?:\s+back)?\b/i],
];

/** Explicit "book me / come out / are you free" cues → an appointment. */
const APPOINTMENT_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ["book", /\bbook(?:ing|ed)?\b/i],
  ["appointment", /\bappointment\b/i],
  ["schedule", /\b(?:re)?schedule\b/i],
  ["slot", /\bslot\b/i],
  ["site_visit", /\bsite\s+visit\b/i],
  ["come_out", /\bcome\s+(?:round|out|over|by|to)\b/i],
  ["pop_round", /\bpop\s+(?:round|out|over|by)\b/i],
  ["send_someone", /\bsend\s+someone\b/i],
  ["someone_come", /\bsomeone\s+(?:to\s+)?come\b/i],
  ["are_you_free", /\bare\s+you\s+(?:free|available)\b/i],
  ["when_can_you", /\bwhen\s+can\s+(?:you|someone)\s+(?:come|start|do|visit|attend)\b/i],
  ["fit_me_in", /\b(?:fit|squeeze)\s+me\s+in\b/i],
];

// Component fragments for the requested-time window. Kept as strings so the
// window matcher is a single, readable alternation compiled once.
const DAY =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|wednes|thurs?|fri|sat|sun)";
const DAYPART = "(?:morning|afternoon|evening|midday|noon|tonight)";
const TIME = "(?:\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)|\\d{1,2}\\s?o'?clock)";

/**
 * The requested-time window — the leftmost, most-specific time phrase. Ordered
 * day-first so "Tuesday at 2pm" is captured whole rather than as a bare "2pm".
 * A bare day/time alone is NOT booking intent (that is what the cues decide);
 * this only shapes the window once intent is established.
 */
const WINDOW_RE = new RegExp(
  [
    `\\b(?:next|this|on|coming)\\s+${DAY}\\b(?:\\s+${DAYPART})?(?:\\s+(?:at\\s+)?${TIME})?`,
    `\\b${DAY}\\b(?:\\s+${DAYPART})?(?:\\s+(?:at\\s+)?${TIME})?`,
    `\\b(?:today|tomorrow|tonight)\\b(?:\\s+${DAYPART})?(?:\\s+(?:at\\s+)?${TIME})?`,
    `\\b(?:this|next)\\s+week(?:end)?\\b`,
    `\\b(?:this\\s+)?${DAYPART}\\b(?:\\s+(?:at\\s+)?${TIME})?`,
    `\\b${TIME}\\b`,
  ].join("|"),
  "i",
);

/** A soft "come" cue that only counts as intent when paired with a time window. */
const SOFT_COME_RE = /\bcome\b/i;

/**
 * Detect a booking / callback request in a customer's message.
 *
 * Returns the intent (kind + requested-time phrase + the cues that fired) or
 * `null` when there is no booking signal. Callback cues take precedence over
 * appointment cues; a bare "come …" counts only alongside a time window. The
 * window is a bounded PHRASE — never a parsed, committed date.
 */
export function detectBookingIntent(text: string | null | undefined): BookingIntent | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const window = extractWindow(raw);

  const callbackSignals = CALLBACK_CUES.filter(([, re]) => re.test(raw)).map(([id]) => id);
  if (callbackSignals.length > 0) {
    return { kind: "callback", window, signals: callbackSignals };
  }

  const appointmentSignals = APPOINTMENT_CUES.filter(([, re]) => re.test(raw)).map(([id]) => id);
  if (appointmentSignals.length > 0) {
    return { kind: "appointment", window, signals: appointmentSignals };
  }

  // "Can you come Tuesday at 2pm?" — "come" is only a booking cue with a time.
  if (window && SOFT_COME_RE.test(raw)) {
    return { kind: "appointment", window, signals: ["come_with_window"] };
  }

  return null;
}

/** Extract the bounded requested-time window phrase, or null. */
function extractWindow(text: string): string | null {
  const match = text.match(WINDOW_RE);
  if (!match) return null;
  // Drop a bare leading "on " connector ("on Tuesday" → "Tuesday"); keep the
  // meaningful "this / next / coming" qualifiers.
  const phrase = match[0].replace(/\s+/g, " ").replace(/^on\s+/i, "").trim();
  if (!phrase) return null;
  return phrase.length <= MAX_BOOKING_WINDOW ? phrase : phrase.slice(0, MAX_BOOKING_WINDOW).trimEnd();
}

// ---------------------------------------------------------------------
// Composition — the proposal (guarded, never sent) + the operator label.
// ---------------------------------------------------------------------

/**
 * Compose the customer-facing confirmation the AI is PROPOSING.
 *
 * Phrased as an explicit commitment BY CONSTRUCTION ("I've booked you in …" /
 * "I've scheduled your callback …") so the guardrail (`evaluateReply`) returns
 * `review` under category `booking` over it — never `allow`. This text is the
 * subject of the guardrail audit; it is NOT auto-sent. A human owns the send.
 */
export function composeBookingConfirmation(intent: BookingIntent): string {
  const forWindow = intent.window ? ` for ${intent.window}` : "";
  if (intent.kind === "callback") {
    return `I've scheduled your callback${forWindow}.`;
  }
  return `I've booked you in${forWindow}.`;
}

/**
 * The one-line operator label for the inbox queue — a plain description of what
 * the customer asked for. Deterministic and bounded; never sent to the customer.
 */
export function composeBookingSummary(intent: BookingIntent): string {
  const noun = intent.kind === "callback" ? "Callback" : "Appointment";
  const forWindow = intent.window ? ` for ${intent.window}` : "";
  const label = `${noun} requested${forWindow}`;
  return label.length <= MAX_BOOKING_SUMMARY ? label : label.slice(0, MAX_BOOKING_SUMMARY).trimEnd();
}
