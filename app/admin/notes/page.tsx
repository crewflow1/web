import Link from "next/link";
import { listAllInternalNotesForHQ } from "@/server/services/hq-internal-notes";
import {
  INTERNAL_NOTE_CATEGORIES,
  INTERNAL_NOTE_CATEGORY_LABEL,
  INTERNAL_NOTE_PRIORITIES,
  INTERNAL_NOTE_PRIORITY_LABEL,
  INTERNAL_NOTE_SORTS,
  INTERNAL_NOTE_SORT_LABEL,
  filterNotes,
  sortNotes,
  type InternalNoteCategory,
  type InternalNotePriority,
  type InternalNoteSort,
} from "@/lib/hq/internal-notes";
import {
  createNoteAction,
  togglePinNoteAction,
  archiveNoteAction,
  unarchiveNoteAction,
} from "./actions";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  Alert,
  AnimatedNumber,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  GlowHeader,
  Input,
  Panel,
  Select,
  StatTile,
  Surface,
  Textarea,
  type Accent,
} from "@/components/ui";

/** Dark-surface accents per note category (mirrors the legacy light pills). */
const CATEGORY_ACCENT: Record<InternalNoteCategory, Accent> = {
  general: "slate",
  sales: "emerald",
  onboarding: "indigo",
  billing: "amber",
  support: "sky",
  risk: "rose",
  technical: "slate",
  success: "emerald",
};

/** Dark-surface accents per note priority. */
const PRIORITY_ACCENT: Record<InternalNotePriority, Accent> = {
  low: "slate",
  normal: "sky",
  high: "amber",
  urgent: "rose",
};

/**
 * HQ Internal Notes — /admin/notes (HQ-9).
 *
 * Cross-tenant. Service-role read (bypasses RLS, which is exactly
 * what we want — these rows are invisible to customers by design).
 *
 * The page shows every note across every org, sorts pinned first
 * by default, supports search + org/category/priority filters, and
 * hides archived rows unless explicitly toggled.
 */

