import { describe, it, expect } from "vitest";
import {
  CALL_OUTCOMES,
  CALL_SENTIMENTS,
  CALL_STATUSES,
  OBJECTION_CATEGORIES,
  OPEN_CALL_STATUSES,
  SCRIPT_CATEGORIES,
  callDirectionLabel,
  callOutcomeLabel,
  callOutcomeTone,
  callSentimentLabel,
  callStatusLabel,
  formatDuration,
  isConnectedOutcome,
  isDialledStatus,
  isOpenCallStatus,
  objectionCategoryLabel,
  playbookStatusLabel,
  scriptCategoryLabel,
  sentimentTone,
  summariseCalls,
  type CallSummaryInput,
} from "@/lib/sales/calling";

/**
 * CrewFlow HQ — AI Calling Centre model tests (CEO Directive 004, Phase 6).
 *
 * The Calling Centre renders its queue, per-call records, script library and
 * objection playbook from these pure functions, so the tests pin the call
 * vocabulary + labels, the status/outcome semantics that drive the queue and
 * connect-rate, the pill tone mapping, the duration formatter, and the window
 * roll-up maths (connect-rate denominator, talk-time average, follow-ups due).
 */

const NOW = "2026-06-18T12:00:00.000Z";
const NOW_MS = new Date(NOW).getTime();

function call(over: Partial<CallSummaryInput> = {}): CallSummaryInput {
  return {
    status: "queued",
    outcome: "unknown",
    sentiment: "unknown",
    duration_seconds: null,
    ended_at: null,
    follow_up_at: null,
    follow_up_done: false,
    ...over,
  };
}

describe("calling — vocabulary + labels", () => {
  it("mirrors the DB CHECK constraints exactly", () => {
    expect(CALL_STATUSES).toHaveLength(9);
    expect(CALL_OUTCOMES).toHaveLength(11);
    expect(CALL_SENTIMENTS).toHaveLength(5);
    expect(SCRIPT_CATEGORIES).toHaveLength(9);
    expect(OBJECTION_CATEGORIES).toHaveLength(9);
  });

  it("labels every status, outcome, sentiment, category and direction", () => {
    expect(callStatusLabel("in_progress")).toBe("In progress");
    expect(callStatusLabel("no_answer")).toBe("No answer");
    expect(callOutcomeLabel("callback_requested")).toBe("Callback requested");
    expect(callOutcomeLabel("demo_booked")).toBe("Demo booked");
    expect(callSentimentLabel("mixed")).toBe("Mixed");
    expect(scriptCategoryLabel("cold_call")).toBe("Cold call");
    expect(scriptCategoryLabel("follow_up")).toBe("Follow-up");
    expect(objectionCategoryLabel("price")).toBe("Price");
    expect(callDirectionLabel("outbound")).toBe("Outbound");
    expect(playbookStatusLabel("archived")).toBe("Archived");
  });

  it("falls back to the raw slug for unknown values", () => {
    expect(callStatusLabel("pigeon")).toBe("pigeon");
    expect(callOutcomeLabel("pigeon")).toBe("pigeon");
    expect(scriptCategoryLabel("pigeon")).toBe("pigeon");
  });
});

describe("calling — status / outcome semantics", () => {
  it("knows which statuses are still open (the queue)", () => {
    expect(OPEN_CALL_STATUSES).toEqual(["queued", "scheduled", "in_progress"]);
    expect(isOpenCallStatus("queued")).toBe(true);
    expect(isOpenCallStatus("scheduled")).toBe(true);
    expect(isOpenCallStatus("completed")).toBe(false);
    expect(isOpenCallStatus("cancelled")).toBe(false);
  });

  it("knows which statuses count as a dial (connect-rate denominator)", () => {
    expect(isDialledStatus("completed")).toBe(true);
    expect(isDialledStatus("no_answer")).toBe(true);
    expect(isDialledStatus("voicemail")).toBe(true);
    expect(isDialledStatus("queued")).toBe(false);
    expect(isDialledStatus("scheduled")).toBe(false);
    expect(isDialledStatus("cancelled")).toBe(false);
  });

  it("knows which outcomes count as a productive connection", () => {
    expect(isConnectedOutcome("connected")).toBe(true);
    expect(isConnectedOutcome("meeting_booked")).toBe(true);
    expect(isConnectedOutcome("demo_booked")).toBe(true);
    expect(isConnectedOutcome("no_answer")).toBe(false);
    expect(isConnectedOutcome("not_interested")).toBe(false);
  });
});

