import { describe, it, expect } from "vitest";
import {
  INFORMATION_FIELDS,
  JOB_TYPES,
  EMPTY_INFORMATION,
  GOAL_SLOTS,
  isInformationField,
  isValidFieldValue,
  coerceConversationInformation,
  extractInformation,
  advanceInformation,
  planInformationUpdate,
  slotsFor,
  outstandingSlots,
  isInformationComplete,
  type ConversationInformation,
  type InformationField,
} from "@/lib/receptionist/conversation-information";
import {
  resolveGoal,
  type ConversationGoal,
} from "@/lib/receptionist/conversation-goal";
import { resolveIntent } from "@/lib/receptionist/conversation-intent";
import type {
  ConversationContext,
  ContextMessage,
  ContextRole,
} from "@/lib/receptionist/conversation-context";

/**
 * THE CONVERSATION INFORMATION ENGINE — pure core, unit tier
 * (the AI Receptionist Programme, R20 — CONVERSATION INFORMATION ENGINE).
 *
 * lib/receptionist/conversation-information.ts is the deterministic, leaf authority over the STRUCTURED
 * INFORMATION a conversation has accumulated — the single source of truth for "what facts has the customer
 * actually provided?". It executes ON TOP of the whole stack (Context → Intent → Goal), takes exactly TWO
 * inputs (the resolved ConversationGoal, which SELECTS the fields; the ConversationContext, which it READS
 * the facts FROM), and reaches NOTHING else — no policy, no provider, no ledger, no clock, no RNG and, the
 * cardinal rule, NO MODEL — so it is exhaustively unit-testable in isolation. These tests pin, EXHAUSTIVELY:
 * the field vocabulary and its lock-step with the migration key check; the deterministic, model-free,
 * extraction-IS-validation extractors (a real email/UK phone/UK postcode/known job type, canonicalised, or
 * nothing); deny-unknown coercion of a persisted value (defence-in-depth); the GOAL-SCOPED, CUSTOMER-ONLY,
 * newest-wins extraction; the monotonic-accumulation fold and its turn planner (updated / unchanged — there
 * is deliberately NO rejected arm, because extraction validates on the way in); and the slot-filling surface
 * the first consumer reads. One block composes the WHOLE stack — extractInformation over
 * resolveGoal ∘ resolveIntent — to prove the layering Context → Intent → Goal → Information directly.
 *
 * The engine's REACHING behaviour (extract pre-dispatch → persist an update over real Postgres) is proven in
 * the integration tier; its architectural isolation (single-sourced, single consumer, three type-only-plus-
 * phone imports, persist-only-under-updated, never moves the ownership / intent / goal markers) is proven in
 * the security tier. This file proves the calculus alone.
 */

// The full field vocabulary, enumerated locally so a drift in INFORMATION_FIELDS is caught by the lock-step
// assertion below rather than silently propagating into every other case (and mirrored in the migration's
// key check: supabase/migrations/20260825000000_receptionist_conversation_information.sql).
const ALL_FIELDS: readonly InformationField[] = [
  "email_address",
  "phone_number",
  "postcode",
  "job_type",
];

// The full goal vocabulary, enumerated locally (position-parallel to the goal engine) so a drift is caught
// HERE rather than silently changing which slots each objective needs.
const ALL_GOALS: readonly ConversationGoal[] = [
  "undetermined",
  "answer_enquiry",
  "arrange_booking",
  "arrange_callback",
  "provide_quote",
  "handoff_to_human",
];

// The expected GOAL → SLOTS schema, enumerated locally so a drift in the engine's map is caught HERE.
const EXPECTED_SLOTS: ReadonlyArray<readonly [ConversationGoal, readonly InformationField[]]> = [
  ["undetermined", []],
  ["answer_enquiry", []],
  ["arrange_booking", ["job_type", "postcode", "phone_number"]],
  ["arrange_callback", ["phone_number"]],
  ["provide_quote", ["job_type", "postcode", "phone_number", "email_address"]],
  ["handoff_to_human", ["phone_number"]],
];

