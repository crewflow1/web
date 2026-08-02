import { describe, it, expect } from "vitest";
import {
  computeSupportBoard,
  SUPPORT_KIND_LABEL,
  SUPPORT_SLA_HOURS,
  type SupportBoard,
  type SupportBoardInput,
  type SupportBoardTicket,
  type SupportMetric,
} from "@/lib/hq/support-ai";
import { isActiveStatus } from "@/lib/hq/support";

/**
 * HQ Support AI — pure triage board contract.
 *
 * Pins:
 *   1. Deterministic triage: open/total counts, aging buckets, SLA breaches,
 *      oldest-open age, priority + category mix and top-category share are exact
 *      from fixtures, and the same inputs + `now` always give the same board.
 *   2. The honesty invariant: with ZERO tickets every metric is `insufficient`
 *      with a stated basis and value === null — never a fabricated 0-as-real.
 *      With tickets present but NONE active, the queue-shape figures go
 *      insufficient while the counts stay honest derived zeros.
 *   3. Every figure carries a label and a non-empty basis.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

function ticket(overrides: Partial<SupportBoardTicket>): SupportBoardTicket {
  return {
    status: "open",
    priority: "normal",
    category: "other",
    createdAt: hoursAgo(1),
    resolvedAt: null,
    closedAt: null,
    lastReplyAt: null,
    lastReplyKind: null,
    ...overrides,
  };
}

// A representative HQ queue: 4 active + 1 resolved.
//   A urgent/billing   100h old, customer last replied  → breach (>4h)
//   B high/bug          30h old, hq last replied         → breach (>24h)
//   C normal/bug       200h old, customer last replied   → breach (>72h), >7d
//   D low/onboarding    10h old, no reply yet            → no breach (<168h)
//   E normal/billing   500h old, RESOLVED                → excluded from triage
const FIXTURE: SupportBoardTicket[] = [
  ticket({ priority: "urgent", category: "billing", createdAt: hoursAgo(100), status: "open", lastReplyKind: "customer" }),
  ticket({ priority: "high", category: "bug", createdAt: hoursAgo(30), status: "in_progress", lastReplyKind: "hq" }),
  ticket({ priority: "normal", category: "bug", createdAt: hoursAgo(200), status: "waiting_on_customer", lastReplyKind: "customer" }),
  ticket({ priority: "low", category: "onboarding", createdAt: hoursAgo(10), status: "open", lastReplyKind: null }),
  ticket({ priority: "normal", category: "billing", createdAt: hoursAgo(500), status: "resolved", resolvedAt: hoursAgo(1) }),
];

const BASE: SupportBoardInput = { tickets: FIXTURE };

function metric(board: SupportBoard, key: string): SupportMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeSupportBoard — deterministic triage", () => {
  const board = computeSupportBoard(BASE, NOW);

  it("open tickets = a count of the active rows themselves; total = every row", () => {
    expect(metric(board, "open_tickets").value).toBe(4);
    expect(metric(board, "open_tickets").kind).toBe("fact");
    expect(metric(board, "total_tickets").value).toBe(5);
    expect(metric(board, "total_tickets").kind).toBe("fact");
  });

  it("open tickets == the number of active tickets in the fixture (never a separate head count that could diverge)", () => {
    const activeInFixture = FIXTURE.filter((t) => isActiveStatus(t.status)).length;
    expect(activeInFixture).toBe(4);
    // The board's open_tickets is derived from the SAME active rows the aging
    // buckets triage, so it can never disagree with them or be a swallowed zero.
    expect(metric(board, "open_tickets").value).toBe(activeInFixture);
  });

  it("aging buckets over ACTIVE tickets are exact and derived", () => {
    expect(metric(board, "unresolved_over_24h").value).toBe(3); // A,B,C
    expect(metric(board, "unresolved_over_72h").value).toBe(2); // A,C
    expect(metric(board, "unresolved_over_7d").value).toBe(1); // C
    for (const k of ["unresolved_over_24h", "unresolved_over_72h", "unresolved_over_7d"]) {
      expect(metric(board, k).kind).toBe("derived");
    }
  });

  it("oldest open age = the oldest active ticket's age in hours", () => {
    const m = metric(board, "oldest_open_age");
    expect(m.value).toBe(200);
    expect(m.kind).toBe("derived");
    expect(m.format).toBe("hours");
  });

  it("urgent-open and awaiting-reply headline counts are exact", () => {
    expect(metric(board, "urgent_open").value).toBe(1); // A
    expect(metric(board, "awaiting_reply").value).toBe(2); // A,C
  });

  it("SLA breaches count active tickets past their priority target", () => {
    // A(100>4) B(30>24) C(200>72) breach; D(10<168) does not.
    expect(metric(board, "sla_breaches").value).toBe(3);
    expect(metric(board, "sla_breaches").kind).toBe("derived");
  });

  it("priority mix covers all priorities over active tickets (canonical order)", () => {
    expect(board.priorityMix.map((b) => b.key)).toEqual([
      "low",
      "normal",
      "high",
      "urgent",
    ]);
    // 1 each of 4 active → 25% each.
    for (const b of board.priorityMix) {
      expect(b.count).toBe(1);
      expect(b.share).toBe(25);
    }
  });

  it("category mix is the recurring-theme signal, busiest first, zeros dropped", () => {
    expect(board.categoryMix.map((b) => b.key)).toEqual([
      "bug", // 2
      "billing", // 1 (tie broken alphabetically)
      "onboarding", // 1
    ]);
    expect(board.categoryMix[0]).toMatchObject({ key: "bug", count: 2, share: 50 });
  });

  it("top category share names and quantifies the recurring theme", () => {
    const m = metric(board, "top_category_share");
    expect(m.value).toBe(50); // bug: 2 of 4 active
    expect(m.kind).toBe("derived");
    expect(m.basis).toMatch(/Bug/);
  });

  it("is a pure function of (input, now) — identical inputs give an identical board", () => {
    expect(computeSupportBoard(BASE, NOW)).toEqual(computeSupportBoard(BASE, NOW));
  });

  it("stamps asOf + period label from the injected now (no wall clock)", () => {
    expect(board.asOf).toBe("2026-08-01T12:00:00.000Z");
    expect(board.periodLabel).toBe("August 2026");
  });

  it("publishes the SLA policy as reviewable data", () => {
    expect(SUPPORT_SLA_HOURS).toEqual({ urgent: 4, high: 24, normal: 72, low: 168 });
  });
});

describe("computeSupportBoard — insufficient when NO tickets (never a fake 0)", () => {
  const board = computeSupportBoard({ tickets: [] }, NOW);

  it("every metric is insufficient with value null — not a zero queue", () => {
    expect(board.metrics.length).toBeGreaterThan(0);
    for (const m of board.metrics) {
      expect(m.kind).toBe("insufficient");
      expect(m.value).toBeNull();
      expect(m.value).not.toBe(0);
      expect(m.basis).toMatch(/no support tickets/i);
    }
  });

  it("both breakdown mixes are empty", () => {
    expect(board.priorityMix).toEqual([]);
    expect(board.categoryMix).toEqual([]);
  });

  it("still stamps a period label from now", () => {
    expect(board.periodLabel).toBe("August 2026");
  });
});

describe("computeSupportBoard — tickets present but none active", () => {
  // One resolved + one closed ticket: counts are honest zeros, queue-shape
  // figures (oldest-open age, top-category share) are insufficient.
  const board = computeSupportBoard(
    {
      tickets: [
        ticket({ status: "resolved", createdAt: hoursAgo(300) }),
        ticket({ status: "closed", createdAt: hoursAgo(400) }),
      ],
    },
    NOW,
  );

  it("open tickets is an honest fact zero — tickets exist but none is active", () => {
    expect(metric(board, "open_tickets").value).toBe(0);
    expect(metric(board, "open_tickets").kind).toBe("fact");
  });

  it("total is a real fact, aging/breach counts are honest derived zeros", () => {
    expect(metric(board, "total_tickets").value).toBe(2);
    expect(metric(board, "unresolved_over_24h").value).toBe(0);
    expect(metric(board, "sla_breaches").value).toBe(0);
    expect(metric(board, "sla_breaches").kind).toBe("derived");
  });

  it("oldest-open age and top-category share are insufficient (nothing open to measure)", () => {
    expect(metric(board, "oldest_open_age").kind).toBe("insufficient");
    expect(metric(board, "oldest_open_age").value).toBeNull();
    expect(metric(board, "top_category_share").kind).toBe("insufficient");
    expect(metric(board, "top_category_share").value).toBeNull();
  });

  it("mixes are empty when nothing is active", () => {
    expect(board.priorityMix).toEqual([]);
    expect(board.categoryMix).toEqual([]);
  });
});

describe("computeSupportBoard — a malformed createdAt is NOT treated as fresh (P2-3)", () => {
  // One active ticket with a broken timestamp, one with a real 100h age. The
  // broken one must never read as a healthy 0h-old ticket that silently never
  // ages and never breaches — it is counted as `unmeasurable` instead.
  const board = computeSupportBoard(
    {
      tickets: [
        ticket({ status: "open", priority: "urgent", category: "bug", createdAt: "not-a-real-date" }),
        ticket({ status: "open", priority: "normal", category: "bug", createdAt: hoursAgo(100) }),
      ],
    },
    NOW,
  );

  it("the malformed ticket is excluded from aging and SLA, not aged from 0h", () => {
    // Only the 100h ticket ages / breaches; the malformed one contributes to none.
    expect(metric(board, "unresolved_over_24h").value).toBe(1);
    expect(metric(board, "unresolved_over_72h").value).toBe(1);
    expect(metric(board, "unresolved_over_7d").value).toBe(0);
    expect(metric(board, "sla_breaches").value).toBe(1);
  });

  it("surfaces the malformed ticket as an honest `unmeasurable` count", () => {
    const u = metric(board, "unmeasurable");
    expect(u.value).toBe(1);
    expect(u.kind).toBe("derived");
    expect(u.basis).toMatch(/timestamp/i);
  });

  it("open tickets still counts BOTH active rows (validity is independent of the count)", () => {
    // The malformed ticket is still an active ticket; only its AGE is unknown.
    expect(metric(board, "open_tickets").value).toBe(2);
  });

  it("oldest open age still measures the one valid ticket", () => {
    expect(metric(board, "oldest_open_age").value).toBe(100);
    expect(metric(board, "oldest_open_age").kind).toBe("derived");
  });

  it("when EVERY active ticket is unmeasurable, oldest-open age is insufficient (never -Infinity/NaN)", () => {
    const allBroken = computeSupportBoard(
      {
        tickets: [
          ticket({ status: "open", createdAt: "" }),
          ticket({ status: "in_progress", createdAt: "garbage" }),
        ],
      },
      NOW,
    );
    expect(metric(allBroken, "unmeasurable").value).toBe(2);
    expect(metric(allBroken, "unresolved_over_24h").value).toBe(0);
    expect(metric(allBroken, "sla_breaches").value).toBe(0);
    const oldest = metric(allBroken, "oldest_open_age");
    expect(oldest.kind).toBe("insufficient");
    expect(oldest.value).toBeNull();
    // But there ARE active tickets, so open_tickets is a real fact, not zero.
    expect(metric(allBroken, "open_tickets").value).toBe(2);
  });
});

describe("computeSupportBoard — every metric self-labels", () => {
  it("has a label word for every kind and a non-empty basis on every metric", () => {
    const board = computeSupportBoard(BASE, NOW);
    expect(Object.keys(SUPPORT_KIND_LABEL).sort()).toEqual([
      "derived",
      "fact",
      "insufficient",
    ]);
    for (const m of board.metrics) {
      expect(m.basis.trim().length).toBeGreaterThan(0);
      expect(["fact", "derived", "insufficient"]).toContain(m.kind);
      // The value/kind invariant: null iff insufficient.
      if (m.kind === "insufficient") expect(m.value).toBeNull();
      else expect(typeof m.value).toBe("number");
    }
  });
});
