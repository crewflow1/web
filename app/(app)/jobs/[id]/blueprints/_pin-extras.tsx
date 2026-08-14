"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  updateTaskPinAction,
  getPinCommentsAction, addPinCommentAction, deletePinCommentAction,
  getPinPhotosAction, uploadPinPhotoAction, deletePinPhotoAction,
} from "./pin-actions";
import {
  TASK_PIN_STATUSES, TASK_PIN_STATUS_LABELS, type BlueprintPin, type TaskPinStatus,
} from "@/lib/blueprints/pins";
import {
  buildCommentTree, type PinComment, type PinCommentNode,
} from "@/lib/blueprints/pin-comments";

/**
 * Blueprint Pin — rich detail surfaces (P2 wave): task lifecycle controls, a
 * threaded comment discussion, and a direct-photo strip. All are client
 * components that call the pin server actions; text is rendered as React
 * children (auto-escaped) so there is no path from stored content to raw HTML.
 */

const inputCls = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none";
type Member = { id: string; name: string };

// ── task controls ────────────────────────────────────────────────────────────

export function TaskControls({
  pin, jobId, members, onChanged,
}: { pin: BlueprintPin; jobId: string; members: Member[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = pin.task_status ?? "open";

  const run = useCallback(async (patch: { status?: TaskPinStatus; assigned_to?: string | null; due_date?: string | null }) => {
    setBusy(true); setError(null);
    const res = await updateTaskPinAction(jobId, { id: pin.id, ...patch });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    onChanged();
  }, [jobId, pin.id, onChanged]);

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">Status</p>
        <div className="flex gap-1" role="group" aria-label="Task status">
          {TASK_PIN_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              aria-pressed={status === s}
              onClick={() => { if (s !== status) void run({ status: s }); }}
              className={`min-h-[40px] flex-1 rounded-md px-2 py-1.5 text-xs font-semibold disabled:opacity-50 ${status === s ? "bg-slate-900 text-white" : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"}`}
            >
              {TASK_PIN_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="mb-1 block font-semibold text-slate-500">Assignee</span>
          <select
            className={inputCls}
            disabled={busy}
            value={pin.assigned_to ?? ""}
            onChange={(e) => void run({ assigned_to: e.target.value === "" ? null : e.target.value })}
            aria-label="Assignee"
          >
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-semibold text-slate-500">Due date</span>
          <input
            type="date"
            className={inputCls}
            disabled={busy}
            defaultValue={pin.due_date ?? ""}
            onChange={(e) => void run({ due_date: e.target.value === "" ? null : e.target.value })}
            aria-label="Due date"
          />
        </label>
      </div>
      {error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}

// ── comments thread ──────────────────────────────────────────────────────────

export function CommentsThread({
  pin, jobId, currentUserId, isAdmin,
}: { pin: BlueprintPin; jobId: string; currentUserId: string | null; isAdmin: boolean }) {
  const [comments, setComments] = useState<PinComment[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setComments(await getPinCommentsAction(pin.id));
      setLoadError(false);
    } catch {
      setLoadError(true); // never render an empty thread on a failed read
    }
  }, [pin.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const submit = useCallback(async () => {
    if (!body.trim()) return;
    setBusy(true); setError(null);
    const res = await addPinCommentAction(jobId, { pin_id: pin.id, body, parent_comment_id: replyTo ?? undefined });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setBody(""); setReplyTo(null);
    void refresh();
  }, [body, jobId, pin.id, replyTo, refresh]);

  const remove = useCallback(async (id: string) => {
    const res = await deletePinCommentAction(jobId, id);
    if (res.ok) void refresh();
  }, [jobId, refresh]);

  const tree = buildCommentTree(comments);

  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-semibold text-slate-500">Discussion ({comments.length})</p>
      {loadError ? (
        <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-md bg-amber-100 px-2 py-1.5 text-xs text-amber-900">
          <span>Couldn&rsquo;t load the discussion — this is a load failure, not an empty thread.</span>
          <button type="button" onClick={() => void refresh()} className="rounded border border-amber-400 bg-white px-2 py-0.5 font-semibold">Retry</button>
        </div>
      ) : null}
      <ul className="max-h-48 space-y-2 overflow-y-auto">
        {tree.map((node) => (
          <CommentItem
            key={node.id} node={node} depth={0}
            currentUserId={currentUserId} isAdmin={isAdmin}
            onReply={(id) => setReplyTo(id)} onDelete={remove}
          />
        ))}
        {tree.length === 0 && !loadError ? <li className="text-xs text-slate-400">No comments yet.</li> : null}
      </ul>
      <div className="mt-2">
        {replyTo ? (
          <p className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
            Replying to a comment
            <button type="button" onClick={() => setReplyTo(null)} className="underline">cancel</button>
          </p>
        ) : null}
        <textarea
          className={inputCls} rows={2} maxLength={2000} value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={replyTo ? "Write a reply…" : "Add a comment…"} aria-label="Comment text"
        />
        {error ? <p role="alert" className="mt-1 text-xs text-rose-600">{error}</p> : null}
        <button
          type="button" disabled={busy || !body.trim()} onClick={submit}
          className="mt-2 min-h-[40px] rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "Posting…" : replyTo ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}

function CommentItem({
  node, depth, currentUserId, isAdmin, onReply, onDelete,
}: {
  node: PinCommentNode; depth: number; currentUserId: string | null; isAdmin: boolean;
  onReply: (id: string) => void; onDelete: (id: string) => void;
}) {
  const canDelete = isAdmin || (currentUserId != null && node.author_id === currentUserId);
  return (
    <li style={{ marginLeft: depth > 0 ? Math.min(depth, 4) * 12 : 0 }}>
      <div className="rounded-md border border-slate-200 bg-white p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-600">{node.author_name ?? "Member"}</span>
          <span className="text-[10px] text-slate-400">{node.created_at.slice(0, 10)}</span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-800">{node.body}</p>
        <div className="mt-1 flex gap-3">
          <button type="button" onClick={() => onReply(node.id)} className="text-[11px] font-medium text-slate-500 hover:text-slate-800">Reply</button>
          {canDelete ? (
            <button type="button" onClick={() => onDelete(node.id)} className="text-[11px] font-medium text-rose-500 hover:text-rose-700">Delete</button>
          ) : null}
        </div>
      </div>
      {node.replies.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {node.replies.map((child) => (
            <CommentItem
              key={child.id} node={child} depth={depth + 1}
              currentUserId={currentUserId} isAdmin={isAdmin}
              onReply={onReply} onDelete={onDelete}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ── photos strip ─────────────────────────────────────────────────────────────

const PHOTO_ERROR: Record<string, string> = {
  bad_file_type: "Photos only (JPG, PNG, HEIC, HEIF, WebP).",
  file_too_large: "That photo is too large (max 25 MB).",
  no_file: "Pick a photo first.",
  pin_not_found: "That pin no longer exists.",
  upload_failed: "Upload failed. Try again.",
  record_failed: "Couldn't record the photo. Try again.",
  forbidden: "Only an owner or admin can remove a photo.",
  not_deleted: "That photo is already gone.",
};

export function PhotosStrip({
  pin, canDelete,
}: { pin: BlueprintPin; canDelete: boolean }) {
  const [photos, setPhotos] = useState<{ id: string; filename: string; url: string | null }[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setPhotos(await getPinPhotosAction(pin.id));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [pin.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const onPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.set("pin_id", pin.id);
    fd.set("file", file);
    const res = await uploadPinPhotoAction(fd);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) { setError(PHOTO_ERROR[res.error] ?? "Couldn't add the photo."); return; }
    void refresh();
  }, [pin.id, refresh]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    const res = await deletePinPhotoAction(id);
    if (!res.ok) { setError(PHOTO_ERROR[res.error] ?? "Couldn't remove the photo."); return; }
    void refresh();
  }, [refresh]);

  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-semibold text-slate-500">Photos ({photos.length})</p>
      {loadError ? (
        <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-md bg-amber-100 px-2 py-1.5 text-xs text-amber-900">
          <span>Couldn&rsquo;t load photos — load failure, not an empty set.</span>
          <button type="button" onClick={() => void refresh()} className="rounded border border-amber-400 bg-white px-2 py-0.5 font-semibold">Retry</button>
        </div>
      ) : null}
      {photos.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="relative overflow-hidden rounded-lg border border-slate-200">
              {p.url ? (
                // Signed URLs expire in ~60s — next/image's cached optimiser would
                // re-fetch after expiry and 400. Use a plain <img>.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.url} alt={p.filename} loading="lazy" className="aspect-square w-full object-cover" />
              ) : (
                <span className="flex aspect-square w-full items-center justify-center bg-slate-100 text-[10px] text-slate-500">Preview unavailable</span>
              )}
              {canDelete ? (
                <button
                  type="button" aria-label={`Remove ${p.filename}`} onClick={() => remove(p.id)}
                  className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-md bg-white/90 text-xs font-bold text-rose-700 hover:bg-white"
                >✕</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2">
        <input
          ref={fileRef} type="file" accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
          disabled={busy} onChange={onPick} aria-label="Attach a photo to this pin"
          className="block w-full text-xs text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-slate-200 disabled:opacity-50"
        />
        {busy ? <p className="mt-1 text-xs text-slate-500">Uploading…</p> : null}
        {error ? <p role="alert" className="mt-1 text-xs text-rose-600">{error}</p> : null}
      </div>
    </div>
  );
}
