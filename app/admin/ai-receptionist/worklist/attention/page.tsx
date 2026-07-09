import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { getConversationAttentionQueue } from "@/server/services/receptionist-attention-queue";
import {
  projectAttentionQueueSurface,
  type AttentionQueueGroupView,
  type AttentionQueueRowView,
} from "@/lib/receptionist/conversation-attention-queue-view";
import { detailPath } from "../navigation";
import { AttentionQueueRefreshButton } from "./refresh-button";
import { AttentionQueueClaimButton } from "./claim-button";

/**
 * /admin/ai-receptionist/worklist/attention — the CONVERSATION ATTENTION QUEUE (Directive #018, R59: CONVERSATION
 * ATTENTION QUEUE SURFACE).
 *
 * The authorised operator-facing surface built on the R58 Attention Queue runtime: a read-only view of the work that
 * needs attention, GROUPED by ownership — the conversations no operator holds yet ("waiting to be picked up") first, the
 * ones already in hand ("in progress") next — preserving the R38 canonical priority-then-recency order WITHIN each
 * group. Where R44 lists the worklists, R45 inspects one item and R49 lists the viewer's own claims, this surface
 * answers, for the whole org, "of the work that needs attention, what is waiting to be picked up versus already being
 * handled, and in what order?".
 *
 * IT CONSUMES ONLY EXISTING AUTHORITATIVE SEAMS — IT DERIVES NO CONVERSATION STATE. Its ONE data path is the R58 runtime
 * {@link getConversationAttentionQueue}, which itself reads THROUGH the R39 worklist read surface (the R38 engine's
 * derived worklist) and the R48 ownership read model, and composes them in the R58 pure core. This page opens no
 * database client, names no ledger, no engine and no worklist / ownership reader, and reaches around the runtime in no
 * way. Every value it renders is the pure {@link projectAttentionQueueSurface} projection of that runtime's output —
 * humanised, never re-derived. The Worklist Engine stays the sole derivation of worklists, the Ownership Read Model the
 * sole answer to who owns what, and the Attention Queue runtime the sole composition; this surface adds pixels, not a
 * second read path.
 *
 * ORGANISATION ISOLATION IS PRESERVED. Auth is the EXISTING HQ gate (`requireHqPage`); the organisation the read is
 * scoped to is resolved ONLY from the session (`requireOrgContext` → `ctx.org.id`), never from the client. The page
 * takes no parameter that could name another org, and threads that one org id straight into the runtime, which scopes
 * BOTH seam reads to it. So one organisation can never read another's attention queue.
 *
 * IT ADDS ONE AFFORDANCE — THE R60 CLAIM — AND NO OTHER EXECUTION PATH. It renders the grouped queue and, per row, its
 * DERIVED priority, its RECORDED mode + categories, its SURFACED human-required flag and its R48 ownership state; each
 * row links to the existing R45 detail surface, and one Refresh control re-reads the same page. On the UNOWNED rows (the
 * pure view's `canClaim`) it also offers ONE affordance — a Claim button that REUSES the existing R46 Conversation Work
 * Claim capability through the queue claim action; the page itself inlines no write runtime, no write primitive and no
 * claim action — it DELEGATES the claim to the client button, and the R46 runtime stays the final gate on the claim.
 * Beyond that one claim it assigns nobody, reassigns nothing, releases nothing, dispatches nothing, notifies no one,
 * schedules nothing, promotes no customer, retrieves no memory and completes nothing — every one an explicit R60 non-goal.
 */

/** `force-dynamic` so the queue re-reads its authoritative seams on every request (including the Refresh re-read) rather
 *  than serving a cached render — the operator always sees the present ownership state. */
export const dynamic = "force-dynamic";

/**
 * How many of the org's most-recent coordinations the worklist engine reads before deriving (the R37 reader's window),
 * bounding the queue. Passed straight to the runtime; the runtime threads it into the R39 read surface.
 */
const ATTENTION_QUEUE_LIMIT = 200;

