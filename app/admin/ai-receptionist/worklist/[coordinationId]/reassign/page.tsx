import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { getCoordinationById } from "@/server/services/receptionist-coordination-view";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import { listOrgOperators } from "@/server/services/receptionist-operators";
import { projectReassignmentView } from "@/lib/receptionist/conversation-reassignment-view";
import { ReassignPanel } from "./reassign-panel";

/**
 * /admin/ai-receptionist/worklist/[coordinationId]/reassign — the CONVERSATION WORK REASSIGNMENT SURFACE
 * (Directive #018, R54: CONVERSATION WORK REASSIGNMENT SURFACE).
 *
 * The single authorised operator-facing UI for TRANSFERRING ownership of a Conversation Worklist item from the operator
 * who holds it to another authorised operator. Where R47's detail surface offers the CLAIM, this surface offers the
 * REASSIGNMENT — and only that. It shows the current owner, lets the operator pick another authorised operator of the
 * SAME organisation, and (through the panel's confirm step + server action) records the transfer through the R52 runtime.
 *
 * IT CONSUMES ONLY THE AUTHORISED READ SEAMS, AND WRITES ONLY THROUGH THE RUNTIME. Its READ paths are three org-scoped
 * seams — the R37 Coordination Read Model's single-item seam {@link getCoordinationById} (for existence + isolation),
 * the R48/R51/R53 Ownership Read Model's {@link getOwnership} (for the CURRENT owner, folded from the transfer chain)
 * and the R54 operator roster {@link listOrgOperators} (for the destination candidates) — and its ONE WRITE path is the
 * R52 runtime, reached ONLY through the {@link ReassignPanel}'s `reassignWorkItemAction` server action. It opens no
 * database client, names no ledger and no write primitive, and reaches around no layer. The Reassignment Runtime, the
 * Ownership State Engine and the Ownership Read Model all stay authoritative; this surface adds pixels and a SINGLE
 * transfer affordance — not a second read path, not a second write path, and not a decision.
 *
 * ORGANISATION ISOLATION IS PRESERVED. Auth is the EXISTING HQ gate (`requireHqPage`); the organisation every read is
 * scoped to is resolved ONLY from the session (`requireOrgContext` → `ctx.org.id`), never from the URL. The coordination
 * id comes from the path, but the read is org-scoped, so a coordination belonging to ANOTHER organisation resolves to
 * null and renders a 404 — a caller can only ever reassign a coordination that belongs to their session's organisation.
 * The destination roster is likewise org-scoped, so the item can only ever be handed to an authorised operator of the
 * same organisation. The action re-resolves the org the same way, and the R52 runtime's writer refuses any coordination
 * not held in that org — so a transfer can never cross a tenant boundary either.
 *
 * IT OFFERS EXACTLY ONE OPERATOR ACTION — TRANSFER OWNERSHIP — AND NOTHING ELSE. It does NOT claim, release, dispatch,
 * notify, schedule, fulfil, promote or execute any work, and it performs no automatic selection of a destination — every
 * one an explicit R54 non-goal. The transfer it records lands in R52's append-only reassignment ledger through the
 * runtime; this surface introduces no second write path and no execution path.
 */

type Params = Promise<{ coordinationId: string }>;

export default async function HqReceptionistWorklistReassignPage({
  params,
}: {
  params: Params;
}) {
  // The EXISTING HQ gate authenticates the operator; the org is resolved from the SESSION (never the URL). The gate's
  // user is the VIEWER whose relationship to the owner the view is projected for (drives "You hold this item").
  const user = await requireHqPage();
  const { ctx } = await requireOrgContext();
  const { coordinationId } = await params;

  // Coordination existence + organisation isolation — the R37 org-scoped single-item seam. A coordination that does not
  // belong to this organisation resolves to null and 404s: isolation, structurally.
  const record = await getCoordinationById({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
  });
  if (!record) notFound();

  // The current owner — the R48 ownership read model (folded from the R51/R53 engine's transfer chain), org-scoped. The
  // destination roster — the org's authorised operators, org-scoped. Both feed the pure projection below.
  const ownership = await getOwnership({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
  });
  const operators = await listOrgOperators({ org_id: ctx.org.id });

  const view = projectReassignmentView({
    coordinationId,
    ownership,
    operators,
    viewerOperatorId: user.id,
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
        <Link
          href={`/admin/ai-receptionist/worklist/${coordinationId}`}
          className="font-mono hover:text-slate-900"
        >
          {coordinationId.slice(0, 8)}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Reassign</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Reassign ownership</h1>
        <p className="mt-1 text-sm text-slate-600">
          Transfer ownership of this coordinated conversation to another authorised operator. It records the transfer
          only — no other action follows.
        </p>
      </header>

      <ReassignPanel view={view} />

      <div className="text-sm">
        <Link
          href={`/admin/ai-receptionist/worklist/${coordinationId}`}
          className="text-slate-500 hover:text-slate-900"
        >
          ← Back to the work item
        </Link>
      </div>
    </div>
  );
}
