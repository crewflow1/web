/**
 * CrewFlow HQ — AI employee recommendations (contract item: Recommendations),
 * pure fold layer.
 *
 * WHY A FOLD AND NOT A TABLE. No `recommendations` store exists and none is
 * needed: every recommendation an AI employee has actually made is ALREADY
 * persisted inside the `result` jsonb of a completed `hq_ai_tasks` row, in one
 * of the typed shapes the runners really write:
 *
 *   • the standard output envelope (server/sdk/output.ts, Volume XIII §10) —
 *     `alternatives[]` (considered-but-not-chosen) and `actions[]` (proposed,
 *     never executed);
 *   • an exec review (lib/hq/exec-runners.ts, `kind: "exec_review"`) — each
 *     finding carries a human-approvable `proposedAction`;
 *   • a qualification verdict (lib/qualification/model.ts, `result.verdict`) —
 *     `recommendedStatus` is the pipeline move the verdict recommends;
 *   • a research sales-prep brief (lib/research/model.ts, `result.brief`) —
 *     `recommendedModules` + `bestAngle` are the pitch it recommends.
 *
 * This module folds those stored shapes into ONE read-only list. Pure and
 * server/client-safe (no Supabase imports) exactly like
 * `lib/ai-employees/interaction-feed.ts` and `lib/ai-employees/stats.ts`, so
 * the service layer, the boardroom page and the unit tests share one
 * vocabulary. Nothing is generated; every item points at a stored task result,
 * and a malformed result is SKIPPED, never guessed at and never thrown on —
 * this is a display fold over jsonb whose writers evolve independently.
 */

// ---------------------------------------------------------------------
// Lean input row shape — structural subset of hq_ai_tasks (completed rows).
// ---------------------------------------------------------------------

export type RecommendationTaskRow = {
  id: string;
  task_type: string;
  result: Record<string, unknown> | null;
  created_at: string;
  finished_at: string | null;
};

// ---------------------------------------------------------------------
// The folded item.
// ---------------------------------------------------------------------

/** Which stored shape the item was read from — the provenance of the claim. */
export type RecommendationKind =
  | "action" // envelope actions[] — a proposed (never executed) action
  | "alternative" // envelope alternatives[] — considered but not chosen
  | "finding" // exec review finding — proposedAction for a human
  | "verdict" // qualification verdict — recommendedStatus / hold
  | "sales_prep"; // research brief — recommended modules + angle

export type RecommendationItem = {
  /** Stable key ("<taskId>:<kind>:<index>") for React lists. */
  key: string;
  taskId: string;
  taskType: string;
  /** ISO timestamp the list orders by (newest first) — when the task finished. */
  at: string;
  title: string;
  detail: string | null;
  kind: RecommendationKind;
};

// Same clip bound as the interaction feed — these render in the same column.
const DETAIL_MAX = 280;

function clip(text: string): string {
  const t = text.trim();
  return t.length <= DETAIL_MAX ? t : `${t.slice(0, DETAIL_MAX - 1)}…`;
}

