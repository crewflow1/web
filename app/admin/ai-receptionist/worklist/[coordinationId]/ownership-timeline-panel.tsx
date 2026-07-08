import type {
  OwnershipTimelinePanelView,
  OwnershipTimelinePanelHeader,
  OwnershipTimelinePanelEntry,
} from "@/lib/receptionist/conversation-ownership-timeline-panel";

/**
 * The CONVERSATION OWNERSHIP TIMELINE PANEL — the read-only presentation surface (CEO Directive #018, R56: CONVERSATION
 * OWNERSHIP TIMELINE PANEL).
 *
 * The Conversation Detail experience's read-only view of WHO has held this coordinated conversation, and who holds it now.
 * It renders the pure {@link OwnershipTimelinePanelView} the page projected — the present-ownership HEADER (the R48/R53 Read
 * Model's current owner, humanised) plus the append-only chronological EVENT rows (the R51 State Engine's transitions,
 * relabelled by the R55 Timeline Runtime). It is a PRESENTATIONAL server component: it holds no state, offers no button and
 * fires no action, so it is not a client component. It opens no database client, names no ledger, resolves no organisation
 * or operator identity of its own, and DERIVES NO OWNERSHIP — every fact it shows is the view's, which the page read through
 * the R55 Timeline Runtime and nothing else.
 *
 * IT INTRODUCES NO EXECUTION PATH. It reads the projected view and paints pixels — it claims nothing, releases nothing,
 * transfers nothing and records nothing; it dispatches nothing, notifies no one, schedules nothing and completes nothing —
 * every one an explicit R56 non-goal. Where the R47 {@link ClaimPanel} offers the surface's single write affordance, this
 * panel offers none: it is inspection only.
 */
export function OwnershipTimelinePanel({ view }: { view: OwnershipTimelinePanelView }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Ownership timeline</h2>
        <OwnershipStatusBadge header={view.header} />
      </div>

      <p className="mt-2 text-sm text-slate-600">{view.header.summary}</p>

      {view.header.owned ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Current owner</dt>
            <dd className="mt-0.5 truncate text-sm text-slate-900">{view.header.currentOwnerLabel ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Claimed at</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{view.header.claimedAt}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Held since</dt>
            <dd className="mt-0.5 text-sm text-slate-900">{view.header.heldSince}</dd>
          </div>
        </dl>
      ) : null}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Ownership history</h3>
          {view.isEmpty ? null : (
            <span className="text-xs text-slate-500">
              {view.eventCount} event{view.eventCount === 1 ? "" : "s"} · {view.firstEventAt} → {view.lastEventAt}
            </span>
          )}
        </div>

        {view.isEmpty ? (
          <p className="mt-2 text-sm text-slate-500">{view.emptyMessage}</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {view.entries.map((entry) => (
              <TimelineRow key={entry.sequence} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** A pill naming the PRESENT ownership — "Owned" (an operator holds it now) / "Unowned". Presentation only. */
function OwnershipStatusBadge({ header }: { header: OwnershipTimelinePanelHeader }) {
  if (header.tone === "held") {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        {header.statusLabel}
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      {header.statusLabel}
    </span>
  );
}

/**
 * ONE ownership event ROW — a recorded transition, oldest-first in the surrounding list. Shows its kind, the instant it was
 * recorded, its ready headline and the participating operators (prior holder → new holder). Presentation only — every value
 * is the projected entry's; this row re-derives none.
 */
function TimelineRow({ entry }: { entry: OwnershipTimelinePanelEntry }) {
  return (
    <li className="flex gap-3">
      <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-400" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">
          {entry.kindLabel}
          <span className="ml-2 text-xs font-normal text-slate-500">{entry.at}</span>
        </p>
        <p className="text-sm text-slate-600">{entry.headline}</p>
        {entry.fromLabel || entry.toLabel ? (
          <p className="mt-0.5 text-xs text-slate-500">
            {entry.fromLabel ? (
              <>
                From <span className="font-medium text-slate-700">{entry.fromLabel}</span>
              </>
            ) : null}
            {entry.fromLabel && entry.toLabel ? <span aria-hidden> · </span> : null}
            {entry.toLabel ? (
              <>
                To <span className="font-medium text-slate-700">{entry.toLabel}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}
