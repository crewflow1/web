import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { withPreservedOption } from "@/lib/quotes/preserve-option";
import { createReviewRequestAction } from "../actions";

const ERROR_MAP: Record<string, string> = {
  validation: "Some fields look off — pick a customer and platform.",
  insert_failed: "Couldn't schedule the review. Try again.",
  "Delay must be 0, 3, or 7 days": "Pick 0, 3, or 7 days.",
};

type SP = Promise<{ customer_id?: string; job_id?: string; error?: string }>;

type CustomerOption = { id: string; name: string | null; email: string | null };
type JobOption = {
  id: string;
  customer_id: string | null;
  status: string | null;
  notes: string | null;
};

export default async function NewReviewRequestPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const [customersRes, jobsRes] = await Promise.all([
    // ACTIVE-org pins — both pickers wrote their selection onto a review
    // request in THIS org, so a blended option produced a cross-org row.
    //
    // COMPLETE read (F-1) for the CUSTOMER picker: the old `.limit(500)` on an
    // alphabetical list dropped late-alphabet customers past the cap, so a
    // review could never be requested from them. Page the whole org-scoped set.
    fetchAllRows<CustomerOption>(
      (from, to) =>
        supabase
          .from("customers")
          .select("id, name, email" as never)
          .eq("org_id", ctx.org.id)
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<CustomerOption>>,
    ),
    // COMPLETE read (F-1 picker-completion class) for the JOB picker. The old
    // 200-row cap on `updated_at desc` silently dropped every completed
    // job older than the 200 most-recently-touched, so with >200 done jobs you
    // could not attribute a review to an older one — the same picker-completion
    // shape the customer picker beside it already fixed. Page the whole org-scoped
    // completed set on a stable, unique order (updated_at desc + id desc). The
    // `?job_id=` preset is preserve-injected below so an out-of-list id is always
    // a selectable <option> and an untouched submit never silently drops it.
    fetchAllRows<JobOption>(
      (from, to) =>
        supabase
          .from("jobs")
          .select("id, customer_id, status, notes" as never)
          .eq("org_id", ctx.org.id)
          .eq("status", "done")
          .order("updated_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<PageResult<JobOption>>,
    ),
  ]);

  const customers = (customersRes.data ?? []) as unknown as CustomerOption[];
  const jobs = (jobsRes.data ?? []) as unknown as JobOption[];
  // Preserve the `?job_id=` preset as a selectable option even if a future
  // cap/filter would drop it (belt-and-braces atop the complete read). The job
  // picker is OPTIONAL, so it can't lean on the `required` exemption the customer
  // picker uses — the preserved option is what keeps an out-of-list preset from
  // silently resolving to "— No specific job —".
  const jobOptions = withPreservedOption(jobs, sp.job_id || null, (id) => ({
    id,
    customer_id: null,
    status: null,
    notes: "Selected job",
  }));
  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/reviews" className="hover:text-slate-900">
          Reviews
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Request a review</h1>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createReviewRequestAction}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label
            htmlFor="customer_id"
            className="block text-sm font-medium text-slate-800"
          >
            Customer<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="customer_id"
            name="customer_id"
            required
            defaultValue={sp.customer_id ?? ""}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">— Choose a customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? "Customer"}
                {c.email ? ` · ${c.email}` : " · no email"}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Customers without an email can still be tracked, but you won&rsquo;t be
            able to use &ldquo;Send email now&rdquo;.
          </p>
        </div>

        <div>
          <label
            htmlFor="job_id"
            className="block text-sm font-medium text-slate-800"
          >
            Completed job (optional)
          </label>
          <select
            id="job_id"
            name="job_id"
            defaultValue={sp.job_id ?? ""}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">— No specific job —</option>
            {jobOptions.map((j) => (
              <option key={j.id} value={j.id}>
                {(j.notes ?? "Job").slice(0, 60)} · {j.status}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="platform"
              className="block text-sm font-medium text-slate-800"
            >
              Platform<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="platform"
              name="platform"
              required
              defaultValue="google"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="google">Google</option>
              <option value="facebook">Facebook</option>
              <option value="trustpilot">Trustpilot</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="delay_days"
              className="block text-sm font-medium text-slate-800"
            >
              When to send<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="delay_days"
              name="delay_days"
              required
              defaultValue="0"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="0">Immediately</option>
              <option value="3">3 days from now</option>
              <option value="7">7 days from now</option>
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="notes"
            className="block text-sm font-medium text-slate-800"
          >
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            placeholder="Optional — internal note about why you&rsquo;re requesting"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Schedule review request
          </button>
          <Link
            href="/reviews"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