// A canonical, fully-populated record — one valid value per field, in each field's post-extraction shape.
const FULL_INFORMATION: ConversationInformation = {
  email_address: "jo@brightspark.co.uk",
  phone_number: "+447700900123",
  postcode: "SW1A 1AA",
  job_type: "plumbing",
};

// A minimal, valid ConversationContext built from a role/text turn list (the SAME helper the R18/R19 tests
// use). extractInformation reads only the CUSTOMER turns' text; the whole object is well-formed so the
// extraction exercises the real types end to end.
function contextFrom(
  turns: ReadonlyArray<{ role: ContextRole; text: string }>,
): ConversationContext {
  const messages: ContextMessage[] = turns.map((t, i) => ({
    message_id: `m${i}`,
    role: t.role,
    channel: "sms",
    event_at: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
    text: t.text,
    tokens: 0,
  }));
  return {
    conversation: {
      conversation_id: "conv-1",
      org_id: "org-1",
      employee_slug: "voice-receptionist-ai",
      channel: "sms",
      status: "active",
      message_count: messages.length,
      first_message_at: "2026-01-01T10:00:00.000Z",
      last_message_at: "2026-01-01T10:00:00.000Z",
      last_direction: "inbound",
    },
    contact: { contact_ref: "+447700900000", contact_name: null },
    summary: null,
    elision: null,
    messages,
    boundaries: {
      total_message_count: messages.length,
      included_message_count: messages.length,
      omitted_message_count: 0,
      included_from: messages[0]?.event_at ?? null,
      included_to: messages[messages.length - 1]?.event_at ?? null,
      truncated: false,
    },
    budget: { budget: 4000, tokens_used: 0, within_budget: true },
    text: "",
  };
}

describe("the field vocabulary — lock-step with the migration key check", () => {
  it("INFORMATION_FIELDS is exactly the four fields, in canonical order", () => {
    expect(INFORMATION_FIELDS).toEqual(ALL_FIELDS);
  });

  it("the vocabulary has no duplicates", () => {
    expect(new Set(INFORMATION_FIELDS).size).toBe(INFORMATION_FIELDS.length);
  });
});

describe("the job-type vocabulary", () => {
  it("JOB_TYPES is exactly the eight canonical trades, in canonical order", () => {
    expect(JOB_TYPES).toEqual([
      "plumbing",
      "electrical",
      "roofing",
      "carpentry",
      "plastering",
      "painting",
      "landscaping",
      "building",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(JOB_TYPES).size).toBe(JOB_TYPES.length);
  });
});

describe("EMPTY_INFORMATION — the frozen initial value", () => {
  it("is an empty record", () => {
    expect(EMPTY_INFORMATION).toEqual({});
    expect(Object.keys(EMPTY_INFORMATION)).toHaveLength(0);
  });

  it("is frozen — the shared constant can never be mutated by a consumer", () => {
    expect(Object.isFrozen(EMPTY_INFORMATION)).toBe(true);
  });
});

describe("isInformationField — narrows exactly the known vocabulary", () => {
  it("accepts every canonical field", () => {
    for (const f of ALL_FIELDS) expect(isInformationField(f)).toBe(true);
  });

  it("rejects out-of-vocabulary strings (including goal / intent / job-type names — the layers do not share a vocabulary)", () => {
    for (const bad of [
      "",
      "EMAIL_ADDRESS",
      "email",
      "phone",
      "name",
      "contact_name",
      "plumbing",
      "provide_quote",
      "quote_request",
      "postcode ",
    ]) {
      expect(isInformationField(bad)).toBe(false);
    }
  });

  it("rejects non-string values", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], true, NaN]) {
      expect(isInformationField(bad)).toBe(false);
    }
  });
});

