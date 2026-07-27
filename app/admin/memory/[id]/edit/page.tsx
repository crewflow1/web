import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import {
  listMemorySources,
  listMemoryTypes,
  loadMemoryDetail,
} from "@/server/services/hq-memory";
import { listAiEmployees } from "@/server/services/ai-employees";
import { Banner } from "../../_components";
import { MemoryForm } from "../../_form";
import { updateMemoryAction } from "../../actions";

/**
 * Shared Memory Engine — edit a memory (CEO Directive 002, Phase 2).
 * Saving snapshots a new version + writes an audit entry and timeline
 * event. HQ operator only.
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SP = Promise<{ error?: string }>;

export default async function EditMemoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const [detail, types, sources, employees] = await Promise.all([
    loadMemoryDetail(id),
    listMemoryTypes(true),
    listMemorySources(true),
    listAiEmployees(),
  ]);
  if (!detail) notFound();

  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        <p className="text-sm text-slate-500">
          <Link href="/admin/memory" className="hover:text-slate-300">
            Shared Memory
          </Link>{" "}
          /{" "}
          <Link
            href={`/admin/memory/${detail.memory.id}`}
            className="hover:text-slate-300"
          >
            {detail.memory.title}
          </Link>{" "}
          / <span className="text-slate-300">Edit</span>
        </p>

        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <Pencil className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Edit memory
            </h1>
            <p className="text-xs text-slate-400">
              Currently v{detail.memory.version}. Saving creates v
              {detail.memory.version + 1}.
            </p>
          </div>
        </div>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}

        <MemoryForm
          action={updateMemoryAction}
          types={types}
          sources={sources}
          employees={employees}
          initial={detail}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
