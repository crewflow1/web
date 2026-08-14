import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../../../jobs/_form-helpers";
import { updateSnag } from "../../actions";
import { SnagForm } from "../../_form";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * /snags/[id]/edit — edit a snag's owned free-text/scalar detail. The STATUS
 * lifecycle is NOT edited here (it has its own controls on the detail page, with
 * server-pinned resolved_at); this form touches title/description/location/trade/
 * priority/job/assignee/due date only.
 *
 * It is offline-writable (lib/offline/registry.ts — snag.update): an edit authored
 * with no signal is queued with the row version it was rendered with and 3-way
 * merged on sync, so a concurrent office change survives (or is surfaced as a
 * conflict), never silently reverted.
 */

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save your changes. Try again.",
  validation: "Please check the form and try again.",
  job_missing:
    "That job no longer exists in this company. Pick a current job and save again.",
  assignee_missing:
    "That person is no longer a member of this company. Pick someone else and save again.",
};

type JobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

type SnagRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  trade: string | null;
  priority: string;
  job_id: string | null;
  assigned_to: string | null;
  due_date: string | null;
  updated_at: string;
};

export default async function EditSnagPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  // Pinned to the ACTIVE org — a by-id read alone admits every org the viewer
  // belongs to, so an unpinned read would load another org's snag into this form.
  const [{ data: snag }, { data: jobsRaw, error: jobsError }, staff] =
    await Promise.all([
      (
        supabase.from("snags" as never) as unknown as {
          select: (cols: string) => {
            eq: (k: string, v: unknown) => {
              eq: (k: string, v: unknown) => {
                maybeSingle: () => Promise<{ data: SnagRow | null }>;
              };
            };
          };
        }
      )
        .select(
          "id, title, description, location, trade, priority, job_id, assigned_to, due_date, updated_at",
        )
        .eq("id", id)
        .eq("org_id", ctx.org.id)
        .maybeSingle(),
      fetchAllRows<JobOption>((from, to) =>
        supabase
          .from("jobs")
          .select("id, status, scheduled_date, customer:customers ( name )")
          .eq("org_id", ctx.org.id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
          data: JobOption[] | null;
          error: unknown;
        }>,
      ),
      listStaffForOrg(ctx.org.id),
    ]);
  if (jobsError) throw readFailure("snags: job picker", jobsError as SupabaseReadError);
  if (!snag) notFound();

  const jobs = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/snags" className="hover:text-slate-900">
          Snagging
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/snags/${snag.id}`} className="hover:text-slate-900">
          Snag
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Edit</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Edit snag</h1>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <SnagForm
        action={updateSnag}
        jobs={jobs}
        staff={staff.map((s) => ({ id: s.id, label: s.full_name || s.email || "—" }))}
        defaults={snag}
        hiddenId={snag.id}
        mode="update"
        baseVersion={snag.updated_at}
        submitLabel="Save changes"
        cancelHref={`/snags/${snag.id}`}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}
