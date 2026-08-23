import Link from "next/link";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { NewFinanceForm } from "./_form";

/**
 * New finance entry — server wrapper around the client form.
 *
 * Accepts `?job_id=<uuid>` to pre-attach the cost to a specific job
 * (used by the "+ Add cost" CTA on /jobs/[id]). We look up the
 * customer name for a friendlier banner on the form. RLS keeps the
 * lookup safe — non-members get null and the banner just shows the
 * UUID stub.
 */

type SP = Promise<{ job_id?: string }>;

const uuid = z.string().uuid();

export default async function NewFinancePage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const jobIdParam = sp.job_id ?? "";
  const jobId = uuid.safeParse(jobIdParam).success ? jobIdParam : undefined;

  let jobLabel: string | undefined;
  if (jobId) {
    const supabase = await createClient();
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", jobId)
      // ACTIVE-org pin — the `?job=` deep-link must not resolve (and label) a
      // job belonging to the viewer's other org.
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (job) {
      const customerName = (job.customer as { name?: string } | null)?.name;
      jobLabel = customerName
        ? `${customerName}'s job (${jobId.slice(0, 8)})`
        : `job ${jobId.slice(0, 8)}`;
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/finances" className="hover:text-slate-900">
          Costs
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New cost entry</h1>
        <p className="mt-1 text-sm text-slate-600">
          Record a cost or expense. VAT is computed automatically.
        </p>
      </header>

      <NewFinanceForm jobId={jobId} jobLabel={jobLabel} />
    </div>
  );
}
