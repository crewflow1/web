import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUSES,
  type AssetOwnership,
  type AssetStatus,
} from "@/lib/assets/schema";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { deleteAsset, updateAssetStatus } from "../actions";
import { generateOrRegenerateQr, revokeQr } from "../qr-actions";
import { CustodySection, type CurrentAssignment } from "./_custody";
import { InspectionsSection, type InspectionRow, type PublishedTemplate } from "./_inspections";
import { SchedulesSection, type ScheduleRow } from "./_schedules";
import { SafetyBlocksSection } from "./_safety";
import { MaintenanceSection, type MaintenanceCaseRow } from "./_maintenance";
import { ServiceSchedulesSection, type ServiceScheduleRow } from "./_service-schedules";
import { AssetTimelineSection, type TimelineEvent } from "./_timeline";
import { INSPECTION_OUTCOME_LABELS } from "@/lib/assets/inspection";
import { MAINTENANCE_STATUS_LABELS as CASE_STATUS_LABELS } from "@/lib/assets/maintenance";
import {
  currentSafetyBlocks,
  hasUnbypassedBlock,
  type BlockableInspection,
  type OverrideRow,
} from "@/lib/assets/inspection-override";

type AssetRow = {
  id: string;
  name: string;
  category: string | null;
  asset_ref: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  registration: string | null;
  ownership: string;
  status: string;
  supplier_id: string | null;
  purchase_date: string | null;
  purchase_price: number | string | null;
  current_value: number | string | null;
  warranty_expires_at: string | null;
  hire_start: string | null;
  hire_end: string | null;
  hire_rate: number | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
};

const STATUS_STYLES: Record<AssetStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  retired: "bg-slate-100 text-slate-600",
  sold: "bg-blue-100 text-blue-700",
  lost: "bg-amber-100 text-amber-800",
  stolen: "bg-red-100 text-red-800",
  written_off: "bg-red-100 text-red-800",
};

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });
const money = (v: number | string | null) => (v == null ? "—" : GBP.format(Number(v)));

