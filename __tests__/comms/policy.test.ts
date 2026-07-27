import { describe, it, expect } from "vitest";
import { VERB_GROUPS } from "@/lib/events/registry";
import {
  COMM_STATES,
  ACTIVE_STATES,
  TERMINAL_STATES,
  COMM_ACTIONS,
  TRANSITIONS,
  isActive,
  isTerminal,
  verbFor,
  isInsertAction,
  bornState,
  canApply,
  nextState,
  legalActions,
  type CommAction,
} from "@/lib/comms/state";
import {
  normalizeAddress,
  isValidEmail,
  isSuppressed,
  suppressionReasonForOutcome,
  canRetry,
  retryDelayMs,
  plaintextToHtml,
  MAX_DELIVERY_ATTEMPTS,
  SUPPRESSION_REASONS,
} from "@/lib/comms/policy";
import { emailCostUsd } from "@/lib/comms/cost";

/**
 * CrewFlow HQ — Communication Layer: the pure core, unit-pinned (Directive 010, Phase 4).
 *
 * Phase 4 delivers an APPROVED draft through a replaceable provider. Like the Approval
 * Engine's transition map and the Draft Engine's prompt construction, the layer's
 * DETERMINISTIC decisions are pure and PROVABLE — so they are proven here, exhaustively,
 * with no database and no network. These are the CEO success criteria as executable spec:
 *   • the delivery state machine is deterministic and total — every (action, state) pair
 *     has a definite, named answer, and no move exists that the map omits;
 *   • the hard safety rules are CODE, not comments — a suppressed address is never sent
 *     to, and a bounce/complaint/suppression is NEVER retried (the repeat-contact a
 *     do-not-contact list exists to prevent);
 *   • one event vocabulary — every transition emits a verb the frozen registry froze;
 *   • costs are measurable — an accepted send has a recorded (or honestly-unknown) cost.
 *
 * The state machine here is the MIRROR; the database trigger is the ENFORCER;
 * __tests__/security/comms-invariants.test.ts pins that they never diverge.
 */

// =====================================================================
// 1. The delivery state machine — deterministic, total, one vocabulary.
// =====================================================================

describe("comms state machine — states & lifecycle classification", () => {
  it("enumerates exactly the six delivery states", () => {
    expect(COMM_STATES).toEqual([
      "sent",
      "delivered",
      "bounced",
      "complained",
      "failed",
      "suppressed",
    ]);
  });

  it("`sent` is the ONLY active state; everything else is terminal (frozen forever)", () => {
    expect(ACTIVE_STATES).toEqual(["sent"]);
    expect([...TERMINAL_STATES].sort()).toEqual(
      ["bounced", "complained", "delivered", "failed", "suppressed"].sort(),
    );
    // Active and terminal partition the state space — no overlap, no gap.
    for (const s of COMM_STATES) {
      expect(isActive(s)).toBe(!isTerminal(s));
    }
    expect(isActive("sent")).toBe(true);
    expect(isTerminal("delivered")).toBe(true);
    expect(isTerminal("suppressed")).toBe(true);
  });
});

describe("comms state machine — actions map to the frozen comm.* vocabulary, honestly attributed", () => {
  it("the six actions are exactly the six reserved comm.* verbs — no more, no less", () => {
    expect(COMM_ACTIONS).toEqual(["send", "fail", "suppress", "deliver", "bounce", "complain"]);
    const verbs = COMM_ACTIONS.map(verbFor).sort();
    expect(verbs).toEqual([...VERB_GROUPS.comm].sort());
  });

  it("mints NO vocabulary beyond the registry — every action verb is a registered comm.* verb", () => {
    for (const action of COMM_ACTIONS) {
      const verb = verbFor(action);
      expect(verb).toMatch(/^comm\./);
      expect(VERB_GROUPS.comm).toContain(verb as (typeof VERB_GROUPS.comm)[number]);
    }
  });

  it("attributes the actor honestly — `send` is the employee's one deliberate act; the rest are the world reporting back (system)", () => {
    expect(TRANSITIONS.send.actor).toBe("ai_employee");
    for (const action of ["fail", "suppress", "deliver", "bounce", "complain"] as CommAction[]) {
      expect(TRANSITIONS[action].actor).toBe("system");
    }
  });

  it("maps each action to its exact reserved verb", () => {
    expect(verbFor("send")).toBe("comm.sent");
    expect(verbFor("fail")).toBe("comm.failed");
    expect(verbFor("suppress")).toBe("comm.suppressed");
    expect(verbFor("deliver")).toBe("comm.delivered");
    expect(verbFor("bounce")).toBe("comm.bounced");
    expect(verbFor("complain")).toBe("comm.complained");
  });
});

