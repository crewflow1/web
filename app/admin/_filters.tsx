"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input, Select } from "@/components/ui";

/**
 * URL-bound search + status filter for the admin panel.
 *
 * Updates `?q=...&status=...&sort=...` on submit. The server component
 * re-reads the search params, refetches the rows, and renders. No
 * useState — the URL is the source of truth so a refresh / share-link
 * preserves the filter state.
 */

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending_demo", label: "Pending demo" },
  { value: "demo_booked", label: "Demo booked" },
  { value: "approved", label: "Approved (awaiting signup)" },
  { value: "pending", label: "Pending (signed up)" },
  { value: "trial", label: "Trial" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { value: "pending_first", label: "Pending first (default)" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function AdminFilters({
  defaultQuery,
  defaultStatus,
  defaultSort,
}: {
  defaultQuery: string;
  defaultStatus: string;
  defaultSort: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    startTransition(() => {
      router.replace(`/admin/organizations?${params.toString()}`);
    });
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-[1fr_180px_220px]">
      <label className="block text-xs font-medium text-slate-400">
        Search
        <Input
          type="search"
          name="q"
          defaultValue={defaultQuery}
          placeholder="Company, owner, email…"
          onChange={(e) => setParam("q", e.target.value)}
          className="mt-1"
        />
      </label>
      <label className="block text-xs font-medium text-slate-400">
        Status
        <Select
          name="status"
          defaultValue={defaultStatus}
          onChange={(e) => setParam("status", e.target.value)}
          className="mt-1"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="block text-xs font-medium text-slate-400">
        Sort
        <Select
          name="sort"
          defaultValue={defaultSort}
          onChange={(e) => setParam("sort", e.target.value)}
          className="mt-1"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>
      {pending ? (
        <p className="text-[11px] text-slate-500 sm:col-span-3">Filtering…</p>
      ) : null}
    </div>
  );
}
