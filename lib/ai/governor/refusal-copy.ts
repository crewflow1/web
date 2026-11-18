/**
 * User-facing copy for a governed AI call the governor REFUSED.
 *
 * Pure, no I/O, no `server-only` — safe to import from a client component
 * (the type import below is erased at build time).
 *
 * WHY THIS EXISTS. Every governed feature already degrades safely on a refusal
 * (an empty draft, a deterministic answer, a keyword search). Where a surface
 * TELLS the user why, it must say the true reason: the refusal reasons are
 * operationally different, and only `ceiling` means "your company's money for
 * this month is gone". Rendering the org's spend/ceiling figures for a
 * CrewFlow-wide, per-employee or rate-limit refusal shows a misleading
 * "used up (£0.10 of £100.00)".
 */
import type { BlockReason } from "../governor";

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/**
 * One sentence saying why AI did not run, followed by `fallback` (what the user
 * can do instead, e.g. "Write the quote as usual."). An unknown reason gets the
 * neutral "temporarily unavailable" — never a budget claim. Both limits are
 * set by CrewFlow HQ (/admin/ai-costs), so the copy points to CrewFlow support.
 */
export function aiRefusalMessage(
  reason: BlockReason | string | null | undefined,
  figures: { spentPence?: number | null; ceilingPence?: number | null },
  fallback: string,
): string {
  const tail = fallback.trim() ? ` ${fallback.trim()}` : "";
  switch (reason) {
    case "ceiling": {
      const spent = Number(figures.spentPence);
      const ceiling = Number(figures.ceilingPence);
      const amounts =
        Number.isFinite(spent) && Number.isFinite(ceiling) && ceiling > 0
          ? ` (${GBP.format(spent / 100)} of ${GBP.format(ceiling / 100)})`
          : "";
      return `Your company's AI budget for this month is used up${amounts}. AI features resume on the 1st of next month; contact CrewFlow support if you need more.${tail}`;
    }
    case "employee_limit":
      return `You have reached your personal AI limit for this month; contact CrewFlow support if you need it raised.${tail}`;
    case "platform_ceiling":
      return `AI features are paused across CrewFlow for the rest of this month. CrewFlow has been alerted.${tail}`;
    case "ai_disabled":
      return `AI features are switched off for your company. A company owner can turn them back on in Settings > AI features.${tail}`;
    case "rate_limited":
      return `Too many AI requests in the last hour. Try again later.${tail}`;
    case "tier_dark_provider_live":
      return `This AI feature is not switched on.${tail}`;
    default:
      return `AI is temporarily unavailable.${tail}`;
  }
}
