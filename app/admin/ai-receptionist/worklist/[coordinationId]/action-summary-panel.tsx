import type {
  ConversationActionSummaryView,
  ConversationActionSummaryHumanRequired,
  ConversationActionSummaryOwnership,
} from "@/lib/receptionist/conversation-action-summary-panel";

/**
 * The CONVERSATION ACTION SUMMARY PANEL — the read-only presentation surface (CEO Directive #018, R57: CONVERSATION ACTION
 * SUMMARY PANEL).
 *
 * The Conversation Detail experience's at-a-glance digest of WHERE this coordinated conversation stands right now. It renders
 * the pure {@link ConversationActionSummaryView} the page projected — the current lifecycle, the current resolution, the
 * current coordination mode, the human-required status, the current owner and the ownership-history summary — each humanised
 * by the R57 core from the two authoritative views (the R37 Coordination Read Model's record + the R55 Ownership Timeline
 * view). It is a PRESENTATIONAL server component: it holds no state, offers no button and fires no action, so it is not a
 * client component. It opens no database client, names no ledger, resolves no organisation or operator identity of its own,
 * and DERIVES NO CONVERSATION STATE — every fact it shows is the view's, which the page read through the authorised seams and
 * nothing else.
 *
 * IT INTRODUCES NO EXECUTION PATH. It reads the projected view and paints pixels — it claims nothing, releases nothing,
 * transfers nothing and records nothing; it dispatches nothing, notifies no one, schedules nothing and completes nothing —
 * every one an explicit R57 non-goal. Where the R47 {@link ClaimPanel} offers the surface's single write affordance, this
 * panel offers none: it is inspection only.
 */
export function ConversationActionSummaryPanel({ view }: { view: ConversationActionSummaryView }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Conversation summary</h2>
        <HumanRequiredBadge humanRequired={view.humanRequired} />
      </div>

      <p className="mt-2 text-sm text-slate-600">
        Where this coordinated conversation stands right now — a read-only digest of its recorded state.
      </p>

      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <SummaryFact label={view.lifecycle.label} value={view.lifecycle.stateLabel} summary={view.lifecycle.summary} />
        <SummaryFact
          label={view.resolution.label}
          value={view.resolution.stateLabel}
          summary={view.resolution.summary}
        />
        <SummaryFact
          label={view.coordination.label}
          value={view.coordination.modeLabel}
          summary={view.coordination.summary}
        />
        <SummaryFact
          label={view.humanRequired.label}
          value={view.humanRequired.statusLabel}
          summary={view.humanRequired.summary}
        />
        <SummaryFact label={view.ownership.label} value={view.ownership.statusLabel} summary={view.ownership.summary} />
      </dl>

      <OwnershipSummaryRow ownership={view.ownership} />
    </section>
  );
}

/** A pill naming the HUMAN-REQUIRED status — amber "Human required" (a human must act) / emerald "Autonomous". Presentation only. */
function HumanRequiredBadge({ humanRequired }: { humanRequired: ConversationActionSummaryHumanRequired }) {
  if (humanRequired.tone === "required") {
    return (
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        Human required
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
      Autonomous
    </span>
  );
}

/**
 * ONE at-a-glance FACT — its label, its humanised value, and the ready human sentence beneath. Presentation only — every
 * value is the projected view's; this fact re-derives none.
 */
function SummaryFact({ label, value, summary }: { label: string; value: string; summary: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900">{value}</dd>
      <p className="mt-0.5 text-xs text-slate-500">{summary}</p>
    </div>
  );
}

/**
 * The OWNERSHIP detail row — the current owner (or the reason no one holds it) and the ownership-history summary. Every value
 * is the projected view's (copied from the R55 Ownership Timeline view); this row re-derives no ownership.
 */
function OwnershipSummaryRow({ ownership }: { ownership: ConversationActionSummaryOwnership }) {
  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Current owner</dt>
          <dd className="mt-0.5 truncate text-sm text-slate-900">{ownership.currentOwnerLabel ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Ownership history</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{ownership.historySummary}</dd>
        </div>
      </dl>
    </div>
  );
}
