import { createAdminClient } from "@/lib/supabase/admin";
import { emitNotifications } from "@/server/services/notifications-service";
import {
  cycleKey,
  isDueForGeneration,
  isOneOff,
  nextDueAfter,
} from "@/lib/assets/inspection-schedule";
import {
  materializeTemplateSnapshot,
  templateDefinitionSchema,
  type CheckLevel,
} from "@/lib/assets/inspection-template";

/**
 * Due-inspection generator (M4b-2). Runs from the cron route on the service
 * client (the cron norm — RLS bypass; the DB triggers still enforce same-org
 * shape and the claim index enforces idempotency).
 *
 * Claim doctrine (automation_runs 20260912): the INSERT **is** the claim —
 * `upsert(..., { onConflict: "schedule_id,cycle_key", ignoreDuplicates: true })`
 * compiles to INSERT ... ON CONFLICT DO NOTHING RETURNING; returned rows are
 * cycles won, conflicts return nothing and cause no side effects. Repeated,
 * concurrent and retried runs converge on exactly one due inspection per cycle.
 *
 * Advancement is a count-gated CAS (`next_due = D` → `nextDueAfter(D)`): under
 * concurrency both runners compute the same target from the same read, the
 * second matches zero rows. Run on win AND on conflict-loss (a conflict means
 * the cycle already exists, so the schedule must still advance to unstick).
 * One cycle per run — an overdue schedule catches up run by run, bounded work.
 *
 * A family with NO current published version (never published / archived)
 * generates nothing AND does not advance: when re-published, generation resumes
 * from the stale next_due — immediately overdue, which is the truthful state.
 */

type ScheduleRow = {
  id: string;
  org_id: string;
  asset_id: string;
  template_id: string;
  title: string | null;
  interval_days: number | null;
  interval_months: number | null;
  next_due: string;
  lead_time_days: number;
  active: boolean;
};

type TemplateRow = {
  id: string;
  family_id: string;
  version: number;
  name: string;
  check_level: CheckLevel;
  status: string;
  definition: unknown;
};

export type GeneratorSummary = {
  scanned: number;
  generated: number;
  advanced: number;
  deactivated_one_offs: number;
  skipped_unpublished: number;
};

const BATCH = 50; // bounded batch, notifications-service precedent

export async function runInspectionGenerator(
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<GeneratorSummary> {
  const admin = createAdminClient();
  const summary: GeneratorSummary = {
    scanned: 0,
    generated: 0,
    advanced: 0,
    deactivated_one_offs: 0,
    skipped_unpublished: 0,
  };

  // Bounded scan of active schedules ordered by due date; the lead-window
  // filter is applied per-row (lead_time_days varies).
  const { data: schedulesRaw, error: scanError } = await (
    admin.from("asset_inspection_schedules" as never) as unknown as {
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
      "id, org_id, asset_id, template_id, title, interval_days, interval_months, next_due, lead_time_days, active",
    )
    .eq("active", true)
    .order("next_due", { ascending: true })
    .limit(BATCH);
  if (scanError) throw new Error(`generator scan failed: ${scanError.message}`);

  const due = (schedulesRaw ?? []).filter((s) => isDueForGeneration(s, todayIso));
  summary.scanned = schedulesRaw?.length ?? 0;

  for (const schedule of due) {
    // Resolve the CURRENT PUBLISHED version of the schedule's template family.
    const { data: anchor } = await (
      admin.from("asset_inspection_templates" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: { family_id: string } | null }> };
        };
      }
    )
      .select("family_id")
      .eq("id", schedule.template_id)
      .maybeSingle();
    if (!anchor) {
      summary.skipped_unpublished += 1;
      continue;
    }
    const { data: published } = await (
      admin.from("asset_inspection_templates" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: TemplateRow | null }> };
          };
        };
      }
    )
      .select("id, family_id, version, name, check_level, status, definition")
      .eq("family_id", anchor.family_id)
      .eq("status", "published")
      .maybeSingle();
    if (!published) {
      summary.skipped_unpublished += 1;
      continue; // no advance: resumes (overdue) when re-published
    }
    const def = templateDefinitionSchema.safeParse(published.definition);
    if (!def.success) {
      summary.skipped_unpublished += 1;
      continue;
    }

    const key = cycleKey(schedule.next_due);
    const snapshot = materializeTemplateSnapshot({
      id: published.id,
      family_id: published.family_id,
      version: published.version,
      name: published.name,
      check_level: published.check_level,
      definition: def.data,
    });

    // THE CLAIM: insert-or-nothing on (schedule_id, cycle_key).
    const { data: won, error: claimError } = await (
      admin.from("asset_inspections" as never) as unknown as {
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
            title: schedule.title?.trim() || published.name,
            status: "draft",
            safety_critical: false, // derived at issue from the answers
            content: {},
            template_id: published.id,
            template_version: published.version,
            template_snapshot: snapshot,
            due_at: `${schedule.next_due}T00:00:00.000Z`,
            schedule_id: schedule.id,
            cycle_key: key,
          },
        ],
        { onConflict: "schedule_id,cycle_key", ignoreDuplicates: true },
      )
      .select("id");
    if (claimError) throw new Error(`generator claim failed: ${claimError.message}`);
    if ((won ?? []).length > 0) {
      summary.generated += 1;
      // Idempotent by construction: one emission per WON claim — retried or
      // concurrent runs lose the conflict and emit nothing (the notifications
      // table has no DB dedup, so the claim is the dedup).
      const wonId = won?.[0]?.id;
      await emitNotifications([
        {
          org_id: schedule.org_id,
          user_id: null,
          audience: "customer",
          type: "inspection.due",
          category: "system",
          priority: "medium",
          title: `Inspection due — ${schedule.title?.trim() || published.name}`,
          body: `Due ${schedule.next_due}. Complete it from the asset's inspections.`,
          action_url: wonId ? `/assets/${schedule.asset_id}/inspections/${wonId}` : `/assets/${schedule.asset_id}`,
          source_module: "assets",
          source_id: wonId ?? schedule.id,
          metadata: { asset_id: schedule.asset_id, schedule_id: schedule.id, cycle_key: key },
        },
      ]).catch((e) => console.error("[inspection-generator] notify failed", e));
    }

    // ADVANCE (win or conflict-loss): CAS on next_due; one-offs deactivate.
    const interval = { interval_days: schedule.interval_days, interval_months: schedule.interval_months };
    const patch = isOneOff(interval)
      ? { active: false }
      : { next_due: nextDueAfter(schedule.next_due, interval) };
    const { error: casError, count } = await (
      admin.from("asset_inspection_schedules" as never) as unknown as {
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
    if (casError) throw new Error(`generator advance failed: ${casError.message}`);
    if (count) {
      if (isOneOff(interval)) summary.deactivated_one_offs += 1;
      else summary.advanced += 1;
    }
  }

  return summary;
}
