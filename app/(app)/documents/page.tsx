import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import {
  ilikeOrFilter,
  JOB_DOCUMENT_SEARCH_COLUMNS,
} from "@/lib/search/filters";
import { EmptyState } from "../_components/empty-state";

/**
 * /documents — the org-wide document home.
 *
 * ONE place that aggregates every document the org holds, across the two stores
 * that actually carry them:
 *   1. job_documents      — the structured, versioned per-job documents (EICRs,
 *                           test sheets, custom forms). RLS is the visibility
 *                           boundary: a non-admin sees only `staff`-visibility
 *                           docs, an admin also sees `private` ones — identical
 *                           to the job page, because this uses the SAME tenant
 *                           client (never service-role).
 *   2. tenant_attachments — the universal polymorphic attachment store (job /
 *                           quote / snag / site-report photos + files).
 *
 * Both reads are RLS-scoped AND pinned to the ACTIVE org, LOUD (a read error
 * throws, never a silent partial list), and fully paged so the home shows the
 * org's COMPLETE document set. Searchable (title / filename) and filterable by
 * source. Each row links to the entity that owns it, where the file is served
 * through its existing signed-URL pipeline.
 */

export const metadata = { title: "Documents · CrewFlow" };

type JobDocRow = {
  id: string;
  job_id: string | null;
  title: string | null;
  doc_type: string | null;
  status: string | null;
  visibility: string | null;
  external_reference: string | null;
  created_at: string;
};

type AttachmentRow = {
  id: string;
  target_table: string | null;
  target_id: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  portal_visible: boolean | null;
  created_at: string;
};

/** A self-referential PostgREST builder shape for the `as never` cast reads —
 * every method returns the same type so the (order-flexible) chain type-checks
 * without the generated Database types (these tables post-date types.ts). */
type ScopedQuery<Row> = PromiseLike<{
  data: Row[] | null;
  error: SupabaseReadError | null;
}> & {
  select: (cols: string) => ScopedQuery<Row>;
  eq: (k: string, v: unknown) => ScopedQuery<Row>;
  or: (filter: string) => ScopedQuery<Row>;
  order: (col: string, opts: { ascending: boolean }) => ScopedQuery<Row>;
  range: (from: number, to: number) => ScopedQuery<Row>;
};

type DocEntry = {
  key: string;
  source: "job_document" | "attachment";
  title: string;
  sub: string;
  date: string;
  /** The entity that owns this document — where the file is served. */
  href: string | null;
  badge: string;
  portalVisible: boolean;
};

/** Where an attachment's parent entity lives, so a row can link to it. Only
 * entities with a detail route are linkable; anything else shows no link. */
const ATTACHMENT_HREF: Record<string, (id: string) => string> = {
  jobs: (id) => `/jobs/${id}`,
  quotes: (id) => `/quotes/${id}`,
  invoices: (id) => `/invoices/${id}`,
  suppliers: (id) => `/suppliers/${id}`,
  customers: (id) => `/customers/${id}`,
  leads: (id) => `/leads/${id}`,
  snags: (id) => `/snags/${id}`,
  site_reports: (id) => `/site-reports/${id}`,
};

const ATTACHMENT_LABEL: Record<string, string> = {
  jobs: "Job",
  quotes: "Quote",
  invoices: "Invoice",
  suppliers: "Supplier",
  customers: "Customer",
  leads: "Lead",
  snags: "Snag",
  site_reports: "Site report",
  memberships: "Staff",
  toolbox_talks: "Toolbox talk",
  site_diary_entries: "Site diary",
};

const JOB_IN_CHUNK = 500;

type SP = Promise<{ q?: string; source?: string }>;

