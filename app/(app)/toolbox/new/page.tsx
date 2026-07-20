import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createToolboxTalk } from "../actions";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the talk. Try again.",
  validation: "Please check the form and try again.",
};

type JobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

type SP = Promise<{ error?: string; job?: string }>;

export default async function NewToolboxTalkPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: jobsRaw } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .order("created_at", { ascending: false })
    .limit(200);
  const jobs = (jobsRaw ?? []) as unknown as JobOption[];

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/toolbox" className="hover:text-slate-900">
          Toolbox talks
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Record a toolbox talk</h1>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createToolboxTalk}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label htmlFor="topic" className="block text-sm font-medium text-slate-800">
            Topic<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="topic"
            name="topic"
            type="text"
            required
            autoFocus
            placeholder="Working at height"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="talk_date" className="block text-sm font-medium text-slate-800">
              Date<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="talk_date"
              name="talk_date"
              type="date"
              required
              defaultValue={today}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label htmlFor="job_id" className="block text-sm font-medium text-slate-800">
              Job / site
            </label>
            <select
              id="job_id"
              name="job_id"
              defaultValue={sp.job ?? ""}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="">No job (general)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {(j.customer?.name ?? "Job") +
                    (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
                    (j.status ? ` · ${j.status}` : "")}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="presenter" className="block text-sm font-medium text-slate-800">
              Delivered by
            </label>
            <input
              id="presenter"
              name="presenter"
              type="text"
              placeholder="Site supervisor's name"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label htmlFor="attendee_count" className="block text-sm font-medium text-slate-800">
              Number who attended
            </label>
            <input
              id="attendee_count"
              name="attendee_count"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="6"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor="attendees" className="block text-sm font-medium text-slate-800">
            Who attended
          </label>
          <textarea
            id="attendees"
            name="attendees"
            rows={2}
            placeholder="Names or trades — J. Smith, K. Patel, the groundworks crew…"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            placeholder="Key points covered, any actions raised…"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            You can attach the signed attendance sheet as a photo once saved.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Save talk
          </button>
          <Link
            href="/toolbox"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
