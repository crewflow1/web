import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_FILTERS,
  deriveLifecycleStage,
  formatLifecycleTimestamp,
  isLifecycleFilter,
  isTerminalStage,
  stageMatchesFilter,
  type LifecycleRow,
  type LifecycleStage,
} from "@/lib/ai-receptionist/lifecycle";

/**
 * Reply-delivery lifecycle read model — unit tier (the AI Receptionist Programme, R9:
 * DELIVERY MONITORING).
 *
 * `deriveLifecycleStage` is the read model's ONE derived value: it folds a lifecycle row
 * (audit ⟕ transport ⟕ latest receipt) into the single coarse stage the operator triages
 * on. These tests pin every branch of that fold across the eight lifecycle shapes, prove
 * the stage→filter bucketing the list surface uses for both its pill counts and its rows,
 * and pin the small pure helpers (filter guard, timestamp format). Pure logic, no DB — the
 * join behaviour itself is proven against real Postgres in the integration tier.
 */

/** A minimal, ALLOWED-and-sent-and-delivered row; override per case. */
function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    audit_id: "aud-1",
    org_id: "org-1",
    employee_slug: "voice-receptionist-ai",
    channel: "sms",
    enquiry_id: null,
    lead_id: null,
    customer_ref: "+447700900000",
    correlation_id: "corr-1",
    draft: "Thanks — we'll be in touch.",
    verdict: "allow",
    allowed: true,
    categories: [],
    enforcement_reason: "clean",
    safe_text: null,
    audit_at: "2026-07-03T09:00:00.000Z",
    transport_id: "tr-1",
    transport_status: "sent",
    transport_provider: "twilio",
    provider_message_id: "SM-1",
    transport_failure_reason: null,
    to_ref: "+447700900000",
    attempt: 1,
    cost_usd: null,
    latency_ms: null,
    dedup_key: null,
    transport_at: "2026-07-03T09:00:01.000Z",
    receipt_id: "rc-1",
    delivery_status: "delivered",
    delivery_terminal: true,
    delivery_provider_status: null,
    delivery_error_code: null,
    receipt_at: "2026-07-03T09:00:05.000Z",
    receipt_count: 1,
    ...overrides,
  };
}

describe("deriveLifecycleStage — the coarse triage stage for each lifecycle shape", () => {
  it("blocked: a refused reply never reaches a transport", () => {
    expect(
      deriveLifecycleStage(
        row({ verdict: "block", allowed: false, transport_id: null, receipt_id: null }),
      ),
    ).toBe("blocked");
  });

  it("review: a held reply is not auto-carried", () => {
    expect(
      deriveLifecycleStage(
        row({ verdict: "review", allowed: false, transport_id: null, receipt_id: null }),
      ),
    ).toBe("review");
  });

  it("not_sent: allowed, but no transport was attempted", () => {
    expect(
      deriveLifecycleStage(
        row({ transport_id: null, transport_status: null, receipt_id: null }),
      ),
    ).toBe("not_sent");
  });

  it("send_failed: the transport attempt itself failed", () => {
    expect(
      deriveLifecycleStage(
        row({
          transport_status: "failed",
          provider_message_id: null,
          transport_failure_reason: "no_provider",
          receipt_id: null,
        }),
      ),
    ).toBe("send_failed");
  });

  it("awaiting_receipt: sent, but the provider has reported nothing yet", () => {
    expect(
      deriveLifecycleStage(
        row({ receipt_id: null, delivery_status: null, delivery_terminal: null, receipt_count: 0 }),
      ),
    ).toBe("awaiting_receipt");
  });

  it("in_transit: sent, a NON-terminal provider status has arrived", () => {
    expect(
      deriveLifecycleStage(
        row({ delivery_status: "queued", delivery_terminal: false, receipt_count: 1 }),
      ),
    ).toBe("in_transit");
  });

  it("delivered: a terminal 'delivered' receipt", () => {
    expect(deriveLifecycleStage(row())).toBe("delivered");
  });

  it("delivery_failed: a terminal non-delivery (undelivered/failed/canceled)", () => {
    for (const s of ["undelivered", "failed", "canceled"] as const) {
      expect(
        deriveLifecycleStage(
          row({ delivery_status: s, delivery_terminal: true, delivery_error_code: "30008" }),
        ),
        s,
      ).toBe("delivery_failed");
    }
  });

  it("treats allowed=false as held even if verdict string is unexpected (deny-by-default)", () => {
    // The DB pins allowed = (verdict='allow'); if allowed is false the reply was never
    // auto-sendable, so it can carry no transport — never classified as a send outcome.
    expect(deriveLifecycleStage(row({ allowed: false, transport_id: null }))).toBe("blocked");
  });
});

