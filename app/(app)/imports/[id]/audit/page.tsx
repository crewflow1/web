import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { rollbackImport } from "../../actions";

/**
 * Audit log for one import session. Every imported row, its source file,
 * destination table + id, and a rollback button.
 */

export default async function ImportAuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return <p className="text-sm text-slate-700">Imports are admin-only.</p>;
  }
  const { id } = await params;
  const supabase = await createClient();

  const { data: imp } = await supabase
    .from("imports")
    .select("id, name, status, created_at, committed_at, rolled_back_at")
    .eq("id", id)
    // ACTIVE-org pin — same reasoning as the wizard: this page offers rollback.
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!imp) notFound();

  const [{ data: files }, { data: audit }] = await Promise.all([
    supabase
      .from("import_files")
      .select("id, filename")
      .eq("import_id", id),
    supabase
      .from("import_audit")
      .select("id, target_table, target_id, created_at, import_row_id")
      .eq("import_id", id)
      .order("created_at", { ascending: false }),
  ]);

  // Row metadata for the "what was imported" column.
  const rowIds = (audit ?? []).map((a) => a.import_row_id).filter((x): x is string => !!x);
  let rows: Array<{ id: string; entity_type: string | null; mapped: Record<string, unknown>; file_id: string }> = [];
  if (rowIds.length > 0) {
    const { data } = await supabase
      .from("import_rows")
      .select("id, entity_type, mapped, file_id")
      .in("id", rowIds);
    rows = (data ?? []).map((r) => ({
      id: r.id,
      entity_type: r.entity_type,
      mapped: r.mapped as Record<string, unknown>,
      file_id: r.file_id,
    }));
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const fileById = new Map((files ?? []).map((f) => [f.id, f.filename]));

  // Counts by target_table.
  const byTable = new Map<string, number>();
  for (const a of audit ?? []) {
    byTable.set(a.target_table, (byTable.get(a.target_table) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/imports" className="hover:text-slate-900">Imports</Link>
        <span aria-hidden>/</span>
        <Link href={`/imports/${imp.id}`} className="hover:text-slate-900">{imp.name}</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Audit</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit log</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every row this import inserted. Roll back to undo all of it.
          </p>
        </div>
        {imp.status === "committed" ? (
          <form action={rollbackImport.bind(null, imp.id)}>
            <button
              type="submit"
              className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Roll back entire import
            </button>
          </form>
        ) : null}
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from(byTable.entries()).map(([table, count]) => (
          <div key={table} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">{table}</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{count}</div>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Source file</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Mapped</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Imported at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(audit ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-slate-500">
                    {imp.status === "rolled_back" ? "Rolled back." : "Nothing imported yet."}
                  </td>
                </tr>
              ) : null}
              {(audit ?? []).map((a) => {
                const row = a.import_row_id ? rowById.get(a.import_row_id) : null;
                const filename = row ? fileById.get(row.file_id) ?? "—" : "—";
                const mapped = row?.mapped ?? {};
                const name =
                  (mapped as { name?: string; full_name?: string; number?: string }).name ??
                  (mapped as { full_name?: string }).full_name ??
                  (mapped as { number?: string }).number ??
                  "—";
                return (
                  <tr key={a.id}>
                    <td className="px-3 py-2 text-xs text-slate-700">{filename}</td>
                    <td className="px-3 py-2 text-xs text-slate-700 capitalize">{row?.entity_type ?? "—"}</td>
                    <td className="px-3 py-2 text-sm text-slate-900">{name}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {a.target_table} · {a.target_id.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {a.created_at.slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
