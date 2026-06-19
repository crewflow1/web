import Link from "next/link";
import { Plus } from "lucide-react";
import {
  listMemorySources,
  listMemoryTypes,
} from "@/server/services/hq-memory";
import { listAiEmployees } from "@/server/services/ai-employees";
import { Banner } from "../_components";
import { MemoryForm } from "../_form";
import { createMemoryAction } from "../actions";

/**
 * Shared Memory Engine — create a memory (CEO Directive 002, Phase 2).
 * HQ operator only (the /admin layout gates it; the action re-checks).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ error?: string }>;

export default async function NewMemoryPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const [types, sources, employees] = await Promise.all([
    listMemoryTypes(true),
    listMemorySources(true),
    listAiEmployees(),
  ]);
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        <p className="text-sm text-slate-500">
          <Link href="/admin/memory" className="transition-colors hover:text-slate-300">
            Shared Memory
          </Link>{" "}
          / <span className="text-slate-300">New memory</span>
        </p>

        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <Plus className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              New memory
            </h1>
            <p className="text-xs text-slate-400">
              Capture a piece of company knowledge. It becomes searchable and
              permission-aware immediately.
            </p>
          </div>
        </div>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}

        <MemoryForm
          action={createMemoryAction}
          types={types}
          sources={sources}
          employees={employees}
          submitLabel="Create memory"
        />
      </div>
    </div>
  );
}
