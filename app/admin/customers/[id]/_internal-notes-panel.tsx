import Link from "next/link";
import { pill, pillMap } from "@/components/ui/tokens";
import { listInternalNotesForOrg } from "@/server/services/hq-internal-notes";
import {
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_CATEGORY_LABEL,
  INTERNAL_NOTE_PRIORITIES,
  INTERNAL_NOTE_PRIORITY_LABEL,
  type InternalNoteCategory,
  type InternalNotePriority,
} from "@/lib/hq/internal-notes";
import {
  createNoteAction,
  togglePinNoteAction,
  archiveNoteAction,
  unarchiveNoteAction,
} from "@/app/admin/notes/actions";
import { Button, Input, Panel, Select, Textarea } from "@/components/ui";

/**
 * Per-customer internal-notes panel embedded on
 * /admin/customers/[id] (HQ-9).
 *
 * Read-only summary + inline create form. Edit/pin/archive use the
 * same actions as /admin/notes — they redirect back via the
 * `redirect_to` hidden field.
 */

// Dark-surface pills. The shared *_PILL maps in lib/hq/internal-notes
// are light-themed (consumed by the light /admin/notes view), so HQ's
// dark surfaces resolve their own token idioms locally — presentation
// only, no behaviour change.
const NOTE_CATEGORY_PILL_DARK = pillMap<InternalNoteCategory>({
  general: "quiet",
  sales: "emerald",
  onboarding: "indigo",
  billing: "amber",
  support: "sky",
  risk: "rose",
  technical: "quiet",
  success: "emerald",
});

const NOTE_PRIORITY_PILL_DARK = pillMap<InternalNotePriority>({
  low: "quiet",
  normal: "sky",
  high: "amber",
  urgent: "rose",
});

const PILL_FALLBACK_DARK = pill("quiet");

export async function InternalNotesPanel({ orgId }: { orgId: string }) {
  const notes = await listInternalNotesForOrg(orgId, {
    include_archived: false,
  });
  const redirectBack = `/admin/customers/${orgId}`;

  return (
    <Panel
      title="Internal notes"
      subtitle="HQ-only context. Customers cannot see these."
      action={
        <Link
          href={`/admin/notes?org_id=${orgId}`}
          className="text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200 hover:underline"
        >
          Open all notes →
        </Link>
      }
    >
      {/* Add note inline */}
      <form action={createNoteAction} className="space-y-2">
        <input type="hidden" name="org_id" value={orgId} />
        <input type="hidden" name="redirect_to" value={redirectBack} />
        <Input
          name="title"
          type="text"
          maxLength={200}
          placeholder="Title (optional)"
        />
        <Textarea
          name="body"
          required
          minLength={1}
          maxLength={20_000}
          rows={3}
          placeholder="Note body…"
        />
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-slate-300">
          <Select name="category" defaultValue="general" className="w-auto py-1">
            {INTERNAL_NOTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {INTERNAL_NOTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          <Select name="priority" defaultValue="normal" className="w-auto py-1">
            {INTERNAL_NOTE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {INTERNAL_NOTE_PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              name="pinned"
              value="true"
              className="h-3.5 w-3.5 rounded border-slate-700 bg-slate-900 text-indigo-500"
            />
            Pin
          </label>
          <Button type="submit" variant="accent" size="sm" className="ml-auto">
            Add note
          </Button>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 px-3 py-3 text-center text-xs text-slate-500">
          No notes yet — add the first one above.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {notes.slice(0, 10).map((n) => (
            <li
              key={n.id}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {n.pinned ? (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${pill("amber")}`}>
                      Pinned
                    </span>
                  ) : null}
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${NOTE_CATEGORY_PILL_DARK[n.category as InternalNoteCategory] ?? PILL_FALLBACK_DARK}`}
                  >
                    {INTERNAL_NOTE_CATEGORY_LABEL[n.category as InternalNoteCategory] ?? n.category}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${NOTE_PRIORITY_PILL_DARK[n.priority as InternalNotePriority] ?? PILL_FALLBACK_DARK}`}
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
                      className="font-medium text-slate-400 transition-colors hover:text-slate-200 hover:underline"
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
                        className="font-medium text-slate-400 transition-colors hover:text-slate-200 hover:underline"
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
                        className="font-medium text-slate-400 transition-colors hover:text-slate-200 hover:underline"
                      >
                        Unarchive
                      </button>
                    </form>
                  )}
                </div>
              </div>
              {n.title ? (
                <h3 className="mt-1 text-sm font-semibold text-white">
                  {n.title}
                </h3>
              ) : null}
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
                {n.body}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">
                {n.author_email} ·{" "}
                {n.created_at.slice(0, 16).replace("T", " ")} UTC
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
