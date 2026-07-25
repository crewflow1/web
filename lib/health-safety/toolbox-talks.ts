/**
 * Health & Safety — Toolbox Talks pure domain logic. Deterministic, no DB/IO;
 * imported by the server actions AND unit-tested directly. Mirrors the DB in
 * 20261025000000_health_safety_toolbox_talks.sql and the RAMS lifecycle in rams.ts.
 *
 * A toolbox talk is an on-site safety briefing that evolves into acknowledgeable,
 * revisable evidence: draft -> issued ("Delivered") -> superseded/withdrawn.
 */

export const TOOLBOX_TALK_STATUSES = ["draft", "issued", "superseded", "withdrawn"] as const;
export type ToolboxTalkStatus = (typeof TOOLBOX_TALK_STATUSES)[number];

/** UI label — "issued" reads as "Delivered" for a talk (construction-natural). */
export const TOOLBOX_TALK_STATUS_META: Record<ToolboxTalkStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "bg-slate-100 text-slate-700" },
  issued: { label: "Delivered", tone: "bg-emerald-100 text-emerald-800" },
  superseded: { label: "Superseded", tone: "bg-amber-100 text-amber-900" },
  withdrawn: { label: "Withdrawn", tone: "bg-slate-100 text-slate-500" },
};

export function toolboxStatusLabel(status: ToolboxTalkStatus): string {
  return TOOLBOX_TALK_STATUS_META[status].label;
}

/** Only a draft is editable; a delivered talk is frozen evidence (DB-enforced). */
export function isEditable(status: ToolboxTalkStatus): boolean {
  return status === "draft";
}

export function isTerminal(status: ToolboxTalkStatus): boolean {
  return status === "superseded" || status === "withdrawn";
}

/**
 * Allowed lifecycle transitions (the DB immutability trigger enforces the same):
 * draft -> issued; issued -> superseded | withdrawn. Nothing else, never backwards.
 */
export function canTransition(from: ToolboxTalkStatus, to: ToolboxTalkStatus): boolean {
  if (from === "draft") return to === "issued";
  if (from === "issued") return to === "superseded" || to === "withdrawn";
  return false; // superseded/withdrawn are terminal
}

/**
 * Issue ("deliver") readiness — a talk may only be delivered when it is a complete
 * briefing: a draft with a topic and key points. The DB re-enforces this gate on
 * the draft->issued transition (tg_tt_a_lifecycle). Returns the blocking reasons so
 * the UI can show exactly what's missing (mirrors RAMS canIssue).
 */
export function canIssue(talk: {
  status: ToolboxTalkStatus;
  topic?: string | null;
  key_points?: string | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (talk.status !== "draft") reasons.push("Only a draft toolbox talk can be delivered.");
  if (!talk.topic || talk.topic.trim().length === 0) reasons.push("Give the talk a topic.");
  if (!talk.key_points || talk.key_points.trim().length === 0) reasons.push("Add the key points that were briefed.");
  return { ok: reasons.length === 0, reasons };
}

/** Reference helpers — TBT-NNNN, with -R0n for revisions (matches next_tbt_number). */
const TBT_RE = /^TBT-(\d+)(?:-R(\d+))?$/;

export function parseTbtNumber(reference: string | null): { series: number; revision: number } | null {
  if (!reference) return null;
  const m = TBT_RE.exec(reference.trim());
  if (!m) return null;
  return { series: Number(m[1]), revision: m[2] ? Number(m[2]) : 1 };
}

/** The reference a revision N (>=2) of a series carries: TBT-0001 -> TBT-0001-R02. */
export function revisionReference(seriesReference: string, revisionNumber: number): string {
  const base = seriesReference.replace(/-R\d+$/, "");
  if (revisionNumber <= 1) return base;
  return `${base}-R${String(revisionNumber).padStart(2, "0")}`;
}

/** The single current revision of a series is the one whose status is 'issued'. */
export function currentRevision<T extends { status: ToolboxTalkStatus; revision_number: number }>(
  series: readonly T[],
): T | null {
  return series.find((t) => t.status === "issued") ?? null;
}

/** True when this row is the series' live record (drives the "not the current version" UI). */
export function isCurrentRevision(
  talk: { id: string; status: ToolboxTalkStatus },
  series: readonly { id: string; status: ToolboxTalkStatus }[],
): boolean {
  const current = series.find((t) => t.status === "issued");
  return current != null && current.id === talk.id;
}