describe("comms state machine — INSERT (born) actions vs transitions", () => {
  it("send/fail/suppress are INSERTs that BORN the row; deliver/bounce/complain are transitions", () => {
    expect(isInsertAction("send")).toBe(true);
    expect(isInsertAction("fail")).toBe(true);
    expect(isInsertAction("suppress")).toBe(true);
    expect(isInsertAction("deliver")).toBe(false);
    expect(isInsertAction("bounce")).toBe(false);
    expect(isInsertAction("complain")).toBe(false);
  });

  it("a row is born sent/failed/suppressed — never delivered/bounced/complained", () => {
    expect(bornState("send")).toBe("sent");
    expect(bornState("fail")).toBe("failed");
    expect(bornState("suppress")).toBe("suppressed");
    expect(bornState("deliver")).toBeNull();
    expect(bornState("bounce")).toBeNull();
    expect(bornState("complain")).toBeNull();
  });
});

describe("comms state machine — canApply / nextState / legalActions are deterministic and total", () => {
  it("INSERT actions are NEVER legal on an existing row (they born, they do not transition)", () => {
    for (const from of COMM_STATES) {
      expect(canApply("send", from)).toBe(false);
      expect(canApply("fail", from)).toBe(false);
      expect(canApply("suppress", from)).toBe(false);
    }
  });

  it("a live `sent` row may ONLY move to delivered / bounced / complained", () => {
    expect(legalActions("sent").sort()).toEqual(["bounce", "complain", "deliver"].sort());
    expect(nextState("deliver", "sent")).toBe("delivered");
    expect(nextState("bounce", "sent")).toBe("bounced");
    expect(nextState("complain", "sent")).toBe("complained");
  });

  it("a terminal row is frozen — no action is legal from it", () => {
    for (const term of TERMINAL_STATES) {
      expect(legalActions(term)).toEqual([]);
      expect(nextState("deliver", term)).toBeNull();
      expect(nextState("bounce", term)).toBeNull();
      expect(nextState("complain", term)).toBeNull();
    }
  });

  it("every (action, state) pair has a definite yes/no — total, never undefined", () => {
    for (const action of COMM_ACTIONS) {
      for (const from of COMM_STATES) {
        expect(typeof canApply(action, from)).toBe("boolean");
        const next = nextState(action, from);
        expect(next === null || COMM_STATES.includes(next)).toBe(true);
      }
    }
  });
});

// =====================================================================
// 2. Address policy — one canonical form, conservative validation.
// =====================================================================

