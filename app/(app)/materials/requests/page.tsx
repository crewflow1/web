import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { formatDateUK, formatDayKeyUK } from "@/lib/time/format";
import {
  loadMaterialRequestQueue,
  userLabel,
  jobLabel,
  jobLocation,
  type MaterialRequestListItem,
} from "@/server/services/material-requests";
import {
  MATERIAL_REQUEST_OPEN_STATUSES,
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_STATUS_CLASS,
  MATERIAL_REQUEST_STATUS_LABEL,
  MATERIAL_REQUEST_PRIORITY_CLASS,
  MATERIAL_REQUEST_PRIORITY_LABEL,
  type MaterialRequestPriority,
  type MaterialRequestStatus,
} from "@/lib/material-requests/schema";
import { formatMaterialQty } from "@/lib/material-requests/fulfilment";

/**
 * The office queue — "what has site asked for, and what still needs doing".
 *
 * Defaults to the OPEN set (submitted / approved / part fulfilled) rather than
 * everything: a queue that opens on a year of closed requests is a list, not a
 * queue. Filters are plain links with searchParams — no client state, so the
 * view is shareable and survives a refresh.
 *
 * Every read is ACTIVE-ORG PINNED inside the service (see its header).
 */

export const dynamic = "force-dynamic";

type Search = {
  status?: string;
  job?: string;
  requester?: string;
  overdue?: string;
};

function parseStatuses(raw: string | undefined): readonly MaterialRequestStatus[] | undefined {
  if (!raw || raw === "open") return MATERIAL_REQUEST_OPEN_STATUSES;
  if (raw === "all") return undefined;
  const wanted = raw.split(",").filter((s): s is MaterialRequestStatus =>
    (MATERIAL_REQUEST_STATUSES as readonly string[]).includes(s),
  );
  return wanted.length > 0 ? wanted : MATERIAL_REQUEST_OPEN_STATUSES;
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex min-h-9 items-center rounded-full px-3 text-xs font-medium ${
        active
          ? "bg-slate-900 text-white"
          : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * One request — a card on a phone, a row from `sm` up.
 *
 * `overdue` arrives already computed by the service (one definition, in
 * lib/material-requests/fulfilment) rather than being re-derived here, so the
 * badge and the Overdue filter can never disagree.
 */
function RequestCard({ item }: { item: MaterialRequestListItem }) {
  const { request, fulfilment, overdue, lineCount } = item;
  const status = request.status;
  const priority = (request.priority as MaterialRequestPriority) ?? "normal";
  const who = jobLabel(request.job);
  const where = jobLocation(request.job);

  return (
    <li className="p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link
          href={`/materials/requests/${request.id}`}
          className="font-semibold text-slate-900 hover:underline"
        >
          {request.number}
        </Link>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATERIAL_REQUEST_STATUS_CLASS[status]}`}
        >
          {MATERIAL_REQUEST_STATUS_LABEL[status]}
        </span>
        {priority === "urgent" ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${MATERIAL_REQUEST_PRIORITY_CLASS.urgent}`}
          >
            {MATERIAL_REQUEST_PRIORITY_LABEL.urgent}
          </span>
        ) : null}
        {overdue ? (
          <span className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">
            Past needed-by
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-sm text-slate-700">
        {who ? (
          <Link href={`/jobs/${request.job?.id}`} className="hover:underline">
            {who}
          </Link>
        ) : (
          <span className="text-slate-500">Yard / van stock</span>
        )}
        {where ? <span className="text-slate-400"> · {where}</span> : null}
      </p>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <div>
          <dt className="inline text-slate-500">Asked by </dt>
          <dd className="inline font-medium">{userLabel(request.requester)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Needed </dt>
          <dd className={`inline font-medium ${overdue ? "text-red-700" : ""}`}>
            {request.needed_by ? (
              <time dateTime={request.needed_by}>{formatDateUK(request.needed_by)}</time>
            ) : (
              "No date"
            )}
          </dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Lines </dt>
          <dd className="inline font-medium">{lineCount}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Outstanding </dt>
          <dd className="inline font-medium">
            {fulfilment.stockModulePending ? (
              <span className="text-slate-500">Stock module pending</span>
            ) : (
              `${formatMaterialQty(fulfilment.totalOutstanding)} of ${formatMaterialQty(
                fulfilment.totalRequested,
              )}`
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export default async function MaterialRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const { ctx, user } = await requireOrgContext();

  // The site's calendar day (Europe/London) — one value, so the "overdue"
  // badge and the overdue filter cannot disagree by a timezone.
  const todayIso = formatDayKeyUK(new Date());

  const statusParam = sp.status ?? "open";
  const overdueOnly = sp.overdue === "1";
  const mine = sp.requester === "me";

  const items = await loadMaterialRequestQueue(ctx.org.id, todayIso, {
    statuses: parseStatuses(statusParam),
    jobId: sp.job,
    requesterId: mine ? user.id : undefined,
    overdueOnly,
  });

  const base = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    const merged: Search = { ...sp, ...patch };
    for (const [k, v] of Object.entries(merged)) {
      if (v) next.set(k, String(v));
    }
    const qs = next.toString();
    return qs ? `/materials/requests?${qs}` : "/materials/requests";
  };

  const awaiting = items.filter((i) => i.request.status === "submitted").length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Materials</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            What site has asked for, and where each request has got to.
          </p>
        </div>
        <Link
          href="/materials/requests/new"
          className="min-h-11 rounded-md bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New request
        </Link>
      </div>

      {awaiting > 0 ? (
        <p
          role="status"
          className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900"
        >
          {awaiting === 1
            ? "1 request is waiting for a decision."
            : `${awaiting} requests are waiting for a decision.`}
        </p>
      ) : null}

      <nav aria-label="Filter requests" className="flex flex-wrap gap-2">
        <FilterLink href={base({ status: "open", overdue: undefined })} active={statusParam === "open" && !overdueOnly}>
          Open
        </FilterLink>
        <FilterLink href={base({ status: "submitted" })} active={statusParam === "submitted"}>
          Awaiting approval
        </FilterLink>
        <FilterLink href={base({ status: "approved,partially_fulfilled" })} active={statusParam === "approved,partially_fulfilled"}>
          Being sourced
        </FilterLink>
        <FilterLink href={base({ status: "all" })} active={statusParam === "all"}>
          All
        </FilterLink>
        <FilterLink href={base({ overdue: overdueOnly ? undefined : "1" })} active={overdueOnly}>
          Overdue
        </FilterLink>
        <FilterLink href={base({ requester: mine ? undefined : "me" })} active={mine}>
          Mine
        </FilterLink>
        {sp.job ? (
          <FilterLink href={base({ job: undefined })} active>
            One job ✕
          </FilterLink>
        ) : null}
      </nav>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm text-slate-500">
            {statusParam === "open" && !overdueOnly && !mine && !sp.job
              ? "Nothing outstanding. Requests raised on site land here."
              : "No requests match these filters."}
          </p>
          <Link
            href="/materials/requests/new"
            className="mt-2 inline-block text-sm font-semibold text-slate-900 underline"
          >
            Raise a request
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {items.map((item) => (
            <RequestCard key={item.request.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
