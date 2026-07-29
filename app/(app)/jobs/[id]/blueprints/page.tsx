import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { StateForm } from "@/components/forms/StateForm";
import {
  listBlueprints, listBlueprintVersionsForBlueprints,
  type BlueprintRow, type BlueprintVersionRow,
} from "@/server/services/blueprints";
import {
  DISCIPLINE_LABELS, BLUEPRINT_STATUS_LABELS, BLUEPRINT_STATUS_STYLES, BLUEPRINT_STATUSES,
  type Discipline, type BlueprintStatus,
} from "@/lib/blueprints/schema";
import { AddDrawingForm, AddRevisionForm } from "./_client";
import { ViewerLauncher } from "./_viewer-launcher";
import { CompareLauncher } from "./_compare-launcher";
import { OfflineControls } from "./_offline-controls";
import { setBlueprintStatus, removeBlueprint } from "./actions";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default async function JobBlueprintsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;

  const { ctx, user } = await requireOrgContext();
  const identity = { userId: user.id, orgId: ctx.org.id };
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();
  const job = await loadJobForOrg(supabase, id, ctx.org.id, "id");
  if (!job) notFound();

  const blueprints = await listBlueprints(id);
  const versionsByBp = await listBlueprintVersionsForBlueprints(blueprints.map((b) => b.id));
  const currentOf = (b: BlueprintRow): (BlueprintVersionRow & { mime_type: string }) | null =>
    (versionsByBp[b.id] ?? []).find((v) => v.version === b.current_version) ?? (versionsByBp[b.id] ?? [])[0] ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href={`/jobs/${id}`} className="hover:text-slate-900">Job</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Drawings</span>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{decodeURIComponent(error)}</div>
      ) : null}
      {saved ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saved === "created" ? "Drawing added." : saved === "revision" ? "Revision uploaded." : saved === "status" ? "Status updated." : saved === "deleted" ? "Drawing deleted." : "Saved."}
        </div>
      ) : null}

      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Drawings</h1>
          <p className="mt-0.5 text-sm text-slate-500">The current issue of every drawing, with its full revision history — so the site team always builds off the right one.</p>
        </div>
        <AddDrawingForm jobId={id} />
      </header>

      {blueprints.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-3xl">📐</p>
          <p className="mt-2 text-sm font-medium text-slate-900">No drawings yet</p>
          <p className="mt-1 text-sm text-slate-500">Upload the current issue so the site team always builds off the right revision.</p>
        </section>
      ) : (
        <ul className="space-y-4">
          {blueprints.map((b) => {
            const current = currentOf(b);
            const history = versionsByBp[b.id] ?? [];
            const status = b.status as BlueprintStatus;
            const label = `${b.drawing_number} ${b.title}${current ? ` — ${current.revision}` : ""}`;
            return (
              <li key={b.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900">{b.drawing_number}</span>
                      <span className="text-sm text-slate-700">{b.title}</span>
                      {b.discipline ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{DISCIPLINE_LABELS[b.discipline as Discipline] ?? b.discipline}</span>
                      ) : null}
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${BLUEPRINT_STATUS_STYLES[status] ?? ""}`}>{BLUEPRINT_STATUS_LABELS[status] ?? status}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      Current: <strong>{current?.revision ?? "—"}</strong>
                      {current?.revision_date ? ` · issued ${current.revision_date}` : ""}
                      {current ? ` · ${fmtSize(current.size_bytes)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {current ? (
                      <ViewerLauncher
                        jobId={id}
                        versionId={current.id}
                        mime={current.mime_type}
                        label={label}
                        drawingNumber={b.drawing_number}
                        revision={current.revision}
                        supersededNotice={status === "superseded" ? "This drawing is marked superseded." : null}
                        canDeletePins={isAdmin}
                        identity={identity}
                      />
                    ) : null}
                    {current ? (
                      <OfflineControls
                        identity={identity}
                        drawing={{
                          jobId: id, blueprintId: b.id,
                          currentVersionId: current.id, currentVersion: current.version, currentRevision: current.revision,
                          drawingName: `${b.drawing_number} ${b.title}`, fileName: current.file_name, mimeType: current.mime_type,
                        }}
                      />
                    ) : null}
                    <CompareLauncher
                      jobId={id}
                      blueprintId={b.id}
                      drawingNumber={b.drawing_number}
                      title={b.title}
                      isAdmin={isAdmin}
                      versions={history.map((v) => ({ id: v.id, version: v.version, revision: v.revision, revision_date: v.revision_date, uploaded_at: v.uploaded_at, mime_type: v.mime_type }))}
                    />
                    <AddRevisionForm jobId={id} blueprintId={b.id} />
                  </div>
                </div>

                {history.length > 0 ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Revision history ({history.length})</summary>
                    <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
                      {history.map((v) => (
                        <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="text-slate-700">
                            <strong>{v.revision}</strong>
                            {v.version === b.current_version ? <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">current</span> : null}
                            {v.revision_date ? <span className="text-slate-400"> · {v.revision_date}</span> : null}
                            {v.notes ? <span className="text-slate-400"> · {v.notes}</span> : null}
                          </span>
                          <a href={`/jobs/${id}/blueprints/f/${v.id}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${b.drawing_number} ${v.revision} in a new tab`} className="text-xs font-medium text-slate-600 hover:text-slate-900">
                            Open · {fmtSize(v.size_bytes)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {isAdmin ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    <StateForm action={setBlueprintStatus.bind(null, id, b.id)}>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-500" htmlFor={`status-${b.id}`}>Status</label>
                        <select id={`status-${b.id}`} name="status" defaultValue={status} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                          {BLUEPRINT_STATUSES.map((s) => <option key={s} value={s}>{BLUEPRINT_STATUS_LABELS[s]}</option>)}
                        </select>
                        <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">Set</button>
                      </div>
                    </StateForm>
                    <StateForm action={removeBlueprint.bind(null, id, b.id)} confirm={`Delete drawing ${b.drawing_number} and all its revisions? This can't be undone.`}>
                      <button type="submit" className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Delete</button>
                    </StateForm>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