describe("isValidFieldValue — the canonical, post-extraction per-field format checks", () => {
  it("email_address accepts a real address, rejects placeholders and malformed", () => {
    for (const ok of ["jo@brightspark.co.uk", "a.b-c%d@sub.domain-x.io", "info@acme.com"]) {
      expect(isValidFieldValue("email_address", ok)).toBe(true);
    }
    for (const bad of [
      "jo@example.com", // reserved-example placeholder
      "name@acme.co.uk", // form stand-in
      "your@thing.com",
      "notanemail",
      "a@b.c", // tld too short
      "@nope.com",
      "",
    ]) {
      expect(isValidFieldValue("email_address", bad)).toBe(false);
    }
  });

  it("phone_number accepts canonical E.164, rejects national / punctuated / out-of-range", () => {
    for (const ok of ["+447700900123", "+14155550123"]) {
      expect(isValidFieldValue("phone_number", ok)).toBe(true);
    }
    for (const bad of [
      "07700900123", // national, no +
      "+44 7700 900123", // still punctuated
      "+44770", // too short
      "+44770090012345678", // too long
      "447700900123", // no +
      "",
    ]) {
      expect(isValidFieldValue("phone_number", bad)).toBe(false);
    }
  });

  it("postcode accepts canonical `OUTWARD INWARD` upper-case, rejects lower / unspaced / malformed", () => {
    for (const ok of ["SW1A 1AA", "EC1A 1BB", "M1 1AE", "B33 8TH", "CR2 6XH"]) {
      expect(isValidFieldValue("postcode", ok)).toBe(true);
    }
    for (const bad of [
      "sw1a 1aa", // lower-case
      "SW1A1AA", // no space
      "SW1A  1AA", // double space
      "SW1A 1A", // inward too short
      "1AA",
      "",
    ]) {
      expect(isValidFieldValue("postcode", bad)).toBe(false);
    }
  });

  it("job_type accepts exactly the canonical trades, rejects cues / unknowns", () => {
    for (const jt of JOB_TYPES) expect(isValidFieldValue("job_type", jt)).toBe(true);
    for (const bad of ["gardening", "boiler", "plumber", "electrician", "general_builder", "", "PLUMBING"]) {
      expect(isValidFieldValue("job_type", bad)).toBe(false);
    }
  });
});

describe("coerceConversationInformation — TOTAL, DENY-UNKNOWN, defence-in-depth", () => {
  it("preserves a fully-valid record verbatim", () => {
    expect(coerceConversationInformation({ ...FULL_INFORMATION })).toEqual(FULL_INFORMATION);
  });

  it("preserves each single valid field on its own", () => {
    for (const field of ALL_FIELDS) {
      const one = { [field]: FULL_INFORMATION[field] };
      expect(coerceConversationInformation(one)).toEqual(one);
    }
  });

  it("drops out-of-vocabulary keys, keeping the valid remainder", () => {
    expect(
      coerceConversationInformation({
        email_address: "jo@brightspark.co.uk",
        contact_name: "Jo Bloggs",
        foo: "bar",
      }),
    ).toEqual({ email_address: "jo@brightspark.co.uk" });
  });

  it("drops in-vocabulary keys whose value is malformed (re-validates the persisted value)", () => {
    expect(coerceConversationInformation({ phone_number: "not a phone" })).toEqual({});
    expect(coerceConversationInformation({ postcode: "sw1a 1aa" })).toEqual({});
    expect(coerceConversationInformation({ email_address: "jo@example.com" })).toEqual({});
    expect(coerceConversationInformation({ job_type: "gardening" })).toEqual({});
  });

  it("drops non-string values", () => {
    expect(
      coerceConversationInformation({ email_address: 42, postcode: null, job_type: {} }),
    ).toEqual({});
  });

  it("is TOTAL — any non-object input resolves to an empty record (never throws)", () => {
    for (const bad of [null, undefined, "", "x", 42, true, NaN, [], ["postcode"]]) {
      expect(coerceConversationInformation(bad)).toEqual({});
    }
  });

  it("is DETERMINISTIC and returns a FRESH record (never the input)", () => {
    const input = { ...FULL_INFORMATION };
    const once = coerceConversationInformation(input);
    expect(once).not.toBe(input);
    for (let i = 0; i < 10; i++) expect(coerceConversationInformation(input)).toEqual(once);
  });
});

