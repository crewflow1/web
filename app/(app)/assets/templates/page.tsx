import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import {
  CHECK_LEVEL_LABELS,
  TEMPLATE_STATUS_LABELS,
  type CheckLevel,
  type TemplateStatus,
} from "@/lib/assets/inspection-template";

export const metadata = { title: "Inspection templates · CrewFlow" };

type Row = {
  id: string;
  family_id: string;
  version: number;
  name: string;
  categories: string[] | null;
  check_level: CheckLevel;
  status: TemplateStatus;
  updated_at: string;
};

type SP = Promise<{ status?: string; q?: string; saved?: string; error?: string }>;

const STATUS_STYLES: Record<TemplateStatus, string> = {
  draft: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  superseded: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
  archived: "bg-slate-100 text-slate-600", // slate-600, not 400: AA contrast on slate-100
};

const ERROR_MAP: Record<string, string> = {
  template_invalid: "Please check the template details.",
  template_failed: "Couldn't save the template. Try again.",
  template_missing: "That template could not be found.",
};

/**
 * Inspection template library — one row per FAMILY (its latest version), so the
 * operator sees "which checklists do we have and which are live", not a wall of
 * versions. History lives on the template page.
 */
export default async function TemplatesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data } = await (
    supabase.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: Row[] | null }>;
        };
      };
    }
  )
    .select("id, family_id, version, name, categories, check_level, status, updated_at")
    // ACTIVE-org pin — the template library is per-org; RLS alone blends both.
    .eq("org_id", ctx.org.id)
    .order("updated_at", { ascending: false });

  // Group to one row per family: prefer the PUBLISHED version as the face of the
  // family (that's what can start inspections); otherwise the newest version.
  const byFamily = new Map<string, { face: Row; hasDraft: boolean; versions: number }>();
  for (const row of data ?? []) {
    const cur = byFamily.get(row.family_id);
    if (!cur) {
      byFamily.set(row.family_id, { face: row, hasDraft: row.status === "draft", versions: 1 });
      continue;
    }
    cur.versions += 1;
    cur.hasDraft = cur.hasDraft || row.status === "draft";
    if (row.status === "published" && cur.face.status !== "published") cur.face = row;
    else if (cur.face.status !== "published" && row.version > cur.face.version) cur.face = row;
  }

  const q = (sp.q ?? "").trim().toLowerCase();
  const statusFilter = sp.status ?? "all";
  const families = [...byFamily.values()]
    .filter((f) => (q ? f.face.name.toLowerCase().includes(q) : true))
    .filter((f) => (statusFilter === "all" ? true : f.face.status === statusFilter))
    .sort((a, b) => a.face.name.localeCompare(b.face.name));

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
            ← Assets
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Inspection templates</h1>
          <p className="mt-1 text-sm text-slate-600">
            Reusable checklists for pre-use checks, recorded inspections and
            servicing. Published versions are locked — editing creates the next
            version.
          </p>
        </div>
        <Link
          href="/assets/templates/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New template
        </Link>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <form className="flex items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
          />
          {statusFilter !== "all" ? <input type="hidden" name="status" value={statusFilter} /> : null}
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Search
          </button>
        </form>
        <nav className="flex items-center gap-1 text-xs">
          {(["all", "published", "draft", "archived"] as const).map((s) => (
            <Link
              key={s}
              href={s === "all" ? "/assets/templates" : `/assets/templates?status=${s}`}
              className={`rounded-full px-3 py-1 font-medium ${
                statusFilter === s ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {s === "all" ? "All" : TEMPLATE_STATUS_LABELS[s]}
            </Link>
          ))}
        </nav>
      </div>

      {families.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📋"
            title="No inspection templates yet"
            body="Create your first checklist — an excavator pre-use check, a 7-day scaffold inspection, a harness check — then publish it to start recording inspections against it."
            primary={{ href: "/assets/templates/new", label: "Create a template" }}
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Level</th>
                <th className="px-4 py-3">Categories</th>
                <th className="px-4 py-3">Live version</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {families.map(({ face, hasDraft, versions }) => (
                <tr key={face.family_id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link href={`/assets/templates/${face.id}`} className="font-medium text-slate-900 hover:underline">
                      {face.name}
                    </Link>
                    {hasDraft && face.status === "published" ? (
                      <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Draft in progress</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{CHECK_LEVEL_LABELS[face.check_level]}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {face.categories?.length ? face.categories.join(", ") : "All assets"}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    v{face.version}
                    {versions > 1 ? <span className="text-slate-400"> · {versions} versions</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[face.status]}`}>
                      {TEMPLATE_STATUS_LABELS[face.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
