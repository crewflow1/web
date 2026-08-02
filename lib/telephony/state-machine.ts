/**
 * Voice Telephony (Wave 8) — the call state machine, as a PURE reducer.
 *
 * A call advances through provider lifecycle events. This module is the ONE
 * place that decides what `calls.status` becomes when an event arrives, and it
 * is deliberately pure: no I/O, no clock, no database. That is what lets the
 * status webhook be a thin adapter (verify → append event → reduce → persist)
 * and lets this logic own a fast unit test rather than needing Postgres.
 *
 * Terminal events are ABSORBING: once a call is completed/failed/etc., a late or
 * out-of-order event (providers deliver at-least-once and unordered) never walks
 * it back to a live state. That is the load-bearing property — without it a
 * "ringing" redelivered after "completed" would resurrect a finished call.
 */

import { TERMINAL_CALL_EVENTS, type CallEventType } from "./types";

/**
 * The persisted call statuses. A superset-shaped mirror of the lifecycle: the
 * live phases plus the terminal outcomes. `initiated`/`ringing`/`answered`/
 * `in_progress`/`transferred` are live; the rest are terminal.
 */
export const CALL_STATUSES = [
  "initiated",
  "ringing",
  "answered",
  "in_progress",
  "transferred",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const TERMINAL = new Set<CallEventType>(TERMINAL_CALL_EVENTS);

/** True when a status is terminal — the call is over and advances no further. */
export function isTerminal(status: CallStatus | CallEventType): boolean {
  return TERMINAL.has(status as CallEventType);
}

/**
 * The reducer: given the call's CURRENT status and an arriving event, return the
 * NEXT status.
 *
 * Rules, in order:
 *   1. If the current status is already terminal, it is ABSORBING — the event is
 *      ignored and the terminal status stands (out-of-order/late redelivery).
 *   2. Otherwise the event's type IS the next status. Every event type is also a
 *      valid status by construction (the two vocabularies are the same set), so
 *      an `answered` event moves a `ringing` call to `answered`, a `completed`
 *      event moves any live call to `completed`, and so on.
 *
 * Pure and total: it returns a valid status for every (status, event) pair and
 * never throws.
 */
export function nextCallState(current: CallStatus, event: CallEventType): CallStatus {
  if (isTerminal(current)) return current;
  return event;
}
