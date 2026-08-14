"use client";

import { useState } from "react";
import {
  placeSnagPinAction, placeNotePinAction, linkSnagPinAction, placeTaskPinAction, deletePinAction,
} from "./pin-actions";
import {
  normalizedToPercent, pinDisplayStatus, pinShortLabel,
  type BlueprintPin, type PinTone, type PinFilter,
} from "@/lib/blueprints/pins";
import { SNAG_PRIORITIES, SNAG_PRIORITY_LABELS } from "@/lib/snags/schema";
import { TaskControls, CommentsThread, PhotosStrip } from "./_pin-extras";

/**
 * Blueprint Pins — presentational surfaces (markers, placement sheet, detail
 * popover, filter). Text is rendered as React children (auto-escaped); there is
 * NO path from a stored title/note to raw HTML/SVG. Touch targets are >= 44px.
 */

const toneDot: Record<PinTone, string> = {
  open: "bg-rose-500",
  progress: "bg-amber-500",
  resolved: "bg-emerald-500",
  muted: "bg-slate-400",
  note: "bg-sky-500",
};
const toneRing: Record<PinTone, string> = {
  open: "ring-rose-300",
  progress: "ring-amber-300",
  resolved: "ring-emerald-300",
  muted: "ring-slate-300",
  note: "ring-sky-300",
};

