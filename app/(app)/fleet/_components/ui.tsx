import Link from "next/link";
import type { ReactNode } from "react";
import {
  FLEET_COMPLIANCE_LABELS,
  type ComplianceState,
  type FleetComplianceType,
} from "@/lib/fleet/compliance";
import {
  OPERATIONAL_STATUS_LABELS,
  VEHICLE_CLASS_LABELS,
  type OperationalStatus,
  type VehicleClass,
} from "@/lib/fleet/schema";

/**
 * Fleet presentational primitives.
 *
 * Deliberately built from the SAME tokens the rest of the app already uses —
 * `rounded-xl border border-slate-200 bg-white shadow-sm` cards, slate type
 * scale, `bg-slate-900` primary buttons, pill filters (see /assets, /cash and
 * /jobs). Fleet must read as another room in CrewFlow, not a bolted-on module.
 */

export function Stat({
  label,
  value,
  hint,
  accent,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {/* `truncate` clips a wide GBP token (a comma-grouped 7-figure fuel
          spend has no soft-wrap opportunity) so it can never push its
          `min-w-0` grid track past the 375px viewport. See the money-tile
          overflow guard and e2e/fleet-mobile.spec.ts. */}
      <p className={`mt-1 truncate text-xl font-bold tabular-nums sm:text-2xl ${accent ?? "text-slate-900"}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </>
  );
  const cls = "min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
  return href ? (
    <Link href={href} className={`${cls} block transition hover:border-slate-300 hover:shadow`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function SectionCard({
  title,
  id,
  action,
  children,
}: {
  title: string;
  id?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const hid = id ?? `s-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section
      id={id}
      aria-labelledby={`${hid}-h`}
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
        <h2 id={`${hid}-h`} className="text-sm font-semibold text-slate-900">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const OPERATIONAL_STYLES: Record<OperationalStatus, string> = {
  in_service: "bg-emerald-100 text-emerald-800",
  off_road: "bg-amber-100 text-amber-800",
  in_workshop: "bg-blue-100 text-blue-700",
};

export function OperationalPill({ status }: { status: string }) {
  const key = status as OperationalStatus;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        OPERATIONAL_STYLES[key] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {OPERATIONAL_STATUS_LABELS[key] ?? status}
    </span>
  );
}

const COMPLIANCE_STYLES: Record<ComplianceState, string> = {
  overdue: "bg-red-100 text-red-800",
  due_soon: "bg-amber-100 text-amber-800",
  ok: "bg-emerald-100 text-emerald-800",
};

/**
 * A compliance chip. The wording is exact rather than cheerful: "MOT 12 days
 * late" is actionable, "MOT ⚠️" is not. `critical` additionally gets a ring so
 * a live legal breach is visually distinct from a merely-late service.
 */
export function CompliancePill({
  type,
  state,
  daysUntilDue,
  critical,
}: {
  type: FleetComplianceType;
  state: ComplianceState;
  daysUntilDue: number;
  critical?: boolean;
}) {
  const label = FLEET_COMPLIANCE_LABELS[type];
  const when =
    state === "overdue"
      ? `${Math.abs(daysUntilDue)}d late`
      : state === "due_soon"
        ? daysUntilDue === 0
          ? "due today"
          : `in ${daysUntilDue}d`
        : `in ${daysUntilDue}d`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        COMPLIANCE_STYLES[state]
      } ${critical ? "ring-1 ring-red-500" : ""}`}
    >
      <span className="font-semibold">{label}</span>
      <span className="font-normal opacity-80">{when}</span>
    </span>
  );
}

export function VehicleClassLabel({ value }: { value: string | null }) {
  if (!value) return null;
  return <>{VEHICLE_CLASS_LABELS[value as VehicleClass] ?? value}</>;
}

/** UK registration plate treatment — monospaced, uppercase, unmistakable. */
export function Plate({ registration }: { registration: string | null }) {
  if (!registration) {
    return <span className="text-xs italic text-slate-500">No registration</span>;
  }
  return (
    <span className="inline-block rounded border border-slate-300 bg-yellow-50 px-1.5 py-0.5 font-mono text-xs font-bold uppercase tracking-wider text-slate-900">
      {registration}
    </span>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "error" | "success" | "warn";
  children: ReactNode;
}) {
  const styles =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-emerald-200 bg-emerald-50 text-emerald-800";
  return (
    <div
      role={tone === "success" ? "status" : "alert"}
      className={`rounded-md border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}

export function FilterPill({
  href,
  label,
  active,
  count,
}: {
  href: string;
  label: string;
  active: boolean;
  count?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
      {/* Solid tones, never opacity-*: the blended count fell below WCAG AA 4.5:1. */}
      {count != null ? (
        <span className={`ml-1 tabular-nums ${active ? "text-slate-300" : "text-slate-600"}`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

/** Shared input styling so every fleet form matches the rest of the app. */
export const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
export const labelClass = "block text-xs font-medium text-slate-700";
export const primaryButtonClass =
  "rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50";
export const secondaryButtonClass =
  "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50";