describe("calling — tone mapping", () => {
  it("tones an outcome for its pill", () => {
    expect(callOutcomeTone("demo_booked")).toBe("positive");
    expect(callOutcomeTone("connected")).toBe("positive");
    expect(callOutcomeTone("not_interested")).toBe("negative");
    expect(callOutcomeTone("do_not_call")).toBe("negative");
    expect(callOutcomeTone("no_answer")).toBe("neutral");
    expect(callOutcomeTone("gatekeeper")).toBe("neutral");
    expect(callOutcomeTone("pigeon")).toBe("neutral");
  });

  it("tones a sentiment for its pill", () => {
    expect(sentimentTone("positive")).toBe("positive");
    expect(sentimentTone("negative")).toBe("negative");
    expect(sentimentTone("mixed")).toBe("neutral");
    expect(sentimentTone("unknown")).toBe("neutral");
  });
});

describe("calling — formatDuration", () => {
  it("formats seconds, minutes and hours; em-dash for missing", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(240)).toBe("4m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(3780)).toBe("1h 3m");
  });
});

describe("calling — summariseCalls", () => {
  const calls: CallSummaryInput[] = [
    // Completed, demo booked, positive, future follow-up (not due).
    call({
      status: "completed",
      outcome: "demo_booked",
      sentiment: "positive",
      duration_seconds: 252,
      ended_at: "2026-06-17T09:00:00.000Z",
      follow_up_at: "2026-06-19T09:00:00.000Z",
    }),
    // Completed, connected, neutral, overdue follow-up (due).
    call({
      status: "completed",
      outcome: "connected",
      sentiment: "neutral",
      duration_seconds: 45,
      ended_at: "2026-06-18T08:00:00.000Z",
      follow_up_at: "2026-06-17T09:00:00.000Z",
    }),
    // No answer — dialled, not connected, no duration.
    call({
      status: "no_answer",
      outcome: "no_answer",
      ended_at: "2026-06-16T09:00:00.000Z",
    }),
    // Voicemail — dialled, overdue follow-up but already done (not due).
    call({
      status: "voicemail",
      outcome: "left_voicemail",
      duration_seconds: 20,
      ended_at: "2026-06-15T09:00:00.000Z",
      follow_up_at: "2026-06-10T09:00:00.000Z",
      follow_up_done: true,
    }),
    // Still queued — open, no dial.
    call({ status: "queued" }),
    // Scheduled — open, no dial.
    call({ status: "scheduled" }),
    // Completed, not interested, negative, latest ended_at.
    call({
      status: "completed",
      outcome: "not_interested",
      sentiment: "negative",
      duration_seconds: 600,
      ended_at: "2026-06-18T10:00:00.000Z",
    }),
  ];
  const stats = summariseCalls(calls, NOW_MS);

  it("rolls up the headline counts", () => {
    expect(stats.total).toBe(7);
    expect(stats.queued).toBe(2); // queued + scheduled (open)
    expect(stats.completed).toBe(3);
    expect(stats.dialled).toBe(5); // 3 completed + no_answer + voicemail
    expect(stats.connected).toBe(2); // demo_booked + connected
    expect(stats.connectRate).toBe(40); // 2 / 5
  });

  it("computes talk time only from calls with a recorded duration", () => {
    expect(stats.totalTalkSeconds).toBe(917); // 252 + 45 + 20 + 600
    expect(stats.avgTalkSeconds).toBe(229); // round(917 / 4)
  });

  it("reports every sentiment and outcome, including the silent ones", () => {
    expect(stats.bySentiment).toHaveLength(CALL_SENTIMENTS.length);
    const positive = stats.bySentiment.find((s) => s.slug === "positive");
    expect(positive?.count).toBe(1);
    const unknown = stats.bySentiment.find((s) => s.slug === "unknown");
    expect(unknown?.count).toBe(4); // no_answer + voicemail + queued + scheduled

    expect(stats.byOutcome).toHaveLength(CALL_OUTCOMES.length);
    expect(stats.byOutcome.find((o) => o.slug === "demo_booked")?.count).toBe(1);
    expect(stats.byOutcome.find((o) => o.slug === "unknown")?.count).toBe(2);
    expect(stats.byOutcome.find((o) => o.slug === "do_not_call")?.count).toBe(0);
    expect(stats.byOutcome.reduce((n, o) => n + o.count, 0)).toBe(7);
  });

  it("counts only overdue, not-done follow-ups as due", () => {
    expect(stats.followUpsDue).toBe(1); // the overdue, undone one only
  });

  it("tracks the most recent call end time", () => {
    expect(stats.lastCallAt).toBe("2026-06-18T10:00:00.000Z");
  });

  it("is safe on an empty window", () => {
    const empty = summariseCalls([], NOW_MS);
    expect(empty.total).toBe(0);
    expect(empty.connectRate).toBe(0);
    expect(empty.avgTalkSeconds).toBe(0);
    expect(empty.lastCallAt).toBeNull();
    expect(empty.bySentiment).toHaveLength(CALL_SENTIMENTS.length);
  });
});
