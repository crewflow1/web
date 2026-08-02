import { describe, it, expect } from "vitest";
import {
  nextCallState,
  isTerminal,
  CALL_STATUSES,
  type CallStatus,
} from "@/lib/telephony/state-machine";
import { CALL_EVENT_TYPES, TERMINAL_CALL_EVENTS, type CallEventType } from "@/lib/telephony/types";

/**
 * The call state machine is a PURE reducer — it owns its own fast unit test,
 * unfolded into a route. These prove the load-bearing properties: every event
 * type is a valid next status, and terminal states are ABSORBING (a late/out-of-
 * order redelivery never walks a finished call back to a live phase).
 */

describe("nextCallState — pure reducer", () => {
  it("advances a live call to the event's status", () => {
    expect(nextCallState("initiated", "ringing")).toBe("ringing");
    expect(nextCallState("ringing", "answered")).toBe("answered");
    expect(nextCallState("answered", "in_progress")).toBe("in_progress");
    expect(nextCallState("in_progress", "completed")).toBe("completed");
  });

  it("is TOTAL — returns a valid status for every (status, event) pair", () => {
    for (const status of CALL_STATUSES) {
      for (const event of CALL_EVENT_TYPES) {
        const next = nextCallState(status, event as CallEventType);
        expect(CALL_STATUSES).toContain(next);
      }
    }
  });

  it("terminal states are ABSORBING — no event walks them back", () => {
    for (const terminal of TERMINAL_CALL_EVENTS) {
      for (const event of CALL_EVENT_TYPES) {
        // Whatever arrives, a terminal status stands.
        expect(nextCallState(terminal as CallStatus, event as CallEventType)).toBe(terminal);
      }
    }
  });

  it("a late 'ringing' after 'completed' does NOT resurrect the call", () => {
    expect(nextCallState("completed", "ringing")).toBe("completed");
    expect(nextCallState("failed", "in_progress")).toBe("failed");
  });
});

describe("isTerminal", () => {
  it("is true for exactly the terminal set", () => {
    for (const t of TERMINAL_CALL_EVENTS) expect(isTerminal(t)).toBe(true);
    for (const live of ["initiated", "ringing", "answered", "in_progress", "transferred"] as const) {
      expect(isTerminal(live)).toBe(false);
    }
  });
});
