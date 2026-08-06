import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import type { Database } from "@/lib/supabase/types";
import { verifyAssigneeInOrg } from "@/lib/crm/reference-integrity";
import {
  bestEffortPushJob,
  bestEffortDeleteJobEvent,
} from "@/server/services/calendar-connections";

type JobUpdate = Database["public"]["Tables"]["jobs"]["Update"];

/**
 * PUT /api/schedule/[id]
 *
 * Update a job's scheduled date and/or assignee from the calendar UI.
 * Other fields are out of scope for this endpoint — full edits go
 * through /jobs/[id].
 *
 *   Body: { scheduled_date?: "YYYY-MM-DD" | null, assigned_to?: uuid | null }
 *
 * RLS:
 *   - Existing "jobs: admins can update" policy means non-admin moves
 *     hit count=0 and return 403. Field staff trying to drag-drop will
 *     see a clear permission error.
 *   - Once the broader role model is loosened (or per-field via RPC like
 *     job photos), this endpoint inherits the change for free.
 */

const bodySchema = z
  .object({
    scheduled_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
      .or(z.null())
      .optional(),
    assigned_to: z.string().uuid().or(z.null()).optional(),
  })
  .refine(
    (v) => v.scheduled_date !== undefined || v.assigned_to !== undefined,
    { message: "At least one of scheduled_date or assigned_to is required" },
  );

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  // Reject virtual recurring-occurrence ids — those carry ":<date>" and
  // aren't editable directly. The UI handles them by editing the parent.
  if (id.includes(":")) {
    return NextResponse.json(
      { error: "Recurring occurrences aren't editable. Edit the parent job at /jobs/[id]." },
      { status: 422 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const patch: JobUpdate = {};
  if (parsed.data.scheduled_date !== undefined) {
    patch.scheduled_date = parsed.data.scheduled_date;
  }
  if (parsed.data.assigned_to !== undefined) {
    patch.assigned_to = parsed.data.assigned_to;
  }

  const supabase = await createClient();

  // Cross-tenant reference integrity (defence in depth over the membership
  // trigger from 20261112000000): a reassignment must not attach a user who is
  // not a member of the caller's active org. Rejected with a clean 400 rather
  // than surfacing a raw trigger exception as a 500. (This endpoint never sets
  // customer_id, so only assigned_to is checked.)
  if (parsed.data.assigned_to) {
    const check = await verifyAssigneeInOrg(supabase, parsed.data.assigned_to, ctx.org.id);
    if (!check.ok) {
      return NextResponse.json({ error: check.message }, { status: 400 });
    }
  }

  const { error, count } = await supabase
    .from("jobs")
    .update(patch, { count: "exact" })
    .eq("id", id)
    // Active-org scope: `is_org_admin(org_id)` passes for EVERY org the caller
    // administers, so without this a reschedule issued while working in org A
    // could move an org B job. See lib/jobs/load.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[schedule] update failed", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json(
      { error: "Only admins/owners can reschedule or reassign jobs" },
      { status: 403 },
    );
  }

  // Keep the external calendar event in sync, mirroring updateJob. A grid-drag
  // reschedule that changes scheduled_date must move (or, when cleared, delete)
  // the event so it does not strand on the old day once calendar OAuth activates.
  // Both composers are DARK no-ops today (gated on calendarConnectFeatureEnabled)
  // — no DB read, no network — so this is safe to ship immediately. An
  // assigned_to-only patch touches no date and needs no calendar call.
  if (parsed.data.scheduled_date !== undefined) {
    if (parsed.data.scheduled_date === null) {
      await bestEffortDeleteJobEvent(ctx.org.id, id);
    } else {
      await bestEffortPushJob(ctx.org.id, id);
    }
  }

  return NextResponse.json({ ok: true });
}
