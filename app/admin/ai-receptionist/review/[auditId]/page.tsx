import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReviewItem } from "@/server/services/receptionist-review";
import type { ReviewQueueItem } from "@/server/services/receptionist-review";
import { ChannelBadge } from "@/app/admin/ai-receptionist/_components/channel-badge";
import type { TimelineEvent } from "@/server/services/receptionist-conversation-reads";
import {
  REVIEW_STATE_LABELS,
  REVIEW_STATE_STYLES,
  deriveReviewState,
  formatReviewTimestamp,
  isPending,
} from "@/lib/ai-receptionist/review";
import {
  sendReviewedReply,
  dismissReviewedReply,
  claimConversation,
  releaseConversation,
} from "../actions";

/**
 * /admin/ai-receptionist/review/[auditId] — review ONE held reply (Directive #018, R14).
 *
 * THE canonical consumer of the conversation engine: it reconstructs the whole conversation
 * through R11's read model (via `getReviewItem` → `reconstructConversation`), shows the operator
 * the full timeline and the proposed draft, and lets them edit + send it through the EXISTING
 * pipeline (`sendReviewedReply` → `dispatchHumanReviewedReply` → Enforce → Audit → Transport) or
 * dismiss it. Policy is still evaluated on send: an absolute `block` is refused even here. A
 * resolved reply shows its outcome read-only — it can never be re-sent from this surface.
 */

type OrgLite = { id: string; name: string | null; slug: string | null };
type UserLite = { id: string; email: string | null; full_name: string | null };

type SP = Promise<{
  sent?: string;
  dismissed?: string;
  owned?: string;
  released?: string;
  error?: string;
}>;

export default async function HqReceptionistReviewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ auditId: string }>;
  searchParams: SP;
}) {
  const user = await requireHqPage();
  const { auditId } = await params;
  const sp = await searchParams;

  const detail = await getReviewItem({ review_audit_id: auditId });
  if (!detail) notFound();
  const { item, conversation } = detail;

  const supabase = createAdminClient();

  // Org + assignee identity for display (read-only lookups; a miss just shows the id).
  const orgRes = await supabase
    .from("organizations" as never)
    .select("id, name, slug")
    .eq("id" as never, item.org_id)
    .maybeSingle();
  const org = ((orgRes as { data?: OrgLite | null }).data ?? null) as OrgLite | null;

  let owner: UserLite | null = null;
  if (item.assignee_id) {
    const ownerRes = await supabase
      .from("users" as never)
      .select("id, email, full_name")
      .eq("id" as never, item.assignee_id)
      .maybeSingle();
    owner = ((ownerRes as { data?: UserLite | null }).data ?? null) as UserLite | null;
  }

  const state = deriveReviewState(item);
  const pending = isPending(item);
  const banner = resolveBanner(sp);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <Link href="/admin/ai-receptionist/review" className="hover:text-slate-900">
          Reply review inbox
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{org?.name ?? item.org_id.slice(0, 8)}</span>
      </div>

      {banner ? (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            banner.tone === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Review held reply</h1>
          <p className="mt-1 text-sm text-slate-600">
            {org?.name ?? "Unknown org"}
            {org?.slug ? (
              <>
                {" · "}
                <code className="rounded bg-slate-100 px-1">{org.slug}</code>
              </>
            ) : null}
          </p>
          <div className="mt-2">
            <ChannelBadge channel={item.channel} />
          </div>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${REVIEW_STATE_STYLES[state]}`}
        >
          {REVIEW_STATE_LABELS[state]}
        </span>
      </header>

      {/* Why the policy held this reply. */}
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm">
        <h2 className="text-base font-semibold text-amber-900">Why this was held for review</h2>
        <p className="mt-1 text-amber-800">{item.reason}</p>
        {item.categories && item.categories.length ? (
          <p className="mt-2 text-xs text-amber-700">
            Categories: {item.categories.join(", ")}
          </p>
        ) : null}
        <p className="mt-2 text-[11px] text-amber-700">
          The policy engine classified this reply as <code>review</code>: it may commit the
          business or is otherwise substantive, so a human must approve it. Sending records a new
          approved audit and carries it through the same transport as an automatic reply.
        </p>
      </section>

      {/* Ownership. */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Ownership</h2>
            <p className="mt-0.5 text-sm text-slate-600">
              {item.assignee_id ? (
                <>
                  Owned by{" "}
                  <span className="font-medium text-slate-900">
                    {owner?.email ?? owner?.full_name ?? item.assignee_id.slice(0, 8)}
                  </span>
                  {item.assigned_at ? ` · since ${formatReviewTimestamp(item.assigned_at)}` : ""}
                </>
              ) : (
                "Unassigned — claim it so your team knows you are handling it."
              )}
            </p>
          </div>
          {conversation ? (
            <div className="flex gap-2">
              <form action={claimConversation}>
                <input type="hidden" name="review_audit_id" value={item.review_audit_id} />
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {item.assignee_id === user.id ? "Re-claim" : "Claim"}
                </button>
              </form>
              {item.assignee_id ? (
                <form action={releaseConversation}>
                  <input type="hidden" name="review_audit_id" value={item.review_audit_id} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50"
                  >
                    Release
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-slate-500">No conversation to assign</span>
          )}
        </div>
      </section>

      {/* The reconstructed conversation timeline (R11). */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Conversation
          {conversation ? (
            <span className="ml-2 text-xs font-normal text-slate-500">
              {conversation.conversation.message_count} messages ·{" "}
              {conversation.conversation.contact_name ?? conversation.conversation.contact_ref}
            </span>
          ) : null}
        </h2>
        {conversation && conversation.timeline.length > 0 ? (
          <ol className="mt-4 space-y-3">
            {conversation.timeline.map((event) => (
              <TimelineBubble key={event.message_id} event={event} />
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            No threaded conversation — this held reply answers a contactless enquiry, so there is
            no prior timeline to reconstruct. Review the draft below on its own merits.
          </p>
        )}
      </section>

      {/* Review / edit / send / dismiss — or the read-only resolution outcome. */}
      {pending ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Proposed reply</h2>
          <p className="mt-1 text-xs text-slate-500">
            Edit the draft if needed, then send it through the pipeline. Policy is re-checked on
            send — a prohibited reply is refused even here.
          </p>

          <form action={sendReviewedReply} className="mt-3 space-y-3">
            <input type="hidden" name="review_audit_id" value={item.review_audit_id} />
            <textarea
              name="text"
              defaultValue={item.draft}
              rows={5}
              className="w-full rounded-lg border border-slate-300 p-3 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                Send through pipeline
              </button>
              <span className="text-xs text-slate-500">
                Sends via the same transport as an automatic reply, and records an approved audit.
              </span>
            </div>
          </form>

          <div className="mt-6 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Dismiss instead</h3>
            <p className="mt-1 text-xs text-slate-500">
              Record a decision NOT to send. No message leaves the building.
            </p>
            <form action={dismissReviewedReply} className="mt-2 space-y-2">
              <input type="hidden" name="review_audit_id" value={item.review_audit_id} />
              <input
                type="text"
                name="note"
                placeholder="Optional note (why dismissed)"
                className="w-full rounded-lg border border-slate-300 p-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Dismiss reply
              </button>
            </form>
          </div>
        </section>
      ) : (
        <ResolutionSummary item={item} />
      )}
    </div>
  );
}

/** The read-only outcome shown once a held reply has been resolved — it can never be re-sent. */
function ResolutionSummary({ item }: { item: ReviewQueueItem }) {
  const sent = item.resolution === "sent";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          {sent ? "This reply was sent" : "This reply was dismissed"}
        </h2>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            sent ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
          }`}
        >
          {sent ? (item.resolution_edited ? "Sent (edited)" : "Sent (as drafted)") : "Dismissed"}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <Detail label="Decided by" value={item.resolved_by_email ?? item.resolved_by} />
        <Detail label="Decided at" value={formatReviewTimestamp(item.resolved_at)} />
        {sent ? (
          <Detail label="Edited before sending" value={item.resolution_edited ? "Yes" : "No"} />
        ) : null}
        {item.resolution_note ? (
          <div className="sm:col-span-2">
            <Detail label="Note" value={item.resolution_note} multiline />
          </div>
        ) : null}
      </dl>
      <div className="mt-3 sm:col-span-2">
        <Detail label="Proposed draft" value={item.draft} multiline />
      </div>
      {sent && item.sent_audit_id ? (
        <p className="mt-3 text-xs text-slate-500">
          The approved send is recorded as its own audit —{" "}
          <Link
            href={`/admin/ai-receptionist/deliveries/${item.sent_audit_id}`}
            className="font-medium text-slate-700 underline hover:text-slate-900"
          >
            view its delivery lifecycle
          </Link>
          . It went through the same Enforce → Audit → Transport chain as an automatic reply.
        </p>
      ) : null}
    </section>
  );
}