const SAVED_MAP: Record<string, string> = {
  created: "Asset added.",
  status: "Status updated.",
  checked_out: "Asset checked out.",
  returned: "Asset returned.",
  transferred: "Asset transferred.",
  qr: "QR identity generated. Any previous label no longer works.",
  qr_revoked: "QR identity revoked.",
  inspection: "Inspection recorded.",
  inspection_issued: "Inspection issued. The record is now locked.",
  inspection_archived: "Draft inspection discarded.",
  schedule: "Schedule added. Due inspections generate automatically.",
  schedule_paused: "Schedule paused.",
  schedule_resumed: "Schedule resumed.",
  schedule_deleted: "Schedule removed. Generated history is preserved.",
  override: "Authorised operational override recorded.",
  override_revoked: "Override revoked. Blocking has resumed.",
  reinspection: "Re-inspection draft created. Complete and issue it to clear the block.",
  case_reported: "Maintenance case reported.",
  case_updated: "Maintenance case updated.",
  case_costs: "Costs saved.",
};
const ERROR_MAP: Record<string, string> = {
  bad_status: "Invalid status.",
  update_failed: "Couldn't update the asset.",
  validation: "Please check the form.",
  not_open: "That asset isn't currently checked out.",
  qr_failed: "Couldn't update the QR identity. Try again.",
  no_active_qr: "This asset has no active QR identity.",
  inspection_invalid: "Please check the inspection details.",
  inspection_failed: "Couldn't save the inspection. Try again.",
  inspection_outcome: "Choose an outcome to issue the inspection.",
  inspection_not_draft: "That inspection is no longer a draft.",
  inspection_missing: "That inspection could not be found.",
  inspection_locked: "That inspection is locked.",
  template_missing: "That template could not be found.",
  template_not_published: "Only a published template can start an inspection.",
  template_failed: "Couldn't load that template. Try again.",
  schedule_invalid: "Please check the schedule details.",
  schedule_failed: "Couldn't save the schedule. Try again.",
  forbidden: "Only an owner or admin can do that.",
  override_invalid: "Give a real reason (at least 10 characters).",
  override_failed: "Couldn't save the override. Try again.",
  override_already_revoked: "That override was already revoked.",
  inspection_not_issued: "Only an issued inspection can be re-inspected.",
  case_invalid: "Please check the maintenance details.",
  case_failed: "Couldn't save the maintenance case. Try again.",
  case_missing: "That maintenance case could not be found.",
  case_transition: "That step isn't allowed from the case's current state.",
  case_stale: "The case changed while you were looking — try again.",
};

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Pinned to the ACTIVE org, not just to RLS: `current_org_ids()` returns
  // every membership, so a by-id read alone renders another org's asset inside
  // this org's shell — and this page is where the custody/QR/maintenance
  // actions live. A non-active-org asset must be indistinguishable from a
  // missing one.
  const { data: asset } = await (
    supabase.from("assets" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => { maybeSingle: () => Promise<{ data: AssetRow | null }> };
        };
      };
    }
  )
    .select(
      "id, name, category, asset_ref, manufacturer, model, serial_number, registration, ownership, status, supplier_id, purchase_date, purchase_price, current_value, warranty_expires_at, hire_start, hire_end, hire_rate, notes, created_at, updated_at",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!asset) notFound();

  const status = asset.status as AssetStatus;
  const ownership = asset.ownership as AssetOwnership;
  const canDelete = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  let supplierName: string | null = null;
  if (asset.supplier_id) {
    const { data: s } = await (
      supabase.from("suppliers" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: { name: string | null } | null }>;
          };
        };
      }
    )
      .select("name")
      .eq("id", asset.supplier_id)
      .maybeSingle();
    supplierName = s?.name ?? null;
  }

  // Current open custody assignment (if any) + the pickers for check-out/transfer.
  const { data: currentRaw } = await (
    supabase.from("asset_assignments" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: {
                id: string;
                assignment_type: string;
                job_id: string | null;
                assignee_id: string | null;
                location: string | null;
                assigned_at: string;
                expected_return_at: string | null;
                issue_condition: string | null;
              } | null;
            }>;
          };
        };
      };
    }
  )
    .select(
      "id, assignment_type, job_id, assignee_id, location, assigned_at, expected_return_at, issue_condition",
    )
    .eq("asset_id", id)
    .eq("status", "open")
    .maybeSingle();

  const staff = await listStaffForOrg(ctx.org.id);
  const { data: jobsRaw } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name )")
    .order("created_at", { ascending: false })
    .limit(200);
  const jobs = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    label: (j.customer?.name ?? "Job") + (j.scheduled_date ? ` · ${j.scheduled_date}` : ""),
  }));
  const staffOpts = staff.map((s) => ({ id: s.id, name: s.full_name || s.email }));
  const jobName = (jid: string | null) =>
    jid ? (jobs.find((j) => j.id === jid)?.label ?? "Job") : null;

  const current: CurrentAssignment | null = currentRaw
    ? {
        id: currentRaw.id,
        assignment_type: currentRaw.assignment_type,
        job_name: jobName(currentRaw.job_id),
        assignee_name: currentRaw.assignee_id
          ? (staffOpts.find((s) => s.id === currentRaw.assignee_id)?.name ?? "Someone")
          : null,
        location: currentRaw.location,
        assigned_at: currentRaw.assigned_at,
        expected_return_at: currentRaw.expected_return_at,
        issue_condition: currentRaw.issue_condition,
      }
    : null;
  const today = new Date().toISOString().slice(0, 10);

  // Current active QR identity (if any).
  const { data: qr } = await (
    supabase.from("asset_qr_identities" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: { id: string; generated_at: string } | null }>;
          };
        };
      };
    }
  )
    .select("id, generated_at")
    .eq("asset_id", id)
    .eq("active", true)
    .maybeSingle();

  // Inspections for this asset (newest first), excluding archived drafts.
  const { data: inspectionsRaw } = await (
    supabase.from("asset_inspections" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          neq: (k: string, v: unknown) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{ data: InspectionRow[] | null }>;
          };
        };
      };
    }
  )
    .select("id, title, kind, safety_critical, status, outcome, inspected_at, created_at, due_at, template_id, template_version, reinspection_of")
    .eq("asset_id", id)
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  const inspections: InspectionRow[] = inspectionsRaw ?? [];

  // Published templates (the live versions) for the start-from-template picker.
  const { data: templatesRaw } = await (
    supabase.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: PublishedTemplate[] | null }>;
        };
      };
    }
  )
    .select("id, name, version, categories")
    .eq("status", "published")
    .order("name", { ascending: true });
  const publishedTemplates: PublishedTemplate[] = templatesRaw ?? [];

  // Standing inspection schedules for this asset (with their template names).
  const { data: schedulesRaw } = await (
    supabase.from("asset_inspection_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: ScheduleRow[] | null }>;
        };
      };
    }
  )
    .select(
      "id, template_id, interval_days, interval_months, next_due, lead_time_days, active, required_for_assignment, asset_inspection_templates(name, version)",
    )
    .eq("asset_id", id)
    .order("next_due", { ascending: true });
  const schedules: ScheduleRow[] = schedulesRaw ?? [];

  // Overrides for this asset + the current safety blocks (the guard's mirror).
  const { data: overridesRaw } = await (
    supabase.from("asset_inspection_overrides" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: OverrideRow[] | null }>;
        };
      };
    }
  )
    .select("id, inspection_id, reason, expires_at, created_at, created_by, revoked_at")
    .eq("asset_id", id)
    .order("created_at", { ascending: false });
  const nowIso = new Date().toISOString();
  const safetyBlocks = currentSafetyBlocks(
    inspections as unknown as BlockableInspection[],
    overridesRaw ?? [],
    nowIso,
  );
  const blockedFromIssue = hasUnbypassedBlock(safetyBlocks);

  // Maintenance cases for this asset (open first, newest first).
  const { data: casesRaw } = await (
    supabase.from("asset_maintenance_cases" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: MaintenanceCaseRow[] | null }>;
        };
      };
    }
  )
    .select(
      "id, case_type, priority, status, title, out_of_service, reinspection_required, work_performed, downtime_start, downtime_end, created_at, source_inspection_id",
    )
    .eq("asset_id", id)
    .order("created_at", { ascending: false });
  const maintenanceCases: MaintenanceCaseRow[] = casesRaw ?? [];

  // Standing service schedules for this asset.
  const { data: svcSchedulesRaw } = await (
    supabase.from("asset_service_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: ServiceScheduleRow[] | null }>;
        };
      };
    }
  )
    .select("id, maintenance_type, title, interval_days, interval_months, next_due, lead_time_days, active")
    .eq("asset_id", id)
    .order("next_due", { ascending: true });
  const serviceSchedules: ServiceScheduleRow[] = svcSchedulesRaw ?? [];

  // Unified history: one bounded custody read + events composed from data
  // already loaded above (inspections, overrides, maintenance cases).
  const { data: historyRaw } = await (
    supabase.from("asset_assignments" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => { limit: (n: number) => Promise<{ data: { assignment_type: string; assigned_at: string; actual_return_at: string | null; location: string | null }[] | null }> };
        };
      };
    }
  )
    .select("assignment_type, assigned_at, actual_return_at, location")
    .eq("asset_id", id)
    .order("assigned_at", { ascending: false })
    .limit(15);
  const timeline: TimelineEvent[] = [];
  for (const a of historyRaw ?? []) {
    timeline.push({ at: a.assigned_at, kind: "custody", label: `Checked out (${a.assignment_type.replaceAll("_", " ")}${a.location ? ` — ${a.location}` : ""})` });
    if (a.actual_return_at) timeline.push({ at: a.actual_return_at, kind: "custody", label: "Returned" });
  }
  for (const i of inspections) {
    if (i.status === "issued" || i.status === "superseded") {
      timeline.push({
        at: i.inspected_at ?? i.created_at,
        kind: "inspection",
        label: `${i.title} — ${i.outcome ? INSPECTION_OUTCOME_LABELS[i.outcome] : "recorded"}${i.safety_critical && i.outcome === "fail" ? " (safety block)" : ""}`,
      });
    }
  }
  for (const o of overridesRaw ?? []) {
    timeline.push({ at: o.created_at, kind: "override", label: "Operational override recorded" });
    if (o.revoked_at) timeline.push({ at: o.revoked_at, kind: "override", label: "Override revoked" });
  }
  for (const c of maintenanceCases) {
    timeline.push({ at: c.created_at, kind: "maintenance", label: `${c.title} — ${CASE_STATUS_LABELS[c.status]}` });
  }

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Assets
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{asset.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
            {ASSET_STATUS_LABELS[status] ?? asset.status}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
            {ASSET_OWNERSHIP_LABELS[ownership] ?? asset.ownership}
          </span>
          {asset.category ? <span className="text-slate-500">{asset.category}</span> : null}
        </div>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedMessage}</div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Detail label="Manufacturer">{asset.manufacturer}</Detail>
          <Detail label="Model">{asset.model}</Detail>
          <Detail label="Serial number">{asset.serial_number}</Detail>
          <Detail label="Registration">{asset.registration}</Detail>
          <Detail label="Your reference">{asset.asset_ref}</Detail>
          <Detail label="Supplier">{supplierName}</Detail>
          <Detail label="Purchase date">{asset.purchase_date}</Detail>
          <Detail label="Purchase price">{money(asset.purchase_price)}</Detail>
          <Detail label="Current value">{money(asset.current_value)}</Detail>
          <Detail label="Warranty expiry">{asset.warranty_expires_at}</Detail>
          {ownership === "hired" ? (
            <>
              <Detail label="Hire period">
                {asset.hire_start || asset.hire_end
                  ? `${asset.hire_start ?? "—"} → ${asset.hire_end ?? "—"}`
                  : "—"}
              </Detail>
              <Detail label="Hire rate">{money(asset.hire_rate)}</Detail>
            </>
          ) : null}
        </dl>
        {asset.notes ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{asset.notes}</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Status</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {ASSET_STATUSES.map((s) => {
            const isCurrent = s === status;
            return (
              <form key={s} action={updateAssetStatus}>
                <input type="hidden" name="id" value={asset.id} />
                <input type="hidden" name="status" value={s} />
                <button
                  type="submit"
                  disabled={isCurrent}
                  className={
                    isCurrent
                      ? "cursor-default rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                      : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  }
                >
                  {ASSET_STATUS_LABELS[s]}
                </button>
              </form>
            );
          })}
        </div>
      </section>

      <SafetyBlocksSection assetId={asset.id} blocks={safetyBlocks} isAdmin={canDelete} />

      <CustodySection
        assetId={asset.id}
        assetActive={status === "active"}
        current={current}
        jobs={jobs}
        staff={staffOpts}
        today={today}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">QR identity</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {qr
            ? `Active since ${qr.generated_at.slice(0, 10)}. A scan resolves here after sign-in — the label carries only an opaque token.`
            : "No QR identity yet. Generate one to print a label; the label carries only an opaque token."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={generateOrRegenerateQr.bind(null, asset.id)}>
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
              {qr ? "Regenerate (invalidates old label)" : "Generate QR identity"}
            </button>
          </form>
          {qr ? (
            <>
              <a
                href={`/api/assets/${asset.id}/label/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Print label
              </a>
              <a
                href={`/api/assets/${asset.id}/label/pdf?copies=12`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Print sheet
              </a>
              <form action={revokeQr.bind(null, asset.id)}>
                <button type="submit" className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                  Revoke
                </button>
              </form>
            </>
          ) : null}
        </div>
      </section>

      <InspectionsSection assetId={asset.id} inspections={inspections} templates={publishedTemplates} today={today} blocked={blockedFromIssue} />

      <MaintenanceSection assetId={asset.id} cases={maintenanceCases} isAdmin={canDelete} />

      <ServiceSchedulesSection
        assetId={asset.id}
        schedules={serviceSchedules}
        isAdmin={canDelete}
        today={today}
      />

      <SchedulesSection
        assetId={asset.id}
        schedules={schedules}
        templates={publishedTemplates}
        isAdmin={canDelete}
        today={today}
      />

      <AssetTimelineSection events={timeline} />

      {/* Images, manuals, certificates — via the universal attachments pipeline. */}
      <AttachmentsPanel targetTable="assets" targetId={asset.id} />

      {canDelete ? (
        <form action={deleteAsset.bind(null, asset.id)}>
          <button type="submit" className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
            Delete asset
          </button>
          <span className="ml-3 text-xs text-slate-500">Prefer a status change (retired/sold) to keep the history.</span>
        </form>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children || "—"}</dd>
    </div>
  );
}
