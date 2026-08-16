import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listOutboundAudit } from "@/server/services/outbound-audit";
import { pageOutboundAudit, type OutboundAuditEntry } from "@/lib/inbox/outbound-audit";
import { EmptyState } from "../../_components/empty-state";
import { InboxTabs } from "../_components/inbox-tabs";

/**
 * /inbox/audit — the UNIFIED outbound delivery audit.
 *
 * One cross-channel record of every outbound communication and what happened to it:
 * inbox replies (with Resend open/click/bounce enrichment) and AI-receptionist SMS
 * (with the latest delivery receipt). Org-pinned + loud reads via the service; the
 * complete (F-1) read is paged for display.
 */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const STATUS_PILL: Record<string, string> = {
  opened: "bg-emerald-100 text-emerald-800",
  clicked: "bg-emerald-100 text-emerald-800",
  delivered: "bg-sky-100 text-sky-800",
  sent: "bg-slate-100 text-slate-700",
  queued: "bg-slate-100 text-slate-600",
  bounced: "bg-red-100 text-red-800",
  complained: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  undelivered: "bg-red-100 text-red-800",
};

type SP = Promise<{ page?: string }>;

export default async function OutboundAuditPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const requestedPage = Number.parseInt(sp.page ?? "1", 10);
  const entries = await listOutboundAudit(ctx.org.id);
  const { rows, page, pageCount, total } = pageOutboundAudit(
    entries,
    Number.isFinite(requestedPage) ? requestedPage : 1,
    PAGE_SIZE,
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <InboxTabs active="audit" />
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Delivery audit</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every message you or the assistant sent, across email, SMS and WhatsApp — with
          delivery, open and bounce status where the provider reports it.
        </p>
      </header>

      {total === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📤"
            title="No outbound messages yet"
            body="When you reply to a customer or the assistant sends on your behalf, delivery status appears here."
            primary={{ href: "/inbox/conversations", label: "Go to conversations" }}
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Channel</th>
                  <th className="px-4 py-2">Recipient</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          <nav className="flex items-center justify-between text-sm text-slate-600">
            <span>
              {total} message{total === 1 ? "" : "s"} · page {page} of {pageCount}
            </span>
            <span className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={`/inbox/audit?page=${page - 1}`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 font-medium hover:bg-slate-50"
                >
                  Previous
                </Link>
              ) : null}
              {page < pageCount ? (
                <Link
                  href={`/inbox/audit?page=${page + 1}`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1 font-medium hover:bg-slate-50"
                >
                  Next
                </Link>
              ) : null}
            </span>
          </nav>
        </>
      )}
    </div>
  );
}

function AuditRow({ row }: { row: OutboundAuditEntry }) {
  return (
    <tr className="text-slate-800">
      <td className="whitespace-nowrap px-4 py-2 text-slate-500">{formatWhen(row.occurred_at)}</td>
      <td className="px-4 py-2 capitalize">{row.channel}</td>
      <td className="max-w-[16rem] truncate px-4 py-2">{row.recipient ?? "—"}</td>
      <td className="px-4 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[row.status] ?? "bg-slate-100 text-slate-700"}`}
        >
          {row.status}
        </span>
      </td>
      <td className="px-4 py-2 text-slate-500">
        {row.source === "receptionist" ? "Assistant" : "You"}
      </td>
      <td className="px-4 py-2 text-xs text-slate-500">
        {row.error ? <span className="text-red-700">{row.error}</span> : null}
        {row.opened ? <span className="mr-2">Opened</span> : null}
        {row.clicked ? <span className="mr-2">Clicked</span> : null}
      </td>
    </tr>
  );
}

function formatWhen(iso: string): string {
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
