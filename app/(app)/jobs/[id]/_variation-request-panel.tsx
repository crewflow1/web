import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { StateForm } from "@/components/forms/StateForm";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  createVariationRequest,
  reviewVariationRequest,
} from "./variation-request-actions";
import {
  VARIATION_REQUEST_STATUS_LABELS,
  VARIATION_REQUEST_URGENCIES,
  VARIATION_REQUEST_URGENCY_LABELS,
  VARIATION_REQUESTER_TYPE_LABELS,
  type VariationRequestStatus,
  type VariationRequestUrgency,
  type VariationRequesterType,
} from "@/lib/variation-requests/schema";

/**
 * Variation requests on the job workspace (roadmap G2, migration 20261221).
 *
 * One panel, two audiences:
 *   - ANY member logs a request ("client wants the socket moved — needs
 *     pricing") — intake is site work, not an admin act;
 *   - MANAGEMENT reviews: start review / accept / reject-with-note. Accepting
 *     never creates money — it exposes a "Create variation" link into the
 *     EXISTING /jobs/[id]/variations/new flow, and createVariation stamps the
 *     request 'converted' via the ?fromRequest= hidden field.
 *
 * Requests also arrive here from the customer portal ("Request a change") and
 * the worker portal — same table, requester_type tells them apart.
 *
 * Forms are StateForm + FormState actions (the deep-[id]-route navigation
 * mandate — see StateForm.tsx). Fields are simple stacked (house mobile
 * style), no fixed widths.
 */

const STATUS_STYLES: Record<VariationRequestStatus, string> = {
  requested: "bg-blue-100 text-blue-800",
  reviewing: "bg-indigo-100 text-indigo-800",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  converted: "bg-slate-900 text-white",
};

const URGENCY_STYLES: Record<VariationRequestUrgency, string> = {
  high: "bg-red-100 text-red-800",
  normal: "bg-slate-100 text-slate-700",
  low: "bg-slate-100 text-slate-500",
};

/** Newest N rendered; the panel is a working queue, not an archive. */
const PANEL_LIMIT = 8;

type RequestRow = {
  id: string;
  title: string;
  description: string | null;
  reason: string | null;
  urgency: VariationRequestUrgency;
  requester_type: VariationRequesterType;
  requester_name: string | null;
  status: VariationRequestStatus;
  review_note: string | null;
  variation_quote_id: string | null;
  created_at: string;
  requester: { full_name: string | null } | null;
};

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function requesterLabel(r: RequestRow): string {
  if (r.requester_type === "staff") {
    return r.requester?.full_name ?? "Staff";
  }
  const who = VARIATION_REQUESTER_TYPE_LABELS[r.requester_type];
  return r.requester_name ? `${who} · ${r.requester_name}` : who;
}

