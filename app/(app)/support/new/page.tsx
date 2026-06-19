import Link from "next/link";
import {
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABEL,
} from "@/lib/hq/support";
import { createSupportTicket } from "../actions";
import { FadeIn } from "@/components/ui";

type SP = Promise<{ error?: string }>;

export const dynamic = "force-dynamic";

export default async function NewSupportTicketPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Workspace · Support
        </p>
        <h1 className="text-2xl font-bold text-slate-900">Raise a ticket</h1>
        <p className="mt-1 text-sm text-slate-600">
          The CrewFlow team gets the ticket the moment you submit. We aim to
          respond within one working day; urgent items get attention sooner.
        </p>
      </header>

      {sp.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {decodeURIComponent(sp.error)}
        </div>
      ) : null}

      <FadeIn>
        <form
          action={createSupportTicket}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <label className="block text-sm font-medium text-slate-700">
            Subject
            <input
              name="subject"
              type="text"
              required
              minLength={3}
              maxLength={200}
              placeholder="e.g. Invoice didn't send to my customer"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Category
              <select
                name="category"
                defaultValue="other"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm"
              >
                {SUPPORT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SUPPORT_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm font-medium text-slate-700">
              Priority
              <select
                name="priority"
                defaultValue="normal"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm"
              >
                {SUPPORT_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {SUPPORT_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-sm font-medium text-slate-700">
            What&apos;s going on?
            <textarea
              name="body"
              required
              minLength={1}
              maxLength={10_000}
              rows={6}
              placeholder="The more detail the better — error messages, screenshots in the next reply, what you were trying to do…"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Submit ticket
            </button>
            <Link
              href="/support"
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      </FadeIn>
    </div>
  );
}
