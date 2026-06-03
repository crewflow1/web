import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_STYLES,
  LEAD_SOURCES,
  LEAD_URGENCIES,
  type LeadStage,
} from "@/lib/leads/schema";
import { LeadCard, type PipelineLead } from "./_card";
import { ilikeOrFilter, LEAD_SEARCH_COLUMNS } from "@/lib/search/filters";

/**
 * /leads — kanban pipeline.
 *
 * Layout:
 *   - Horizontally scrolling column per stage.
 *   - Each column: stage label + count + value + cards.
 *   - Cards are tap-friendly; status-change happens via a dropdown
 *     inline on each card (no drag-drop yet — see report).
 *
 * Search + filter via search params: ?q=text, ?source=phone,
 *   ?urgency=high, ?assigned=<uuid>.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
});

type SP = Promise<{
  q?: string;
  source?: string;
  urgency?: string;
  assigned?: string;
}>;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("leads")
    .select(
      `
        id, status, source, urgency, postcode, service, estimated_value,
        last_activity_at, customer_id, assigned_to,
        customer:customers ( id, name ),
        assigned:users!leads_assigned_to_fkey ( id, full_name, email )
      `,
    )
    .order("last_activity_at", { ascending: false })
    .limit(500);

  if (sp.source && (LEAD_SOURCES as readonly string[]).includes(sp.source)) {
    query = query.eq("source", sp.source);
  }
  if (sp.urgency && (LEAD_URGENCIES as readonly string[]).includes(sp.urgency)) {
    query = query.eq("urgency", sp.urgency);
  }
  if (sp.assigned) {
    query = query.eq("assigned_to", sp.assigned);
  }
  // q is sanitised then searched across the lead's own columns — service,
  // source, postcode + the enquirer's contact name/email (LEAD_SEARCH_COLUMNS).
  // Address-first: a postcode or area matches here; discovery of a lead via a
  // linked customer's full structured address is handled by the global Cmd/K
  // search. ilikeOrFilter strips PostgREST structural/wildcard chars, so the
  // term can no longer inject OR-branches or break the filter grammar — the
  // previous implementation interpolated the raw term straight into .or().
  const q = sp.q?.trim();
  const leadOr = ilikeOrFilter(q, LEAD_SEARCH_COLUMNS);
  if (leadOr) {
    query = query.or(leadOr);
  }

  const { data: raw } = await query;
  const leads = raw ?? [];

  // Bucket by stage. Anything unknown defaults to "new" for display.
  const byStage: Record<LeadStage, PipelineLead[]> = {
    new: [],
    contacted: [],
    qualified: [],
    quoted: [],
    won: [],
    lost: [],
    job_booked: [],
  };
  let totalValue = 0;
  for (const l of leads) {
    const status = (LEAD_STAGES as readonly string[]).includes(l.status)
      ? (l.status as LeadStage)
      : "new";
    const ev = Number(l.estimated_value ?? 0);
    totalValue += ev;
    byStage[status].push({
      id: l.id,
      service: l.service ?? null,
      source: l.source,
      urgency: l.urgency ?? null,
      postcode: l.postcode ?? null,
      estimated_value: l.estimated_value ? Number(l.estimated_value) : null,
      status,
      last_activity_at: l.last_activity_at,
      customer_name: l.customer?.name ?? null,
      assigned_name: l.assigned?.full_name ?? l.assigned?.email ?? null,
    });
  }

  // Build assigned-staff filter options inline from the visible data.
  const assignedOptions = new Map<string, string>();
  for (const l of leads) {
    if (l.assigned?.id) {
      assignedOptions.set(
        l.assigned.id,
        l.assigned.full_name ?? l.assigned.email ?? l.assigned.id.slice(0, 8),
      );
    }
  }

  if (leads.length === 0 && !q && !sp.source && !sp.urgency && !sp.assigned) {
    return (
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Leads</h1>
            <p className="mt-1 text-sm text-slate-600">Pipeline overview.</p>
          </div>
          <Link
            href="/leads/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            + New lead
          </Link>
        </header>
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🎯"
            title="No leads yet"
            body="Capture every enquiry — phone, web, referral. Move them through the pipeline as you contact, qualify, quote, and win."
            primary={{ href: "/leads/new", label: "Add first lead" }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Leads</h1>
          <p className="mt-1 text-sm text-slate-600">
            {leads.length} {leads.length === 1 ? "lead" : "leads"} · forecast{" "}
            {GBP.format(totalValue)}
          </p>
        </div>
        <Link
          href="/leads/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          + New lead
        </Link>
      </header>

      {/* Filters */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="grow">
          <label className="block text-xs font-medium text-slate-700">Search</label>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Postcode, name, or service"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Source</label>
          <select
            name="source"
            defaultValue={sp.source ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Urgency</label>
          <select
            name="urgency"
            defaultValue={sp.urgency ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {LEAD_URGENCIES.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Assigned</label>
          <select
            name="assigned"
            defaultValue={sp.assigned ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {Array.from(assignedOptions.entries()).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/leads"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {/* Pipeline columns. Horizontally scrollable on every viewport. */}
      <div className="-mx-2 overflow-x-auto pb-2">
        <ol className="flex min-w-fit items-stretch gap-3 px-2">
          {LEAD_STAGES.map((stage) => {
            const cards = byStage[stage];
            const stageValue = cards.reduce(
              (s, c) => s + (c.estimated_value ?? 0),
              0,
            );
            return (
              <li
                key={stage}
                className="flex w-72 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/60"
              >
                <header className="border-b border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${LEAD_STAGE_STYLES[stage]}`}
                      >
                        {LEAD_STAGE_LABELS[stage]}
                      </span>
                      <span className="text-xs text-slate-500">{cards.length}</span>
                    </div>
                    <span className="text-xs font-medium text-slate-700">
                      {GBP.format(stageValue)}
                    </span>
                  </div>
                </header>
                <ul className="flex-1 space-y-2 p-2">
                  {cards.length === 0 ? (
                    <li className="rounded-md border border-dashed border-slate-200 bg-white py-6 text-center text-xs text-slate-400">
                      Nothing here yet
                    </li>
                  ) : (
                    cards.map((c) => <LeadCard key={c.id} lead={c} />)
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