describe("extractInformation — deterministic, total, model-free, CUSTOMER-only, GOAL-scoped", () => {
  it("a goal that needs no structured information extracts NOTHING, even when facts are present", () => {
    const ctx = contextFrom([
      { role: "customer", text: "hi, my boiler is leaking at SW1A 1AA, call 07700 900123" },
    ]);
    expect(extractInformation(ctx, "undetermined")).toEqual({});
    expect(extractInformation(ctx, "answer_enquiry")).toEqual({});
  });

  it("extracts exactly the slots the current goal needs — arrange_callback seeks only the phone", () => {
    const ctx = contextFrom([
      { role: "customer", text: "I need a plumber at SW1A 1AA, my number is 07700 900123" },
    ]);
    // arrange_callback's only slot is phone_number — the postcode and job type are NOT sought.
    expect(extractInformation(ctx, "arrange_callback")).toEqual({ phone_number: "+447700900123" });
  });

  it("extracts every slot a provide_quote objective needs from a single rich message, canonicalised", () => {
    const ctx = contextFrom([
      {
        role: "customer",
        text: "Can I get a quote for some plumbing — boiler's leaking. I'm at sw1a 1aa, number 07700 900123, email JO@Brightspark.co.uk",
      },
    ]);
    expect(extractInformation(ctx, "provide_quote")).toEqual({
      job_type: "plumbing",
      postcode: "SW1A 1AA", // upper-cased, single-spaced
      phone_number: "+447700900123", // E.164, the SMS transport's form
      email_address: "jo@brightspark.co.uk", // lower-cased
    });
  });

  it("normalises a +44 international phone identically to a national one", () => {
    const ctx = contextFrom([{ role: "customer", text: "reach me on +44 7700 900123" }]);
    expect(extractInformation(ctx, "arrange_callback")).toEqual({ phone_number: "+447700900123" });
  });

  it("maps a customer's SYMPTOM vocabulary to the canonical job type (not just the trade name)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["my boiler has broken down", "plumbing"],
      ["a socket stopped working", "electrical"],
      ["the roof needs repairing after the storm", "roofing"],
      ["I need new skirting board fitted", "carpentry"],
      ["the walls need plastering", "plastering"],
      ["the hallway needs painting", "painting"],
      ["I want a new patio laid", "landscaping"],
      ["planning a two-storey extension", "building"],
    ];
    for (const [text, jobType] of cases) {
      const ctx = contextFrom([{ role: "customer", text }]);
      expect(extractInformation(ctx, "arrange_booking"), text).toEqual({ job_type: jobType });
    }
  });

  it("reads ONLY the customer's own turns — NEVER a fact the assistant merely proposed", () => {
    const ctx = contextFrom([
      { role: "customer", text: "hello" },
      { role: "assistant", text: "Just to confirm — postcode SW1A 1AA and number 07700 900123?" },
    ]);
    // The assistant PROPOSED a postcode and a phone; the engine must not learn them.
    expect(extractInformation(ctx, "arrange_booking")).toEqual({});
  });

  it("newest customer statement of a fact WINS — a correction supersedes an earlier value", () => {
    const ctx = contextFrom([
      { role: "customer", text: "I'm at SW1A 1AA" },
      { role: "assistant", text: "Thanks — could you confirm the postcode?" },
      { role: "customer", text: "sorry it's actually EC1A 1BB" },
    ]);
    expect(extractInformation(ctx, "arrange_booking")).toEqual({ postcode: "EC1A 1BB" });
  });

  it("extracts a fact stated on an EARLIER customer turn when the latest turn omits it", () => {
    const ctx = contextFrom([
      { role: "customer", text: "my number is 07700 900123" },
      { role: "assistant", text: "Great — what work do you need?" },
      { role: "customer", text: "some electrical work" },
    ]);
    expect(extractInformation(ctx, "arrange_booking")).toEqual({
      phone_number: "+447700900123",
      job_type: "electrical",
    });
  });

  it("yields the empty record when the context carries no valid value for any slot", () => {
    const ctx = contextFrom([{ role: "customer", text: "morning, are you around?" }]);
    expect(extractInformation(ctx, "provide_quote")).toEqual({});
  });

  it("ignores a bare run of digits (a house number / quantity) — only UK-shaped phones extract", () => {
    const ctx = contextFrom([{ role: "customer", text: "it's flat 42, the boiler needs looking at" }]);
    // '42' is not a UK-shaped phone, so nothing is dialled; the job type still resolves from 'boiler'.
    expect(extractInformation(ctx, "arrange_booking")).toEqual({ job_type: "plumbing" });
  });

  it("is DETERMINISTIC — the same (context, goal) extracts the same record every call", () => {
    const ctx = contextFrom([
      { role: "customer", text: "quote for plumbing at SW1A 1AA, 07700 900123, jo@brightspark.co.uk" },
    ]);
    const once = extractInformation(ctx, "provide_quote");
    for (let i = 0; i < 25; i++) expect(extractInformation(ctx, "provide_quote")).toEqual(once);
  });

  it("returns a value only ever passing the field's own validator (extraction IS validation)", () => {
    const ctx = contextFrom([
      { role: "customer", text: "quote for plumbing at SW1A 1AA, 07700 900123, jo@brightspark.co.uk" },
    ]);
    const info = extractInformation(ctx, "provide_quote");
    for (const field of ALL_FIELDS) {
      const value = info[field];
      if (value !== undefined) expect(isValidFieldValue(field, value)).toBe(true);
    }
  });
});

