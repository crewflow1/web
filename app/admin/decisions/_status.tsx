import type { DecisionStatus } from "@/server/services/hq-decisions";
import { Badge } from "@/components/ui/badge";
import { presentDecisionState } from "@/lib/hq/presentation-state";

/**
 * Decision status pill — now speaks the ONE HQ decision language
 * (lib/hq/presentation-state): proposed → "Needs decision", approved →
 * "Completed" (the call is recorded), rejected → "Rejected", delayed/delegated
 * keep their own honest name. Shared by the list, detail and history so the
 * vocabulary renders identically everywhere. Presentation only — the underlying
 * DecisionStatus enum and its DB-enforced transitions are untouched.
 */
export function DecisionStatusPill({
  status,
  suffix,
}: {
  status: DecisionStatus;
  suffix?: string;
}) {
  const badge = presentDecisionState(status);
  return (
    <Badge tone={badge.tone}>
      {badge.label}
      {suffix ?? ""}
    </Badge>
  );
}