/** One conversation event as a chat bubble — inbound (customer) left, outbound (AI) right. */
function TimelineBubble({ event }: { event: TimelineEvent }) {
  const inbound = event.direction === "inbound";
  const text = inbound
    ? event.inbound_text ?? event.inbound_summary ?? "(no text)"
    : event.outbound_draft ?? "(no draft)";

  return (
    <li className={inbound ? "flex justify-start" : "flex justify-end"}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
          inbound
            ? "bg-slate-100 text-slate-900"
            : "bg-slate-900 text-white"
        }`}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
          {inbound ? "Customer" : "AI receptionist"} · {formatReviewTimestamp(event.event_at)}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap">{text}</p>
        {!inbound && event.outbound_verdict ? (
          <p className="mt-1 text-[10px] opacity-70">
            verdict {event.outbound_verdict}
            {event.transport_status ? ` · transport ${event.transport_status}` : ""}
            {event.delivery_status ? ` · ${event.delivery_status}` : ""}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Detail({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | null;
  multiline?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          multiline
            ? "mt-0.5 whitespace-pre-wrap text-sm text-slate-900"
            : "mt-0.5 text-sm text-slate-900"
        }
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

/** Map the redirect status params onto a single banner. */
function resolveBanner(sp: {
  sent?: string;
  dismissed?: string;
  owned?: string;
  released?: string;
  error?: string;
}): { tone: "success" | "error"; text: string } | null {
  if (sp.error) {
    const text =
      sp.error === "blocked"
        ? "This reply is prohibited by policy (block) and cannot be sent, even by a human. Dismiss it instead."
        : sp.error === "already_resolved"
          ? "This reply was already resolved — someone else got to it first."
          : sp.error === "empty_draft"
            ? "The draft was empty — nothing was sent."
            : sp.error === "no_conversation"
              ? "This held reply has no threaded conversation to assign."
              : sp.error === "claim_failed"
                ? "Could not claim the conversation."
                : sp.error === "release_failed"
                  ? "Could not release the conversation."
                  : "Something went wrong.";
    return { tone: "error", text };
  }
  if (sp.sent) {
    return {
      tone: "success",
      text:
        sp.sent === "edited"
          ? "Edited reply sent through the pipeline and recorded as an approved audit."
          : "Reply sent through the pipeline and recorded as an approved audit.",
    };
  }
  if (sp.dismissed) return { tone: "success", text: "Reply dismissed. No message was sent." };
  if (sp.owned) return { tone: "success", text: "You now own this conversation." };
  if (sp.released) return { tone: "success", text: "Ownership released." };
  return null;
}