export default async function DocumentsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const rawQ = (sp.q ?? "").trim();
  const docOr = ilikeOrFilter(rawQ, JOB_DOCUMENT_SEARCH_COLUMNS);
  const attOr = ilikeOrFilter(rawQ, ["filename"]);
  const sourceFilter =
    sp.source === "job_document" || sp.source === "attachment" ? sp.source : null;

  // ── job_documents (RLS-scoped visibility) — paged in full on a stable order.
  const showDocs = sourceFilter !== "attachment";
  let jobDocs: JobDocRow[] = [];
  if (showDocs) {
    const { data, error } = await fetchAllRows<JobDocRow>((from, to) => {
      let query = (
        supabase.from("job_documents" as never) as unknown as {
          select: (cols: string) => ScopedQuery<JobDocRow>;
        }
      )
        .select(
          "id, job_id, title, doc_type, status, visibility, external_reference, created_at",
        )
        .eq("org_id", ctx.org.id);
      if (docOr) query = query.or(docOr);
      return query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
    });
    if (error) throw readFailure("documents: job documents", error);
    jobDocs = data ?? [];
  }

  // ── tenant_attachments (RLS-scoped) — paged in full on a stable order.
  const showAttachments = sourceFilter !== "job_document";
  let attachments: AttachmentRow[] = [];
  if (showAttachments) {
    const { data, error } = await fetchAllRows<AttachmentRow>((from, to) => {
      let query = (
        supabase.from("tenant_attachments" as never) as unknown as {
          select: (cols: string) => ScopedQuery<AttachmentRow>;
        }
      )
        .select(
          "id, target_table, target_id, filename, mime_type, size_bytes, portal_visible, created_at",
        )
        .eq("org_id", ctx.org.id);
      if (attOr) query = query.or(attOr);
      return query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
    });
    if (error) throw readFailure("documents: attachments", error);
    attachments = data ?? [];
  }

  // Resolve job → customer names in chunked batches (jobs.id is unique, so a
  // chunk of ≤500 ids yields ≤500 rows; `.limit` keeps each read an honest,
  // guard-visible bound).
  const jobIds = [
    ...new Set(jobDocs.map((d) => d.job_id).filter((x): x is string => !!x)),
  ];
  const jobsMap = new Map<string, string>();
  for (let i = 0; i < jobIds.length; i += JOB_IN_CHUNK) {
    const idsChunk = jobIds.slice(i, i + JOB_IN_CHUNK);
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", idsChunk)
      .limit(JOB_IN_CHUNK);
    if (error) throw readFailure("documents: job names", error);
    for (const j of jobs ?? []) jobsMap.set(j.id, j.customer?.name ?? "Job");
  }

  const entries: DocEntry[] = [];
  for (const d of jobDocs) {
    const jobName = d.job_id ? jobsMap.get(d.job_id) : null;
    const bits = [
      d.doc_type ? d.doc_type.replace(/_/g, " ") : null,
      d.status ?? null,
      jobName ? `📋 ${jobName}` : null,
      d.external_reference ? `Ref ${d.external_reference}` : null,
      d.visibility === "private" ? "🔒 Private" : null,
    ].filter(Boolean);
    entries.push({
      key: `doc-${d.id}`,
      source: "job_document",
      title: d.title ?? "Document",
      sub: bits.join(" · ") || "Job document",
      date: d.created_at.slice(0, 10),
      href: d.job_id ? `/jobs/${d.job_id}` : null,
      badge: "Job document",
      portalVisible: false,
    });
  }
  for (const a of attachments) {
    const table = a.target_table ?? "";
    const label = ATTACHMENT_LABEL[table] ?? "Attachment";
    const href =
      a.target_id && ATTACHMENT_HREF[table] ? ATTACHMENT_HREF[table]!(a.target_id) : null;
    const bits = [
      label,
      a.mime_type ?? null,
      a.size_bytes ? formatBytes(a.size_bytes) : null,
    ].filter(Boolean);
    entries.push({
      key: `att-${a.id}`,
      source: "attachment",
      title: a.filename ?? "File",
      sub: bits.join(" · "),
      date: a.created_at.slice(0, 10),
      href,
      badge: label,
      portalVisible: !!a.portal_visible,
    });
  }
  // Newest first; stable tie-break on title.
  entries.sort((x, y) =>
    x.date !== y.date ? (x.date < y.date ? 1 : -1) : x.title.localeCompare(y.title),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Documents</h1>
        <p className="text-sm text-slate-600">
          Every document across the business in one place — job documents and
          files attached to jobs, quotes, snags and reports. Search by name and
          open the record it belongs to.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          name="q"
          defaultValue={rawQ}
          placeholder="Search documents by name or reference…"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        {sourceFilter ? (
          <input type="hidden" name="source" value={sourceFilter} />
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Search
        </button>
      </form>

      <nav aria-label="Source" className="flex flex-wrap gap-2 text-xs">
        <SourceFilter current={sourceFilter} value={null} label="All" q={rawQ} />
        <SourceFilter current={sourceFilter} value="job_document" label="Job documents" q={rawQ} />
        <SourceFilter current={sourceFilter} value="attachment" label="Attachments" q={rawQ} />
      </nav>

      {entries.length === 0 ? (
        <EmptyState
          icon="📄"
          title={rawQ ? "No documents match your search" : "No documents yet"}
          body={
            rawQ
              ? "Try a different search term, or clear the filter."
              : "Documents you add to jobs, quotes, snags and reports will gather here automatically."
          }
        />
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => {
            const inner = (
              <>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                  {e.badge}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{e.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {e.sub}
                    {e.date ? ` · ${e.date}` : ""}
                  </p>
                </div>
                {e.portalVisible ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                    Shared with customer
                  </span>
                ) : null}
                {e.href ? (
                  <span className="text-xs font-medium text-slate-400">Open →</span>
                ) : null}
              </>
            );
            return (
              <li key={e.key}>
                {e.href ? (
                  <Link
                    href={e.href}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-300 hover:bg-slate-50"
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {entries.length} document{entries.length === 1 ? "" : "s"} shown.
      </p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function SourceFilter({
  current,
  value,
  label,
  q,
}: {
  current: string | null;
  value: "job_document" | "attachment" | null;
  label: string;
  q: string;
}) {
  const isActive = current === value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (value) params.set("source", value);
  const qs = params.toString();
  const href = qs ? `/documents?${qs}` : "/documents";
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