describe("comms policy — address normalisation & validation", () => {
  it("extracts the bare address from a display-name field and lower-cases it", () => {
    expect(normalizeAddress("Jane Roe <Jane.Roe@Example.COM>")).toBe("jane.roe@example.com");
    expect(normalizeAddress("  Plain@Host.IO  ")).toBe("plain@host.io");
    expect(normalizeAddress("a@b.co")).toBe("a@b.co");
  });

  it("normalisation is idempotent — normalising a normalised address is a no-op", () => {
    const once = normalizeAddress("Owner <Owner@Crewflow.UK>");
    expect(normalizeAddress(once)).toBe(once);
  });

  it("accepts a conservative real address and rejects the obvious non-addresses", () => {
    expect(isValidEmail("jane@example.com")).toBe(true);
    expect(isValidEmail("Jane Roe <jane@example.co.uk>")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("missing@domain")).toBe(false); // no dotted domain
    expect(isValidEmail("two @spaces.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

// =====================================================================
// 3. Suppression — the do-not-contact rule, as code.
// =====================================================================

describe("comms policy — suppression matching & the outcome→reason mapping", () => {
  it("matches a suppressed address regardless of display-name wrapping or case", () => {
    const set = new Set(["blocked@example.com"]);
    expect(isSuppressed("Blocked <Blocked@Example.com>", set)).toBe(true);
    expect(isSuppressed("blocked@example.com", set)).toBe(true);
    expect(isSuppressed("someone-else@example.com", set)).toBe(false);
  });

  it("a bounce and a complaint suppress; a delivery (and a clean send) do NOT", () => {
    expect(suppressionReasonForOutcome("bounced")).toBe("bounce");
    expect(suppressionReasonForOutcome("complained")).toBe("complaint");
    expect(suppressionReasonForOutcome("delivered")).toBeNull();
    expect(suppressionReasonForOutcome("sent")).toBeNull();
    expect(suppressionReasonForOutcome("failed")).toBeNull();
    expect(suppressionReasonForOutcome("suppressed")).toBeNull();
  });

  it("the suppression reasons are exactly bounce / complaint / manual", () => {
    expect(SUPPRESSION_REASONS).toEqual(["bounce", "complaint", "manual"]);
  });
});

// =====================================================================
// 4. Retry — bounded, deterministic, and NEVER for a bounce/complaint.
// =====================================================================

describe("comms policy — retry eligibility & deterministic backoff", () => {
  it("ONLY a transport `failed` row is retryable — never sent/delivered/bounced/complained/suppressed", () => {
    expect(canRetry("failed", 1)).toBe(true);
    expect(canRetry("sent", 1)).toBe(false);
    expect(canRetry("delivered", 1)).toBe(false);
    expect(canRetry("bounced", 1)).toBe(false); // the hard "never retry a bounce" rule
    expect(canRetry("complained", 1)).toBe(false);
    expect(canRetry("suppressed", 1)).toBe(false);
  });

  it("retry is bounded by MAX_DELIVERY_ATTEMPTS — the last attempt cannot be retried again", () => {
    expect(canRetry("failed", MAX_DELIVERY_ATTEMPTS - 1)).toBe(true);
    expect(canRetry("failed", MAX_DELIVERY_ATTEMPTS)).toBe(false);
    expect(canRetry("failed", MAX_DELIVERY_ATTEMPTS + 1)).toBe(false);
  });

  it("backoff is deterministic, exponential, and capped — same attempt in → same delay out", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    // Monotonic non-decreasing, and capped at six hours.
    let prev = 0;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = retryDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(prev);
      expect(delay).toBeLessThanOrEqual(6 * 60 * 60_000);
      prev = delay;
    }
    expect(retryDelayMs(1)).toBe(retryDelayMs(1)); // pure
  });
});

// =====================================================================
// 5. Rendering — plaintext draft body → deterministic, escaped HTML.
// =====================================================================

describe("comms policy — plaintextToHtml is deterministic and escapes first", () => {
  it("same body in → byte-identical HTML out", () => {
    const body = "Hi there,\n\nA quick note.\nSecond line.\n\nRegards";
    expect(plaintextToHtml(body)).toBe(plaintextToHtml(body));
  });

  it("blank-line blocks become <p>; single newlines become <br>", () => {
    const html = plaintextToHtml("Para one.\nstill one.\n\nPara two.");
    expect(html).toBe("<p>Para one.<br>still one.</p>\n<p>Para two.</p>");
  });

  it("escapes HTML-significant characters so draft prose is NEVER interpreted as markup", () => {
    const html = plaintextToHtml("5 < 6 & 7 > 2 <script>alert('x')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });
});

// =====================================================================
// 6. Cost — observability, provider metadata, never a gate.
// =====================================================================

describe("comms cost — per-message pricing is provider metadata, unknown degrades to null", () => {
  it("prices the configured resend:email pairing", () => {
    expect(emailCostUsd({ provider: "resend", channel: "email" })).toBe(0);
  });

  it("an unknown provider/channel pairing is honestly unknown (null) — cost never gates a send", () => {
    expect(emailCostUsd({ provider: "unconfigured", channel: "email" })).toBeNull();
    expect(emailCostUsd({ provider: "resend", channel: "sms" })).toBeNull();
  });
});
