/**
 * Works Quality — ITP template pure domain logic (M2).
 *
 * Deterministic, no DB, no I/O, NO AI. Mirrors migration 20261081's template
 * lifecycle: a version is born draft, published (freezing its substance and
 * archiving the family's previous published version atomically), archived
 * when replaced or retired. Items are RELATIONAL — instantiation copies them
 * into REAL inspection_plan_items rows on a DRAFT plan, so from that moment
 * on the plan behaves exactly like a hand-built one (M1's freeze-on-issue
 * applies untouched).
 */

export const TEMPLATE_STATUSES = ["draft", "published", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_STATUS_META: Record<TemplateStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "bg-slate-100 text-slate-700" },
  published: { label: "Published", tone: "bg-emerald-100 text-emerald-800" },
  archived: { label: "Archived", tone: "bg-slate-100 text-slate-600" },
};

/** Only a draft's substance and items are editable (mirrors tg_ipt_lifecycle). */
export function isTemplateEditable(status: TemplateStatus): boolean {
  return status === "draft";
}

/**
 * Allowed transitions (mirrors tg_ipt_lifecycle):
 *   draft     → published | archived
 *   published → archived
 *   archived  → terminal
 */
export function canTemplateTransition(from: TemplateStatus, to: TemplateStatus): boolean {
  if (from === "draft") return to === "published" || to === "archived";
  if (from === "published") return to === "archived";
  return false;
}

/**
 * Publish readiness — the DB gate is "at least one item"; the friendly
 * pre-check mirrors it (the canIssue convention).
 */
export function canPublish(t: { status: TemplateStatus; itemCount: number }): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (t.status !== "draft") reasons.push("Only a draft version can be published.");
  if (t.itemCount < 1) reasons.push("At least one inspection item is required.");
  return { ok: reasons.length === 0, reasons };
}

/** Only a PUBLISHED version instantiates — a draft is not a controlled checklist. */
export function canInstantiate(status: TemplateStatus): boolean {
  return status === "published";
}
