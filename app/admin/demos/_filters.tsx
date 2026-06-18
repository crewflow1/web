"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DEMO_LIFECYCLE_STATUSES,
  DEMO_STATUS_LABELS,
  type DemoLifecycleStatus,
} from "@/lib/hq/demo-lifecycle";
import { Input, Select } from "@/components/ui";

/**
 * Toolbar above the kanban — search, status filter, sort.
 *
 * All state lives in the URL so a refresh or shared link preserves the
 * view. Debounced for the search input so we don't push history on
 * every keystroke.
 */
export function DemosFilters({ initialCount }: { initialCount: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [q, setQ] = useState(params.get("q") ?? "");
  const status = (params.get("status") ?? "") as DemoLifecycleStatus | "";
  const sort = params.get("sort") ?? "newest";

  // Debounced URL push for the search box (250ms).
  useEffect(() => {
    const cur = params.get("q") ?? "";
    if (cur === q) return;
    const t = setTimeout(() => {
      startTransition(() => {
        const next = new URLSearchParams(params);
        if (q.trim()) next.set("q", q.trim());
        else next.delete("q");
        router.replace(`/admin/demos?${next.toString()}`);
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => {
      router.replace(`/admin/demos?${next.toString()}`);
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <label className="flex-1 min-w-[200px] text-[11px] font-medium text-slate-400">
        Search
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Company, name, email…"
          className="mt-1"
        />
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Status
        <Select
          value={status}
          onChange={(e) => setParam("status", e.target.value || null)}
          className="mt-1"
        >
          <option value="">All statuses</option>
          {DEMO_LIFECYCLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DEMO_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-[11px] font-medium text-slate-400">
        Sort
        <Select
          value={sort}
          onChange={(e) => setParam("sort", e.target.value)}
          className="mt-1"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="company">Company A→Z</option>
        </Select>
      </label>
      <div className="text-[11px] text-slate-500">
        {pending ? "Filtering…" : `${initialCount} demos`}
      </div>
    </div>
  );
}