type SP = Promise<{
  q?: string;
  org_id?: string;
  category?: string;
  priority?: string;
  sort?: string;
  show_archived?: string;
  pinned_only?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function HqNotesPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const orgId = (sp.org_id ?? "").trim();
  const category =
    (sp.category as InternalNoteCategory | "all" | undefined) ?? "all";
  const priority =
    (sp.priority as InternalNotePriority | "all" | undefined) ?? "all";
  const sort = (INTERNAL_NOTE_SORTS.includes(sp.sort as InternalNoteSort)
    ? sp.sort
    : "default") as InternalNoteSort;
  const showArchived = sp.show_archived === "1";
  const pinnedOnly = sp.pinned_only === "1";

  const rows = await listAllInternalNotesForHQ({
    include_archived: showArchived,
    limit: 500,
  });

  // Org options for the dropdown — keep it cheap, just pull names
  // from the notes themselves. If you have 0 notes, the org filter
  // collapses to "All" which is fine.
  const orgOptions = Array.from(
    new Map(rows.map((n) => [n.org_id, n.org_name ?? n.org_id])).entries(),
  ).sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? ""));

  const filtered = filterNotes(rows, {
    q,
    org_id: orgId || null,
    category,
    priority,
    show_archived: showArchived,
    pinned_only: pinnedOnly,
  });
  const sorted = sortNotes(filtered, sort);

  // KPIs (full unfiltered set, so the operator sees system-wide
  // truth regardless of current view).
  const active = rows.filter((n) => n.archived_at === null);
  const urgentActive = active.filter((n) => n.priority === "urgent").length;
  const pinnedActive = active.filter((n) => n.pinned).length;
  const today24h = rows.filter((n) => {
    return Date.now() - new Date(n.created_at).getTime() <= 24 * 3600_000;
  }).length;

  // Customers list for the "new note" form (every active org).
  // The 'status' column type in the generated Supabase types is
  // narrower than what's actually in the DB (HQ-3 added it via
  // migration), so cast through unknown.
  const admin = createAdminClient();
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, status" as never)
    .order("name", { ascending: true });
  const orgsForForm = ((orgs ?? []) as unknown) as Array<{
    id: string;
    name: string;
    status: string | null;
  }>;

  const banner = (() => {
    if (sp.saved)
      return { tone: "ok" as const, msg: `Saved (${sp.saved}).` };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Customer context library"
        subtitle="Sales nuance, onboarding observations, risk flags, billing decisions. Never visible to customers — internal only."
        actions={
          <ButtonLink href="/admin/overview" variant="glass" size="sm">
            ← HQ overview
          </ButtonLink>
        }
      />

      <div className="space-y-5 p-5 sm:p-7">
        {banner ? (
          <Alert tone={banner.tone === "ok" ? "success" : "danger"}>
            {banner.msg}
          </Alert>
        ) : null}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="Active notes"
            value={<AnimatedNumber value={active.length} />}
          />
          <StatTile
            label="Urgent"
            value={<AnimatedNumber value={urgentActive} />}
            accent={urgentActive > 0 ? "rose" : "slate"}
          />
          <StatTile
            label="Pinned"
            value={<AnimatedNumber value={pinnedActive} />}
            accent={pinnedActive > 0 ? "amber" : "slate"}
          />
          <StatTile
            label="Last 24h"
            value={<AnimatedNumber value={today24h} />}
            accent="indigo"
          />
        </section>

        {/* New note form */}
        <Panel title="New note">
          <form action={createNoteAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[11px] font-medium text-slate-400">
                Customer
                <Select
                  name="org_id"
                  required
                  defaultValue={orgId}
                  className="mt-1"
                >
                  <option value="">Pick a customer…</option>
                  {orgsForForm.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                      {o.status ? ` · ${o.status}` : ""}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-[11px] font-medium text-slate-400">
                Title (optional)
                <Input
                  name="title"
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Renewal call — next Tuesday"
                  className="mt-1"
                />
              </label>
            </div>
            <label className="block text-[11px] font-medium text-slate-400">
              Body
              <Textarea
                name="body"
                required
                minLength={1}
                maxLength={20_000}
                rows={4}
                placeholder="Markdown allowed…"
                className="mt-1"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-[11px] font-medium text-slate-400">
                Category
                <Select name="category" defaultValue="general" className="mt-1">
                  {INTERNAL_NOTE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {INTERNAL_NOTE_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-[11px] font-medium text-slate-400">
                Priority
                <Select name="priority" defaultValue="normal" className="mt-1">
                  {INTERNAL_NOTE_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {INTERNAL_NOTE_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-end gap-2 pb-1 text-[11px] font-medium text-slate-400">
                <input
                  type="checkbox"
                  name="pinned"
                  value="true"
                  className="h-4 w-4 rounded border-slate-700 bg-slate-900/80 text-indigo-500 focus:ring-indigo-500/30"
                />
                Pin to top
              </label>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="accent">
                Save note
              </Button>
            </div>
          </form>
        </Panel>

        {/* Filter bar */}
        <form
          method="get"
          action="/admin/notes"
          className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-3"
        >
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Search
            <Input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="title, body, author"
              className="mt-1 w-56"
            />
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Customer
            <Select name="org_id" defaultValue={orgId} className="mt-1">
              <option value="">All</option>
              {orgOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name ?? id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Category
            <Select name="category" defaultValue={category} className="mt-1">
              <option value="all">All</option>
              {INTERNAL_NOTE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {INTERNAL_NOTE_CATEGORY_LABEL[c]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Priority
            <Select name="priority" defaultValue={priority} className="mt-1">
              <option value="all">All</option>
              {INTERNAL_NOTE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {INTERNAL_NOTE_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Sort
            <Select name="sort" defaultValue={sort} className="mt-1">
              {INTERNAL_NOTE_SORTS.map((s) => (
                <option key={s} value={s}>
                  {INTERNAL_NOTE_SORT_LABEL[s]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-[11px] font-medium text-slate-400">
            <input
              type="checkbox"
              name="pinned_only"
              value="1"
              defaultChecked={pinnedOnly}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900/80 text-indigo-500 focus:ring-indigo-500/30"
            />
            Pinned only
          </label>
          <label className="flex items-center gap-2 text-[11px] font-medium text-slate-400">
            <input
              type="checkbox"
              name="show_archived"
              value="1"
              defaultChecked={showArchived}
              className="h-4 w-4 rounded border-slate-700 bg-slate-900/80 text-indigo-500 focus:ring-indigo-500/30"
            />
            Show archived
          </label>
          <Button type="submit" variant="accent" size="sm">
            Apply
          </Button>
          <ButtonLink href="/admin/notes" variant="glass" size="sm">
            Reset
          </ButtonLink>
        </form>

        {sorted.length === 0 ? (
          <EmptyState
            title="No notes match these filters."
            description="Add one above."
          />
        ) : (
          <ul className="space-y-3">
            {sorted.map((n) => (
              <li
                key={n.id}
                className={`rounded-2xl border border-slate-800 bg-slate-900/40 p-4 ${
                  n.archived_at !== null ? "opacity-60" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {n.pinned ? (
                        <Badge accent="amber">Pinned</Badge>
                      ) : null}
                      <Badge
                        accent={
                          CATEGORY_ACCENT[n.category as InternalNoteCategory] ??
                          "slate"
                        }
                      >
                        {INTERNAL_NOTE_CATEGORY_LABEL[n.category as InternalNoteCategory] ?? n.category}
                      </Badge>
                      <Badge
                        accent={
                          PRIORITY_ACCENT[n.priority as InternalNotePriority] ??
                          "slate"
                        }
                      >
                        {INTERNAL_NOTE_PRIORITY_LABEL[n.priority as InternalNotePriority] ?? n.priority}
                      </Badge>
                      <Link
                        href={`/admin/customers/${n.org_id}`}
                        className="text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200"
                      >
                        {n.org_name ?? n.org_id.slice(0, 8)} →
                      </Link>
                      {n.archived_at ? (
                        <span className="text-[10px] font-medium text-slate-500">
                          Archived {n.archived_at.slice(0, 10)}
                        </span>
                      ) : null}
                    </div>
                    {n.title ? (
                      <h3 className="mt-2 text-sm font-semibold text-white">
                        {n.title}
                      </h3>
                    ) : null}
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">
                      {n.body}
                    </p>
                    <p className="mt-2 text-[10px] text-slate-500">
                      {n.author_email} · {n.created_at.slice(0, 16).replace("T", " ")} UTC
                      {n.updated_at !== n.created_at
                        ? ` · edited ${n.updated_at.slice(0, 10)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <form action={togglePinNoteAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <button
                        type="submit"
                        className="text-[11px] font-medium text-slate-400 transition-colors hover:text-white hover:underline"
                      >
                        {n.pinned ? "Unpin" : "Pin"}
                      </button>
                    </form>
                    {n.archived_at === null ? (
                      <form action={archiveNoteAction}>
                        <input type="hidden" name="id" value={n.id} />
                        <button
                          type="submit"
                          className="text-[11px] font-medium text-slate-400 transition-colors hover:text-white hover:underline"
                        >
                          Archive
                        </button>
                      </form>
                    ) : (
                      <form action={unarchiveNoteAction}>
                        <input type="hidden" name="id" value={n.id} />
                        <button
                          type="submit"
                          className="text-[11px] font-medium text-slate-400 transition-colors hover:text-white hover:underline"
                        >
                          Unarchive
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Surface>
  );
}
