import { describe, it, expect } from "vitest";
import {
  FIELD_PRIORITY,
  prioritiseFields,
  missingInformation,
  nextRequiredInformation,
  isGoalSatisfied,
  isTurnRequired,
  detectGap,
  type ConversationGap,
} from "@/lib/receptionist/conversation-gap";
import {
  INFORMATION_FIELDS,
  GOAL_SLOTS,
  outstandingSlots,
  isInformationComplete,
  type ConversationInformation,
  type InformationField,
} from "@/lib/receptionist/conversation-information";
import {
  CONVERSATION_GOALS,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";

/**
 * THE CONVERSATION GAP ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R21 — CONVERSATION GAP ENGINE).
 *
 * lib/receptionist/conversation-gap.ts is the deterministic, leaf authority over conversational
 * COMPLETENESS — the single source of truth for "given the objective and the facts we hold, what is still
 * MISSING, which missing item matters MOST, is the objective SATISFIED, and is another turn REQUIRED?". It
 * is the FIRST layer of the stack that persists NOTHING: the gap is a TOTAL, DETERMINISTIC function of two
 * already-persisted observations — the R19 goal and the R20 information — so it is exhaustively
 * unit-testable in isolation. These tests pin, EXHAUSTIVELY:
 *   • FIELD_PRIORITY is a single, independent PERMUTATION of the R20 field vocabulary (a genuine cross-goal
 *     ordering, deliberately NOT the vocabulary's declaration order — it is its exact reverse);
 *   • prioritiseFields is a deterministic, NON-MUTATING priority sort that re-orders ANY subset;
 *   • detectGap derives the completeness view for EVERY goal × representative information state, with the
 *     priority-ordered `missing`, the single `nextRequired`, `satisfied` and `turnRequired`;
 *   • nextRequired is always the HIGHEST-PRIORITY missing field, even when facts arrive out of priority
 *     order (the cardinal slot-filling behaviour);
 *   • completeness is DELEGATED wholesale to R20 (isGoalSatisfied === isInformationComplete) — the gap
 *     engine forks no "what's missing / is it complete" logic, it only adds the priority semantics on top;
 *   • the whole surface is TOTAL over the goal vocabulary and DETERMINISTIC, and detectGap is the faithful
 *     composition of its parts (the single entry point every consumer calls).
 */

// The canonical field values a customer provides — one per information field, in the exact form the R20
// extractors canonicalise to (so an information record here is byte-identical to a persisted one).
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";
const PHONE = "+447700900123";
const EMAIL = "jo@brightspark.co.uk";
const FULL: ConversationInformation = {
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
  email_address: EMAIL,
};

describe("R21 gap engine — FIELD_PRIORITY: a single, independent cross-goal ordering", () => {
  it("is EXACTLY the deliberate priority order — qualify the work + location, then contact, email last", () => {
    expect(FIELD_PRIORITY).toEqual([
      "job_type",
      "postcode",
      "phone_number",
      "email_address",
    ]);
  });

  it("is a PERMUTATION of the R20 field vocabulary — same members, same count, no duplicates", () => {
    // Every field the schema can ever ask for has a defined rank, and no rank is invented: FIELD_PRIORITY
    // and INFORMATION_FIELDS are the SAME SET. So prioritising any subset of the vocabulary is total.
    expect([...FIELD_PRIORITY].sort()).toEqual([...INFORMATION_FIELDS].sort());
    expect(FIELD_PRIORITY.length).toBe(INFORMATION_FIELDS.length);
    expect(new Set(FIELD_PRIORITY).size).toBe(FIELD_PRIORITY.length);
  });

  it("is INDEPENDENT of the vocabulary's declaration order — it is its exact REVERSE, not a copy", () => {
    // The strongest independence proof: FIELD_PRIORITY is not INFORMATION_FIELDS re-labelled — it is a
    // genuinely different ordering (here, the exact reverse). The gap engine's priority is its OWN semantic.
    expect(FIELD_PRIORITY).toEqual([...INFORMATION_FIELDS].reverse());
    expect([...FIELD_PRIORITY]).not.toEqual([...INFORMATION_FIELDS]);
  });
});

describe("R21 gap engine — prioritiseFields: deterministic, non-mutating priority sort", () => {
  it("re-orders a SHUFFLED set into canonical priority order (the direct sorter proof)", () => {
    const shuffled: InformationField[] = [
      "email_address",
      "job_type",
      "phone_number",
      "postcode",
    ];
    expect(prioritiseFields(shuffled)).toEqual([
      "job_type",
      "postcode",
      "phone_number",
      "email_address",
    ]);
  });

  it("orders the FULL vocabulary given in reverse back to FIELD_PRIORITY", () => {
    expect(prioritiseFields([...INFORMATION_FIELDS])).toEqual([...FIELD_PRIORITY]);
  });

  it("does NOT mutate its input (copies before sorting)", () => {
    const input: InformationField[] = ["email_address", "job_type"];
    const snapshot = [...input];
    prioritiseFields(input);
    expect(input).toEqual(snapshot);
  });

  it("is deterministic — the same input always yields the same order", () => {
    const input: InformationField[] = ["phone_number", "job_type", "email_address"];
    expect(prioritiseFields(input)).toEqual(prioritiseFields(input));
  });

  it("preserves EXACTLY the input fields — an ordering, never a filter", () => {
    const subset: InformationField[] = ["email_address", "postcode"];
    expect([...prioritiseFields(subset)].sort()).toEqual([...subset].sort());
  });

  it("returns [] for the empty set", () => {
    expect(prioritiseFields([])).toEqual([]);
  });
});

describe("R21 gap engine — detectGap: the derived completeness view, per goal (empty information)", () => {
  // With NOTHING provided, the gap is exactly the goal's slot schema, priority-ordered.
  const cases: ReadonlyArray<{
    goal: ConversationGoal;
    missing: InformationField[];
    nextRequired: InformationField | null;
    satisfied: boolean;
  }> = [
    { goal: "undetermined", missing: [], nextRequired: null, satisfied: true },
    { goal: "answer_enquiry", missing: [], nextRequired: null, satisfied: true },
    {
      goal: "arrange_booking",
      missing: ["job_type", "postcode", "phone_number"],
      nextRequired: "job_type",
      satisfied: false,
    },
    {
      goal: "arrange_callback",
      missing: ["phone_number"],
      nextRequired: "phone_number",
      satisfied: false,
    },
    {
      goal: "provide_quote",
      missing: ["job_type", "postcode", "phone_number", "email_address"],
      nextRequired: "job_type",
      satisfied: false,
    },
    {
      goal: "handoff_to_human",
      missing: ["phone_number"],
      nextRequired: "phone_number",
      satisfied: false,
    },
  ];

  for (const c of cases) {
    it(`${c.goal}: missing=[${c.missing.join(", ")}], next=${c.nextRequired}, satisfied=${c.satisfied}`, () => {
      const gap = detectGap(c.goal, {});
      expect(gap).toEqual<ConversationGap>({
        goal: c.goal,
        missing: c.missing,
        nextRequired: c.nextRequired,
        satisfied: c.satisfied,
        turnRequired: !c.satisfied,
      });
    });
  }

  it("covers EVERY goal in the vocabulary (no goal left untested)", () => {
    expect(cases.map((c) => c.goal).sort()).toEqual([...CONVERSATION_GOALS].sort());
  });
});

describe("R21 gap engine — priority selection: nextRequired is the HIGHEST-priority missing field", () => {
  it("provide_quote, nothing yet → asks for job_type first", () => {
    expect(nextRequiredInformation("provide_quote", {})).toBe("job_type");
  });

  it("provide_quote, job_type known → asks for postcode next", () => {
    expect(nextRequiredInformation("provide_quote", { job_type: JOB })).toBe("postcode");
  });

  it("provide_quote, facts provided OUT of priority order → still asks for the highest-priority gap", () => {
    // The customer volunteered their email and postcode first; the engine ignores arrival order and asks
    // for job_type (the highest-priority OUTSTANDING field), NOT phone_number. This is the cardinal
    // slot-filling behaviour the priority ordering exists to produce.
    const info: ConversationInformation = { email_address: EMAIL, postcode: POSTCODE };
    const gap = detectGap("provide_quote", info);
    expect(gap.missing).toEqual(["job_type", "phone_number"]);
    expect(gap.nextRequired).toBe("job_type");
    expect(gap.satisfied).toBe(false);
    expect(gap.turnRequired).toBe(true);
  });

  it("provide_quote, all four provided → complete, no next, no turn required", () => {
    const gap = detectGap("provide_quote", FULL);
    expect(gap).toEqual<ConversationGap>({
      goal: "provide_quote",
      missing: [],
      nextRequired: null,
      satisfied: true,
      turnRequired: false,
    });
  });

  it("the gap SHRINKS monotonically as facts arrive (provide_quote)", () => {
    expect(detectGap("provide_quote", {}).missing).toEqual([
      "job_type",
      "postcode",
      "phone_number",
      "email_address",
    ]);
    expect(detectGap("provide_quote", { job_type: JOB }).missing).toEqual([
      "postcode",
      "phone_number",
      "email_address",
    ]);
    expect(
      detectGap("provide_quote", { job_type: JOB, postcode: POSTCODE }).missing,
    ).toEqual(["phone_number", "email_address"]);
    expect(detectGap("provide_quote", FULL).missing).toEqual([]);
  });

  it("ignores information OUTSIDE the goal's slot schema (a callback needs only a phone)", () => {
    // email_address is not a slot for arrange_callback; providing it does not make the objective complete,
    // and providing the phone (its only slot) does — extra fields never change the gap.
    expect(detectGap("arrange_callback", { email_address: EMAIL }).satisfied).toBe(false);
    expect(detectGap("arrange_callback", { email_address: EMAIL }).nextRequired).toBe(
      "phone_number",
    );
    expect(detectGap("arrange_callback", { phone_number: PHONE, email_address: EMAIL }))
      .toEqual<ConversationGap>({
        goal: "arrange_callback",
        missing: [],
        nextRequired: null,
        satisfied: true,
        turnRequired: false,
      });
  });
});

describe("R21 gap engine — reuse & delegation: completeness is R20's, priority is R21's", () => {
  // Exercise every goal against a spread of information states.
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { phone_number: PHONE },
    { job_type: JOB, postcode: POSTCODE },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("isGoalSatisfied DELEGATES wholesale to R20's isInformationComplete (never a second rule)", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        expect(isGoalSatisfied(goal, info)).toBe(isInformationComplete(goal, info));
      }
    }
  });

  it("isTurnRequired is exactly the negation of completeness", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        expect(isTurnRequired(goal, info)).toBe(!isInformationComplete(goal, info));
      }
    }
  });

  it("missing is R20's outstandingSlots re-ordered by priority — SAME SET, priority order", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const missing = missingInformation(goal, info);
        // Same members as R20's schema-ordered outstanding set…
        expect([...missing].sort()).toEqual([...outstandingSlots(goal, info)].sort());
        // …and in FIELD_PRIORITY order (each rank strictly increasing).
        const ranks = missing.map((f) => FIELD_PRIORITY.indexOf(f));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      }
    }
  });

  it("missing ⊆ the goal's slot schema — the gap never invents a field the goal does not need", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const slots = new Set<InformationField>(GOAL_SLOTS[goal]);
        for (const field of missingInformation(goal, info)) {
          expect(slots.has(field)).toBe(true);
        }
      }
    }
  });
});