describe("stageMatchesFilter — the list buckets (counts and rows share this predicate)", () => {
  const stages: LifecycleStage[] = [
    "blocked",
    "review",
    "not_sent",
    "send_failed",
    "awaiting_receipt",
    "in_transit",
    "delivered",
    "delivery_failed",
  ];

  it("'all' matches every stage", () => {
    for (const s of stages) expect(stageMatchesFilter(s, "all")).toBe(true);
  });

  it("'held' matches exactly blocked + review", () => {
    const matched = stages.filter((s) => stageMatchesFilter(s, "held"));
    expect(matched).toEqual(["blocked", "review"]);
  });

  it("'awaiting' matches exactly awaiting_receipt + in_transit", () => {
    const matched = stages.filter((s) => stageMatchesFilter(s, "awaiting"));
    expect(matched).toEqual(["awaiting_receipt", "in_transit"]);
  });

  it("'delivered' matches exactly delivered", () => {
    const matched = stages.filter((s) => stageMatchesFilter(s, "delivered"));
    expect(matched).toEqual(["delivered"]);
  });

  it("'failed' matches exactly send_failed + delivery_failed", () => {
    const matched = stages.filter((s) => stageMatchesFilter(s, "failed"));
    expect(matched).toEqual(["send_failed", "delivery_failed"]);
  });

  it("every non-'all' filter is a strict subset of 'all' (no stage is orphaned from a bucket it should be in)", () => {
    // Every stage that is a settled failure or hold lands in some non-'all' bucket.
    const buckets = LIFECYCLE_FILTERS.filter((f) => f.key !== "all");
    for (const s of stages) {
      const inSome = buckets.some((f) => stageMatchesFilter(s, f.key));
      // not_sent is the one interim, non-failure, non-delivered stage with no bucket — it
      // only shows under 'all'. Everything else belongs to at least one triage bucket.
      if (s === "not_sent") expect(inSome).toBe(false);
      else expect(inSome, s).toBe(true);
    }
  });
});

describe("isTerminalStage — settled outcomes", () => {
  it("is true for the settled fates and false for the in-flight ones", () => {
    expect(isTerminalStage("blocked")).toBe(true);
    expect(isTerminalStage("send_failed")).toBe(true);
    expect(isTerminalStage("delivered")).toBe(true);
    expect(isTerminalStage("delivery_failed")).toBe(true);
    expect(isTerminalStage("review")).toBe(false);
    expect(isTerminalStage("not_sent")).toBe(false);
    expect(isTerminalStage("awaiting_receipt")).toBe(false);
    expect(isTerminalStage("in_transit")).toBe(false);
  });
});

describe("pure helpers", () => {
  it("isLifecycleFilter narrows only the known filter keys", () => {
    expect(isLifecycleFilter("all")).toBe(true);
    expect(isLifecycleFilter("held")).toBe(true);
    expect(isLifecycleFilter("failed")).toBe(true);
    expect(isLifecycleFilter("nope")).toBe(false);
    expect(isLifecycleFilter(undefined)).toBe(false);
    expect(isLifecycleFilter(null)).toBe(false);
  });

  it("formatLifecycleTimestamp renders 'YYYY-MM-DD HH:MM' or an em dash", () => {
    expect(formatLifecycleTimestamp("2026-07-03T09:00:05.000Z")).toBe("2026-07-03 09:00");
    expect(formatLifecycleTimestamp(null)).toBe("—");
    expect(formatLifecycleTimestamp(undefined)).toBe("—");
  });
});
