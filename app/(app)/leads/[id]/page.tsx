import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { Field, TextareaField, SelectField } from "../../_components/field";
import {
  LEAD_SOURCES,
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_STYLES,
  LEAD_URGENCIES,
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
} from "../actions";

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
  update_failed: "Couldn't save changes. Try again.",
  move_failed: "Couldn't move stage.",
  delete_failed: "Couldn't delete.",
};

const SAVED_MAP: Record<string, string> = {
  "1": "Saved.",
};

type SP = Promise<{ error?: string; saved?: string }>;

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireOrgContext();
  const supabase = await createClient();

  const { data: lead } = await supabase
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
    .maybeSingle();
  if (!lead) notFound();

  const [customers, staff, callsRes, quoteRes] = await Promise.all([
    listCustomersForLead(),
    listStaffForLead(),
    supabase
      .from("calls")
      .select(
        "id, direction, status, caller_number, started_at, duration_sec, ai_summary, transcript",
      )
      .eq("lead_id", id)
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("quotes")
      .select("id, number, status, total, sent_at, accepted_at")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const calls = callsRes.data ?? [];
  const quotes = quoteRes.data ?? [];

  const status = (LEAD_STAGES as readonly string[]).includes(lead.status)
    ? (lead.status as LeadStage)
    : ("new" as LeadStage);

  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved
    ? SAVED_MAP[sp.saved] ?? "Saved."
    : null;

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
            {lead.customer?.name ?? "Unknown enquirer"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {lead.service ?? "—"} · {lead.source}
          </p>
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
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {savedMessage}
        </div>
      ) : null}

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
      <form
        action={updateLead.bind(null, id)}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-900">Edit lead</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            name="source"
            label="Source"
            defaultValue={lead.source}
            options={LEAD_SOURCES.map((s) => ({ value: s, label: s }))}
          />
          <SelectField
            name="urgency"
            label="Urgency"
            defaultValue={lead.urgency ?? "normal"}
            options={LEAD_URGENCIES.map((u) => ({ value: u, label: u }))}
          />
        </div>

        <Field name="service" label="Service" optional defaultValue={lead.service ?? ""} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            name="customer_id"
            label="Customer"
            defaultValue={lead.customer_id ?? ""}
            options={[
              { value: "", label: "— None —" },
              ...customers.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            name="assigned_to"
            label="Assigned to"
            defaultValue={lead.assigned_to ?? ""}
            options={[
              { value: "", label: "— Unassigned —" },
              ...staff.map((s) => ({
                value: s.id,
                label: s.full_name ?? s.email,
              })),
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            name="postcode"
            label="Postcode"
            optional
            defaultValue={lead.postcode ?? ""}
          />
          <Field
            name="estimated_value"
            label="Estimated value (£)"
            type="number"
            inputMode="decimal"
            optional
            defaultValue={lead.estimated_value?.toString() ?? ""}
          />
        </div>

        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={3}
          defaultValue={lead.notes ?? ""}
        />

        <TextareaField
          name="ai_summary"
          label="AI / call summary"
          optional
          rows={3}
          defaultValue={lead.ai_summary ?? ""}
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save changes
          </button>
          <Link
            href="/leads"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>

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
