import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { markEnquiryStatus } from "./actions";

/**
 * /inbox — every inbound enquiry the AI receptionist captured.
 *
 * Each row shows: channel · caller · timestamp · AI summary · job_type /
 * urgency / postcode · linked lead (if the AI managed to create one).
 *
 * Filters via search params: ?status=received|qualified|ignored
 *
 * Bulk states: `received` (new), `processed` (AI handled + lead created),
 * `qualified` (operator confirmed real lead), `ignored` (spam), `failed`.
 */

const CHANNEL_LABELS: Record<string, string> = {
  phone: "Phone call",
  sms: "SMS",
  whatsapp_msg: "WhatsApp",
  whatsapp_call: "WhatsApp call",
  instagram_dm: "Instagram",
  facebook_dm: "Facebook",
  manual: "Manual",
};

const URGENCY_STYLES: Record<string, string> = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-orange-100 text-orange-800",
  urgent: "bg-red-100 text-red-800",
};

const STATUS_STYLES: Record<string, string> = {
  received: "bg-blue-100 text-blue-800",
  processed: "bg-emerald-100 text-emerald-800",
  qualified: "bg-emerald-100 text-emerald-800",
  ignored: "bg-slate-100 text-slate-600",
  failed: "bg-red-100 text-red-800",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid enquiry id.",
  bad_status: "Invalid status.",
  update_failed: "Couldn't update the enquiry. Try again.",
};

type EnquiryRow = {
  id: string;
  channel: string;
  caller: string | null;
  raw_text: string | null;
  ai_summary: string | null;
  ai_confidence: number | null;
  job_type: string | null;
  urgency: string | null;
  postcode: string | null;
  budget_gbp: number | null;
  lead_id: string | null;
  status: string;
  created_at: string;
};

type SP = Promise<{ status?: string; error?: string }>;

export default async function InboxPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const filter =
    sp.status && ["received", "processed", "qualified", "ignored", "failed"].includes(sp.status)
      ? sp.status
      : null;

  const query = (
    supabase.from("inbound_enquiries" as never) as unknown as {
      select: (cols: string) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => {
            eq: (k: string, v: unknown) => Promise<{ data: EnquiryRow[] | null }>;
          } & Promise<{ data: EnquiryRow[] | null }>;
        };
      };
    }
  )
    .select(
      "id, channel, caller, raw_text, ai_summary, ai_confidence, job_type, urgency, postcode, budget_gbp, lead_id, status, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  const result = filter
    ? await query.eq("status", filter)
    : await (query as unknown as Promise<{ data: EnquiryRow[] | null }>);
  const rows = result.data ?? [];

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? null : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Inbox</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every inbound enquiry the AI receptionist has captured. Calls, WhatsApps,
            Instagram DMs and SMS land here. The AI summarises and, where it has
            enough information, creates the lead automatically.
          </p>
        </div>
      </header>

      {/* Status filter */}
      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <FilterLink current={sp.status ?? "all"} value="all" label="All" />
        <FilterLink current={sp.status ?? "all"} value="received" label="New" />
        <FilterLink current={sp.status ?? "all"} value="processed" label="Processed" />
        <FilterLink current={sp.status ?? "all"} value="qualified" label="Qualified" />
        <FilterLink current={sp.status ?? "all"} value="ignored" label="Ignored" />
        <FilterLink current={sp.status ?? "all"} value="failed" label="Failed" />
      </nav>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="📥"
          title="No enquiries yet"
          body="When customers call, message or DM you, the AI receptionist will capture them here."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                      {CHANNEL_LABELS[row.channel] ?? row.channel}
                    </span>
                    {row.urgency ? (
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${
                          URGENCY_STYLES[row.urgency] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {row.urgency}
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${
                        STATUS_STYLES[row.status] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {row.status}
                    </span>
                    {row.ai_confidence !== null ? (
                      <span className="text-slate-500">
                        AI confidence: {row.ai_confidence}%
                      </span>
                    ) : null}
                    <span className="text-slate-500">
                      {formatWhen(row.created_at)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-slate-900">
                    {row.caller ?? "Unknown caller"}
                    {row.job_type ? ` · ${row.job_type}` : ""}
                    {row.postcode ? ` · ${row.postcode}` : ""}
                  </p>
                  {row.ai_summary ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                      {row.ai_summary}
                    </p>
                  ) : row.raw_text ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-slate-500">
                        Show raw message
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap text-slate-600">
                        {row.raw_text}
                      </p>
                    </details>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {row.lead_id ? (
                  <Link
                    href={`/leads/${row.lead_id}`}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    Open lead →
                  </Link>
                ) : null}
                {row.status === "received" || row.status === "processed" ? (
                  <>
                    <form
                      action={markEnquiryStatus.bind(null, row.id)}
                      className="inline-block"
                    >
                      <input type="hidden" name="status" value="qualified" />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Mark qualified
                      </button>
                    </form>
                    <form
                      action={markEnquiryStatus.bind(null, row.id)}
                      className="inline-block"
                    >
                      <input type="hidden" name="status" value="ignored" />
                      <button
                        type="submit"
                        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Mark spam
                      </button>
                    </form>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
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
  const href = value === "all" ? "/inbox" : `/inbox?status=${value}`;
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

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
