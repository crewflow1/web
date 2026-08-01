import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalFutureWorkRequests } from "../../_future-work";
import { submitFutureWorkRequest } from "../../_future-work-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  FUTURE_WORK_TIMINGS,
  FUTURE_WORK_TIMING_LABELS,
  PORTAL_REQUEST_STAGE_LABELS,
} from "@/lib/leads/portal";

export const metadata = { title: "Requests · CrewFlow" };

/**
 * Customer portal — future-work requests.
 *
 * The form creates a lead (source 'portal') in the org's existing pipeline;
 * the list below is the customer's read-back, scoped org_id + customer_id +
 * source and projected to a coarse stage word (see _future-work.ts — staff
 * notes, values and raw pipeline status never round-trip to this page).
 */

type SP = Promise<{ saved?: string; error?: string }>;

const STAGE_STYLES: Record<string, string> = {
  received: "bg-blue-100 text-blue-700",
  in_review: "bg-indigo-100 text-indigo-700",
  quoted: "bg-amber-100 text-amber-800",
  booked: "bg-green-100 text-green-700",
  closed: "bg-slate-100 text-slate-600",
};

export default async function PortalRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const requests = await listPortalFutureWorkRequests(
    customer.id,
    customer.org_id,
  );

  const banner = (() => {
    if (sp.saved === "submitted")
      return {
        tone: "ok" as const,
        msg: `Request sent. ${org.name} will be in touch about it.`,
      };
    if (sp.error) return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="requests">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Request future work</h2>
        <p className="text-sm text-slate-600">
          Planning more work? Tell {org.name} what you have in mind and when.
        </p>
      </header>

      {banner ? (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${banner.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
        >
          {banner.msg}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">New request</h3>
        <form action={submitFutureWorkRequest} className="mt-3 space-y-3">
          <input type="hidden" name="token" value={token} />
          <label className="block text-sm">
            <span className="font-medium text-slate-700">What is it?</span>
            <input
              name="title"
              type="text"
              required
              minLength={3}
              maxLength={200}
              placeholder="e.g. Rewire the garage"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Tell us more</span>
            <textarea
              name="details"
              required
              minLength={10}
              maxLength={5000}
              rows={4}
              placeholder="Rough scope, rooms involved, anything already decided…"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">
              When would you like it done?
            </span>
            <select
              name="timing"
              required
              defaultValue="flexible"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              {FUTURE_WORK_TIMINGS.map((t) => (
                <option key={t} value={t}>
                  {FUTURE_WORK_TIMING_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Send request
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Your requests</h3>
        {requests.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            Nothing requested yet. Your submitted requests will be listed here.
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {r.title}
                  </p>
                  <p className="text-xs text-slate-500">
                    Submitted {r.submitted_on}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STAGE_STYLES[r.stage] ?? "bg-slate-100 text-slate-600"}`}
                >
                  {PORTAL_REQUEST_STAGE_LABELS[r.stage]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
