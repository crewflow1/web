import type { BriefingItem } from "./types";

/**
 * The deterministic "coach voice" for the briefing.
 *
 * This is the CrewFlow philosophy applied to AI: the structured, evidence-backed
 * items ARE the intelligence (OBSERVE → RECOMMEND → EXPLAIN). This summary just
 * frames them in plain English, with NO external provider and no black box.
 *
 * FUTURE (provider-gated, graceful): when an LLM key lands, a service-layer path
 * may pass the same ranked `BriefingItem[]` to lib/ai/text and swap `headline`/
 * `lead` for a richer generation — degrading to exactly this deterministic
 * output whenever the provider is absent or errs, mirroring lib/ai/insight-narrative.
 */
export interface BriefingSummary {
  /** Time-of-day greeting. */
  greeting: string;
  /** One-line status: how many things need attention (or all-clear). */
  headline: string;
  /** Optional pointer to the single most urgent item; null when all-clear. */
  lead: string | null;
}

/**
 * PURE. `items` MUST already be ranked (composeBriefing output) — `lead` names
 * items[0]. `now` drives only the greeting, so callers can pin it in tests.
 */
export function summariseBriefing(items: BriefingItem[], now: Date = new Date()): BriefingSummary {
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  if (items.length === 0) {
    return {
      greeting,
      headline: "You're all caught up — nothing needs your attention right now.",
      lead: null,
    };
  }

  const n = items.length;
  const headline = `${n} ${n === 1 ? "thing needs" : "things need"} your attention today.`;
  const top = items[0]!;
  return { greeting, headline, lead: `Start with: ${top.title}.` };
}