describe("R21 gap engine — totality, determinism & faithful composition", () => {
  const infoStates: ConversationInformation[] = [
    {},
    { job_type: JOB },
    { email_address: EMAIL, postcode: POSTCODE },
    FULL,
  ];

  it("detectGap is TOTAL over the whole goal vocabulary and internally consistent", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const gap = detectGap(goal, info);
        expect(gap.goal).toBe(goal);
        // satisfied ⟺ nothing missing.
        expect(gap.satisfied).toBe(gap.missing.length === 0);
        // nextRequired is exactly the head of missing (or null).
        expect(gap.nextRequired).toBe(gap.missing[0] ?? null);
        // turnRequired is exactly the negation of satisfied.
        expect(gap.turnRequired).toBe(!gap.satisfied);
      }
    }
  });

  it("detectGap is the FAITHFUL composition of its parts (the single entry point)", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        const gap = detectGap(goal, info);
        expect(gap.missing).toEqual(missingInformation(goal, info));
        expect(gap.nextRequired).toBe(nextRequiredInformation(goal, info));
        expect(gap.satisfied).toBe(isGoalSatisfied(goal, info));
        expect(gap.turnRequired).toBe(isTurnRequired(goal, info));
      }
    }
  });

  it("is DETERMINISTIC — the same (goal, information) always yields a deeply-equal gap", () => {
    for (const goal of CONVERSATION_GOALS) {
      for (const info of infoStates) {
        expect(detectGap(goal, info)).toEqual(detectGap(goal, info));
      }
    }
  });

  it("does NOT mutate the information argument", () => {
    const info: ConversationInformation = { job_type: JOB, postcode: POSTCODE };
    const snapshot = { ...info };
    detectGap("provide_quote", info);
    expect(info).toEqual(snapshot);
  });
});