/** A non-empty trimmed string, clipped — or null. Never invents text. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? clip(v) : null;
}

/** "comms.send_email" → "comms send email" (readable, honest). */
function humaniseToken(token: string): string {
  return token.replace(/[._-]+/g, " ").trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------
// Per-shape extractors. Each is total: a shape that does not structurally
// match contributes NOTHING — no throw, no fabricated fallback item.
// ---------------------------------------------------------------------

/**
 * Standard envelope `actions[]` / `alternatives[]` (AiAction / AiAlternative,
 * server/sdk/output.ts). `type` is the only required action field; `summary`
 * the only required alternative field — entries missing them are skipped.
 */
function extractEnvelope(
  t: RecommendationTaskRow,
  result: Record<string, unknown>,
  at: string,
  push: (item: RecommendationItem) => void,
): void {
  const actions = result["actions"];
  if (Array.isArray(actions)) {
    actions.forEach((a, i) => {
      if (!isRecord(a)) return;
      const type = str(a["type"]);
      if (!type) return;
      push({
        key: `${t.id}:action:${i}`,
        taskId: t.id,
        taskType: t.task_type,
        at,
        title: `Proposed: ${humaniseToken(type)}`,
        detail: str(a["description"]),
        kind: "action",
      });
    });
  }

  const alternatives = result["alternatives"];
  if (Array.isArray(alternatives)) {
    alternatives.forEach((a, i) => {
      if (!isRecord(a)) return;
      const summary = str(a["summary"]);
      if (!summary) return;
      push({
        key: `${t.id}:alternative:${i}`,
        taskId: t.id,
        taskType: t.task_type,
        at,
        title: summary,
        detail: str(a["reasoning"]),
        kind: "alternative",
      });
    });
  }
}

/**
 * Exec review findings (lib/hq/exec-runners.ts). Gated on the review's own
 * `kind: "exec_review"` discriminant so an unrelated `findings` key in some
 * other domain result is never misread as an exec recommendation.
 */
function extractExecReview(
  t: RecommendationTaskRow,
  result: Record<string, unknown>,
  at: string,
  push: (item: RecommendationItem) => void,
): void {
  if (result["kind"] !== "exec_review") return;
  const findings = result["findings"];
  if (!Array.isArray(findings)) return;
  findings.forEach((f, i) => {
    if (!isRecord(f)) return;
    const proposed = str(f["proposedAction"]);
    if (!proposed) return;
    const label = str(f["label"]);
    const detail = str(f["detail"]);
    push({
      key: `${t.id}:finding:${i}`,
      taskId: t.id,
      taskType: t.task_type,
      at,
      title: proposed,
      detail: label && detail ? clip(`${label} — ${detail}`) : (label ?? detail),
      kind: "finding",
    });
  });
}

/**
 * Qualification verdict (lib/qualification/model.ts, `result.verdict`).
 * `recommendedStatus` is the pipeline move the verdict recommends; null with a
 * real decision string means "hold for a human" — which IS the recommendation,
 * so it is surfaced as such rather than dropped.
 */
function extractVerdict(
  t: RecommendationTaskRow,
  result: Record<string, unknown>,
  at: string,
  push: (item: RecommendationItem) => void,
): void {
  const verdict = result["verdict"];
  if (!isRecord(verdict)) return;
  // `decision` is the verdict's required discriminant — no decision, no verdict.
  const decision = str(verdict["decision"]);
  if (!decision) return;
  const recommended = str(verdict["recommendedStatus"]);
  push({
    key: `${t.id}:verdict:0`,
    taskId: t.id,
    taskType: t.task_type,
    at,
    title: recommended
      ? `Recommended pipeline status: ${humaniseToken(recommended)}`
      : "Recommended: hold for human review",
    detail: str(verdict["summary"]),
    kind: "verdict",
  });
}

/**
 * Research sales-prep brief (lib/research/model.ts, `result.brief`). One item
 * per brief: the recommended CrewFlow modules, with the recommended angle as
 * the detail. A brief with no string module recommendations contributes
 * nothing — an empty recommendation is not a recommendation.
 */
function extractSalesPrep(
  t: RecommendationTaskRow,
  result: Record<string, unknown>,
  at: string,
  push: (item: RecommendationItem) => void,
): void {
  const brief = result["brief"];
  if (!isRecord(brief)) return;
  const modulesRaw = brief["recommendedModules"];
  if (!Array.isArray(modulesRaw)) return;
  const modules = modulesRaw.filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0,
  );
  if (modules.length === 0) return;
  push({
    key: `${t.id}:sales_prep:0`,
    taskId: t.id,
    taskType: t.task_type,
    at,
    title: clip(`Recommended modules: ${modules.join(", ")}`),
    detail: str(brief["bestAngle"]),
    kind: "sales_prep",
  });
}

// ---------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------

/**
 * Fold a bounded recent sample of an employee's COMPLETED tasks into its
 * recommendation list, newest first. Deterministic: ISO stamps order
 * lexicographically and ties break by key, exactly like the interaction feed's
 * merge, so the output is stable for a given input (testable).
 */
export function foldRecommendations(
  tasks: ReadonlyArray<RecommendationTaskRow>,
  limit = 60,
): RecommendationItem[] {
  const items: RecommendationItem[] = [];
  const push = (item: RecommendationItem) => items.push(item);

  for (const t of tasks) {
    if (!isRecord(t.result)) continue;
    // A recommendation exists from the moment its task finished; a completed
    // row with no finish stamp (legacy) honestly falls back to creation.
    const at = t.finished_at ?? t.created_at;
    extractEnvelope(t, t.result, at, push);
    extractExecReview(t, t.result, at, push);
    extractVerdict(t, t.result, at, push);
    extractSalesPrep(t, t.result, at, push);
  }

  items.sort((x, y) => (x.at === y.at ? (x.key < y.key ? 1 : -1) : x.at < y.at ? 1 : -1));
  return items.slice(0, Math.max(0, limit));
}
