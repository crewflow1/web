import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import {
  cancelReviewRequestAction,
  emailReviewRequestNow,
  markReviewCompletedAction,
} from "./actions";
import { Stagger, StaggerItem } from "@/components/ui";

/**
 * /reviews — list of every review request the operator has scheduled.
 *
 * Filter by status; "Send email now" surfaces only on pre-send rows;
 * "Mark completed" on sent rows; "Cancel" on scheduled rows.
 */

type ReviewRow = {
  id: string;
  platform: string;
  delay_days: number;
  send_at: string;
  sent_at: string | null;
  completed_at: string | null;
  status: string;
  notes: string | null;
  customer: { id: string; name: string | null; email: string | null } | null;
  job: { id: string; status: string | null; notes: string | null } | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  google: "Google",
  facebook: "Facebook",
  trustpilot: "Trustpilot",
  other: "Other",
};

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800",
  sent: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-100 text-slate-600",
  ignored: "bg-slate-100 text-slate-600",
};

const SAVED_MAP: Record<string, string> = {
  created: "Review request scheduled.",
  emailed: "Email sent.",
  completed: "Marked as completed.",
  cancelled: "Request cancelled.",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid review request.",
  update_failed: "Couldn't update the request.",
  not_found: "Review request not found.",
  already_resolved: "This request is already done.",
  email_no_key: "Email isn't configured — set RESEND_API_KEY in Vercel to send.",
};

type SP = Promise<{ status?: string; saved?: string; error?: string }>;

export default async function ReviewsPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const filter =
    sp.status && ["scheduled", "sent", "completed", "cancelled", "ignored"].includes(sp.status)
      ? sp.status
      : null;

  const baseQuery = (
    supabase.from("review_requests" as never) as unknown as {
      select: (cols: string) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => {
            eq: (
              k: string,
              v: unknown,
            ) => Promise<{ data: ReviewRow[] | null }>;
          } & Promise<{ data: ReviewRow[] | null }>;
        };
      };
    }
  )
    .select(
      `
        id, platform, delay_days, send_at, sent_at, completed_at, status, notes,
        customer:customers ( id, name, email ),
        job:jobs ( id, status, notes )
      `,
    )
    .order("send_at", { ascending: false })
    .limit(200);

  const result = filter
    ? await baseQuery.eq("status", filter)
    : await (baseQuery as unknown as Promise<{ data: ReviewRow[] | null }>);
  const rows = result.data ?? [];

  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;
  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reviews</h1>
          <p className="mt-1 text-sm text-slate-600">
            Schedule a review request after each completed job. The cron
            sends a reminder at the chosen delay — or send the email now.
          </p>
        </div>
        <Link
          href="/reviews/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Request review
        </Link>
      </header>

      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <FilterLink current={sp.status ?? "all"} value="all" label="All" />
        <FilterLink current={sp.status ?? "all"} value="scheduled" label="Scheduled" />
        <FilterLink current={sp.status ?? "all"} value="sent" label="Sent" />
        <FilterLink current={sp.status ?? "all"} value="completed" label="Completed" />
        <FilterLink current={sp.status ?? "all"} value="cancelled" label="Cancelled" />
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          icon="⭐"
          title="No review requests yet"
          body="Pick a happy customer with a completed job and ask them to leave a review."
          primary={{ href: "/reviews/new", label: "Request a review" }}
        />
      ) : (
        <Stagger className="space-y-3">
          {rows.map((row) => (
            <StaggerItem
              key={row.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                      {PLATFORM_LABELS[row.platform] ?? row.platform}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${
                        STATUS_STYLES[row.status] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {row.status}
                    </span>
                    <span className="text-slate-500">
                      {row.status === "scheduled"
                        ? `Send at ${row.send_at.slice(0, 10)} (delay: ${row.delay_days}d)`
                        : row.sent_at
                          ? `Sent ${row.sent_at.slice(0, 10)}`
                          : ""}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-slate-900">
                    {row.customer ? (
                      <Link
                        href={`/customers/${row.customer.id}`}
                        className="hover:text-slate-700"
                      >
                        {row.customer.name ?? "Customer"}
                      </Link>
                    ) : (
                      "Customer removed"
                    )}
                  </p>
                  {row.customer?.email ? (
                    <p className="text-xs text-slate-500">{row.customer.email}</p>
                  ) : (
                    <p className="text-xs text-red-700">
                      No email on file — won&rsquo;t be emailable
                    </p>
                  )}
                  {row.notes ? (
                    <p className="mt-1 text-xs text-slate-600">{row.notes}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {row.job ? (
                    <Link
                      href={`/jobs/${row.job.id}`}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900"
                    >
                      View job →
                    </Link>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {row.status === "scheduled" || row.status === "sent" ? (
                  row.customer?.email ? (
                    <form action={emailReviewRequestNow.bind(null, row.id)}>
                      <button
                        type="submit"
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                      >
                        {row.status === "sent" ? "Resend email" : "Send email now"}
                      </button>
                    </form>
                  ) : null
                ) : null}
                {row.status === "scheduled" ? (
                  <form action={cancelReviewRequestAction.bind(null, row.id)}>
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </form>
                ) : null}
                {row.status === "sent" ? (
                  <form action={markReviewCompletedAction.bind(null, row.id)}>
                    <button
                      type="submit"
                      className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-50"
                    >
                      Mark completed
                    </button>
                  </form>
                ) : null}
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function FilterLink({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href = value === "all" ? "/reviews" : `/reviews?status=${value}`;
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
