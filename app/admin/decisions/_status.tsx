import type { DecisionStatus } from "@/server/services/hq-decisions";

/**
 * Decision status → pill styling. Shared by the list and detail surfaces so the
 * vocabulary renders identically everywhere (one source for the five states).
 */
export const DECISION_STATUS_PILL: Record<DecisionStatus, string> = {
  proposed: "bg-amber-100 text-amber-800 ring-amber-300",
  approved: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  rejected: "bg-red-100 text-red-800 ring-red-300",
  delayed: "bg-sky-100 text-sky-800 ring-sky-300",
  delegated: "bg-violet-100 text-violet-800 ring-violet-300",
};

export function DecisionStatusPill({
  status,
  suffix,
}: {
  status: DecisionStatus;
  suffix?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${DECISION_STATUS_PILL[status]}`}
    >
      {status}
      {suffix ?? ""}
    </span>
  );
}
