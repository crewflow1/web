import { describe, expect, it } from "vitest";
import {
  assertTemplateTransition,
  missingSignatures,
  canStartInspection,
  canTransitionTemplate,
  createTemplateSchema,
  deriveOutcome,
  itemFailed,
  materializeTemplateSnapshot,
  missingFailComments,
  missingRequired,
  templateDefinitionSchema,
  templateItemSchema,
  validateForPublish,
  type TemplateDefinition,
  type TemplateItem,
  type TemplateSection,
} from "@/lib/assets/inspection-template";

const item = (over: Partial<TemplateItem> = {}): TemplateItem =>
  templateItemSchema.parse({
    key: over.key ?? "itm-1",
    prompt: "Check the thing",
    response_type: "pass_fail",
    ...over,
  });

const sections = (items: TemplateItem[]): TemplateSection[] => [
  { key: "sec-1", title: "Checks", items },
];

describe("template state machine", () => {
  it("permits only the legal transitions", () => {
    expect(canTransitionTemplate("draft", "published")).toBe(true);
    expect(canTransitionTemplate("draft", "archived")).toBe(true);
    expect(canTransitionTemplate("published", "superseded")).toBe(true);
    expect(canTransitionTemplate("published", "archived")).toBe(true);
    expect(canTransitionTemplate("superseded", "archived")).toBe(true);
  });

  it("forbids un-publish / resurrect", () => {
    expect(canTransitionTemplate("published", "draft")).toBe(false);
    expect(canTransitionTemplate("superseded", "published")).toBe(false);
    expect(canTransitionTemplate("archived", "draft")).toBe(false);
    expect(() => assertTemplateTransition("published", "draft")).toThrow(
      "invalid_transition:published->draft",
    );
  });

  it("only a published version can seed inspections", () => {
    expect(canStartInspection("published")).toBe(true);
    expect(canStartInspection("draft")).toBe(false);
    expect(canStartInspection("superseded")).toBe(false);
    expect(canStartInspection("archived")).toBe(false);
  });
});

describe("item schema", () => {
  it("accepts a minimal pass/fail item with safe defaults", () => {
    const i = item();
    expect(i.required).toBe(true);
    expect(i.safety_critical).toBe(false);
    expect(i.severity).toBe("minor");
    expect(i.requires_comment_on_fail).toBe(true);
  });

  it("rejects a choice item with fewer than 2 options or bogus failing choices", () => {
    expect(
      templateItemSchema.safeParse({
        key: "c1", prompt: "Pick", response_type: "choice", choices: ["Only one"],
      }).success,
    ).toBe(false);
    expect(
      templateItemSchema.safeParse({
        key: "c1", prompt: "Pick", response_type: "choice",
        choices: ["Good", "Worn"], failing_choices: ["Broken"],
      }).success,
    ).toBe(false);
  });

  it("rejects type-mismatched rules (fail_on off yes/no, min>max, range on text)", () => {
    expect(
      templateItemSchema.safeParse({ key: "a1", prompt: "x", response_type: "pass_fail", fail_on: "no" }).success,
    ).toBe(false);
    expect(
      templateItemSchema.safeParse({ key: "a1", prompt: "x", response_type: "number", min: 10, max: 5 }).success,
    ).toBe(false);
    expect(
      templateItemSchema.safeParse({ key: "a1", prompt: "x", response_type: "text", min: 1 }).success,
    ).toBe(false);
  });
});

describe("definition schema + publish validation", () => {
  it("rejects duplicate keys anywhere in the document", () => {
    const dup = {
      sections: [
        { key: "s1", title: "A", items: [{ key: "x", prompt: "p", response_type: "pass_fail" }] },
        { key: "s2", title: "B", items: [{ key: "x", prompt: "q", response_type: "pass_fail" }] },
      ],
    };
    expect(templateDefinitionSchema.safeParse(dup).success).toBe(false);
  });

  it("flags empty definitions and empty sections for publish", () => {
    expect(validateForPublish({ sections: [] })).toHaveLength(1);
    const def: TemplateDefinition = { sections: [{ key: "s1", title: "Empty", items: [] }] };
    expect(validateForPublish(def)[0]).toMatch(/has no items/);
    expect(validateForPublish({ sections: sections([item()]) })).toHaveLength(0);
  });

  it("createTemplateSchema requires a name and bounds categories", () => {
    expect(createTemplateSchema.safeParse({ name: "" }).success).toBe(false);
    const parsed = createTemplateSchema.parse({ name: "  Excavator pre-use  " });
    expect(parsed.name).toBe("Excavator pre-use");
  });
});

