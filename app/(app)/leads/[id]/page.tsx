import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_STYLES,
  type LeadStage,
} from "@/lib/leads/schema";
import {
  listCustomersForLead,
  listStaffForLead,
} from "../_form-helpers";
import {
  updateLead,
  moveLeadStage,
  deleteLead,
  acknowledgeLead,
  regenerateLeadSummary,
} from "../actions";
import { LeadForm } from "../_form";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";

/**
 * Lead detail.
 *
 * Sections:
 *   1. Header + stage badge + quick stage move
 *   2. Edit form (source / service / urgency / customer / assignee /
 *      postcode / estimated_value / notes / ai_summary)
 *   3. Linked entities: calls (calls.lead_id), quote (quotes.lead_id)
 *   4. Delete card
 *
 * Everything RLS-scoped via user-context client.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const ERROR_MAP: Record<string, string> = {
  move_failed: "Couldn't move stage.",
  delete_failed: "Couldn't delete.",
  delete_denied: "Only admins/owners can delete leads.",
  summary_failed: "AI summary failed — try again.",
  bad_kind: "Invalid action.",
  bad_id: "Invalid lead.",
  not_found: "That lead no longer exists.",
};

const SAVED_MAP: Record<string, string> = {
  acknowledged: "Acknowledged — follow-up reminders paused.",
  summary_regenerated: "AI summary regenerated.",
};

type SP = Promise<{ error?: string; saved?: string }>;

type FollowupStateRow = {
  reminder_72h_at: string | null;
  reminder_7d_at: string | null;
  acted_at: string | null;
  acted_kind: string | null;
};

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(
      `
        id, source, service, urgency, status, postcode, estimated_value,
        notes, ai_summary, customer_id, assigned_to,
        first_contact_at, last_activity_at, created_at,
        customer:customers ( id, name )
      `,
    )
    .eq("id", id)
    // ACTIVE-org pin — a lead in a non-active org must be indistinguishable
    // from a missing one (this page `notFound()`s on null), otherwise org B's
    // lead opens inside org A's shell where the actions live.
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  // A rejected read must not masquerade as a missing lead — throw so the error
  // boundary (and Sentry) see it; notFound() stays for a genuinely-null row.
  if (leadError) throw readFailure("lead detail: lead", leadError);
  if (!lead) notFound();

  // contact_name/email/phone landed in migration 20260601000000 and
  // aren't in the generated Supabase types yet. We fetch them with a
  // string selector and an `unknown`-cast to keep the rest of the page
  // strongly typed.
  const { data: contactRaw, error: contactError } = await supabase
    .from("leads")
    .select("contact_name, contact_email, contact_phone" as never)
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (contactError) throw readFailure("lead detail: contact", contactError);
  const leadContact = (contactRaw ?? {}) as unknown as {
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
  };

  const [customers, staff, callsRes, quoteRes, followupRes] = await Promise.all([
    listCustomersForLead(ctx.org.id),
    listStaffForLead(ctx.org.id),
    supabase
      .from("calls")
      .select(
        "id, direction, status, caller_number, started_at, duration_sec, ai_summary, transcript",
      )
      .eq("org_id", ctx.org.id)
      .eq("lead_id", id)
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("quotes")
      .select("id, number, status, total, sent_at, accepted_at")
      .eq("org_id", ctx.org.id)
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
    (
      supabase.from("lead_followup_state" as never) as unknown as {
        select: (cols: string) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: FollowupStateRow | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      }
    )
      .select("reminder_72h_at, reminder_7d_at, acted_at, acted_kind")
      .eq("lead_id", id)
      .maybeSingle(),
  ]);

  // These sections ARE the lead's record — a failed read rendering "no calls"
  // or hiding the follow-up state would silently misstate the lead.
  if (callsRes.error) throw readFailure("lead detail: calls", callsRes.error);
  if (quoteRes.error) throw readFailure("lead detail: quotes", quoteRes.error);
  if (followupRes.error) throw readFailure("lead detail: follow-up state", followupRes.error);

  const calls = callsRes.data ?? [];
  const quotes = quoteRes.data ?? [];
  const followup = followupRes.data ?? null;

  const status = (LEAD_STAGES as readonly string[]).includes(lead.status)
    ? (lead.status as LeadStage)
    : ("new" as LeadStage);

  // Lifecycle (stage move / delete) still redirect with ?error.
  // Edit form errors render inline via useActionState.
  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;

  const createdAt = lead.created_at ? new Date(lead.created_at) : null;
  const now = Date.now();
  const hoursSinceCreate = createdAt
    ? Math.floor((now - createdAt.getTime()) / (1000 * 60 * 60))
    : null;
  const past72h = hoursSinceCreate !== null && hoursSinceCreate >= 72;
  const past7d = hoursSinceCreate !== null && hoursSinceCreate >= 24 * 7;
  const isActed = !!followup?.acted_at;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/leads" className="hover:text-slate-900">
          Leads
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">
          {lead.customer?.name ?? "Lead"}
        </span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">
            {leadContact.contact_name ?? lead.customer?.name ?? "Unknown enquirer"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {lead.service ?? "—"} · {lead.source}
          </p>
          {leadContact.contact_email || leadContact.contact_phone ? (
            <p className="mt-0.5 text-sm text-slate-500">
              {leadContact.contact_email ? (
                <a
                  href={`mailto:${leadContact.contact_email}`}
                  className="hover:text-slate-900"
                >
                  {leadContact.contact_email}
                </a>
              ) : null}
              {leadContact.contact_email && leadContact.contact_phone ? " · " : ""}
              {leadContact.contact_phone ? (
                <a
                  href={`tel:${leadContact.contact_phone}`}
                  className="hover:text-slate-900"
                >
                  {leadContact.contact_phone}
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${LEAD_STAGE_STYLES[status]}`}
          >
            {LEAD_STAGE_LABELS[status]}
          </span>
          <form action={moveLeadStage.bind(null, id)} className="flex items-center gap-1">
            <label className="sr-only" htmlFor="quick-move">
              Move stage
            </label>
            <select
              id="quick-move"
              name="status"
              defaultValue={status}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              {LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white"
            >
              Move
            </button>
          </form>
        </div>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {/* Phase B — Follow-up state + acknowledge actions */}
      <section
        aria-labelledby="followup-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="followup-heading" className="text-sm font-semibold text-slate-900">
              Follow-up
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              {isActed ? (
                <>
                  Acknowledged
                  {followup?.acted_kind ? ` (${followup.acted_kind})` : ""} on{" "}
                  {followup?.acted_at?.slice(0, 10) ?? "—"}. Reminders are paused.
                </>
              ) : past7d ? (
                <span className="font-medium text-orange-700">
                  Over 7 days old — high priority. Reach out today.
                </span>
              ) : past72h ? (
                <span className="font-medium text-amber-700">
                  Past 72h — time to follow up.
                </span>
              ) : hoursSinceCreate !== null ? (
                <>
                  Logged {hoursSinceCreate}h ago. First reminder fires at 72h if
                  there&rsquo;s no activity.
                </>
              ) : (
                "—"
              )}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {followup?.reminder_72h_at
                ? `72h reminder sent ${followup.reminder_72h_at.slice(0, 10)}. `
                : ""}
              {followup?.reminder_7d_at
                ? `7d reminder sent ${followup.reminder_7d_at.slice(0, 10)}.`
                : ""}
            </p>
          </div>
        </div>
        {!isActed ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <form
              action={acknowledgeLead.bind(null, id)}
              className="inline-block"
            >
              <input type="hidden" name="kind" value="call" />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
              >
                Mark called
              </button>
            </form>
            <form
              action={acknowledgeLead.bind(null, id)}
              className="inline-block"
            >
              <input type="hidden" name="kind" value="message" />
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Mark messaged
              </button>
            </form>
            <form
              action={acknowledgeLead.bind(null, id)}
              className="inline-block"
            >
              <input type="hidden" name="kind" value="archive" />
              <button
                type="submit"
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                Archive
              </button>
            </form>
          </div>
        ) : null}
      </section>

      {/* Phase C — AI summary panel */}
      <section
        aria-labelledby="ai-summary-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="ai-summary-heading" className="text-sm font-semibold text-slate-900">
            AI summary
          </h2>
          <form action={regenerateLeadSummary.bind(null, id)}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {lead.ai_summary ? "Regenerate" : "Generate"}
            </button>
          </form>
        </div>
        {lead.ai_summary ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
            {lead.ai_summary}
          </p>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            No summary yet. Click Generate to summarise location, urgency, job
            type, photos and a suggested next step. The AI will never invent a
            price or schedule a job.
          </p>
        )}
      </section>

      {/* Linked quote */}
      {quotes.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Linked quote</h2>
          <ul className="mt-2 divide-y divide-slate-100">
            {quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between py-2 text-sm">
                <Link
                  href={`/quotes/${q.id}`}
                  className="font-medium text-slate-900 hover:text-slate-700"
                >
                  {q.number}
                </Link>
                <span className="text-xs text-slate-500">
                  {q.status} · {GBP.format(Number(q.total ?? 0))}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Link
              href={`/quotes/new?lead_id=${id}&customer_id=${lead.customer_id ?? ""}`}
              className="text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              + Add another quote
            </Link>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
          No quote yet for this lead.
          <Link
            href={`/quotes/new?lead_id=${id}&customer_id=${lead.customer_id ?? ""}`}
            className="ml-1 font-medium text-slate-900 underline"
          >
            Create a quote →
          </Link>
        </section>
      )}

      {/* Linked calls / AI transcripts */}
      {calls.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Calls</h2>
          <ul className="mt-2 space-y-3">
            {calls.map((c) => (
              <li key={c.id} className="text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-slate-700">
                    {c.direction} call · {c.status}
                    {c.duration_sec ? ` · ${Math.round(c.duration_sec / 60)} min` : ""}
                  </div>
                  <span className="text-xs text-slate-500">
                    {c.started_at?.slice(0, 16).replace("T", " ") ?? "—"}
                  </span>
                </div>
                {c.caller_number ? (
                  <p className="text-xs text-slate-500">{c.caller_number}</p>
                ) : null}
                {c.ai_summary ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
                    {c.ai_summary}
                  </p>
                ) : c.transcript ? (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-slate-500">
                      Show transcript
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-slate-600">
                      {c.transcript}
                    </p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Edit form */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Edit lead</h2>
        <LeadForm
          action={updateLead.bind(null, id)}
          submitLabel="Save changes"
          cancelHref="/leads"
          customers={customers}
          staff={staff}
          defaults={{
            contact_name: leadContact.contact_name ?? "",
            contact_email: leadContact.contact_email ?? "",
            contact_phone: leadContact.contact_phone ?? "",
            source: lead.source,
            service: lead.service ?? "",
            urgency: lead.urgency ?? "normal",
            postcode: lead.postcode ?? "",
            customer_id: lead.customer_id ?? "",
            assigned_to: lead.assigned_to ?? "",
            estimated_value: lead.estimated_value?.toString() ?? "",
            notes: lead.notes ?? "",
            ai_summary: lead.ai_summary ?? "",
          }}
        />
      </section>

      <AttachmentsPanel targetTable="leads" targetId={id} />

      <form
        action={deleteLead.bind(null, id)}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this lead</p>
        <p className="mt-1 text-xs text-red-700">
          Linked calls/quotes lose their lead reference but otherwise stay put.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Delete lead
        </button>
      </form>
    </div>
  );
}
