import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { listReviewQueue, type ReviewQueueItem } from "@/server/services/receptionist-review";
import { ChannelBadge } from "@/app/admin/ai-receptionist/_components/channel-badge";
import {
  REVIEW_FILTERS,
  REVIEW_STATE_LABELS,
  REVIEW_STATE_STYLES,
  deriveReviewState,
  formatReviewTimestamp,
  isReviewFilter,
  stateMatchesFilter,
  type ReviewFilter,
} from "@/lib/ai-receptionist/review";

/**
 * /admin/ai-receptionist/review — the HQ REPLY REVIEW INBOX (Directive #018, R14: HUMAN
 * HANDOFF & REPLY REVIEW INBOX).
 *
 * The operational half of the receptionist's human-in-the-loop design. R3's policy holds every
 * `review` reply for a human ("the AI drafts, a human sends"); R4 files it as an
 * `ai_reply_audits` row (verdict='review', allowed=false). This inbox is where a human ACTS on
 * those held replies: it lists them, and each opens onto the full conversation + the proposed
 * draft, where the human can edit and send through the EXISTING pipeline, or dismiss.
 *
 * READ-ONLY here: this page reads the `receptionist_review_queue` view and renders it. The
 * mutations (send / dismiss / claim) live in ./actions and the [auditId] detail page. It opens
 * on the `pending` bucket — the operator's actionable queue.
 */

type OrgLite = { id: string; name: string | null; slug: string | null };
type UserLite = { id: string; email: string | null; full_name: string | null };

type SP = Promise<{ filter?: string }>;

export default async function HqReceptionistReviewInboxPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireHqPage();

  const sp = await searchParams;
  const filter: ReviewFilter = isReviewFilter(sp.filter) ? sp.filter : "pending";
  const supabase = createAdminClient();

  // Newest 500 held replies, unfiltered — we bucket + filter in memory so the pill counts and
  // the rendered rows share one predicate (stateMatchesFilter) and can never disagree.
  const allRows = await listReviewQueue({ limit: 500 });

  // Enrich with organisation names + assignee identities for the operator (read-only lookups).
  const orgIds = Array.from(new Set(allRows.map((r) => r.org_id)));
  const orgById = new Map<string, OrgLite>();
  if (orgIds.length > 0) {
    const orgsRes = await supabase
      .from("organizations" as never)
      .select("id, name, slug")
      .in("id" as never, orgIds as never);
    for (const o of ((orgsRes as { data?: OrgLite[] | null }).data ?? []) as OrgLite[]) {
      orgById.set(o.id, o);
    }
  }

  const assigneeIds = Array.from(
    new Set(allRows.map((r) => r.assignee_id).filter((v): v is string => v !== null)),
  );
  const userById = new Map<string, UserLite>();
  if (assigneeIds.length > 0) {
    const usersRes = await supabase
      .from("users" as never)
      .select("id, email, full_name")
      .in("id" as never, assigneeIds as never);
    for (const u of ((usersRes as { data?: UserLite[] | null }).data ?? []) as UserLite[]) {
      userById.set(u.id, u);
    }
  }

  // Bucket counts for the filter pills, then the filtered slice we render.
  const counts: Record<ReviewFilter, number> = {
    pending: 0,
    sent: 0,
    dismissed: 0,
    all: allRows.length,
  };
  for (const row of allRows) {
    const state = deriveReviewState(row);
    for (const f of REVIEW_FILTERS) {
      if (f.key !== "all" && stateMatchesFilter(state, f.key)) counts[f.key]++;
    }
  }

  const rows = allRows.filter((row) => stateMatchesFilter(deriveReviewState(row), filter));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Reply review inbox</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Reply review inbox</h1>
        <p className="mt-1 text-sm text-slate-600">
          Replies the policy held for a human. Open one to review the conversation and the
          proposed draft, then edit and send it through the existing pipeline — or dismiss it.
          Every human decision is audited; nothing here bypasses policy, audit or transport.
        </p>
      </header>

      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-xs">
        {REVIEW_FILTERS.map((f) => (
          <FilterPill
            key={f.key}
            current={filter}
            value={f.key}
            label={`${f.label} (${counts[f.key]})`}
          />
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
          {filter === "pending"
            ? "No replies are awaiting review. The queue is clear."
            : "No replies in this bucket yet."}
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Held</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Proposed reply</th>
                <th className="px-4 py-3">Conversation</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((row) => (
                <ReviewRow
                  key={row.review_audit_id}
                  row={row}
                  org={orgById.get(row.org_id)}
                  owner={row.assignee_id ? userById.get(row.assignee_id) : undefined}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function ReviewRow({
  row,
  org,
  owner,
}: {
  row: ReviewQueueItem;
  org: OrgLite | undefined;
  owner: UserLite | undefined;
}) {
  const state = deriveReviewState(row);
  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
        {formatReviewTimestamp(row.held_at)}
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/admin/ai-receptionist/review/${row.review_audit_id}`}
          className="font-medium text-slate-900 hover:text-slate-700"
        >
          {org?.name ?? "Unknown org"}
        </Link>
        <p className="text-xs text-slate-500">
          {row.contact_name ?? row.contact_ref ?? row.customer_ref ?? org?.slug ?? row.org_id.slice(0, 8)}
        </p>
        <ChannelBadge channel={row.channel} className="mt-1" />
      </td>
      <td className="px-4 py-3">
        <p className="max-w-xs truncate text-xs text-slate-700">{row.draft}</p>
        {row.reason ? (
          <p className="mt-1 max-w-xs truncate text-[11px] text-amber-700">{row.reason}</p>
        ) : null}
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">
        {row.conversation_id ? (
          <>
            <span className="font-medium text-slate-800">{row.message_count ?? 0} msgs</span>
            <p className="text-slate-500">
              last {formatReviewTimestamp(row.last_message_at)}
            </p>
          </>
        ) : (
          <span className="text-slate-400">no thread</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">
        {row.assignee_id ? (
          <span className="text-slate-800">{owner?.email ?? owner?.full_name ?? "assigned"}</span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${REVIEW_STATE_STYLES[state]}`}
        >
          {REVIEW_STATE_LABELS[state]}
        </span>
      </td>
    </tr>
  );
}

function FilterPill({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href =
    value === "pending"
      ? "/admin/ai-receptionist/review"
      : `/admin/ai-receptionist/review?filter=${value}`;
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
