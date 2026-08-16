import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure, reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { StateForm } from "@/components/forms/StateForm";
import {
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUSES,
  type AssetOwnership,
  type AssetStatus,
} from "@/lib/assets/schema";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { listSiteOptionsForOrg, type SitesClient } from "@/server/services/sites";
import { deleteAsset, updateAssetStatus } from "../actions";
import { generateOrRegenerateQr, revokeQr } from "../qr-actions";
import { CustodySection, type CurrentAssignment } from "./_custody";
import { InspectionsSection, type InspectionRow, type PublishedTemplate } from "./_inspections";
import { SchedulesSection, type ScheduleRow } from "./_schedules";
import { SafetyBlocksSection } from "./_safety";
import { MaintenanceSection, type MaintenanceCaseRow } from "./_maintenance";
import { ServiceSchedulesSection, type ServiceScheduleRow } from "./_service-schedules";
import { DepreciationSection, type DepreciationSettingsRow } from "./_depreciation";
import { CalibrationSection, type CalibrationCertRow } from "./_calibration";
import { AssetTimelineSection, type TimelineEvent } from "./_timeline";
import { composeAssetTimeline } from "@/lib/assets/timeline";
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
  depreciation: "Depreciation policy saved. Net book value updates automatically.",
  depreciation_cleared: "Depreciation policy removed.",
  calibration: "Calibration certificate recorded.",
  calibration_deleted: "Calibration certificate deleted.",
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
  const { data: asset, error: assetError } = await (
    supabase.from("assets" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => { maybeSingle: () => Promise<{ data: AssetRow | null; error: SupabaseReadError | null }> };
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

  if (assetError) throw readFailure("asset detail: asset", assetError);
  if (!asset) notFound();

  const status = asset.status as AssetStatus;
  const ownership = asset.ownership as AssetOwnership;
  const canDelete = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  let supplierName: string | null = null;
  if (asset.supplier_id) {
    // Org-pinned like every supplier read (#463): `assets.supplier_id` is a
    // plain FK with no composite org binding, so without the pin a foreign
    // org's supplier name could render here for a dual-org member.
    const { data: s } = await (
      supabase.from("suppliers" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              maybeSingle: () => Promise<{ data: { name: string | null } | null }>;
            };
          };
        };
      }
    )
      .select("name")
      .eq("id", asset.supplier_id)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    supplierName = s?.name ?? null;
  }

  // Current open custody assignment (if any) + the pickers for check-out/transfer.
  const { data: currentRaw, error: currentError } = await (
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
                site_id: string | null;
                location: string | null;
                assigned_at: string;
                expected_return_at: string | null;
                issue_condition: string | null;
              } | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      };
    }
  )
    .select(
      "id, assignment_type, job_id, assignee_id, site_id, location, assigned_at, expected_return_at, issue_condition",
    )
    .eq("asset_id", id)
    .eq("status", "open")
    .maybeSingle();
  if (currentError) throw readFailure("asset detail: current custody", currentError);

  const staff = await listStaffForOrg(ctx.org.id);
  const { data: jobsRaw, error: jobsError } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name )")
    // ACTIVE-org pin. `jobs_select` is `org_id in current_org_ids()`, so for a
    // dual-org member this picker listed the OTHER company's jobs alongside
    // this one's — and picking one would assign this org's asset to a job it
    // has no relation to. Every sibling read on this page is org-scoped; this
    // one was the straggler.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(200);
  // PANEL-scoped, not page-scoped: this is the custody picker. A dead picker
  // must not 500 the whole asset page (status, inspections, safety blocks and
  // maintenance are all still useful and all read fine). Report it and render
  // an explicit notice above the custody section — never an empty <select>
  // that reads as "this org has no jobs".
  if (jobsError) reportReadFailure("asset detail: job picker", jobsError);
  const jobs = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    label: (j.customer?.name ?? "Job") + (j.scheduled_date ? ` · ${j.scheduled_date}` : ""),
  }));
  const staffOpts = staff.map((s) => ({ id: s.id, name: s.full_name || s.email }));
  const jobName = (jid: string | null) =>
    jid ? (jobs.find((j) => j.id === jid)?.label ?? "Job") : null;

  // Company locations for the store-at-depot destination. ORG-PINNED inside the
  // service: `sites_select` admits every org the viewer belongs to, so an
  // unpinned read would offer another company's depot — a choice the
  // site-org guard (20261061000000) would then refuse at write time.
  // The currently-assigned site is kept even if retired, so the open assignment
  // above never renders a blank where a real destination exists.
  const sites = await listSiteOptionsForOrg(
    supabase as unknown as SitesClient,
    ctx.org.id,
    { keepId: currentRaw?.site_id ?? null },
  );

  const current: CurrentAssignment | null = currentRaw
    ? {
        id: currentRaw.id,
        assignment_type: currentRaw.assignment_type,
        job_name: jobName(currentRaw.job_id),
        assignee_name: currentRaw.assignee_id
          ? (staffOpts.find((s) => s.id === currentRaw.assignee_id)?.name ?? "Someone")
          : null,
        site_name: currentRaw.site_id
          ? (sites.find((s) => s.id === currentRaw.site_id)?.name ?? null)
          : null,
        location: currentRaw.location,
        assigned_at: currentRaw.assigned_at,
        expected_return_at: currentRaw.expected_return_at,
        issue_condition: currentRaw.issue_condition,
      }
    : null;
  const today = new Date().toISOString().slice(0, 10);

  // Current active QR identity (if any).
  const { data: qr, error: qrError } = await (
    supabase.from("asset_qr_identities" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string; generated_at: string } | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, generated_at")
    .eq("asset_id", id)
    .eq("active", true)
    .maybeSingle();
  if (qrError) throw readFailure("asset detail: qr identity", qrError);

  // Inspections for this asset (newest first), excluding archived drafts.
  const { data: inspectionsRaw, error: inspectionsError } = await (
    supabase.from("asset_inspections" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          neq: (k: string, v: unknown) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{ data: InspectionRow[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("id, title, kind, safety_critical, status, outcome, inspected_at, created_at, due_at, template_id, template_version, reinspection_of")
    .eq("asset_id", id)
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  if (inspectionsError) throw readFailure("asset detail: inspections", inspectionsError);
  const inspections: InspectionRow[] = inspectionsRaw ?? [];

  // Published templates (the live versions) for the start-from-template picker.
  const { data: templatesRaw, error: templatesError } = await (
    supabase.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: PublishedTemplate[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select("id, name, version, categories")
    .eq("status", "published")
    .order("name", { ascending: true });
  // PANEL-scoped for the same reason as the job picker: the template pickers
  // feed the inspections + schedules sections, and an empty list there reads as
  // "your org has published no templates". Notice instead of a 500.
  if (templatesError) reportReadFailure("asset detail: published templates", templatesError);
  const publishedTemplates: PublishedTemplate[] = templatesRaw ?? [];

  // Standing inspection schedules for this asset (with their template names).
  const { data: schedulesRaw, error: schedulesError } = await (
    supabase.from("asset_inspection_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: ScheduleRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select(
      "id, template_id, interval_days, interval_months, next_due, lead_time_days, active, required_for_assignment, asset_inspection_templates(name, version)",
    )
    .eq("asset_id", id)
    .order("next_due", { ascending: true });
  if (schedulesError) throw readFailure("asset detail: inspection schedules", schedulesError);
  const schedules: ScheduleRow[] = schedulesRaw ?? [];

  // Overrides for this asset + the current safety blocks (the guard's mirror).
  const { data: overridesRaw, error: overridesError } = await (
    supabase.from("asset_inspection_overrides" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: OverrideRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select("id, inspection_id, reason, expires_at, created_at, created_by, revoked_at")
    .eq("asset_id", id)
    .order("created_at", { ascending: false });
  if (overridesError) throw readFailure("asset detail: overrides", overridesError);
  const nowIso = new Date().toISOString();
  const safetyBlocks = currentSafetyBlocks(
    inspections as unknown as BlockableInspection[],
    overridesRaw ?? [],
    nowIso,
  );
  const blockedFromIssue = hasUnbypassedBlock(safetyBlocks);

  // Maintenance cases for this asset (open first, newest first).
  const { data: casesRaw, error: casesError } = await (
    supabase.from("asset_maintenance_cases" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: MaintenanceCaseRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select(
      "id, case_type, priority, status, title, out_of_service, reinspection_required, work_performed, downtime_start, downtime_end, created_at, source_inspection_id",
    )
    .eq("asset_id", id)
    .order("created_at", { ascending: false });
  if (casesError) throw readFailure("asset detail: maintenance cases", casesError);
  const maintenanceCases: MaintenanceCaseRow[] = casesRaw ?? [];

  // Standing service schedules for this asset.
  const { data: svcSchedulesRaw, error: svcSchedulesError } = await (
    supabase.from("asset_service_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: ServiceScheduleRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select("id, maintenance_type, title, interval_days, interval_months, next_due, lead_time_days, active")
    .eq("asset_id", id)
    .order("next_due", { ascending: true });
  if (svcSchedulesError) throw readFailure("asset detail: service schedules", svcSchedulesError);
  const serviceSchedules: ServiceScheduleRow[] = svcSchedulesRaw ?? [];

  // Depreciation policy for this asset (one row per asset; ACTIVE-org pinned —
  // current_org_ids() is permissive so RLS alone doesn't scope a by-id read).
  const { data: depreciationRaw, error: depreciationError } = await (
    supabase.from("asset_depreciation_settings" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: DepreciationSettingsRow | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("method, cost, salvage_value, start_date, useful_life_months, annual_rate_pct")
    .eq("asset_id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (depreciationError) throw readFailure("asset detail: depreciation settings", depreciationError);
  const depreciation: DepreciationSettingsRow | null = depreciationRaw ?? null;

  // Calibration certificate register for this asset (newest calibration first).
  const { data: calibrationRaw, error: calibrationError } = await (
    supabase.from("asset_calibration_certificates" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{ data: CalibrationCertRow[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("id, schedule_id, certificate_number, calibrated_by, calibration_date, next_due_date, result, standard, notes")
    .eq("asset_id", id)
    .eq("org_id", ctx.org.id)
    .order("calibration_date", { ascending: false });
  if (calibrationError) throw readFailure("asset detail: calibration certificates", calibrationError);
  const calibrationCerts: CalibrationCertRow[] = calibrationRaw ?? [];

  // Calibration schedules a certificate can re-arm (derived from the service
  // schedules already read — no extra query).
  const calibrationScheduleOptions = serviceSchedules
    .filter((s) => s.maintenance_type === "calibration" && s.active)
    .map((s) => ({ id: s.id, title: s.title, next_due: s.next_due }));

  // Unified history: two bounded reads (custody assignments + QR-identity
  // lifecycle) plus events composed from data already loaded above
  // (inspections, overrides, maintenance cases). Both reads are ACTIVE-org
  // pinned like every other read on this page — `current_org_ids()` is
  // permissive, so RLS alone is not scoping.
  const { data: historyRaw, error: historyError } = await (
    supabase.from("asset_assignments" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => {
              limit: (n: number) => Promise<{
                data: { assignment_type: string; assigned_at: string; actual_return_at: string | null; location: string | null }[] | null;
                error: SupabaseReadError | null;
              }>;
            };
          };
        };
      };
    }
  )
    .select("assignment_type, assigned_at, actual_return_at, location")
    .eq("asset_id", id)
    .eq("org_id", ctx.org.id)
    .order("assigned_at", { ascending: false })
    .limit(15);
  if (historyError) throw readFailure("asset detail: custody history", historyError);

  // QR-identity lifecycle (generate / regenerate / revoke) — the only logged
  // "QR events" that exist. A scan writes nothing (lib/assets/scan.ts is a pure
  // resolver; no scan-event table exists), so scans are deliberately absent.
  const { data: qrHistoryRaw, error: qrHistoryError } = await (
    supabase.from("asset_qr_identities" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => {
              limit: (n: number) => Promise<{
                data: { generated_at: string; revoked_at: string | null; revocation_reason: string | null; regenerated_from: string | null }[] | null;
                error: SupabaseReadError | null;
              }>;
            };
          };
        };
      };
    }
  )
    .select("generated_at, revoked_at, revocation_reason, regenerated_from")
    .eq("asset_id", id)
    .eq("org_id", ctx.org.id)
    .order("generated_at", { ascending: false })
    .limit(15);
  if (qrHistoryError) throw readFailure("asset detail: qr history", qrHistoryError);

  const timeline: TimelineEvent[] = composeAssetTimeline({
    custody: historyRaw ?? [],
    inspections,
    overrides: overridesRaw ?? [],
    maintenanceCases,
    qr: qrHistoryRaw ?? [],
  });

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
              <StateForm key={s} action={updateAssetStatus}>
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
              </StateForm>
            );
          })}
        </div>
      </section>

      <SafetyBlocksSection assetId={asset.id} blocks={safetyBlocks} isAdmin={canDelete} />

      {jobsError ? <PickerNotice what="job list" /> : null}
      <CustodySection
        assetId={asset.id}
        assetActive={status === "active"}
        current={current}
        jobs={jobs}
        staff={staffOpts}
        sites={sites}
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
          <StateForm action={generateOrRegenerateQr.bind(null, asset.id)}>
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
              {qr ? "Regenerate (invalidates old label)" : "Generate QR identity"}
            </button>
          </StateForm>
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
              <StateForm action={revokeQr.bind(null, asset.id)}>
                <button type="submit" className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                  Revoke
                </button>
              </StateForm>
            </>
          ) : null}
        </div>
      </section>

      {templatesError ? <PickerNotice what="inspection templates" /> : null}
      <InspectionsSection assetId={asset.id} inspections={inspections} templates={publishedTemplates} today={today} blocked={blockedFromIssue} />

      <MaintenanceSection assetId={asset.id} cases={maintenanceCases} isAdmin={canDelete} />

      <ServiceSchedulesSection
        assetId={asset.id}
        schedules={serviceSchedules}
        isAdmin={canDelete}
        today={today}
      />

      <CalibrationSection
        assetId={asset.id}
        certs={calibrationCerts}
        schedules={calibrationScheduleOptions}
        isAdmin={canDelete}
        today={today}
      />

      <DepreciationSection
        assetId={asset.id}
        settings={depreciation}
        isAdmin={canDelete}
        today={today}
        defaultCost={asset.purchase_price}
        defaultStart={asset.purchase_date}
      />

      {templatesError ? <PickerNotice what="inspection templates" /> : null}
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
        <StateForm action={deleteAsset.bind(null, asset.id)}>
          <button type="submit" className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
            Delete asset
          </button>
          <span className="ml-3 text-xs text-slate-500">Prefer a status change (retired/sold) to keep the history.</span>
        </StateForm>
      ) : null}
    </div>
  );
}

/**
 * Explicit failure state for a picker whose read was rejected. The point of the
 * whole loud-reads sweep: an empty <select> is indistinguishable from "you have
 * none", so say which one it is. Panel-scoped — the rest of the page renders.
 */
function PickerNotice({ what }: { what: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      Couldn&rsquo;t load the {what} just now, so the picker below is empty — that
      isn&rsquo;t a sign you have none. Refresh to try again.
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
