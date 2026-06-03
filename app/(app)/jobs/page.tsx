import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { resolveJobAddress, formatAddressOneLine } from "@/lib/address";
import {
  ilikeOrFilter,
  inIdsBranch,
  combineOr,
  CUSTOMER_SEARCH_COLUMNS,
  JOB_SEARCH_COLUMNS,
} from "@/lib/search/filters";
import { MapActions } from "@/components/maps/MapActions";

/**
 * Jobs list.
 *
 * Joins customer name + assigned user name in a single PostgREST select
 * via the FK relationships (jobs.customer_id -> customers.id, jobs.assigned_to
 * -> users.id). RLS scopes everything to the caller's org automatically.
 */

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  "in-progress": "In progress",
  completed: "Completed",
  blocked: "Blocked",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-700",
  "in-progress": "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  blocked: "bg-red-100 text-red-700",
};

type SP = Promise<{ customer?: string; q?: string }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JobsPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const customerFilter =
    sp.customer && UUID_RE.test(sp.customer) ? sp.customer : null;
  const term = (sp.q ?? "").trim();

  const supabase = await createClient();

  // Address-first job search. A job matches when its OWN site address matches
  // the term OR when its linked customer matches (customer name OR the
  // customer's structured address). Jobs with no site-address override inherit
  // the customer's address, so the customer match is essential — it is resolved
  // in a first pass (collect matching customer ids) and folded into the jobs
  // query as a `customer_id.in.(…)` OR-branch. All filtering stays in SQL,
  // applied BEFORE the row cap — never a capped fetch filtered in JS.
  const siteBranch = ilikeOrFilter(term, JOB_SEARCH_COLUMNS);
  let customerIdBranch: string | null = null;
  if (term) {
    const custOr = ilikeOrFilter(term, CUSTOMER_SEARCH_COLUMNS);
    if (custOr) {
      const { data: matchCustomers } = await supabase
        .from("customers")
        .select("id")
        .or(custOr)
        .limit(200);
      customerIdBranch = inIdsBranch(
        "customer_id",
        (matchCustomers ?? []).map((c) => c.id),
      );
    }
  }
  const searchOr = combineOr(siteBranch, customerIdBranch);

  let query = supabase
    .from("jobs")
    .select(
      `
        id,
        status,
        scheduled_date,
        notes,
        created_at,
        site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country,
        customer:customers ( id, name, phone, address_line1, address_line2, city, county, postcode, country ),
        assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
      `,
    )
    .order("scheduled_date", { ascending: true, nullsFirst: false })
    .limit(200);

  if (customerFilter) {
    query = query.eq("customer_id", customerFilter);
  }
  // Applied BEFORE .limit(200) ⇒ the whole table is searched, then capped.
  if (searchOr) {
    query = query.or(searchOr);
  }

  const { data: jobs, error } = await query;

  if (error) {
    console.error("[jobs] list failed", error);
  }
  const rows = jobs ?? [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayRows = rows.filter((j) => j.scheduled_date === todayIso);

  let filteredCustomerName: string | null = null;
  if (customerFilter) {
    const { data: c } = await supabase
      .from("customers")
      .select("name")
      .eq("id", customerFilter)
      .maybeSingle();
    filteredCustomerName = (c as { name?: string } | null)?.name ?? null;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Jobs</h1>
          <p className="mt-1 text-sm text-slate-600">
            {term
              ? `${rows.length} matching “${term}”`
              : `${rows.length} ${rows.length === 1 ? "job" : "jobs"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/jobs/calendar"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Calendar
          </Link>
          <Link
            href="/jobs/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            + New job
          </Link>
        </div>
      </header>

      {/* Address-first search runs server-side across ALL jobs (site address)
          + the linked customer (name + address), not just the rows on screen. */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        {customerFilter ? (
          <input type="hidden" name="customer" value={customerFilter} />
        ) : null}
        <div className="min-w-[12rem] flex-1">
          <label
            htmlFor="job-search"
            className="block text-xs font-medium text-slate-700"
          >
            Search
          </label>
          <input
            id="job-search"
            type="search"
            name="q"
            defaultValue={term}
            placeholder="Site address, postcode, town, or customer"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Search
        </button>
        {term ? (
          <Link
            href={
              customerFilter
                ? { pathname: "/jobs", query: { customer: customerFilter } }
                : "/jobs"
            }
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {customerFilter ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>
            Filtered to{" "}
            <strong>{filteredCustomerName ?? "customer"}</strong>{" "}
            ·{" "}
            <Link
              href={`/customers/${customerFilter}`}
              className="font-medium underline hover:text-indigo-800"
            >
              Back to customer
            </Link>
          </span>
          <Link
            href="/jobs"
            className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-50"
          >
            Clear customer filter
          </Link>
        </div>
      ) : null}

      {rows.length === 0 && term ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 shadow-sm">
          <p>No jobs match “{term}”.</p>
          <Link
            href={
              customerFilter
                ? { pathname: "/jobs", query: { customer: customerFilter } }
                : "/jobs"
            }
            className="mt-2 inline-block font-medium text-slate-700 underline hover:text-slate-900"
          >
            Clear search
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="🔧"
            title="No jobs yet"
            body="Schedule your first job. Pick a customer, set a date, assign a staff member. Field staff can attach photos as work progresses."
            primary={{ href: "/jobs/new", label: "Create first job" }}
            secondary={{ href: "/customers/new", label: "Add a customer first" }}
          />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm md:block">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3">Assigned</th>
                  <th className="px-4 py-3">Scheduled</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {rows.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[j.status] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {STATUS_LABELS[j.status] ?? j.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {j.customer?.name ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {formatAddressOneLine(resolveJobAddress(j, j.customer)) || (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {j.assigned?.full_name ?? j.assigned?.email ?? (
                        <span className="text-slate-400">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {j.scheduled_date ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/jobs/${j.id}`}
                        className="text-sm font-medium text-slate-700 hover:text-slate-900"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: Today's Jobs first, then everything else */}
          <div className="space-y-5 md:hidden">
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-900">
                Today&apos;s jobs{" "}
                <span className="font-normal text-slate-500">
                  ({todayRows.length})
                </span>
              </h2>
              {todayRows.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                  No jobs scheduled for today.
                </p>
              ) : (
                <ul className="space-y-2">
                  {todayRows.map((j) => (
                    <MobileJobCard key={j.id} job={j} />
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-900">
                All jobs
              </h2>
              <ul className="space-y-2">
                {rows.map((j) => (
                  <MobileJobCard key={j.id} job={j} />
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

type JobRow = {
  id: string;
  status: string;
  scheduled_date: string | null;
  notes: string | null;
  site_address_line1: string | null;
  site_address_line2: string | null;
  site_city: string | null;
  site_county: string | null;
  site_postcode: string | null;
  site_country: string | null;
  customer: {
    name: string | null;
    phone: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    county: string | null;
    postcode: string | null;
    country: string | null;
  } | null;
  assigned: { full_name: string | null; email: string } | null;
};

/**
 * Field-worker job card: customer, time, status, address, notes, tap-to-call
 * and navigation. Built for someone standing in a van.
 */
function MobileJobCard({ job }: { job: JobRow }) {
  const address = resolveJobAddress(job, job.customer);
  const phone = job.customer?.phone ?? null;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-900">
            {job.customer?.name ?? "—"}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500">
            {job.assigned?.full_name ?? job.assigned?.email ?? "Unassigned"}
            {job.scheduled_date ? ` · ${job.scheduled_date}` : ""}
          </div>
        </Link>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[job.status] ?? "bg-slate-100 text-slate-700"}`}
        >
          {STATUS_LABELS[job.status] ?? job.status}
        </span>
      </div>

      {address ? (
        <p className="mt-2 text-xs text-slate-600">
          {formatAddressOneLine(address)}
        </p>
      ) : null}

      {job.notes ? (
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{job.notes}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phone ? (
          <a
            href={`tel:${phone}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm active:bg-slate-50"
          >
            Call
          </a>
        ) : null}
        <MapActions address={address} />
      </div>
    </li>
  );
}