export default async function HqReceptionistAttentionQueuePage() {
  // The EXISTING HQ gate authenticates the operator. The org is resolved from the SESSION (never the client), exactly as
  // every worklist surface resolves it — so the runtime read below can only ever be scoped to the caller's organisation.
  await requireHqPage();
  const { ctx } = await requireOrgContext();

  // The ONE data path — the R58 runtime, org-scoped. It reads the org's actionable worklist (through R39) and each
  // entry's ownership (through R48) and composes the grouped view. This surface issues no read of its own.
  const view = await getConversationAttentionQueue({ org_id: ctx.org.id, limit: ATTENTION_QUEUE_LIMIT });

  // Project the runtime's view into the display model — purely, in the R59 core. The page derives nothing.
  const surface = projectAttentionQueueSurface(view);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <Link href="/admin/ai-receptionist/worklist" className="hover:text-slate-900">
          Conversation worklist
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Attention queue</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Attention queue</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            The conversations that need attention, grouped by whether an operator holds them yet — waiting to be picked
            up first, in progress next — in priority order within each group. Each row links to the item&rsquo;s detail,
            and an unowned row can be claimed directly from here — claiming records that you have taken ownership, and
            nothing else is recorded or acted on.
          </p>
        </div>
        <AttentionQueueRefreshButton />
      </header>

      <p className="text-sm text-slate-600">{surface.summaryLabel}</p>

      {surface.isEmpty ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {surface.groups.map((group) => (
            <AttentionQueueGroupSection key={group.group} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The empty verdict — nothing needs attention. A dashed panel, matching the worklist surface's empty state. */
function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
      No conversations need attention right now. When a coordination needs review, recovery or escalation, it will
      appear here — waiting to be picked up, then in progress.
    </div>
  );
}

/** One group section — its title, description and count, then its rows (in canonical order) or a per-group empty note. */
function AttentionQueueGroupSection({ group }: { group: AttentionQueueGroupView }) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{group.title}</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {group.count} {group.count === 1 ? "conversation" : "conversations"}
        </span>
      </div>
      <p className="mt-0.5 text-sm text-slate-500">{group.description}</p>

      {group.rows.length > 0 ? (
        <AttentionQueueTable rows={group.rows} />
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          Nothing here right now.
        </p>
      )}
    </section>
  );
}

/** The rows table for one group — one row per coordination, each linking to the R45 detail surface. */
function AttentionQueueTable({ rows }: { rows: readonly AttentionQueueRowView[] }) {
  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Coordination</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3 hidden md:table-cell">Mode &amp; categories</th>
            <th className="px-4 py-3">Human</th>
            <th className="px-4 py-3">Ownership</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white text-sm">
          {rows.map((row) => (
            <AttentionQueueTableRow key={row.coordinationId} row={row} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A single attention-queue row — every value the pure projection's; the page only styles by the tones it provides. */
function AttentionQueueTableRow({ row }: { row: AttentionQueueRowView }) {
  return (
    <tr className="align-top hover:bg-slate-50">
      <td className="px-4 py-3">
        <Link
          href={detailPath(row.coordinationId)}
          className="font-mono text-xs text-slate-700 hover:text-slate-900 hover:underline"
        >
          {row.coordinationIdShort}
        </Link>
        <div className="mt-1 text-xs text-slate-400">
          {row.conversationIdShort ? (
            <span className="font-mono">conv {row.conversationIdShort}</span>
          ) : (
            <span>no conversation</span>
          )}
        </div>
        <div className="mt-1 text-xs text-slate-400">{row.recordedAt}</div>
      </td>
      <td className="px-4 py-3">
        <PriorityBadge row={row} />
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        <div className="text-sm text-slate-700">{row.modeLabel}</div>
        {row.categoryLabels.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.categoryLabels.map((label) => (
              <span
                key={label}
                className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
              >
                {label}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-1 text-xs text-slate-400">—</div>
        )}
      </td>
      <td className="px-4 py-3">
        <HumanBadge row={row} />
      </td>
      <td className="px-4 py-3">
        <OwnershipBadge row={row} />
        <div className="mt-1 text-xs text-slate-500">{row.ownershipSummary}</div>
        {row.ownershipStatus === "owned" && row.heldSince !== "—" ? (
          <div className="mt-0.5 text-xs text-slate-400">Since {row.heldSince}</div>
        ) : null}
        {/* R60 claim-from-queue — the ONE affordance, shown only on unowned rows (row.canClaim). It delegates the claim
            to the client button, which consumes the existing R46 runtime via the queue action; the page inlines no
            write runtime, no write primitive and no claim action of its own. */}
        {row.canClaim ? <AttentionQueueClaimButton coordinationId={row.coordinationId} /> : null}
      </td>
    </tr>
  );
}

/** The priority pill — styled by the DERIVED priority value the core surfaced (never re-derived here). */
function PriorityBadge({ row }: { row: AttentionQueueRowView }) {
  const cls =
    row.priority === "critical"
      ? "bg-red-100 text-red-800"
      : row.priority === "elevated"
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{row.priorityLabel}</span>
  );
}

/** The human-required pill — styled by the tone the core surfaced. */
function HumanBadge({ row }: { row: AttentionQueueRowView }) {
  const cls =
    row.humanTone === "required" ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-600";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{row.humanLabel}</span>;
}

/** The ownership pill — styled by the tone the core surfaced (held → emerald, unheld → slate). */
function OwnershipBadge({ row }: { row: AttentionQueueRowView }) {
  const cls = row.ownershipTone === "held" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{row.ownershipLabel}</span>;
}
