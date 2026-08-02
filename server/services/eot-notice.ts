import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { composeEotNotice, type EotNotice } from "@/lib/eot/letter";
import type { DelayEventStatus } from "@/lib/eot/lifecycle";

/**
 * EOT NOTICE OF DELAY — the READ LAYER.
 *
 * FETCHES; does not decide. Every sentence, particular and placeholder lives in
 * lib/eot/letter.ts (pure, unit-tested without a database). Same three scoping
 * belts as server/services/eot-pack.ts and app/(app)/delays/_data.ts:
 *
 *   1. RLS — every read runs on the caller's tenant client (their JWT).
 *   2. `org_id` PINNED EXPLICITLY on every query. current_org_ids() spans EVERY
 *      org the viewer belongs to, so an RLS-only read blends a dual-org member's
 *      companies (the shipped-twice P0 class, #456/#468).
 *   3. `id`/`job_id` pinned on every row fetched by identity.
 *
 * LOUD READS. Every read THROWS via @/lib/supabase/read-failure on error; a
 * rejected query must never masquerade as an empty/absent record on an evidence
 * surface (the _data.ts contract, verbatim).
 *
 * RECORDED-ONLY. A formal notice is raised from a RECORDED event only — a draft
 * is a half-written account and a withdrawn event is retracted. The caller is
 * told which case it hit so it can 404 (missing / wrong org) vs 409 (present but
 * not recorded) distinctly.
 *
 * NO AI, NO MONEY, NO WEATHER, NO OUTBOUND. This service reads identity, dates
 * and links only; it never touches the dark weather cache, a money column, an
 * AI helper, or any transport.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFrom = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; extracting it unbound makes
// `this` undefined and supabase-js throws on the first call (the _data.ts idiom).
const tbl = (client: unknown) => (client as AnyFrom).from.bind(client);
/* eslint-enable @typescript-eslint/no-explicit-any */

type EventRow = {
  id: string;
  org_id: string;
  job_id: string;
  category: string;
  status: DelayEventStatus;
  started_on: string;
  ended_on: string | null;
  working_days_lost: number | null;
  description: string;
  diary_entry_id: string | null;
  variation_quote_id: string | null;
};

const EVENT_COLS =
  "id, org_id, job_id, category, status, started_on, ended_on, working_days_lost, " +
  "description, diary_entry_id, variation_quote_id";

export type EotNoticeResult =
  | { ok: true; notice: EotNotice; jobLabel: string }
  | { ok: false; reason: "not_found" | "not_recorded" };

/** Flatten an organizations.address jsonb into one postal line, or null. */
function flattenAddress(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  const parts = ["line1", "line2", "city", "region", "postcode", "country"]
    .map((k) => a[k])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Load one delay event's notice of delay, pinned to the ACTIVE org. Returns
 * `not_found` for a missing or foreign-org event (indistinguishable, by design)
 * and `not_recorded` for one that exists but is still a draft / withdrawn.
 *
 * `now` is injected for reproducibility; it stamps the notice date only.
 */
export async function loadEotNotice(
  orgId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<EotNoticeResult> {
  const supabase = await createClient();

  // 1) The event — id + org pinned. Missing/foreign ⇒ not_found.
  const { data: eventData, error: eventErr } = await tbl(supabase)("delay_events")
    .select(EVENT_COLS)
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (eventErr) throw readFailure("eot-notice: event", eventErr as SupabaseReadError);
  if (!eventData) return { ok: false, reason: "not_found" };
  const event = eventData as EventRow;
  if (event.status !== "recorded") return { ok: false, reason: "not_recorded" };

  // 2) Job + customer (employer) + org (contractor), all org-pinned.
  const [{ data: jobData, error: jobErr }, { data: orgData, error: orgErr }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, scheduled_date, customer:customers ( name )")
      .eq("id", event.job_id)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("id, name, address")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  if (jobErr) throw readFailure("eot-notice: job", jobErr as SupabaseReadError);
  if (orgErr) throw readFailure("eot-notice: org", orgErr as SupabaseReadError);

  const customer = (jobData as unknown as { customer: { name: string | null } | null } | null)
    ?.customer;
  const scheduledDate = (jobData as { scheduled_date: string | null } | null)?.scheduled_date ?? null;
  const jobLabel = [customer?.name ?? "Job", scheduledDate].filter(Boolean).join(" · ");
  const orgRow = orgData as { name: string | null; address: unknown } | null;

  // 3) Linked diary entry (by id + org), when linked.
  let diaryEntryDate: string | null = null;
  if (event.diary_entry_id) {
    const { data: diaryData, error: diaryErr } = await tbl(supabase)("site_diary_entries")
      .select("id, entry_date")
      .eq("id", event.diary_entry_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (diaryErr) throw readFailure("eot-notice: diary", diaryErr as SupabaseReadError);
    diaryEntryDate = (diaryData as { entry_date: string | null } | null)?.entry_date ?? null;
  }

  // 4) Linked variation (by id + org), when linked. Dates + identity only — no money.
  let variation: {
    number: number | null;
    title: string | null;
    requestedCompletionDate: string | null;
    agreedCompletionDate: string | null;
  } | null = null;
  if (event.variation_quote_id) {
    const { data: varData, error: varErr } = await tbl(supabase)("quotes")
      .select(
        "id, variation_number, title, eot_requested_completion_date, eot_agreed_completion_date",
      )
      .eq("id", event.variation_quote_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (varErr) throw readFailure("eot-notice: variation", varErr as SupabaseReadError);
    const v = varData as {
      variation_number: number | null;
      title: string | null;
      eot_requested_completion_date: string | null;
      eot_agreed_completion_date: string | null;
    } | null;
    if (v) {
      variation = {
        number: v.variation_number,
        title: v.title,
        requestedCompletionDate: v.eot_requested_completion_date,
        agreedCompletionDate: v.eot_agreed_completion_date,
      };
    }
  }

  const notice = composeEotNotice({
    contractor: { name: orgRow?.name ?? null, address: flattenAddress(orgRow?.address) },
    employer: { name: customer?.name ?? null, address: null },
    jobReference: jobLabel.length > 0 ? jobLabel : null,
    // Not columns anywhere today ⇒ null ⇒ [not specified]. Never fabricated.
    contractReference: null,
    contractClause: null,
    contractCompletionDate: null,
    diaryEntryDate,
    variation,
    event: {
      id: event.id,
      category: event.category,
      status: event.status,
      startedOn: event.started_on,
      endedOn: event.ended_on,
      workingDaysLost: event.working_days_lost,
      description: event.description,
    },
    noticeDate: now.toISOString(),
  });

  return { ok: true, notice, jobLabel };
}