describe("advanceInformation — the monotonic accumulation fold", () => {
  it("keeps every prior field and adopts every freshly-extracted field", () => {
    expect(advanceInformation({ postcode: "SW1A 1AA" }, { phone_number: "+447700900123" })).toEqual({
      postcode: "SW1A 1AA",
      phone_number: "+447700900123",
    });
  });

  it("a restated field supersedes its earlier value (freshest wins)", () => {
    expect(advanceInformation({ postcode: "SW1A 1AA" }, { postcode: "EC1A 1BB" })).toEqual({
      postcode: "EC1A 1BB",
    });
  });

  it("a field the turn did not extract is left exactly as it was", () => {
    expect(advanceInformation(FULL_INFORMATION, {})).toEqual(FULL_INFORMATION);
  });

  it("the KEY SET never shrinks — accumulation is monotonic in the fields known", () => {
    const prior = { postcode: "SW1A 1AA", phone_number: "+447700900123" };
    const next = advanceInformation(prior, { job_type: "plumbing" });
    for (const k of Object.keys(prior)) expect(next).toHaveProperty(k);
    expect(Object.keys(next).sort()).toEqual(["job_type", "phone_number", "postcode"]);
  });

  it("does NOT mutate either input — returns a fresh record", () => {
    const prior = { postcode: "SW1A 1AA" };
    const extracted = { phone_number: "+447700900123" };
    const next = advanceInformation(prior, extracted);
    expect(next).not.toBe(prior);
    expect(next).not.toBe(extracted);
    expect(prior).toEqual({ postcode: "SW1A 1AA" });
    expect(extracted).toEqual({ phone_number: "+447700900123" });
  });

  it("is DETERMINISTIC — the same (prior, extracted) folds identically every call", () => {
    const prior = { postcode: "SW1A 1AA" };
    const extracted = { postcode: "EC1A 1BB", phone_number: "+447700900123" };
    const once = advanceInformation(prior, extracted);
    for (let i = 0; i < 25; i++) expect(advanceInformation(prior, extracted)).toEqual(once);
  });

  it("folds a whole conversation's per-turn extractions into the accumulated total", () => {
    const perTurn: ConversationInformation[] = [
      { job_type: "plumbing" },
      {},
      { postcode: "SW1A 1AA" },
      { postcode: "EC1A 1BB" }, // corrected
      { phone_number: "+447700900123" },
    ];
    const total = perTurn.reduce(advanceInformation, EMPTY_INFORMATION);
    expect(total).toEqual({
      job_type: "plumbing",
      postcode: "EC1A 1BB",
      phone_number: "+447700900123",
    });
  });
});

