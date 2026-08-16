import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import {
  listPendingAssistantActions,
  type AssistantReviewItem,
} from "@/server/services/assistant-review";
import { EmptyState } from "../../_components/empty-state";
import { InboxTabs } from "../_components/inbox-tabs";
import { resolveAssistantAction } from "./actions";

/**
 * /inbox/review — the WhatsApp assistant REVIEW queue.
 *
 * The assistant files inbound commitments (a priced variation, a task/booking) as
 * pending_review — never auto-committed. A human reviews each draft here and either
 * CONVERTS it (handed to the real, session-bound variation/task writer) or DISMISSES
 * it. Org-pinned + loud reads via the service layer.
 */

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  variation_draft: "Variation request",
  task: "Task / booking",
  note: "Note",
  photo_upload: "Photo",
};

const REASON_LABELS: Record<string, string> = {
  human_in_the_loop: "Needs your decision",
  no_job_context: "No matching job",
  unsupported_mime: "Unsupported attachment",
  no_bytes: "Attachment missing",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That item could not be identified.",
  bad_decision: "Pick convert or dismiss.",
  update_failed: "Couldn't record your decision. Try again.",
  already_resolved: "That item was already handled.",
};

type SP = Promise<{ error?: string }>;

export default async function ReviewQueuePage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const items = await listPendingAssistantActions(ctx.org.id);
  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? "Something went wrong." : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <InboxTabs active="review" />
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Review queue</h1>
        <p className="mt-1 text-sm text-slate-600">
          Commitments the assistant captured from WhatsApp — a variation, a booking, a note
          it couldn&apos;t file — waiting for your decision. Nothing here is acted on
          automatically.
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

      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="✅"
            title="Nothing to review"
            body="When the assistant captures a request that needs your sign-off, it appears here."
            primary={{ href: "/inbox/conversations", label: "Go to conversations" }}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <ReviewCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewCard({ item }: { item: AssistantReviewItem }) {
  const resolve = resolveAssistantAction.bind(null, item.id);
  const canConvert = item.action_type === "variation_draft" || item.job_id !== null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800">
          {TYPE_LABELS[item.action_type] ?? item.action_type}
        </span>
        {item.reason ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
            {REASON_LABELS[item.reason] ?? item.reason}
          </span>
        ) : null}
        <span className="text-slate-500">{formatWhen(item.created_at)}</span>
      </div>

      {item.requested ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-900">{item.requested}</p>
      ) : (
        <p className="mt-2 text-sm italic text-slate-500">No text captured.</p>
      )}
      {item.caller ? (
        <p className="mt-1 text-xs text-slate-500">From {item.caller}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {item.job_id ? (
          <Link
            href={`/jobs/${item.job_id}`}
            className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
          >
            View job
          </Link>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <form action={resolve}>
            <input type="hidden" name="decision" value="dismiss" />
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Dismiss
            </button>
          </form>
          {canConvert ? (
            <form action={resolve}>
              <input type="hidden" name="decision" value="convert" />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                {item.action_type === "variation_draft" ? "Create variation" : "Convert"}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });
  } catch {
    return iso;
  }
}
