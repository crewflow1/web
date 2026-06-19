import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import { notFound } from "next/navigation";
import {
  Activity,
  History,
  Link2,
  Pencil,
  Pin,
  PinOff,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  listMemoryTypes,
  loadMemoryDetail,
  recordMemoryAccess,
} from "@/server/services/hq-memory";
import { listAiEmployees } from "@/server/services/ai-employees";
import {
  MEMORY_STATUSES,
  STATUS_LABELS,
  confidenceNote,
  departmentLabel,
  entityTypeLabel,
  eventLabel,
  importanceLabel,
  relativeTime,
  type MemoryEmployeeLink,
} from "@/lib/memory/model";
import {
  Banner,
  Chip,
  MemoryTypeBadge,
  Pill,
  Section,
  StatusPill,
  Tile,
  VisibilityPill,
  buildTypeMap,
} from "../_components";
import { importancePill } from "../_styles";
import { setStatusAction, togglePinAction } from "../actions";

/**
 * Shared Memory Engine — memory detail (CEO Directive 002, Phase 2).
 *
 * The full record plus every indexed relationship: linked entities,
 * linked AI employees, access grants, the version history, and the
 * fully-auditable event timeline. Opening a memory bumps its access
 * counter (humans don't spawn timeline events — that noise is reserved
 * for future AI consumption).
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

const LINK_KIND_LABEL: Record<string, string> = {
  relevant: "Relevant",
  pinned: "Pinned",
  owner: "Owner",
  contributor: "Contributor",
};

export default async function MemoryDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const detail = await loadMemoryDetail(id);
  if (!detail) notFound();

  const { memory: m, relationships, employeeLinks, grants, events, versions } =
    detail;

  const [types, employees] = await Promise.all([
    listMemoryTypes(),
    listAiEmployees(),
  ]);
  const typeMap = buildTypeMap(types);
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  // Best-effort: record the human view (counter only, no timeline spam).
  await recordMemoryAccess(m.id, m.access_count);

  const type = typeMap[m.memory_type];
  const saved = sp.saved ? prettySaved(sp.saved) : null;
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/memory" className="hover:text-slate-300">
            Shared Memory
          </Link>{" "}
          /{" "}
          <Link href="/admin/memory/search" className="hover:text-slate-300">
            Search
          </Link>{" "}
          / <span className="text-slate-300">{m.title}</span>
        </p>

        {errorMsg ? <Banner kind="error">{errorMsg}</Banner> : null}
        {saved ? <Banner kind="success">{saved}</Banner> : null}

        {/* Header */}
        <header className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <MemoryTypeBadge type={type} slug={m.memory_type} />
                {m.pinned ? (
                  <Pill className="bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30">
                    <Pin className="mr-1 h-3 w-3" aria-hidden /> Pinned
                  </Pill>
                ) : null}
                <Pill className={importancePill(m.importance)}>
                  {importanceLabel(m.importance)}
                </Pill>
                <StatusPill status={m.status} />
                <VisibilityPill visibility={m.visibility} />
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-white">
                {m.title}
              </h1>
              {m.summary ? (
                <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-300">
                  {m.summary}
                </p>
              ) : null}
            </div>
            <Link
              href={`/admin/memory/${m.id}/edit`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Link>
          </div>
        </header>

        {/* Overview tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Department" value={m.department ? departmentLabel(m.department) : "All HQ"} />
          <Tile label="Source" value={m.source} />
          <Tile label="Version" value={`v${m.version}`} />
          <Tile
            label="Confidence"
            value={`${m.confidence}%`}
            sub={confidenceNote(m.confidence)}
          />
          <Tile label="Access count" value={<AnimatedNumber value={m.access_count} />} />
          <Tile
            label="Last accessed"
            value={m.last_accessed_at ? relativeTime(m.last_accessed_at) : "Never"}
          />
        </div>

        {/* Body */}
        <Section title="Memory body">
          {m.body ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
              {m.body}
            </p>
          ) : (
            <p className="text-sm text-slate-500">No body content.</p>
          )}
        </Section>

        {/* Tags + keywords */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Tags">
            {m.tags.length === 0 ? (
              <p className="text-sm text-slate-500">No tags.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {m.tags.map((t) => (
                  <Link
                    key={t}
                    href={`/admin/memory/search?tag=${encodeURIComponent(t)}`}
                    className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300 ring-1 ring-inset ring-slate-700 transition hover:bg-slate-700"
                  >
                    #{t}
                  </Link>
                ))}
              </div>
            )}
          </Section>
          <Section
            title="Index keywords"
            subtitle="Auto-derived for search + topic grouping"
          >
            {m.keywords.length === 0 ? (
              <p className="text-sm text-slate-500">No keywords.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {m.keywords.map((k) => (
                  <span
                    key={k}
                    className="rounded bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-400 ring-1 ring-inset ring-slate-800"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Relationships */}
        <Section
          title="Relationships"
          subtitle="Linked entities across the company graph"
        >
          {relationships.length === 0 ? (
            <p className="text-sm text-slate-500">No linked entities.</p>
          ) : (
            <ul className="space-y-2">
              {relationships.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm"
                >
                  <Link2 className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                  <Chip>{entityTypeLabel(r.entity_type)}</Chip>
                  <span className="font-medium text-slate-200">
                    {r.entity_label}
                  </span>
                  {r.entity_id ? (
                    <span className="font-mono text-[11px] text-slate-500">
                      #{r.entity_id}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[11px] uppercase tracking-wide text-slate-500">
                    {r.relation.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Linked employees + access grants */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Linked AI employees"
            subtitle="See this memory in their Relevant feed"
          >
            {employeeLinks.length === 0 ? (
              <p className="text-sm text-slate-500">No linked employees.</p>
            ) : (
              <ul className="space-y-2">
                {employeeLinks.map((l) => (
                  <EmployeeLinkRow
                    key={l.id}
                    link={l}
                    name={employeeById.get(l.ai_employee_id)?.name ?? "Unknown"}
                    slug={employeeById.get(l.ai_employee_id)?.slug ?? null}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Access grants"
            subtitle="Extra read access beyond the visibility rule"
          >
            {grants.length === 0 ? (
              <p className="text-sm text-slate-500">
                No explicit grants. Visibility rule applies.
              </p>
            ) : (
              <ul className="space-y-2">
                {grants.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm"
                  >
                    <ShieldCheck
                      className="h-4 w-4 shrink-0 text-emerald-400"
                      aria-hidden
                    />
                    <Chip>{g.grantee_type}</Chip>
                    <span className="text-slate-200">
                      {g.grantee_type === "department"
                        ? departmentLabel(g.grantee_value)
                        : g.grantee_value}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {/* Quick actions */}
        <Section
          title="Curation"
          subtitle="Operator actions — each is audit-logged + added to the timeline."
        >
          <div className="flex flex-wrap items-end gap-4">
            <form action={togglePinAction}>
              <input type="hidden" name="id" value={m.id} />
              <input type="hidden" name="next" value={m.pinned ? "false" : "true"} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {m.pinned ? (
                  <>
                    <PinOff className="h-3.5 w-3.5" aria-hidden /> Unpin
                  </>
                ) : (
                  <>
                    <Pin className="h-3.5 w-3.5" aria-hidden /> Pin
                  </>
                )}
              </button>
            </form>

            <form action={setStatusAction} className="flex items-end gap-2">
              <input type="hidden" name="id" value={m.id} />
              <label className="text-[11px] font-medium text-slate-400">
                Status
                <select
                  name="status"
                  defaultValue={m.status}
                  className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                >
                  {MEMORY_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Update
              </button>
            </form>
          </div>
        </Section>

        {/* Version history */}
        <Section
          title="Version history"
          subtitle={`${versions.length} ${versions.length === 1 ? "version" : "versions"} recorded`}
        >
          {versions.length === 0 ? (
            <p className="text-sm text-slate-500">No versions recorded.</p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-bold text-slate-300 ring-1 ring-inset ring-slate-700">
                    v{v.version}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {v.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {v.edited_by_email ? `${v.edited_by_email} · ` : ""}
                      {v.created_at.slice(0, 16).replace("T", " ")}
                    </p>
                  </div>
                  <History className="h-4 w-4 shrink-0 text-slate-600" aria-hidden />
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* Timeline */}
        <Section
          title="Timeline & audit"
          subtitle="Creation, updates, status changes, and AI accesses"
        >
          {events.length === 0 ? (
            <p className="text-sm text-slate-500">No events yet.</p>
          ) : (
            <ol className="divide-y divide-slate-800">
              {events.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 py-2.5 text-sm">
                  <Activity
                    className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-200">
                      {eventLabel(ev.event_type)}
                    </p>
                    {ev.actor_email ? (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        by {ev.actor_email}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {ev.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {/* Footer meta */}
        <p className="text-[11px] text-slate-600">
          Created {m.created_at.slice(0, 16).replace("T", " ")}
          {m.created_by_email ? ` by ${m.created_by_email}` : ""} · Updated{" "}
          {m.updated_at.slice(0, 16).replace("T", " ")} · ID {m.id}
        </p>
      </div>
    </div>
  );
}

function EmployeeLinkRow({
  link,
  name,
  slug,
}: {
  link: MemoryEmployeeLink;
  name: string;
  slug: string | null;
}) {
  const inner = (
    <>
      <Users className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <span className="font-medium text-slate-200">{name}</span>
      <Chip>{LINK_KIND_LABEL[link.link_kind] ?? link.link_kind}</Chip>
    </>
  );
  return (
    <li>
      {slug ? (
        <Link
          href={`/admin/ai-employees/${slug}`}
          className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm transition hover:bg-slate-900"
        >
          {inner}
          <span className="ml-auto text-xs text-slate-500">Open →</span>
        </Link>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm">
          {inner}
        </div>
      )}
    </li>
  );
}

function prettySaved(saved: string): string {
  switch (saved) {
    case "created":
      return "Memory created.";
    case "updated":
      return "Memory updated — a new version was saved.";
    case "pinned":
      return "Pinned.";
    case "unpinned":
      return "Unpinned.";
    case "status":
      return "Status updated.";
    default:
      return "Saved.";
  }
}