describe("planInformationUpdate — updated / unchanged (no rejected arm)", () => {
  it("a brand-new field is an `updated` that names it in `added` and carries the full next record", () => {
    expect(planInformationUpdate({}, { postcode: "SW1A 1AA" })).toEqual({
      kind: "updated",
      information: { postcode: "SW1A 1AA" },
      added: ["postcode"],
    });
  });

  it("a CHANGED field is an `updated` (a restatement is learning something new)", () => {
    expect(planInformationUpdate({ postcode: "SW1A 1AA" }, { postcode: "EC1A 1BB" })).toEqual({
      kind: "updated",
      information: { postcode: "EC1A 1BB" },
      added: ["postcode"],
    });
  });

  it("extracting the SAME value already held is `unchanged` — nothing to persist", () => {
    const prior = { postcode: "SW1A 1AA" };
    const plan = planInformationUpdate(prior, { postcode: "SW1A 1AA" });
    expect(plan.kind).toBe("unchanged");
    // `unchanged` carries the prior record BY REFERENCE — the runtime persists nothing.
    if (plan.kind === "unchanged") expect(plan.information).toBe(prior);
  });

  it("extracting nothing new is `unchanged`", () => {
    const prior = { ...FULL_INFORMATION };
    const plan = planInformationUpdate(prior, {});
    expect(plan.kind).toBe("unchanged");
    if (plan.kind === "unchanged") expect(plan.information).toBe(prior);
  });

  it("the empty→empty turn is `unchanged`", () => {
    expect(planInformationUpdate({}, {}).kind).toBe("unchanged");
  });

  it("`added` collects exactly the changed fields, in canonical INFORMATION_FIELDS order", () => {
    const plan = planInformationUpdate(
      { postcode: "SW1A 1AA" },
      {
        job_type: "plumbing",
        phone_number: "+447700900123",
        email_address: "jo@brightspark.co.uk",
        postcode: "SW1A 1AA", // unchanged — must NOT appear in `added`
      },
    );
    expect(plan.kind).toBe("updated");
    if (plan.kind === "updated") {
      // canonical order is email_address, phone_number, postcode, job_type
      expect(plan.added).toEqual(["email_address", "phone_number", "job_type"]);
      expect(plan.information).toEqual({
        postcode: "SW1A 1AA",
        job_type: "plumbing",
        phone_number: "+447700900123",
        email_address: "jo@brightspark.co.uk",
      });
    }
  });

  it("NEVER yields a `rejected` kind — extraction validates on the way in, so only updated/unchanged exist", () => {
    const priors: ConversationInformation[] = [{}, { postcode: "SW1A 1AA" }, FULL_INFORMATION];
    const extracts: ConversationInformation[] = [
      {},
      { postcode: "SW1A 1AA" },
      { postcode: "EC1A 1BB" },
      { phone_number: "+447700900123" },
      FULL_INFORMATION,
    ];
    for (const prior of priors) {
      for (const extracted of extracts) {
        expect(["updated", "unchanged"]).toContain(planInformationUpdate(prior, extracted).kind);
      }
    }
  });

  it("its `updated` kind is EXACTLY 'the fold changed the record' — the runtime's persisted `information_updated` bit", () => {
    const priors: ConversationInformation[] = [{}, { postcode: "SW1A 1AA" }, FULL_INFORMATION];
    const extracts: ConversationInformation[] = [
      {},
      { postcode: "SW1A 1AA" },
      { postcode: "EC1A 1BB" },
      { phone_number: "+447700900123" },
    ];
    for (const prior of priors) {
      for (const extracted of extracts) {
        const updated = planInformationUpdate(prior, extracted).kind === "updated";
        const folded = advanceInformation(prior, extracted);
        const changed = ALL_FIELDS.some((f) => folded[f] !== prior[f]);
        expect(updated).toBe(changed);
      }
    }
  });

  it("is DETERMINISTIC — the same (prior, extracted) plans identically every call", () => {
    const prior = { postcode: "SW1A 1AA" };
    const extracted = { postcode: "EC1A 1BB", phone_number: "+447700900123" };
    const once = planInformationUpdate(prior, extracted);
    for (let i = 0; i < 25; i++) expect(planInformationUpdate(prior, extracted)).toEqual(once);
  });
});