export async function VariationRequestPanel({
  jobId,
  orgId,
  isManagement,
}: {
  jobId: string;
  orgId: string;
  isManagement: boolean;
}) {
  const supabase = await createClient();
  // variation_requests post-dates the generated types (snags idiom).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as unknown as { from: (t: string) => any };

  const { data, error } = await db
    .from("variation_requests")
    .select(
      `id, title, description, reason, urgency, requester_type, requester_name,
       status, review_note, variation_quote_id, created_at,
       requester:users!variation_requests_requested_by_fkey ( full_name )`,
    )
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(PANEL_LIMIT + 1);

  // Best-effort panel: a failed read degrades to an empty list (the job page
  // must never 500 because one section couldn't load) — but say so.
  const failed = Boolean(error);
  if (error) console.error("[variation-requests] panel read failed", error);
  const rows = (data ?? []) as RequestRow[];
  const overflow = rows.length > PANEL_LIMIT;
  const listed = overflow ? rows.slice(0, PANEL_LIMIT) : rows;

  return (
    <section
      id="variation-requests"
      aria-labelledby="variation-requests-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2
          id="variation-requests-heading"
          className="text-base font-semibold text-slate-900"
        >
          Variation requests
        </h2>
        <p className="text-xs text-slate-500">
          {listed.length === 0
            ? "None raised"
            : `${listed.length}${overflow ? "+" : ""} raised · newest first`}
        </p>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Out-of-scope work spotted on site or asked for by the customer. Accepted
        requests are priced through a Variation Order — nothing here changes the
        money on its own.
      </p>

      {failed ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Couldn&rsquo;t load this job&rsquo;s variation requests just now —
          reload to try again.
        </p>
      ) : null}

      {listed.length > 0 ? (
        <ul className="mt-3 divide-y divide-slate-100">
          {listed.map((r) => {
            const open = r.status === "requested" || r.status === "reviewing";
            return (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 basis-full break-words text-sm font-medium text-slate-900 sm:flex-1 sm:basis-0">
                    {r.title}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${URGENCY_STYLES[r.urgency] ?? "bg-slate-100 text-slate-700"}`}
                  >
                    {VARIATION_REQUEST_URGENCY_LABELS[r.urgency] ?? r.urgency}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[r.status] ?? "bg-slate-100 text-slate-700"}`}
                  >
                    {VARIATION_REQUEST_STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  {requesterLabel(r)} · {dateFmt.format(new Date(r.created_at))}
                </p>
                {r.description ? (
                  <p className="whitespace-pre-line break-words text-sm text-slate-600">
                    {r.description}
                  </p>
                ) : null}
                {r.reason ? (
                  <p className="text-xs text-slate-500">
                    <span className="font-medium text-slate-600">Why:</span>{" "}
                    {r.reason}
                  </p>
                ) : null}
                {r.review_note ? (
                  <p className="rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                    <span className="font-medium text-slate-700">
                      Review note:
                    </span>{" "}
                    {r.review_note}
                  </p>
                ) : null}

                {/* Photos / documents for this request — the universal
                    attachments pipeline (target_table='variation_requests'). */}
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900">
                    Photos &amp; files
                  </summary>
                  <div className="mt-2">
                    <AttachmentsPanel
                      targetTable="variation_requests"
                      targetId={r.id}
                    />
                  </div>
                </details>

                {isManagement && open ? (
                  <StateForm
                    action={reviewVariationRequest.bind(null, jobId)}
                    className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <input type="hidden" name="request_id" value={r.id} />
                    <label className="block text-xs text-slate-600">
                      Review note{" "}
                      <span className="text-slate-400">
                        (required to reject)
                      </span>
                      <textarea
                        name="review_note"
                        rows={2}
                        maxLength={2000}
                        placeholder="e.g. Out of scope of the contract — happy to price it."
                        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {r.status === "requested" ? (
                        <button
                          type="submit"
                          name="decision"
                          value="reviewing"
                          className="min-h-[36px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        >
                          Start review
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        name="decision"
                        value="accepted"
                        className="min-h-[36px] rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                      >
                        Accept
                      </button>
                      <button
                        type="submit"
                        name="decision"
                        value="rejected"
                        className="min-h-[36px] rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                      >
                        Reject
                      </button>
                    </div>
                  </StateForm>
                ) : null}

                {isManagement && r.status === "accepted" ? (
                  <Link
                    href={`/jobs/${jobId}/variations/new?fromRequest=${r.id}`}
                    className="inline-block rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    Create variation from this request
                  </Link>
                ) : null}

                {r.status === "converted" && r.variation_quote_id ? (
                  <Link
                    href={`/quotes/${r.variation_quote_id}`}
                    className="text-xs font-medium text-slate-700 underline hover:text-slate-900"
                  >
                    View the variation order
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !failed ? (
        <p className="mt-3 text-sm text-slate-600">
          No change requests on this job. Anyone on the team can log one below;
          customers can ask via their portal (&ldquo;Requests&rdquo; tab).
        </p>
      ) : null}

      {/* Intake — member-level. Simple stacked fields (house mobile style). */}
      <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">
          Request a variation
        </summary>
        <StateForm
          action={createVariationRequest.bind(null, jobId)}
          className="mt-3 space-y-3"
        >
          <label className="block text-sm">
            <span className="font-medium text-slate-700">What changed?</span>
            <input
              name="title"
              type="text"
              required
              minLength={3}
              maxLength={200}
              placeholder="e.g. Client wants the kitchen socket moved"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Details</span>
            <textarea
              name="description"
              rows={3}
              maxLength={5000}
              placeholder="Scope, rooms involved, anything already agreed on site…"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">
              Why is it needed?{" "}
              <span className="font-normal text-slate-500">(optional)</span>
            </span>
            <input
              name="reason"
              type="text"
              maxLength={2000}
              placeholder="e.g. Unforeseen ground conditions"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Urgency</span>
            <select
              name="urgency"
              defaultValue="normal"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {VARIATION_REQUEST_URGENCIES.map((u) => (
                <option key={u} value={u}>
                  {VARIATION_REQUEST_URGENCY_LABELS[u]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Log request
          </button>
        </StateForm>
      </details>
    </section>
  );
}
