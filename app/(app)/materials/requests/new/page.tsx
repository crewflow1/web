import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { createMaterialRequest } from "../actions";
import { MaterialRequestForm } from "../_request-form";

/**
 * Raise a materials request.
 *
 * Reached two ways:
 *   · from the job's Materials panel with `?job=<id>` — the primary path, and
 *     the job is then FIXED (a worker on site is not choosing a job);
 *   · from the office queue with no job — a yard/van request, which the schema
 *     supports because job_id is nullable (20261066 note 3).
 */

type JobRow = {
  id: string;
  site_address_line1: string | null;
  site_city: string | null;
  status: string;
  customer: { name: string | null } | null;
};

function label(job: JobRow): string {
  const who = job.customer?.name?.trim();
  const where = [job.site_address_line1?.trim(), job.site_city?.trim()]
    .filter(Boolean)
    .join(", ");
  if (who && where) return `${who} — ${where}`;
  return who || where || "Job";
}

export default async function NewMaterialRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job: jobParam } = await searchParams;
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  // ACTIVE-ORG PIN as well as RLS: current_org_ids() returns every org the
  // viewer belongs to, so an RLS-only read would offer the OTHER company's
  // jobs in this company's picker.
  const { data, error } = await (
    supabase.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          in: (
            k: string,
            v: readonly unknown[],
          ) => {
            order: (
              k: string,
              o: { ascending: boolean },
            ) => {
              limit: (n: number) => Promise<{ data: JobRow[] | null; error: SupabaseReadError | null }>;
            };
          };
        };
      };
    }
  )
    .select("id, site_address_line1, site_city, status, customer:customers ( name )")
    .eq("org_id", ctx.org.id)
    .in("status", ["new", "in-progress", "blocked"])
    .order("created_at", { ascending: false })
    .limit(200);
  // LOUD: a failed read here would silently render an empty job picker, and
  // the request would land with no job attached — the "empty-state reads as
  // healthy" failure this codebase has shipped before.
  if (error) throw readFailure("material requests: job picker", error);

  const jobs = data ?? [];
  const pinned = jobParam ? jobs.find((j) => j.id === jobParam) : undefined;
  const backHref = pinned ? `/jobs/${pinned.id}` : "/materials/requests";

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-1 pb-10">
      <div>
        <Link href={backHref} className="text-sm text-slate-500 hover:text-slate-800">
          ← Back
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Request materials</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The office gets it straight away and either approves it or comes back to you.
        </p>
      </div>

      {/*
        No job pinned and jobs to choose from: offer the picker OUTSIDE the
        client form so it stays a server-rendered <select> in the same
        <form> — the form element is the client boundary, and the picker's
        name="job_id" is read by the action either way.
      */}
      {!pinned && jobs.length > 0 ? (
        <details className="rounded-xl border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-800">
            Which job is this for? <span className="text-slate-400">(optional)</span>
          </summary>
          <p className="mt-2 text-xs text-slate-500">
            Leave it blank for yard or van stock. Requests raised from a job page
            already know their job.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {jobs.slice(0, 12).map((j) => (
              <li key={j.id}>
                <Link
                  href={`/materials/requests/new?job=${j.id}`}
                  className="block rounded-md px-2 py-2 text-slate-700 hover:bg-slate-50"
                >
                  {label(j)}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* CREATE (draft) is offline-writable (lib/offline/registry.ts —
          material_request.create). The identity handed to the form is the one
          the SERVER just resolved for this request — newly authored work is
          never attributed from a client-side marker on a shared tablet. */}
      <MaterialRequestForm
        action={createMaterialRequest}
        jobId={pinned?.id ?? null}
        jobLabel={pinned ? label(pinned) : null}
        backHref={backHref}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}