describe("the slot surface — GOAL_SLOTS / slotsFor / outstandingSlots / isInformationComplete", () => {
  it("GOAL_SLOTS is exactly the declared schema, TOTAL over the whole goal vocabulary", () => {
    expect(Object.keys(GOAL_SLOTS).sort()).toEqual([...ALL_GOALS].sort());
    for (const [goal, slots] of EXPECTED_SLOTS) {
      expect(GOAL_SLOTS[goal], goal).toEqual(slots);
    }
  });

  it("every slot in the schema is a valid information field", () => {
    for (const goal of ALL_GOALS) {
      for (const field of GOAL_SLOTS[goal]) expect(isInformationField(field)).toBe(true);
    }
  });

  it("slotsFor returns the goal's schema", () => {
    for (const goal of ALL_GOALS) expect(slotsFor(goal)).toEqual(GOAL_SLOTS[goal]);
  });

  it("outstandingSlots is the schema minus the fields already present", () => {
    expect(outstandingSlots("provide_quote", {})).toEqual([
      "job_type",
      "postcode",
      "phone_number",
      "email_address",
    ]);
    expect(outstandingSlots("provide_quote", { job_type: "plumbing", postcode: "SW1A 1AA" })).toEqual([
      "phone_number",
      "email_address",
    ]);
    expect(outstandingSlots("provide_quote", FULL_INFORMATION)).toEqual([]);
  });

  it("a no-slot goal has no outstanding slots and is vacuously complete, from any information", () => {
    for (const goal of ["undetermined", "answer_enquiry"] as const) {
      expect(outstandingSlots(goal, {})).toEqual([]);
      expect(isInformationComplete(goal, {})).toBe(true);
      expect(isInformationComplete(goal, FULL_INFORMATION)).toBe(true);
    }
  });

  it("isInformationComplete is true iff nothing is outstanding", () => {
    expect(isInformationComplete("arrange_callback", {})).toBe(false);
    expect(isInformationComplete("arrange_callback", { phone_number: "+447700900123" })).toBe(true);
    expect(isInformationComplete("provide_quote", FULL_INFORMATION)).toBe(true);
    expect(
      isInformationComplete("provide_quote", {
        job_type: "plumbing",
        postcode: "SW1A 1AA",
        phone_number: "+447700900123",
      }),
    ).toBe(false); // email still outstanding
  });

  it("outstandingSlots is DETERMINISTIC", () => {
    const info = { phone_number: "+447700900123" };
    const once = outstandingSlots("provide_quote", info);
    for (let i = 0; i < 10; i++) expect(outstandingSlots("provide_quote", info)).toEqual(once);
  });
});

// =====================================================================
// THE STACK — extractInformation over resolveGoal ∘ resolveIntent: the information engine executes ON TOP of
// the goal engine, which elevates the intent, which reads the context. This block proves the layering
// Context → Intent → Goal → Information directly, at the unit tier.
// =====================================================================

/** The composed stack: resolve the goal from the customer's turn, then extract the facts that goal needs. */
function stackExtract(text: string): ConversationInformation {
  const ctx = contextFrom([{ role: "customer", text }]);
  const goal = resolveGoal(resolveIntent(ctx));
  return extractInformation(ctx, goal);
}

describe("the stack — Context → Intent → Goal → Information end to end", () => {
  it("a quote enquiry resolves provide_quote and extracts the facts it stated", () => {
    // 'quote' → quote_request → provide_quote; the message states a job type and a postcode.
    expect(stackExtract("can I get a quote for some plumbing at SW1A 1AA?")).toEqual({
      job_type: "plumbing",
      postcode: "SW1A 1AA",
    });
  });

  it("a callback request resolves arrange_callback and extracts ONLY the phone that objective needs", () => {
    // 'call me back' → callback_request → arrange_callback (slots: phone_number only).
    expect(stackExtract("please call me back on 07700 900123")).toEqual({
      phone_number: "+447700900123",
    });
  });

  it("a bare enquiry resolves answer_enquiry and extracts NOTHING — extraction is scoped to the objective", () => {
    // A substantive-but-cueless turn → general_enquiry → answer_enquiry (no slots), so a job cue is NOT
    // harvested even though it is present. Proves the engine keys on the GOAL, not a blanket scrape.
    expect(stackExtract("hi, my boiler is leaking")).toEqual({});
  });

  it("a content-free turn carries no objective and extracts nothing", () => {
    expect(stackExtract("   ")).toEqual({});
  });
});
