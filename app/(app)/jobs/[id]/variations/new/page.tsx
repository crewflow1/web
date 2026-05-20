import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createVariation } from "@/app/(app)/quotes/actions";
import { VariationForm } from "./_form";

/**
 * New Variation Order page.
 *
 * Sits under the job route so the URL reflects ownership:
 *   /jobs/[id]/variations/new
 *
 * The form (_form.tsx) is a client component for the live-preview math.
 * On submit it server-action-dispatches to createVariation(jobId, fd).
 */

export default async function NewVariationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  await requireOrgContext();
  const supabase = await createClient();

  const { data: job } = await supabase
    .from("jobs")
    .select("id, customer:customers ( id, name )")
    .eq("id", id)
    .maybeSingle();
  if (!job) notFound();

  const errorMessage = error
    ? error === "create_failed"
      ? "Couldn't create the variation. Try again."
      : decodeURIComponent(error)
    : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href={`/jobs/${id}`} className="hover:text-slate-900">
          {job.customer?.name ?? "Job"}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New variation</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New Variation Order</h1>
        <p className="mt-1 text-sm text-slate-600">
          Capture out-of-scope work for this job. The customer approves /
          rejects via a shareable link; on approval an invoice is generated
          and revenue rolls into this job&apos;s profitability.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <VariationForm action={createVariation.bind(null, id)} />
    </div>
  );
}