/** A single pin marker, absolutely positioned within the page box (u,v → %). */
export function PinMarker({ pin, active, onActivate }: { pin: BlueprintPin; active: boolean; onActivate: (id: string) => void }) {
  const { label, tone } = pinDisplayStatus(pin);
  const pos = normalizedToPercent({ u: pin.u, v: pin.v });
  const glyph = pin.kind === "note" ? "✎" : pin.kind === "task" ? "☑" : "!";
  const kindLabel = pin.kind === "note" ? "Note" : pin.kind === "task" ? "Task" : "Snag";
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onActivate(pin.id); }}
      aria-label={`${kindLabel} pin: ${pinShortLabel(pin)} (${label})`}
      data-pin-marker={pin.id}
      className={`pointer-events-auto absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-sm font-bold text-white shadow-md ring-2 ${toneDot[tone]} ${active ? "z-20 scale-125 ring-white" : `z-10 ${toneRing[tone]}`}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}

/** The provisional marker shown at the point being placed. */
export function DraftMarker({ u, v }: { u: number; v: number }) {
  const pos = normalizedToPercent({ u, v });
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-30 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white shadow-lg ring-2 ring-white"
      style={{ left: pos.left, top: pos.top }}
    >
      +
    </span>
  );
}

const inputCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none";
const tabCls = (on: boolean) => `flex-1 rounded-md px-3 py-2 text-sm font-semibold ${on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`;

type Linkable = { id: string; title: string; status: string };
type Member = { id: string; name: string };
type PlacementTab = "snag" | "note" | "task" | "link";

/** The bottom-sheet form for creating a pin at a placed point. */
export function PlacementSheet({
  jobId, versionId, page, u, v, linkable, members, onDone, onCancel,
}: {
  jobId: string; versionId: string; page: number; u: number; v: number;
  linkable: Linkable[]; members: Member[]; onDone: () => void; onCancel: () => void;
}) {
  const [tab, setTab] = useState<PlacementTab>("snag");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // snag fields
  const [snagTitle, setSnagTitle] = useState("");
  const [snagPriority, setSnagPriority] = useState<(typeof SNAG_PRIORITIES)[number]>("medium");
  const [snagLocation, setSnagLocation] = useState("");
  // note fields
  const [note, setNote] = useState("");
  // task fields
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskDue, setTaskDue] = useState("");
  // link field
  const [linkId, setLinkId] = useState("");

  async function submit() {
    setBusy(true); setError(null);
    const base = { blueprint_version_id: versionId, page_number: page, u, v };
    let res;
    if (tab === "snag") {
      if (!snagTitle.trim()) { setError("Give the snag a title."); setBusy(false); return; }
      res = await placeSnagPinAction(jobId, { ...base, snag_title: snagTitle, snag_priority: snagPriority, snag_location: snagLocation });
    } else if (tab === "note") {
      if (!note.trim()) { setError("Write a note."); setBusy(false); return; }
      res = await placeNotePinAction(jobId, { ...base, note });
    } else if (tab === "task") {
      if (!taskTitle.trim()) { setError("Give the task a title."); setBusy(false); return; }
      res = await placeTaskPinAction(jobId, { ...base, title: taskTitle, assigned_to: taskAssignee || undefined, due_date: taskDue || undefined });
    } else {
      if (!linkId) { setError("Pick a snag to link."); setBusy(false); return; }
      res = await linkSnagPinAction(jobId, { ...base, snag_id: linkId });
    }
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onDone();
  }

  const cta = tab === "note" ? "Add note" : tab === "task" ? "Create task" : tab === "link" ? "Link snag" : "Create snag";

  return (
    <div role="dialog" aria-label="Add a pin" className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg rounded-t-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:bottom-4 sm:rounded-2xl">
      <div className="mb-3 flex gap-2">
        <button type="button" className={tabCls(tab === "snag")} onClick={() => setTab("snag")}>Snag</button>
        <button type="button" className={tabCls(tab === "task")} onClick={() => setTab("task")}>Task</button>
        <button type="button" className={tabCls(tab === "note")} onClick={() => setTab("note")}>Note</button>
        <button type="button" className={tabCls(tab === "link")} onClick={() => setTab("link")} disabled={linkable.length === 0}>Link snag</button>
      </div>

      {tab === "snag" ? (
        <div className="space-y-2">
          <input autoFocus className={inputCls} placeholder="What's the snag? (e.g. Cracked render)" value={snagTitle} onChange={(e) => setSnagTitle(e.target.value)} maxLength={200} aria-label="Snag title" />
          <div className="flex gap-2">
            <select className={inputCls} value={snagPriority} onChange={(e) => setSnagPriority(e.target.value as typeof snagPriority)} aria-label="Priority">
              {SNAG_PRIORITIES.map((p) => <option key={p} value={p}>{SNAG_PRIORITY_LABELS[p]}</option>)}
            </select>
            <input className={inputCls} placeholder="Location (optional)" value={snagLocation} onChange={(e) => setSnagLocation(e.target.value)} maxLength={200} aria-label="Location" />
          </div>
        </div>
      ) : tab === "task" ? (
        <div className="space-y-2">
          <input autoFocus className={inputCls} placeholder="What needs doing? (e.g. Fit handrail)" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} maxLength={120} aria-label="Task title" />
          <div className="flex gap-2">
            <select className={inputCls} value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)} aria-label="Assignee">
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <input type="date" className={inputCls} value={taskDue} onChange={(e) => setTaskDue(e.target.value)} aria-label="Due date" />
          </div>
        </div>
      ) : tab === "note" ? (
        <textarea autoFocus className={inputCls} rows={3} placeholder="Note pinned to this spot…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label="Note text" />
      ) : (
        <select autoFocus className={inputCls} value={linkId} onChange={(e) => setLinkId(e.target.value)} aria-label="Snag to link">
          <option value="">Choose an open snag…</option>
          {linkable.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-rose-600">{error}</p> : null}

      <div className="mt-3 flex gap-2">
        <button type="button" onClick={submit} disabled={busy} className="min-h-[44px] flex-1 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
          {busy ? "Saving…" : cta}
        </button>
        <button type="button" onClick={onCancel} className="min-h-[44px] rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  );
}

/** The detail popover when a pin marker is activated. */
export function PinDetail({
  pin, jobId, canDelete, members, identity, isAdmin, onClose, onChanged,
}: {
  pin: BlueprintPin; jobId: string; canDelete: boolean;
  members: Member[]; identity: { userId: string; orgId: string } | null; isAdmin: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { label, tone } = pinDisplayStatus(pin);
  return (
    <div role="dialog" aria-label="Pin details" className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 mx-auto flex max-h-[85vh] max-w-lg flex-col overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:bottom-4 sm:rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold text-white ${toneDot[tone]}`}>{label}</span>
          <p className="mt-1 truncate text-sm font-medium text-slate-900">{pinShortLabel(pin)}</p>
          {(pin.kind === "note" || pin.kind === "task") && pin.note ? <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{pin.note}</p> : null}
          {pin.kind === "task" ? (
            <p className="mt-1 text-xs text-slate-500">
              {pin.assignee_name ? `Assigned to ${pin.assignee_name}` : "Unassigned"}
              {pin.due_date ? ` · Due ${pin.due_date}` : ""}
            </p>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">✕</button>
      </div>

      {pin.kind === "task" ? (
        <TaskControls pin={pin} jobId={jobId} members={members} onChanged={onChanged} />
      ) : null}

      <PhotosStrip pin={pin} canDelete={canDelete} />
      <CommentsThread pin={pin} jobId={jobId} currentUserId={identity?.userId ?? null} isAdmin={isAdmin} />

      <div className="mt-3 flex gap-2">
        {pin.kind === "snag" && pin.snag_id ? (
          <a href={`/snags/${pin.snag_id}`} className="min-h-[44px] flex-1 rounded-md bg-slate-900 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-slate-800">Open snag →</a>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const res = await deletePinAction(jobId, pin.id);
              setBusy(false);
              if (res.ok) { onChanged(); onClose(); }
            }}
            className="min-h-[44px] rounded-md border border-rose-200 px-4 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {busy ? "…" : "Delete pin"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Filter chips for the pin layer. */
export function FilterChips({
  value, onChange,
}: { value: PinFilter; onChange: (v: PinFilter) => void }) {
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-xs font-semibold ${on ? "bg-white text-slate-900" : "text-slate-300 hover:text-white"}`;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Filter pins">
      <button type="button" className={chip(value.kind === "all")} onClick={() => onChange({ ...value, kind: "all" })}>All</button>
      <button type="button" className={chip(value.kind === "snag")} onClick={() => onChange({ ...value, kind: "snag" })}>Snags</button>
      <button type="button" className={chip(value.kind === "task")} onClick={() => onChange({ ...value, kind: "task" })}>Tasks</button>
      <button type="button" className={chip(value.kind === "note")} onClick={() => onChange({ ...value, kind: "note" })}>Notes</button>
      <span aria-hidden className="mx-1 h-4 w-px bg-slate-600" />
      <button type="button" className={chip(value.status === "open")} onClick={() => onChange({ ...value, status: value.status === "open" ? "all" : "open" })}>Open</button>
    </div>
  );
}
