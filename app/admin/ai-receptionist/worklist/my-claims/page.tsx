import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import {
  getOwnershipHistory,
  getOwnershipSummary,
} from "@/server/services/receptionist-ownership-read-model";
import { projectMyClaims, type MyClaimRow, type MyClaimsView } from "@/lib/receptionist/my-claims-view";
import { detailPath } from "../navigation";

/**
 * /admin/ai-receptionist/worklist/my-claims — the MY CLAIMS LIST (Directive #018, R49: MY CLAIMS LIST).
 *
 * The FIRST operator-facing surface built on the R48 Conversation Work Ownership Read Model: a read-only list of the
 * conversation worklist items the signed-in operator has claimed and now owns. Where R44 lists the worklists and R45
 * inspects one item (and offers the single claim affordance), this surface answers "what have I claimed?".
 *
 * IT CONSUMES ONLY THE R48 OWNERSHIP READ MODEL. Its two data paths are the read model's org-scoped seams —
 * {@link getOwnershipHistory} for the org's ownership events and {@link getOwnershipSummary} for the org's tallies —
 * projected through the pure {@link projectMyClaims}, which FILTERS them to the current operator. It opens no database
 * client, names no claim ledger and no write primitive, does not query the R47 claim reader or the R37 coordination
 * reader, and reaches around the read model in no way. Ownership derivation stays R48's; the R46 runtime stays the sole
 * authority over recording a claim; this surface adds pixels, not a second read path.
 *
 * ORGANISATION ISOLATION IS PRESERVED. Auth is the EXISTING HQ gate (`requireHqPage`); the organisation the reads are
 * scoped to is resolved ONLY from the session (`requireOrgContext` → `ctx.org.id`), never from the client. The VIEWER
 * whose claims are shown is the authenticated operator the HQ gate resolved (`user.id`), never a client-supplied value —
 * the surface takes no parameter that could name another operator or another org. So the read model's mandatory `org_id`
 * filter is the security boundary; the current-operator filter is a view-level "show me mine" narrowing on top of it.
 *
 * IT IS READ-ONLY. It renders the operator's own claims and a summary of them; each row links to the existing R45
 * detail surface. It does not claim, re-claim, hand off, dispatch, notify or act on anything — a row is a label, and
 * there is no form, action or mutation anywhere on it. It introduces no execution path.
 */

/**
 * How many of the org's most-recent ownership events to fetch for the row list. The read model's history seam is capped
 * (an accurate LIST is bounded); the viewer's authoritative claim COUNT comes from the uncapped summary tally, so the
 * headline count is correct even when the row list is bounded by this window.
 */
const MY_CLAIMS_ROW_LIMIT = 200;

export default async function HqReceptionistMyClaimsPage() {
  // The EXISTING HQ gate authenticates the operator; `user.id` is the VIEWER whose claims this surface lists. The org is
  // resolved from the SESSION (never the client), exactly as every worklist surface resolves it — so the reads below can
  // only ever be scoped to the caller's organisation.
  const user = await requireHqPage();
  const { ctx } = await requireOrgContext();

  // The two READ-ONLY R48 seams — the org's ownership events (for the rows) and the org's summary (for the viewer's
  // authoritative tally). Both are org-scoped by the read model; the surface issues no read of its own.
  const [events, summary] = await Promise.all([
    getOwnershipHistory({ org_id: ctx.org.id, limit: MY_CLAIMS_ROW_LIMIT }),
    getOwnershipSummary({ org_id: ctx.org.id }),
  ]);

  // Project the read model's output for THIS viewer — filtered to the operator, newest first, with their own tally.
  const view = projectMyClaims({
    operatorId: user.id,
    operatorEmail: user.email ?? null,
    events,
    summary,
  });

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
        <span className="text-slate-900">My claims</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">My claims</h1>
        <p className="mt-1 text-sm text-slate-600">
          The conversation worklist items you have claimed and now own, newest first. This surface is read-only — each
          row links to the item&rsquo;s detail; it records nothing and acts on nothing.
        </p>
      </header>

      <SummaryLine view={view} />

      {view.rows.length > 0 ? <MyClaimsTable rows={view.rows} /> : <EmptyState />}
    </div>
  );
}

/** The headline tally — how many items the viewer owns, and when they most recently took one. From the R48 summary. */
function SummaryLine({ view }: { view: MyClaimsView }) {
  const noun = view.claimCount === 1 ? "item" : "items";
  return (
    <p className="text-sm text-slate-600">
      You own <span className="font-semibold text-slate-900">{view.claimCount}</span> conversation {noun}.
      {view.latestClaimAt ? (
        <span className="ml-1 text-slate-600">Most recent claim {view.latestClaimAt.slice(0, 10)}.</span>
      ) : null}
    </p>
  );
}

/** The empty verdict — the viewer holds no claims. A dashed panel, matching the worklist surface's empty state. */
function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
      You do not own any conversation worklist items yet. Open an item from the{" "}
      <Link href="/admin/ai-receptionist/worklist" className="font-medium text-slate-900 hover:underline">
        Conversation worklist
      </Link>{" "}
      and claim it to see it here.
    </div>
  );
}

/** The claims table — one row per item the viewer owns, each linking to the R45 detail surface. */
function MyClaimsTable({ rows }: { rows: readonly MyClaimRow[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Coordination</th>
            <th className="px-4 py-3 hidden md:table-cell">Conversation</th>
            <th className="px-4 py-3">Claimed</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white text-sm">
          {rows.map((row) => (
            <MyClaimsTableRow key={row.coordinationId} row={row} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A single My Claims row — the coordination reference (linked to detail), the conversation, the claim timestamp, the
 *  ownership status. Presentation only; every value is the projection's. */
function MyClaimsTableRow({ row }: { row: MyClaimRow }) {
  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-4 py-3">
        <Link
          href={detailPath(row.coordinationId)}
          className="font-mono text-xs text-slate-700 hover:text-slate-900 hover:underline"
        >
          {row.coordinationId.slice(0, 8)}
        </Link>
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        {row.conversationId ? (
          <span className="font-mono text-xs text-slate-600">{row.conversationId.slice(0, 8)}</span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-slate-500">
        {row.claimedAt.slice(0, 10)}
        <span className="ml-1 text-slate-500">{row.claimedAt.slice(11, 16)}</span>
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
          Owned
        </span>
      </td>
    </tr>
  );
}
