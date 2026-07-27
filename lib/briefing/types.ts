/**
 * Daily Briefing — "what needs you today".
 *
 * A cross-domain, deadline-aware attention feed composed from CrewFlow's
 * EXISTING live signals (overdue invoices, H&S expiry, unassigned jobs,
 * retention due, stalled quotes, cold leads, compliance expiry). It is
 * deterministic end to end: every item carries a real number, a plain-English
 * reason, and a deep link — OBSERVE → RECOMMEND → EXPLAIN, no black box.
 *
 * The optional AI-coach prose is a FUTURE, provider-gated enhancement layered
 * on top of this structured output (see lib/briefing/narrative.ts); the
 * milestone's value does not depend on any external provider.
 */

/** The domains an item can belong to. Drives grouping + accent colour in the UI. */
export type BriefingCategory = "money" | "safety" | "operations" | "sales";

/** How loudly the item should shout. Drives ordering + badge styling. */
export type BriefingSeverity = "critical" | "high" | "medium" | "low";

/** A single actionable line in the briefing. */
export interface BriefingItem {
  /**
   * Stable identity for the signal family (e.g. `overdue_invoices`). Used to
   * dedupe and to map a per-user "dismiss for today" — so the key must not
   * embed volatile values (counts, ids, amounts).
   */
  key: string;
  category: BriefingCategory;
  severity: BriefingSeverity;
  /** Short imperative headline, e.g. "3 invoices overdue". */
  title: string;
  /** One human sentence stating the number and the reason. */
  detail: string;
  /** Money at stake (£), when relevant — informs ordering + display. */
  amount: number | null;
  /** Count of underlying records, when relevant. */
  count: number | null;
  /** Deep link to the surface that resolves the item. */
  href: string;
  /** Deterministic rank (higher = more urgent). Computed by the composer. */
  score: number;
}