describe("itemFailed", () => {
  it("applies each response type's fail rule", () => {
    expect(itemFailed(item(), "fail")).toBe(true);
    expect(itemFailed(item(), "pass")).toBe(false);
    const yn = item({ key: "y1", response_type: "yes_no" });
    expect(itemFailed(yn, "no")).toBe(true); // default fail_on = no
    const ynInv = item({ key: "y2", response_type: "yes_no", fail_on: "yes" });
    expect(itemFailed(ynInv, "yes")).toBe(true);
    const num = item({ key: "n1", response_type: "number", min: 0, max: 100 });
    expect(itemFailed(num, "150")).toBe(true);
    expect(itemFailed(num, "50")).toBe(false);
    expect(itemFailed(num, "not-a-number")).toBe(true); // unparseable reading = failed
    const ch = item({ key: "c1", response_type: "choice", choices: ["Good", "Worn", "Broken"], failing_choices: ["Broken"] });
    expect(itemFailed(ch, "Broken")).toBe(true);
    expect(itemFailed(ch, "Worn")).toBe(false);
  });

  it("never fails unanswered items or allowed n/a answers", () => {
    expect(itemFailed(item(), undefined)).toBe(false);
    expect(itemFailed(item({ key: "na1", allow_na: true }), "na")).toBe(false);
  });
});

describe("deriveOutcome — the safety bridge to M4c", () => {
  const secs = sections([
    item({ key: "brakes", safety_critical: true }),
    item({ key: "mirror", safety_critical: false }),
    item({ key: "hours", response_type: "meter_reading" }),
  ]);

  it("a failed SAFETY-CRITICAL item → fail + safety_critical (block engages)", () => {
    const d = deriveOutcome(secs, { brakes: "fail", mirror: "pass", hours: "120" });
    expect(d.outcome).toBe("fail");
    expect(d.safety_critical).toBe(true);
    expect(d.critical_failed_keys).toEqual(["brakes"]);
  });

  it("only non-critical failures → pass_with_defects, NO block", () => {
    const d = deriveOutcome(secs, { brakes: "pass", mirror: "fail", hours: "120" });
    expect(d.outcome).toBe("pass_with_defects");
    expect(d.safety_critical).toBe(false);
    expect(d.failed_keys).toEqual(["mirror"]);
  });

  it("no failures → pass", () => {
    const d = deriveOutcome(secs, { brakes: "pass", mirror: "pass", hours: "120" });
    expect(d.outcome).toBe("pass");
    expect(d.safety_critical).toBe(false);
  });
});

describe("issue validation helpers", () => {
  it("missingRequired lists unanswered required items (and disallowed n/a)", () => {
    const secs = sections([
      item({ key: "a" }),
      item({ key: "b", required: false }),
      item({ key: "c" }),
    ]);
    const missing = missingRequired(secs, { a: "pass", c: "na" }); // c: na not allowed
    expect(missing.map((i) => i.key)).toEqual(["c"]);
    expect(missingRequired(secs, { a: "pass", c: "fail" })).toHaveLength(0);
  });

  it("missingFailComments lists failed items lacking their mandatory comment", () => {
    const secs = sections([item({ key: "a" }), item({ key: "b" })]);
    const answers = { a: "fail", b: "fail" };
    const missing = missingFailComments(secs, answers, { a: "chain worn" });
    expect(missing.map((i) => i.key)).toEqual(["b"]);
  });
});

describe("missingSignatures — typed-attestation gate (M4 UX)", () => {
  it("lists signature-required items lacking a typed name; others never", () => {
    const secs = sections([
      item({ key: "sig1", requires_signature: true }),
      item({ key: "plain" }),
    ]);
    expect(missingSignatures(secs, {}).map((i) => i.key)).toEqual(["sig1"]);
    expect(missingSignatures(secs, { sig1: "  " }).map((i) => i.key)).toEqual(["sig1"]);
    expect(missingSignatures(secs, { sig1: "Jo Builder" })).toHaveLength(0);
  });
});

describe("materializeTemplateSnapshot", () => {
  it("freezes identity + version + full sections", () => {
    const def: TemplateDefinition = { sections: sections([item()]) };
    const snap = materializeTemplateSnapshot({
      id: "t1", family_id: "f1", version: 3, name: "Excavator pre-use",
      check_level: "pre_use_check", definition: def,
    });
    expect(snap).toEqual({
      template_id: "t1", family_id: "f1", version: 3, name: "Excavator pre-use",
      check_level: "pre_use_check", sections: def.sections,
    });
  });
});
