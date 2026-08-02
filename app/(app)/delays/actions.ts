"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createDelayEventDraftRecord } from "@/server/services/delay-event-writes";
import {
  closeDelayEventSchema,
  createDelayEventSchema,
  delayEventIdSchema,
  orNull,
  updateDelayEventSchema,
} from "@/lib/eot/schema";

/**
 * Delays & EOT — server actions.
 *
 * Every write runs on the tenant (user-JWT) client so RLS scopes it to the
 * org; the service-role client is never used here. The DATABASE is the
 * authority for the hard invariants — the transition graph, immutability
 * after recording, write-once completion, cross-org link impossibility (the
 * composite FKs) and same-job link integrity (the guard trigger) — so these
 * actions validate shape and surface DB refusals honestly. A count-0 update
 * means "not found / not permitted", never a false success.
 *
 * NOTHING here writes to `finances`, and there is no AI on any path: a delay
 * event is a human's account of what stopped the work, and it stays one.
 *
 * Route-swap depth is 2 (/delays/[id]), well inside the Next 15.5 deep-swap
 * commit race (depth >= 4), so the plain redirect() idiom the quality actions
 * use is correct here — the FormState + window.location.assign workaround is
 * not needed and would be cargo-culting. No useActionState anywhere.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type FromChain = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; extracting it unbound makes
// `this` undefined and supabase-js throws on the first call.
const tbl = (c: unknown) => (c as FromChain).from.bind(c);
/* eslint-enable @typescript-eslint/no-explicit-any */

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

/** FormData → the create/update schema's input shape. */
function readForm(formData: FormData) {
  return {
    jobId: formData.get("jobId"),
    category: formData.get("category"),
    startedOn: formData.get("startedOn"),
    endedOn: formData.get("endedOn") ?? "",
    workingDaysLost: (formData.get("workingDaysLost") as string) ?? "",
    description: formData.get("description"),
    diaryEntryId: formData.get("diaryEntryId") ?? "",
    variationQuoteId: formData.get("variationQuoteId") ?? "",
    weatherDistrict: formData.get("weatherDistrict") ?? "",
  };
}

export async function createDelayEvent(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createDelayEventSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    redirect(`/delays/new?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }

  // ONE write path — the online form and the offline queue replay both land in
  // createDelayEventDraftRecord (server/services/delay-event-writes.ts). This
  // action no longer owns an insert, so validation, org pinning, the job guard
  // and the draft-only rule cannot drift between the two entry points.
  const outcome = await createDelayEventDraftRecord({
    ctx,
    user,
    input: parsed.data,
  });
  if (outcome.status !== "accepted" && outcome.status !== "duplicate") {
    const msg =
      outcome.status === "rejected" && outcome.reason === "job_missing"
        ? "That job isn't in this workspace — switch workspace and try again."
        : "Couldn't save that delay event. Refresh and try again.";
    redirect(`/delays/new?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/delays");
  redirect(`/delays/${outcome.id}?saved=created`);
}

export async function updateDelayEvent(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = updateDelayEventSchema.safeParse({
    id: formData.get("id"),
    ...readForm(formData),
  });
  if (!parsed.success) {
    redirect(`/delays?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("delay_events")
    .update(
      {
        job_id: v.jobId,
        category: v.category,
        started_on: v.startedOn,
        ended_on: orNull(v.endedOn),
        working_days_lost:
          v.workingDaysLost === "" || v.workingDaysLost === undefined ? null : v.workingDaysLost,
        description: v.description,
        diary_entry_id: orNull(v.diaryEntryId),
        variation_quote_id: orNull(v.variationQuoteId),
        weather_district: orNull(v.weatherDistrict),
      },
      { count: "exact" },
    )
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft"); // belt-and-braces; the transition trigger is the real gate
  if (error) redirect(`/delays/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/delays/${v.id}?error=not_editable`);
  revalidatePath(`/delays/${v.id}`);
  revalidatePath("/delays");
  redirect(`/delays/${v.id}?saved=updated`);
}

/**
 * draft → recorded. The DB pins recorded_at/recorded_by to the caller
 * (tg_delay_event_transition) — nothing is supplied here to forge.
 */
export async function recordDelayEvent(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = delayEventIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/delays?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("delay_events")
    .update({ status: "recorded" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) redirect(`/delays/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/delays/${id}?error=not_found`);
  revalidatePath("/delays");
  revalidatePath(`/delays/${id}`);
  redirect(`/delays/${id}?saved=recorded`);
}

/** recorded → withdrawn. Standing changes; the record it retracts does not. */
export async function withdrawDelayEvent(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = delayEventIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/delays?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("delay_events")
    .update({ status: "withdrawn" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "recorded");
  if (error) redirect(`/delays/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/delays/${id}?error=not_found`);
  revalidatePath("/delays");
  revalidatePath(`/delays/${id}`);
  redirect(`/delays/${id}?saved=withdrawn`);
}

/**
 * Write-once COMPLETION of a recorded event: set ended_on and/or
 * working_days_lost where they are still NULL. The trigger refuses anything
 * that is already set (NULL→value only — the 20261073 §4 idiom), so this can
 * complete a record but never rewrite one.
 */
export async function closeDelayEvent(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = closeDelayEventSchema.safeParse({
    id: formData.get("id"),
    endedOn: formData.get("endedOn") ?? "",
    workingDaysLost: (formData.get("workingDaysLost") as string) ?? "",
  });
  if (!parsed.success) {
    redirect(`/delays?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const patch: Record<string, unknown> = {};
  if (orNull(v.endedOn ?? "") !== null) patch.ended_on = v.endedOn;
  if (v.workingDaysLost !== "" && v.workingDaysLost !== undefined) {
    patch.working_days_lost = v.workingDaysLost;
  }
  if (Object.keys(patch).length === 0) {
    redirect(`/delays/${v.id}?error=nothing_to_complete`);
  }
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("delay_events")
    .update(patch, { count: "exact" })
    .eq("id", v.id)
    .eq("org_id", ctx.org.id)
    .eq("status", "recorded");
  if (error) redirect(`/delays/${v.id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/delays/${v.id}?error=not_found`);
  revalidatePath(`/delays/${v.id}`);
  revalidatePath("/delays");
  redirect(`/delays/${v.id}?saved=completed`);
}
