import { z } from "zod";
import type { InspectionOutcome } from "@/lib/assets/inspection";

/**
 * Asset Management — Milestone 4b: inspection template domain (pure).
 *
 * Versioned, reusable checklists that seed inspections. NOT a generic form
 * builder — a bounded document of sections → typed items, sized for real
 * construction checklists (pre-use plant checks, lifting-gear examinations,
 * PAT-style rounds, servicing).
 *
 * Division of enforcement (house pattern):
 *   - the DB (20260929) freezes published substance, guarantees one published
 *     version per family, and makes an inspection's template linkage write-once;
 *   - THIS module owns the state machine, definition validation and outcome
 *     derivation — imported by server actions AND unit-tested directly.
 *
 * No Node imports here: the module stays isomorphic-safe (node:crypto lesson).
 */

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const TEMPLATE_STATUSES = ["draft", "published", "superseded", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_STATUS_LABELS: Record<TemplateStatus, string> = {
  draft: "Draft",
  published: "Published",
  superseded: "Superseded",
  archived: "Archived",
};

const TRANSITIONS: Record<TemplateStatus, readonly TemplateStatus[]> = {
  draft: ["published", "archived"],
  published: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

export function canTransitionTemplate(from: TemplateStatus, to: TemplateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws `invalid_transition:<from>-><to>` when illegal (mirrors inspections). */
export function assertTemplateTransition(from: TemplateStatus, to: TemplateStatus): void {
  if (!canTransitionTemplate(from, to)) {
    throw new Error(`invalid_transition:${from}->${to}`);
  }
}

export function isTemplateEditable(status: TemplateStatus): boolean {
  return status === "draft";
}

/** Only the live version may seed new inspections (archived/superseded never). */
export function canStartInspection(status: TemplateStatus): boolean {
  return status === "published";
}

// ── Check level (the compliance-honesty boundary) ─────────────────────────────
// CrewFlow is a record-keeping and custody-control system, not a certification
// body. pre_use_check / recorded_inspection records are CrewFlow's own system
// of record ("Record of pre-use check"); thorough_examination (LOLER-style,
// independent competent person) is a document-plus-metadata record — CrewFlow
// stores the examiner's report, never synthesises a certificate.
export const CHECK_LEVELS = ["pre_use_check", "recorded_inspection", "thorough_examination"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

export const CHECK_LEVEL_LABELS: Record<CheckLevel, string> = {
  pre_use_check: "Pre-use check (operator)",
  recorded_inspection: "Recorded inspection (competent person)",
  thorough_examination: "Thorough examination (external record)",
};

// ── Items ─────────────────────────────────────────────────────────────────────
export const RESPONSE_TYPES = [
  "pass_fail",
  "yes_no",
  "text",
  "number",
  "meter_reading",
  "choice",
  "date",
  "acknowledgement",
] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

export const RESPONSE_TYPE_LABELS: Record<ResponseType, string> = {
  pass_fail: "Pass / fail",
  yes_no: "Yes / no",
  text: "Text",
  number: "Number",
  meter_reading: "Meter reading",
  choice: "Multiple choice",
  date: "Date",
  acknowledgement: "Acknowledgement",
};

export const ITEM_SEVERITIES = ["minor", "major"] as const;
export type ItemSeverity = (typeof ITEM_SEVERITIES)[number];

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const keySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Invalid key");

export const templateItemSchema = z
  .object({
    key: keySchema,
    prompt: z.string().trim().min(1).max(300),
    guidance: z.preprocess(blankToUndefined, z.string().trim().max(500).optional()),
    response_type: z.enum(RESPONSE_TYPES),
    required: z.boolean().default(true),
    /** A failed safety-critical item blocks the asset (M4c custody boundary). */
    safety_critical: z.boolean().default(false),
    /** Defect classification for NON-critical failures. */
    severity: z.enum(ITEM_SEVERITIES).default("minor"),
    /** yes_no: which answer counts as a failure (default "no"). */
    fail_on: z.enum(["yes", "no"]).optional(),
    /** choice: the offered options (≥2) and which of them count as failures. */
    choices: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    failing_choices: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    /** number / meter_reading: optional acceptable range; outside = failure. */
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /** Allow a "not applicable" answer (counts as answered, never fails). */
    allow_na: z.boolean().default(false),
    /**
     * Evidence requirements (authoring metadata now; per-item capture UX ships
     * with the M4 UX slice — inspection-level photos already ride
     * tenant_attachments). `requires_photo` = always (proof shots, e.g. an
     * engaged quick-hitch pin); `requires_photo_on_fail` = the defect-evidence
     * norm. Signature capture likewise lands with the M4 UX slice.
     */
    requires_photo: z.boolean().default(false),
    requires_photo_on_fail: z.boolean().default(false),
    requires_comment_on_fail: z.boolean().default(true),
    requires_signature: z.boolean().default(false),
  })
  .superRefine((item, ctx) => {
    if (item.response_type === "choice") {
      if (!item.choices || item.choices.length < 2) {
        ctx.addIssue({ code: "custom", message: "A choice item needs at least 2 options", path: ["choices"] });
      } else if (new Set(item.choices).size !== item.choices.length) {
        ctx.addIssue({ code: "custom", message: "Choice options must be unique", path: ["choices"] });
      } else if (item.failing_choices?.some((c) => !item.choices?.includes(c))) {
        ctx.addIssue({ code: "custom", message: "Failing choices must be offered options", path: ["failing_choices"] });
      }
    }
    if (item.fail_on && item.response_type !== "yes_no") {
      ctx.addIssue({ code: "custom", message: "fail_on only applies to yes/no items", path: ["fail_on"] });
    }
    if ((item.min != null || item.max != null) &&
        item.response_type !== "number" && item.response_type !== "meter_reading") {
      ctx.addIssue({ code: "custom", message: "min/max only apply to numeric items", path: ["min"] });
    }
    if (item.min != null && item.max != null && item.min > item.max) {
      ctx.addIssue({ code: "custom", message: "min cannot exceed max", path: ["min"] });
    }
  });
export type TemplateItem = z.infer<typeof templateItemSchema>;

export const templateSectionSchema = z.object({
  key: keySchema,
  title: z.string().trim().min(1).max(120),
  items: z.array(templateItemSchema).max(40),
});
export type TemplateSection = z.infer<typeof templateSectionSchema>;

export const templateDefinitionSchema = z
  .object({
    sections: z.array(templateSectionSchema).max(20),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    for (const s of def.sections) {
      if (keys.has(s.key)) {
        ctx.addIssue({ code: "custom", message: `Duplicate section key: ${s.key}`, path: ["sections"] });
      }
      keys.add(s.key);
      for (const i of s.items) {
        if (keys.has(i.key)) {
          ctx.addIssue({ code: "custom", message: `Duplicate item key: ${i.key}`, path: ["sections"] });
        }
        keys.add(i.key);
      }
    }
  });
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

export const createTemplateSchema = z.object({
  name: z.preprocess(blankToUndefined, z.string().trim().min(1, "A name is required").max(160)),
  description: z.preprocess(blankToUndefined, z.string().trim().max(1000).optional()),
  categories: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  check_level: z.preprocess(blankToUndefined, z.enum(CHECK_LEVELS).default("pre_use_check")),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/** Publishability = a valid, non-empty checklist. Returns human-readable problems. */
export function validateForPublish(definition: TemplateDefinition): string[] {
  const problems: string[] = [];
  if (definition.sections.length === 0) problems.push("Add at least one section.");
  for (const s of definition.sections) {
    if (s.items.length === 0) problems.push(`Section "${s.title}" has no items.`);
  }
  return problems;
}

// ── The frozen copy an inspection carries ─────────────────────────────────────
export type TemplateSnapshot = {
  template_id: string;
  family_id: string;
  version: number;
  name: string;
  check_level: CheckLevel;
  sections: TemplateSection[];
};

export function materializeTemplateSnapshot(t: {
  id: string;
  family_id: string;
  version: number;
  name: string;
  check_level: CheckLevel;
  definition: TemplateDefinition;
}): TemplateSnapshot {
  return {
    template_id: t.id,
    family_id: t.family_id,
    version: t.version,
    name: t.name,
    check_level: t.check_level,
    sections: t.definition.sections,
  };
}

// ── Answers + outcome derivation ──────────────────────────────────────────────
/** Form answers, keyed by item key. "na" is legal only where allow_na is set. */
export type Answers = Record<string, string>;

export function allItems(sections: TemplateSection[]): TemplateItem[] {
  return sections.flatMap((s) => s.items);
}

function isAnswered(value: string | undefined): value is string {
  return value != null && value.trim() !== "";
}

/** Does this answer fail the item's rule? ("na" never fails when allowed.) */
export function itemFailed(item: TemplateItem, answer: string | undefined): boolean {
  if (!isAnswered(answer)) return false; // unanswered is a validation concern, not a failure
  if (item.allow_na && answer === "na") return false;
  switch (item.response_type) {
    case "pass_fail":
      return answer === "fail";
    case "yes_no":
      return answer === (item.fail_on ?? "no");
    case "number":
    case "meter_reading": {
      const n = Number(answer);
      if (!Number.isFinite(n)) return true; // unparseable numeric = failed reading
      if (item.min != null && n < item.min) return true;
      if (item.max != null && n > item.max) return true;
      return false;
    }
    case "choice":
      return item.failing_choices?.includes(answer) ?? false;
    case "text":
    case "date":
    case "acknowledgement":
      return false;
  }
}

/** Required items with no usable answer — these block issue (validation, not auto-fail). */
export function missingRequired(sections: TemplateSection[], answers: Answers): TemplateItem[] {
  return allItems(sections).filter((item) => {
    if (!item.required) return false;
    const a = answers[item.key];
    if (!isAnswered(a)) return true;
    if (a === "na" && !item.allow_na) return true;
    return false;
  });
}

export type DerivedOutcome = {
  outcome: InspectionOutcome;
  /** True ⇒ the M4c custody block engages when issued. */
  safety_critical: boolean;
  failed_keys: string[];
  critical_failed_keys: string[];
};

/**
 * THE derivation rule (unit-tested; the issue action applies it verbatim):
 *   any failed SAFETY-CRITICAL item  → fail + safety_critical (blocks custody)
 *   only non-critical failures       → pass_with_defects (defect ≠ unsafe)
 *   no failures                      → pass
 */
export function deriveOutcome(sections: TemplateSection[], answers: Answers): DerivedOutcome {
  const failed = allItems(sections).filter((i) => itemFailed(i, answers[i.key]));
  const critical = failed.filter((i) => i.safety_critical);
  const outcome: InspectionOutcome =
    critical.length > 0 ? "fail" : failed.length > 0 ? "pass_with_defects" : "pass";
  return {
    outcome,
    safety_critical: critical.length > 0,
    failed_keys: failed.map((i) => i.key),
    critical_failed_keys: critical.map((i) => i.key),
  };
}

/** Failed items that require a comment but have none — blocks issue. */
export function missingFailComments(
  sections: TemplateSection[],
  answers: Answers,
  comments: Record<string, string>,
): TemplateItem[] {
  return allItems(sections).filter(
    (i) =>
      itemFailed(i, answers[i.key]) &&
      i.requires_comment_on_fail &&
      !isAnswered(comments[i.key]),
  );
}
