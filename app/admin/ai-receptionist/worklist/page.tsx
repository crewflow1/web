import Link from "next/link";
import { headers } from "next/headers";
import { requireHqPage } from "@/server/auth/hq";
import { createWorklistViewModel } from "@/server/services/receptionist-worklist-view-model";
import type {
  WorklistViewModel,
  WorklistRow,
  WorklistView,
} from "@/lib/receptionist/conversation-worklist-view-model";
import {
  WORKLIST_VIEW_TABS,
  WORKLIST_PAGE_SIZE,
  parseWorklistViewParam,
  parseOffsetParam,
  nextOffset,
  previousOffset,
  worklistPath,
  detailPath,
} from "./navigation";

/**
 * /admin/ai-receptionist/worklist — the CONVERSATION WORKLIST OPERATOR SURFACE (Directive #018, R44:
 * READ-ONLY WORKLIST OPERATOR SURFACE).
 *
 * The FIRST consumer of the Conversation Worklist spine (R38 engine → R39 read surface → R40 API → R41
 * client → R42 session → R43 view model). It renders the already-authorised worklist state to an operator
 * and does NOTHING else — it is the last read-only layer, made visible.
 *
 * IT CONSUMES ONLY THE R43 VIEW MODEL. Its one data path is {@link createWorklistViewModel}: it opens a view
 * model, forwards the caller's session (the inbound `cookie`) so the API resolves the tenant from that
 * session, awaits one read (`refresh`), and binds the resulting {@link WorklistViewModel}. It does not query
 * a ledger, open a database client, call the read surface, the API or the session/client directly, or reach
 * around the view model in any way. The view model, session, client and API stay authoritative; this surface
 * adds pixels, not a second read path.
 *
 * ORGANISATION ISOLATION IS INHERITED — the surface names no tenant and cannot select one. The view model's
 * options carry no organisation; the surface forwards only the session cookie and lets the API resolve the
 * scope, exactly as every layer below does. What this page shows is precisely what the caller's session is
 * authorised to see.
 *
 * IT IS READ-ONLY. It renders rows, a summary, pagination and the empty / loading / error verdicts the view
 * model derives. It does not assign, claim, dispatch, mutate, notify, schedule, enqueue or retry anything —
 * a row is a label, a page control is a link, and there is no form, action or mutation anywhere on it.
 *
 * Auth is the EXISTING HQ gate (`requireHqPage`); the worklist itself is scoped by the session the API
 * resolves, not by this page.
 */

type SP = Promise<{ view?: string; offset?: string }>;

export default async function HqReceptionistWorklistPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireHqPage();

  const sp = await searchParams;
  const view = parseWorklistViewParam(sp.view);
  const offset = parseOffsetParam(sp.offset);

  // Forward ONLY the caller's session cookie so the API resolves the tenant from the session — the surface
  // names no tenant and cannot select one. The view model (through the session + client) performs the one
  // authorised read; this page issues none of its own.
  const cookie = (await headers()).get("cookie") ?? undefined;
  const worklist = createWorklistViewModel({
    request: { view, page: { limit: WORKLIST_PAGE_SIZE, offset } },
    headers: cookie ? { cookie } : undefined,
  });
  const model = await worklist.refresh();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Conversation worklist</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Conversation worklist</h1>
        <p className="mt-1 text-sm text-slate-600">
          Read-only view of the conversations the receptionist has coordinated for the current session,
          grouped by worklist and ordered by priority. It renders the already-authorised worklist — a row is a
          label, not an action. Nothing here claims, mutates or executes work.
        </p>
      </header>

      <nav aria-label="Worklist" className="flex flex-wrap gap-2 text-xs">
        {WORKLIST_VIEW_TABS.map((tab) => (
          <ViewTab key={tab.view} view={tab.view} label={tab.label} activeView={view} />
        ))}
      </nav>

      <WorklistBody model={model} />

      <WorklistPagination model={model} view={view} />
    </div>
  );
}

