import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
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
  searchParams: Promise<{ error?: string; fromRequest?: string }>;
}) {
  const { id } = await params;
  const { error, fromRequest } = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const job = await loadJobForOrg<{
    id: string;
    customer: { id: string; name: string } | null;
  }>(supabase, id, ctx.org.id, "id, customer:customers ( id, name )");
  if (!job) notFound();

  // G2: arrived via an ACCEPTED variation request → prefill title/description
  // and plant the hidden request id so createVariation stamps it 'converted'.
  // Org + job pinned; anything not accepted (or not found) renders the plain
  // blank form — the prefill is a convenience, never an authority.
  let requestPrefill: { id: string; title: string; description: string | null } | null =
    null;
  if (fromRequest && /^[0-9a-f-]{36}$/i.test(fromRequest)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as unknown as { from: (t: string) => any };
    const { data, error: prefillError } = await db
      .from("variation_requests")
      .select("id, title, description, status")
      .eq("id", fromRequest)
      .eq("org_id", ctx.org.id)
      .eq("job_id", id)
      .eq("status", "accepted")
      .maybeSingle();
    // Best-effort BY DESIGN, but never silent: a failed prefill read logs and
    // falls back to the blank form (the operator can still price the work);
    // the request simply isn't auto-stamped converted on create.
    if (prefillError) {
      console.error("[variations] fromRequest prefill read failed", prefillError);
    }
    if (data) {
      requestPrefill = {
        id: data.id as string,
        title: data.title as string,
        description: (data.description as string | null) ?? null,
      };
    }
  }

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

      {requestPrefill ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Pricing the accepted request &ldquo;{requestPrefill.title}&rdquo; —
          the request is marked converted once this variation is created.
        </p>
      ) : null}

      <VariationForm
        action={createVariation.bind(null, id)}
        defaultTitle={requestPrefill?.title}
        defaultDescription={requestPrefill?.description ?? undefined}
        variationRequestId={requestPrefill?.id}
      />
    </div>
  );
}
