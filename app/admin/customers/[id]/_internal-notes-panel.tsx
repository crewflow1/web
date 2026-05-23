import Link from "next/link";
import { listInternalNotesForOrg } from "@/server/services/hq-internal-notes";
import {
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_CATEGORY_LABEL,
  INTERNAL_NOTE_CATEGORY_PILL,
  INTERNAL_NOTE_PRIORITIES,
  INTERNAL_NOTE_PRIORITY_LABEL,
  INTERNAL_NOTE_PRIORITY_PILL,
  type InternalNoteCategory,
  type InternalNotePriority,
} from "@/lib/hq/internal-notes";
import {
  createNoteAction,
  togglePinNoteAction,
  archiveNoteAction,
  unarchiveNoteAction,
} from "@/app/admin/notes/actions";

/**
 * Per-customer internal-notes panel embedded on
 * /admin/customers/[id] (HQ-9).
 *
 * Read-only summary + inline create form. Edit/pin/archive use the
 * same actions as /admin/notes — they redirect back via the
 * `redirect_to` hidden field.
 */

export async function InternalNotesPanel({ orgId }: { orgId: string }) {
  const notes = await listInternalNotesForOrg(orgId, {
    include_archived: false,
  });
  const redirectBack = `/admin/customers/${orgId}`;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Internal notes
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            HQ-only context. Customers cannot see these.
          </p>
        </div>
        <Link
          href={`/admin/notes?org_id=${orgId}`}
          className="text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:underline"
        >
          Open all notes →
        </Link>
      </div>

      {/* Add note inline */}
      <form action={createNoteAction} className="mt-3 space-y-2">
        <input type="hidden" name="org_id" value={orgId} />
        <input type="hidden" name="redirect_to" value={redirectBack} />
        <input
          name="title"
          type="text"
          maxLength={200}
          placeholder="Title (optional)"
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <textarea
          name="body"
          required
          minLength={1}
          maxLength={20_000}
          rows={3}
          placeholder="Note body…"
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-slate-700">
          <select
            name="category"
            defaultValue="general"
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            {INTERNAL_NOTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {INTERNAL_NOTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <select
            name="priority"
            defaultValue="normal"
            className="rounded-md border border-slate-300 px-2 py-1 text-xs"
          >
            {INTERNAL_NOTE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {INTERNAL_NOTE_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              name="pinned"
              value="true"
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            Pin
          </label>
          <button
            type="submit"
            className="ml-auto rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Add note
          </button>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center text-xs text-slate-500">
          No notes yet — add the first one above.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {notes.slice(0, 10).map((n) => (
            <li
              key={n.id}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {n.pinned ? (
                    <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                      Pinned
                    </span>
                  ) : null}
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${INTERNAL_NOTE_CATEGORY_PILL[n.category as InternalNoteCategory] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}
                  >
                    {INTERNAL_NOTE_CATEGORY_LABEL[n.category as InternalNoteCategory] ?? n.category}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${INTERNAL_NOTE_PRIORITY_PILL[n.priority as InternalNotePriority] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}
                  >
                    {INTERNAL_NOTE_PRIORITY_LABEL[n.priority as InternalNotePriority] ?? n.priority}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <form action={togglePinNoteAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <input
                      type="hidden"
                      name="redirect_to"
                      value={redirectBack}
                    />
                    <button
                      type="submit"
                      className="font-medium text-slate-500 hover:text-slate-900 hover:underline"
                    >
                      {n.pinned ? "Unpin" : "Pin"}
                    </button>
                  </form>
                  {n.archived_at === null ? (
                    <form action={archiveNoteAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <input
                        type="hidden"
                        name="redirect_to"
                        value={redirectBack}
                      />
                      <button
                        type="submit"
                        className="font-medium text-slate-500 hover:text-slate-900 hover:underline"
                      >
                        Archive
                      </button>
                    </form>
                  ) : (
                    <form action={unarchiveNoteAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <input
                        type="hidden"
                        name="redirect_to"
                        value={redirectBack}
                      />
                      <button
                        type="submit"
                        className="font-medium text-slate-500 hover:text-slate-900 hover:underline"
                      >
                        Unarchive
                      </button>
                    </form>
                  )}
                </div>
              </div>
              {n.title ? (
                <h3 className="mt-1 text-sm font-semibold text-slate-900">
                  {n.title}
                </h3>
              ) : null}
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                {n.body}
              </p>
              <p className="mt-1 text-[10px] text-slate-400">
                {n.author_email} ·{" "}
                {n.created_at.slice(0, 16).replace("T", " ")} UTC
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