/** One worklist tab — a link to a view's first page; the active view is marked, never re-fetched in place. */
function ViewTab({
  view,
  label,
  activeView,
}: {
  view: WorklistView;
  label: string;
  activeView: WorklistView;
}) {
  const isActive = view === activeView;
  return (
    <Link
      href={worklistPath(view, 0)}
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

/**
 * The body — the view model's lifecycle verdicts, rendered in order of precedence: an initial-load
 * placeholder, then the error banner (kept above a retained stale page), then the empty verdict, else the
 * rows. Every message shown is the view model's own; the surface writes none of it.
 */
function WorklistBody({ model }: { model: WorklistViewModel }) {
  if (model.loading.isInitialLoad) {
    return <StatePanel>{model.loading.message}</StatePanel>;
  }

  return (
    <div className="space-y-3">
      {model.loading.isLoading ? (
        <p className="text-xs text-slate-600">{model.loading.message}</p>
      ) : null}

      {model.error.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {model.error.message}
        </div>
      ) : null}

      <SummaryLine model={model} />

      {model.empty.isEmpty ? (
        <StatePanel>{model.empty.message}</StatePanel>
      ) : model.rows.length > 0 ? (
        <WorklistTable rows={model.rows} />
      ) : null}
    </div>
  );
}

/** The count / range header — the view model's ready-to-render label, plus a flag when a filter narrows it. */
function SummaryLine({ model }: { model: WorklistViewModel }) {
  return (
    <p className="text-sm text-slate-600">
      {model.summary.label}
      {model.summary.filtered ? <span className="ml-1 text-slate-600">(filtered)</span> : null}
    </p>
  );
}

/** The dashed panel used for the empty and initial-loading messages. */
function StatePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
      {children}
    </div>
  );
}

/** The rows table — one row per worklist entry, each a display projection the view model already computed. */
function WorklistTable({ rows }: { rows: readonly WorklistRow[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Conversation</th>
            <th className="px-4 py-3 hidden md:table-cell">Categories</th>
            <th className="px-4 py-3">Mode</th>
            <th className="px-4 py-3">Human</th>
            <th className="px-4 py-3 hidden lg:table-cell">Recorded</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white text-sm">
          {rows.map((row) => (
            <WorklistTableRow key={row.coordinationId} row={row} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A single worklist row — priority, conversation reference, categories, mode, the requires-human flag. */
function WorklistTableRow({ row }: { row: WorklistRow }) {
  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${priorityStyle(
            row.priority,
          )}`}
        >
          {row.priorityLabel}
        </span>
      </td>
      <td className="px-4 py-3">
        {row.conversationId ? (
          <span className="font-mono text-xs text-slate-700">{row.conversationId}</span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
        <Link
          href={detailPath(row.coordinationId)}
          className="font-mono text-[11px] text-slate-500 hover:text-slate-900 hover:underline"
        >
          {row.coordinationId}
        </Link>
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        {row.categoryLabels.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {row.categoryLabels.map((label, index) => (
              <span
                key={`${row.coordinationId}-${index}`}
                className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"
              >
                {label}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-slate-700">{row.modeLabel}</td>
      <td className="px-4 py-3">
        {row.requiresHuman ? (
          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Required
          </span>
        ) : (
          <span className="text-xs text-slate-500">No</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-slate-500 hidden lg:table-cell">{row.at.slice(0, 10)}</td>
    </tr>
  );
}

/** Map a coded priority to a badge style — presentation only; the value is the view model's. */
function priorityStyle(priority: WorklistRow["priority"]): string {
  switch (priority) {
    case "critical":
      return "bg-red-100 text-red-800";
    case "elevated":
      return "bg-amber-100 text-amber-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

/**
 * The page controls — previous / next links whose offsets are the view model's own window stepped by one
 * page. Both affordances come straight from the view model's pagination verdict; the surface computes no
 * "has more" of its own. Rendered only when at least one direction is available.
 */
function WorklistPagination({ model, view }: { model: WorklistViewModel; view: WorklistView }) {
  const { pagination } = model;
  if (!pagination.hasNext && !pagination.hasPrevious) return null;

  const pageSize = pagination.pageSize ?? WORKLIST_PAGE_SIZE;
  const previous = previousOffset(pagination.offset, pageSize);
  const next = nextOffset(pagination.offset, pageSize);
  const inactive = "rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-300";
  const active =
    "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50";

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{model.summary.label}</span>
      <span className="flex gap-2">
        {pagination.hasPrevious ? (
          <Link href={worklistPath(view, previous)} className={active}>
            ← Previous
          </Link>
        ) : (
          <span className={inactive}>← Previous</span>
        )}
        {pagination.hasNext ? (
          <Link href={worklistPath(view, next)} className={active}>
            Next →
          </Link>
        ) : (
          <span className={inactive}>Next →</span>
        )}
      </span>
    </nav>
  );
}
