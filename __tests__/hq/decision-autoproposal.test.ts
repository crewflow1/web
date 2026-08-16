import { describe, it, expect } from "vitest";
import {
  mapAlertToProposal,
  mapSignalsToProposals,
} from "@/lib/hq/decision-autoproposal";
import type { Alert } from "@/lib/hq/alert-rules";

/**
 * Decision-Centre AUTO-PROPOSAL mapper — pure, deterministic proofs.
 *
 * The mapper turns REAL alert signals into DRAFT decision proposals. These pin the
 * load-bearing rules: only CRITICAL signals map; every field is derived from the
 * alert's own data (honesty doctrine — nothing invented); and a batch de-dupes by
 * signal key. The "never decides" guarantee is a service + DB contract, proven in the
 * security tier; here we prove the mapping never fabricates.
 */

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    key: "failed_payment:org-1",
    ruleId: "failed_payment",
    ruleLabel: "Failed payment",
    severity: "critical",
    orgId: "org-1",
    orgName: "Acme Ltd",
    mrr: 499,
    health: 42,
    healthRisk: "high",
    reason: ["Card declined on 2026-08-10", "2 retries exhausted"],
    suggestion: "Call the customer today to update their card.",
    occurredAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapAlertToProposal — only CRITICAL signals raise a proposal", () => {
  it("maps a critical alert to a draft proposal", () => {
    const p = mapAlertToProposal(alert());
    expect(p).not.toBeNull();
    expect(p!.source).toBe("deterministic");
    expect(p!.sourceSignalKey).toBe("failed_payment:org-1");
  });

  it("returns null for a warning alert", () => {
    expect(mapAlertToProposal(alert({ severity: "warning" }))).toBeNull();
  });

  it("returns null for an info alert", () => {
    expect(mapAlertToProposal(alert({ severity: "info" }))).toBeNull();
  });
});

describe("mapAlertToProposal — honesty doctrine (derives, never invents)", () => {
  it("problem is the alert's own evidence, verbatim", () => {
    const p = mapAlertToProposal(alert())!;
    expect(p.problem).toBe("Card declined on 2026-08-10 · 2 retries exhausted");
  });

  it("revenue impact reflects the real MRR", () => {
    const p = mapAlertToProposal(alert({ mrr: 1200 }))!;
    expect(p.revenueImpact).toContain("£1,200");
    expect(p.revenueImpact).toContain("Acme Ltd");
  });

  it("states honestly when there is no MRR (never fabricates a number)", () => {
    const p = mapAlertToProposal(alert({ mrr: 0 }))!;
    expect(p.revenueImpact).toMatch(/no mrr recorded/i);
    expect(p.revenueImpact).not.toMatch(/£\d/);
  });

  it("risk carries the severity + health band when known", () => {
    const p = mapAlertToProposal(alert({ health: 30, healthRisk: "high" }))!;
    expect(p.risk).toContain("Failed payment");
    expect(p.risk).toContain("30");
    expect(p.risk).toContain("high");
  });

  it("omits the health clause when health is unknown", () => {
    const p = mapAlertToProposal(alert({ health: null, healthRisk: null }))!;
    expect(p.risk).not.toMatch(/health/i);
  });

  it("demand is never invented (null — alerts carry no demand signal)", () => {
    expect(mapAlertToProposal(alert())!.demand).toBeNull();
  });

  it("recommendation is the alert's own suggested action, verbatim", () => {
    const p = mapAlertToProposal(alert())!;
    expect(p.recommendation).toBe("Call the customer today to update their card.");
  });

  it("title names the rule and the org", () => {
    expect(mapAlertToProposal(alert())!.title).toBe("Failed payment — Acme Ltd");
  });
});

describe("mapSignalsToProposals — filter + de-dupe", () => {
  it("keeps only critical signals", () => {
    const proposals = mapSignalsToProposals([
      alert({ key: "a:1", severity: "critical" }),
      alert({ key: "b:2", severity: "warning" }),
      alert({ key: "c:3", severity: "info" }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.sourceSignalKey).toBe("a:1");
  });

  it("de-dupes by signal key within a batch", () => {
    const proposals = mapSignalsToProposals([
      alert({ key: "dup:1" }),
      alert({ key: "dup:1" }),
    ]);
    expect(proposals).toHaveLength(1);
  });

  it("is deterministic — same input yields the same output", () => {
    const input = [alert({ key: "a:1" }), alert({ key: "b:2" })];
    expect(mapSignalsToProposals(input)).toEqual(mapSignalsToProposals(input));
  });

  it("produces no proposal at all when nothing is critical", () => {
    expect(
      mapSignalsToProposals([alert({ severity: "warning" }), alert({ severity: "info" })]),
    ).toHaveLength(0);
  });
});
