/**
 * Pure composer for the unified asset history (Train J).
 *
 * The asset detail page already loads every per-domain source it needs (custody
 * assignments, inspections, overrides, maintenance cases) plus — as of this
 * slice — the asset's QR-identity lifecycle. This module interleaves those
 * already-loaded rows into one chronological event stream. It COMPOSES existing
 * sources; it never re-detects or re-reads them, and it is deliberately pure
 * (no I/O, no `Date.now()`) so the interleave + labelling is unit-testable.
 *
 * QR SCAN EVENTS ARE NOT INCLUDED — and cannot be. A scan resolves a token to
 * an asset (lib/assets/scan.ts) and renders; it writes nothing, and there is no
 * scan_event / qr_scan table anywhere in the schema. What IS logged is the QR
 * *identity lifecycle* (generated / regenerated / revoked on
 * asset_qr_identities), so those real events are what this surfaces under the
 * "qr" kind. Fabricating scan rows would be inventing history the system never
 * recorded.
 */

import { INSPECTION_OUTCOME_LABELS, type InspectionOutcome } from "@/lib/assets/inspection";
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from "@/lib/assets/maintenance";

export type TimelineEvent = {
  at: string;
  kind: "custody" | "inspection" | "override" | "maintenance" | "qr";
  label: string;
};

/** One bounded custody-history row (an assignment; a transfer is a new one). */
export type TimelineCustody = {
  assignment_type: string;
  assigned_at: string;
  actual_return_at: string | null;
  location: string | null;
};

/** The inspection fields the timeline reads — a subset of the detail row. */
export type TimelineInspection = {
  title: string;
  status: string;
  outcome: InspectionOutcome | null;
  safety_critical: boolean;
  inspected_at: string | null;
  created_at: string;
};

export type TimelineOverride = {
  created_at: string;
  revoked_at: string | null;
};

export type TimelineMaintenanceCase = {
  title: string;
  status: MaintenanceStatus;
  created_at: string;
};

/** One QR-identity lifecycle row (asset_qr_identities). */
export type TimelineQrIdentity = {
  generated_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  regenerated_from: string | null;
};

export type AssetTimelineSources = {
  custody: TimelineCustody[];
  inspections: TimelineInspection[];
  overrides: TimelineOverride[];
  maintenanceCases: TimelineMaintenanceCase[];
  qr: TimelineQrIdentity[];
};

/**
 * Interleave the asset's per-domain history into one event list. Returns the
 * events UNSORTED (the render layer sorts newest-first and caps) so this stays
 * a pure fold over the inputs. Missing sources are treated as empty.
 */
export function composeAssetTimeline(sources: Partial<AssetTimelineSources>): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const a of sources.custody ?? []) {
    events.push({
      at: a.assigned_at,
      kind: "custody",
      label: `Checked out (${a.assignment_type.replaceAll("_", " ")}${a.location ? ` — ${a.location}` : ""})`,
    });
    if (a.actual_return_at) {
      events.push({ at: a.actual_return_at, kind: "custody", label: "Returned" });
    }
  }

  for (const i of sources.inspections ?? []) {
    if (i.status === "issued" || i.status === "superseded") {
      events.push({
        at: i.inspected_at ?? i.created_at,
        kind: "inspection",
        label: `${i.title} — ${i.outcome ? INSPECTION_OUTCOME_LABELS[i.outcome] : "recorded"}${
          i.safety_critical && i.outcome === "fail" ? " (safety block)" : ""
        }`,
      });
    }
  }

  for (const o of sources.overrides ?? []) {
    events.push({ at: o.created_at, kind: "override", label: "Operational override recorded" });
    if (o.revoked_at) {
      events.push({ at: o.revoked_at, kind: "override", label: "Override revoked" });
    }
  }

  for (const c of sources.maintenanceCases ?? []) {
    events.push({
      at: c.created_at,
      kind: "maintenance",
      label: `${c.title} — ${MAINTENANCE_STATUS_LABELS[c.status]}`,
    });
  }

  for (const q of sources.qr ?? []) {
    events.push({
      at: q.generated_at,
      kind: "qr",
      label: q.regenerated_from ? "QR identity regenerated" : "QR identity generated",
    });
    if (q.revoked_at) {
      events.push({
        at: q.revoked_at,
        kind: "qr",
        // A revocation with reason 'regenerated' is the old label being
        // superseded by a fresh one — distinct from a deliberate revoke.
        label:
          q.revocation_reason === "regenerated"
            ? "QR identity superseded (old label retired)"
            : "QR identity revoked",
      });
    }
  }

  return events;
}
