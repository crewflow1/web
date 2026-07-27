import { createAdminClient } from "@/lib/supabase/admin";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  cycleKey,
  isDueForGeneration,
  isOneOff,
  nextDueAfter,
} from "@/lib/assets/inspection-schedule";
import { MAINTENANCE_TYPE_LABELS, type MaintenanceType } from "@/lib/assets/maintenance";

/**
 * Service-case generator (M5b) — a direct clone of the PROVEN due-inspection
 * generator (M4b-2): the INSERT ... ON CONFLICT DO NOTHING on the TOTAL unique
 * (schedule_id, cycle_key) IS the claim; advancement is a count-gated CAS on
 * next_due run on win AND conflict-loss; one-offs deactivate. The pure date
 * maths (cycle keys, month-end clamping, lead windows) is REUSED from
 * lib/assets/inspection-schedule — no second scheduler framework. Notification
 * per WON claim (the claim is the dedup — the notifications table has none).
 */

type ScheduleRow = {
  id: string;
  org_id: string;
  asset_id: string;
  maintenance_type: MaintenanceType;
  title: string | null;
  interval_days: number | null;
  interval_months: number | null;
  next_due: string;
  lead_time_days: number;
  active: boolean;
  supplier_id: string | null;
};

export type MaintenanceGeneratorSummary = {
  scanned: number;
  generated: number;
  advanced: number;
  deactivated_one_offs: number;
};

const BATCH = 50;

export async function runMaintenanceGenerator(
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<MaintenanceGeneratorSummary> {
  const admin = createAdminClient();
  const summary: MaintenanceGeneratorSummary = {
    scanned: 0,
    generated: 0,
    advanced: 0,
    deactivated_one_offs: 0,
  };

  const { data: schedulesRaw, error: scanError } = await (
    admin.from("asset_service_schedules" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => { limit: (n: number) => Promise<{ data: ScheduleRow[] | null; error: { message: string } | null }> };
        };
      };
    }
  )
    .select(
      "id, org_id, asset_id, maintenance_type, title, interval_days, interval_months, next_due, lead_time_days, active, supplier_id",
    )
    .eq("active", true)
    .order("next_due", { ascending: true })
    .limit(BATCH);
  if (scanError) throw new Error(`maintenance generator scan failed: ${scanError.message}`);

  const due = (schedulesRaw ?? []).filter((s) => isDueForGeneration(s, todayIso));
  summary.scanned = schedulesRaw?.length ?? 0;

  for (const schedule of due) {
    const key = cycleKey(schedule.next_due);
    const title =
      schedule.title?.trim() ||
      `${MAINTENANCE_TYPE_LABELS[schedule.maintenance_type]} — due ${schedule.next_due}`;

    // THE CLAIM: insert-or-nothing on (schedule_id, cycle_key).
    const { data: won, error: claimError } = await (
      admin.from("asset_maintenance_cases" as never) as unknown as {
        upsert: (
          rows: unknown,
          opts: { onConflict: string; ignoreDuplicates: boolean },
        ) => { select: (c: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }> };
      }
    )
      .upsert(
        [
          {
            org_id: schedule.org_id,
            asset_id: schedule.asset_id,
            case_type: schedule.maintenance_type,
            priority: "medium",
            status: "scheduled",
            title,
            scheduled_for: schedule.next_due,
            supplier_id: schedule.supplier_id,
            schedule_id: schedule.id,
            cycle_key: key,
          },
        ],
        { onConflict: "schedule_id,cycle_key", ignoreDuplicates: true },
      )
      .select("id");
    if (claimError) throw new Error(`maintenance generator claim failed: ${claimError.message}`);
    if ((won ?? []).length > 0) {
      summary.generated += 1;
      const wonId = won?.[0]?.id;
      await emitNotifications([
        {
          org_id: schedule.org_id,
          user_id: null,
          audience: "customer",
          type: "maintenance.due",
          category: "system",
          priority: "medium",
          title: `Service due — ${title}`,
          body: `Scheduled for ${schedule.next_due}. Book it in from the asset's maintenance section.`,
          action_url: `/assets/${schedule.asset_id}`,
          source_module: "assets",
          source_id: wonId ?? schedule.id,
          metadata: { asset_id: schedule.asset_id, schedule_id: schedule.id, cycle_key: key },
        },
      ]).catch((e) => console.error("[maintenance-generator] notify failed", e));
    }

    // ADVANCE (win or conflict-loss): CAS on next_due; one-offs deactivate.
    const interval = { interval_days: schedule.interval_days, interval_months: schedule.interval_months };
    const patch = isOneOff(interval)
      ? { active: false }
      : { next_due: nextDueAfter(schedule.next_due, interval) };
    const { error: casError, count } = await (
      admin.from("asset_service_schedules" as never) as unknown as {
        update: (
          p: unknown,
          o: { count: string },
        ) => {
          eq: (k: string, v: unknown) => {
            eq: (
              k: string,
              v: unknown,
            ) => Promise<{ error: { message: string } | null; count: number | null }>;
          };
        };
      }
    )
      .update(patch, { count: "exact" })
      .eq("id", schedule.id)
      .eq("next_due", schedule.next_due);
    if (casError) throw new Error(`maintenance generator advance failed: ${casError.message}`);
    if (count) {
      if (isOneOff(interval)) summary.deactivated_one_offs += 1;
      else summary.advanced += 1;
    }
  }

  return summary;
}
