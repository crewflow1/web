"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addChecklistItem,
  setChecklistItemDone,
  deleteChecklistItem,
} from "./checklist-actions";

/**
 * Interactive job checklist. Optimistic toggles/adds/removes call the server
 * actions inside a transition, then router.refresh() to reconcile — no
 * redirect()/router.push, so the Next 15.5 deep-swap commit race never applies
 * (the calendar uses the same refresh-after-mutation pattern). Completion
 * provenance is stamped server-side by a trigger; the client only sends is_done.
 */

export type ChecklistItem = {
  id: string;
  label: string;
  requires_photo: boolean;
  is_done: boolean;
  done_at: string | null;
  sort: number;
};

export function ChecklistClient({
  jobId,
  initialItems,
}: {
  jobId: string;
  initialItems: ChecklistItem[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<ChecklistItem[]>(initialItems);
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const doneCount = items.filter((i) => i.is_done).length;

  function reconcile() {
    startTransition(() => router.refresh());
  }

  async function onToggle(item: ChecklistItem) {
    const next = !item.is_done;
    setError(null);
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, is_done: next } : i)),
    );
    const res = await setChecklistItemDone(item.id, next);
    if (!res.ok) {
      setError(res.error ?? "Couldn't update the item.");
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, is_done: item.is_done } : i)),
      );
      return;
    }
    reconcile();
  }

  async function onAdd() {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    setError(null);
    const res = await addChecklistItem(jobId, label);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't add the item.");
      return;
    }
    setNewLabel("");
    reconcile();
  }

  async function onDelete(item: ChecklistItem) {
    setError(null);
    const prev = items;
    setItems((p) => p.filter((i) => i.id !== item.id));
    const res = await deleteChecklistItem(item.id);
    if (!res.ok) {
      setError(res.error ?? "Couldn't remove the item.");
      setItems(prev);
      return;
    }
    reconcile();
  }

  return (
    <section
      id="checklist"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Checklist</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            The crew&apos;s run-list for this job — separate from snags and the
            quality plan.
          </p>
        </div>
        {items.length > 0 ? (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
            {doneCount}/{items.length} done
          </span>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={item.is_done}
                onChange={() => onToggle(item)}
                aria-label={`Mark "${item.label}" ${item.is_done ? "not done" : "done"}`}
                className="h-4 w-4 shrink-0 rounded border-slate-300"
              />
              <span
                className={`min-w-0 flex-1 text-sm ${
                  item.is_done ? "text-slate-400 line-through" : "text-slate-800"
                }`}
              >
                {item.label}
                {item.requires_photo ? (
                  <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                    photo
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                onClick={() => onDelete(item)}
                aria-label={`Remove "${item.label}"`}
                className="shrink-0 text-xs font-medium text-slate-400 hover:text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          No checklist items yet. Add the steps for this job below, or start a job
          from a template to pre-load them.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <input
          type="text"
          value={newLabel}
          maxLength={300}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onAdd();
            }
          }}
          placeholder="Add a checklist step…"
          aria-label="New checklist step"
          className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={busy || newLabel.trim() === ""}
          className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  );
}
