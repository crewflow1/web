import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  getWorkflowRule,
  listWorkflowVersions,
} from "@/server/services/automation-workflows";
import { restoreWorkflowVersionAction } from "../actions";
import { WorkflowCanvas } from "../WorkflowCanvas";

/**
 * Settings → Automations → Visual workflow builder (20261193).
 *
 * Admin-gated node-graph editor for per-org custom rules. The role check here
 * drives the UX; the automation_custom_rules / automation_workflow_versions
 * admin-write RLS policies are the real boundary, and every read/write is
 * org-pinned. The canvas compiles the graph to the SAME CustomRuleDefinition the
 * dispatcher already runs — no second engine.
 *
 * Route depth is 3 (/settings/automations/workflow), under the deep-swap ≥4 trap,
 * so the server actions' plain redirect() is safe.
 */

export const dynamic = "force-dynamic";

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function WorkflowBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; saved?: string; error?: string; vpage?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const sp = await searchParams;
  const vpage = Number.isFinite(Number(sp.vpage)) ? Math.max(0, Number(sp.vpage)) : 0;

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <Crumbs />
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Only owners and admins can build automation workflows.
        </div>
      </div>
    );
  }

  const supabase = await createClient();
  const client = supabase as unknown as never;

  const editRule = sp.edit
    ? await getWorkflowRule(client, ctx.org.id, sp.edit).catch(() => null)
    : null;
  const versions =
    editRule !== null
      ? await listWorkflowVersions(client, ctx.org.id, editRule.id, vpage).catch(
          () => ({ items: [], page: 0, hasMore: false }),
        )
      : { items: [], page: 0, hasMore: false };

  return (
    <div className="space-y-6">
      <Crumbs />

      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">
          {editRule ? `Edit workflow: ${editRule.name}` : "New visual workflow"}
        </h1>
        <p className="text-sm text-slate-600">
          Drag steps onto the canvas and connect them into a flow: a trigger, then
          conditions, actions, communications, and an optional approval. It compiles
          to a rule that runs on CrewFlow&apos;s existing automation engine.
        </p>
      </header>

      {sp.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {sp.error === "forbidden"
            ? "Only owners and admins can change automations."
            : sp.error === "workflow_validation"
              ? "That workflow couldn't be read. Check the steps and connections."
              : "That workflow couldn't be saved. Fix the validation errors and try again."}
        </div>
      ) : null}
      {sp.saved ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {sp.saved === "workflow_draft"
            ? "Saved as a draft (contains a dark step, so it stays disabled)."
            : sp.saved === "workflow_restored"
              ? "Version restored."
              : "Workflow saved."}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <WorkflowCanvas
          ruleId={editRule?.id}
          initialName={editRule?.name}
          initialDescription={editRule?.description ?? null}
          initialGraph={editRule?.graph ?? null}
          mobileInitial={
            editRule
              ? {
                  id: editRule.id,
                  name: editRule.name,
                  description: editRule.description,
                  definition: editRule.definition,
                }
              : undefined
          }
        />
      </section>

      {/* Version history */}
      {editRule ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Version history</h2>
          <p className="mt-1 text-sm text-slate-600">
            Every save records a version. Restore one to bring its graph back (that
            itself records a new version — history is never rewritten).
          </p>
          {versions.items.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No versions yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">Saved</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Note</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {versions.items.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-slate-900">v{v.version}</td>
                      <td className="px-3 py-2 text-xs text-slate-700">
                        {fmt(v.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            v.is_draft
                              ? "border-amber-200 bg-amber-100 text-amber-800"
                              : "border-slate-200 bg-slate-100 text-slate-600"
                          }`}
                        >
                          {v.is_draft ? "Draft" : "Live-capable"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-500">
                        {v.note ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <form action={restoreWorkflowVersionAction}>
                          <input type="hidden" name="rule_id" value={editRule.id} />
                          <input type="hidden" name="version_id" value={v.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Restore
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {versions.page > 0 || versions.hasMore ? (
            <div className="mt-3 flex items-center gap-3 text-xs">
              {versions.page > 0 ? (
                <Link
                  href={`/settings/automations/workflow?edit=${editRule.id}&vpage=${versions.page - 1}`}
                  className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  ← Newer
                </Link>
              ) : null}
              {versions.hasMore ? (
                <Link
                  href={`/settings/automations/workflow?edit=${editRule.id}&vpage=${versions.page + 1}`}
                  className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
                >
                  Older →
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function Crumbs() {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Link href="/settings" className="hover:underline">
        Settings
      </Link>
      <span>/</span>
      <Link href="/settings/automations" className="hover:underline">
        Automations
      </Link>
      <span>/</span>
      <span className="text-slate-700">Workflow builder</span>
    </div>
  );
}
