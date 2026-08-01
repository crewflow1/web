import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { listMembers } from "../../_data";
import { getRaiseContext } from "../_data";
import { raiseNcr } from "../actions";
import { NCR_SEVERITIES, NCR_SEVERITY_META } from "@/lib/quality/ncr";
import { SIGNOFF_RESULT_META } from "@/lib/quality/itp";

/**
 * /quality/ncrs/new?itemId=… — raise an NCR against a plan item.
 *
 * Reached from the plan detail (an item's "Raise NCR" link, optionally
 * carrying the failed sign-off as the source). ACTIVE-org pinned via
 * getRaiseContext: an item in a non-active org is indistinguishable from a
 * missing one. The DB allocates NCR-NNNN, derives the org from the item and
 * pins the raiser to the session — this form only shapes the input.
 */

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

type SP = Promise<{ itemId?: string; signoffId?: string; error?: string }>;

export default async function RaiseNcrPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  if (!sp.itemId) notFound();

  const context = await getRaiseContext(ctx.org.id, sp.itemId);
  if (!context) notFound();
  const { item, plan, failedSignoffs } = context;
  const members = await listMembers(ctx.org.id);

  const preselectedSignoff =
    sp.signoffId && failedSignoffs.some((s) => s.id === sp.signoffId) ? sp.signoffId : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <Link href="/quality/ncrs" className="hover:text-slate-900">
          Non-conformance
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Raise</span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Raise a non-conformance report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Against{" "}
          <strong className="font-semibold">
            item {item.item_number} — {item.title}
          </strong>
          {plan ? (
            <>
              {" "}
              on{" "}
              <Link href={`/quality/${plan.id}`} className="text-slate-800 underline">
                {plan.reference ?? "the plan"} · {plan.work_package}
              </Link>
            </>
          ) : null}
          . The NCR gets its number when it is raised and tracks the corrective
          action through to a verified closure.
        </p>
      </header>

      {sp.error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {decodeURIComponent(sp.error)}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <form action={raiseNcr} className="space-y-4">
          <input type="hidden" name="itemId" value={item.id} />

          {failedSignoffs.length > 0 ? (
            <div>
              <label htmlFor="sourceSignoffId" className={labelClass}>
                Raised from a failed sign-off
              </label>
              <select
                id="sourceSignoffId"
                name="sourceSignoffId"
                defaultValue={preselectedSignoff}
                className={inputClass}
              >
                <option value="">Standalone — no specific sign-off</option>
                {failedSignoffs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {SIGNOFF_RESULT_META[s.result].label} · {s.signed_name} · {s.inspected_at}
                    {s.voided_at ? " (voided)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label htmlFor="title" className={labelClass}>
              Title<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              maxLength={200}
              placeholder="Falls on foul run F1–F3 outside tolerance"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="description" className={labelClass}>
              What does not conform<span className="ml-0.5 text-red-500">*</span>
            </label>
            <textarea
              id="description"
              name="description"
              required
              rows={4}
              maxLength={20000}
              placeholder="What was found, measured against which acceptance criteria / spec clause."
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="severity" className={labelClass}>
              Severity<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select id="severity" name="severity" required defaultValue="major" className={inputClass}>
              {NCR_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {NCR_SEVERITY_META[s].label} — {NCR_SEVERITY_META[s].help}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="space-y-3">
            <legend className={labelClass}>
              Responsible party<span className="ml-0.5 text-red-500">*</span>
            </legend>
            <p className="text-xs text-slate-500">
              Who answers for the fix — one of your team, a subcontractor by
              name, or both.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="responsibleUserId" className={labelClass}>
                  Member
                </label>
                <select
                  id="responsibleUserId"
                  name="responsibleUserId"
                  defaultValue=""
                  className={inputClass}
                >
                  <option value="">Not one of the team</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="responsibleSubcontractor" className={labelClass}>
                  Subcontractor
                </label>
                <input
                  id="responsibleSubcontractor"
                  name="responsibleSubcontractor"
                  type="text"
                  maxLength={200}
                  placeholder="J Smith Groundworks Ltd"
                  className={inputClass}
                />
              </div>
            </div>
          </fieldset>

          <div>
            <label htmlFor="dueDate" className={labelClass}>
              Corrective action due
            </label>
            <input id="dueDate" name="dueDate" type="date" className={inputClass} />
          </div>

          <button
            type="submit"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 sm:w-auto"
          >
            Raise NCR
          </button>
        </form>
      </section>
    </div>
  );
}
