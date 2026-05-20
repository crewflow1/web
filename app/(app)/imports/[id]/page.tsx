import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  uploadImportFiles,
  commitImport,
  rollbackImport,
  ignoreDuplicateRow,
  sendStaffInvitesFromImport,
} from "../actions";

/**
 * The import wizard. Five steps in one page; the displayed UI is driven
 * by `import.status`:
 *
 *   uploaded   → step 1: upload files
 *   detected   → step 2–4: detection summary, preview, approve
 *   committed  → step 5: post-commit summary + rollback button
 *   rolled_back → archive view
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string; imported?: string; skipped?: string; count?: string }>;

export default async function ImportWizardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return <p className="text-sm text-slate-700">Imports are admin-only.</p>;
  }
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: imp } = await supabase
    .from("imports")
    .select("id, name, status, created_at, committed_at, rolled_back_at")
    .eq("id", id)
    .maybeSingle();
  if (!imp) notFound();

  const [{ data: files }, { data: rows }] = await Promise.all([
    supabase
      .from("import_files")
      .select("id, filename, row_count, size_bytes, mime_type")
      .eq("import_id", id),
    supabase
      .from("import_rows")
      .select("id, entity_type, confidence, status, mapped, error_message, duplicate_of_id")
      .eq("import_id", id)
      .order("confidence", { ascending: false }),
  ]);

  // Summary by entity type.
  const summary = new Map<string, { count: number; avgConfidence: number; duplicates: number }>();
  for (const r of rows ?? []) {
    const key = r.entity_type ?? "unknown";
    const t = summary.get(key) ?? { count: 0, avgConfidence: 0, duplicates: 0 };
    t.count++;
    t.avgConfidence += r.confidence ?? 0;
    if (r.status === "duplicate") t.duplicates++;
    summary.set(key, t);
  }
  for (const [, v] of summary) {
    v.avgConfidence = v.count > 0 ? Math.round(v.avgConfidence / v.count) : 0;
  }

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "uploaded"
      ? "Files parsed. Review what we detected, then commit."
      : sp.saved === "committed"
        ? `Imported ${sp.imported ?? 0} rows, skipped ${sp.skipped ?? 0}.`
        : sp.saved === "rolled_back"
          ? "Everything rolled back. Imported rows have been deleted."
          : sp.saved === "duplicate_skipped"
            ? "Duplicate skipped — existing record kept."
            : sp.saved === "invites_sent"
              ? `Sent ${sp.count ?? 0} staff invite${sp.count === "1" ? "" : "s"}.`
              : null
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/imports" className="hover:text-slate-900">Imports</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900 truncate">{imp.name}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{imp.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Started {imp.created_at.slice(0, 16).replace("T", " ")} ·{" "}
            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${pillClass(imp.status)}`}>
              {imp.status.replace("_", " ")}
            </span>
          </p>
        </div>
        <Link
          href={`/imports/${imp.id}/audit`}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Audit log →
        </Link>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {savedMessage}
        </div>
      ) : null}

      <ol className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className={
              isStepActive(imp.status, s.key)
                ? "rounded-full border border-slate-900 bg-slate-900 px-3 py-1 font-medium text-white"
                : isStepDone(imp.status, s.key)
                  ? "rounded-full border border-green-300 bg-green-50 px-3 py-1 font-medium text-green-800"
                  : "rounded-full border border-slate-200 bg-white px-3 py-1 font-medium text-slate-500"
            }
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {/* Step 1 — Upload */}
      {imp.status === "uploaded" || imp.status === "failed" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">1. Upload files</h2>
          <p className="mt-1 text-xs text-slate-500">
            Drop one or more CSV / Excel exports. We&apos;ll parse each
            file, detect what kind of data it is, and write nothing to
            your real tables yet — that&apos;s your call after preview.
          </p>
          <form
            action={uploadImportFiles.bind(null, imp.id)}
            encType="multipart/form-data"
            className="mt-4 space-y-3"
          >
            <input
              type="file"
              name="file"
              multiple
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800"
            />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Parse + detect
            </button>
          </form>
          {(files ?? []).length > 0 ? (
            <div className="mt-4 text-xs text-slate-500">
              <strong>Already attached:</strong>
              <ul className="mt-1 list-disc pl-4">
                {(files ?? []).map((f) => (
                  <li key={f.id}>
                    {f.filename} — {f.row_count} rows
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Step 2–4 — Detected, preview, approve */}
      {imp.status === "detected" ? (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              2. Detection summary
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Per entity type, the average confidence we have in the detected
              columns. Anything below 70% is worth a manual review.
            </p>
            <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
              {Array.from(summary.entries()).map(([entity, t]) => (
                <li key={entity} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{entity}</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">{t.count}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    avg confidence {t.avgConfidence}%
                    {t.duplicates > 0 ? ` · ${t.duplicates} duplicate${t.duplicates === 1 ? "" : "s"}` : ""}
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-100">
                    <div
                      className={
                        t.avgConfidence >= 80
                          ? "h-full bg-green-500"
                          : t.avgConfidence >= 60
                            ? "h-full bg-amber-500"
                            : "h-full bg-red-500"
                      }
                      style={{ width: `${t.avgConfidence}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              3. Sandbox preview
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              First 50 rows of what we&apos;ll import. Duplicates are flagged
              and will be skipped unless you tell us otherwise — your existing
              records are preserved.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Entity</th>
                    <th className="px-3 py-2">Mapped fields</th>
                    <th className="px-3 py-2 text-right">Confidence</th>
                    <th className="px-3 py-2 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(rows ?? []).slice(0, 50).map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-slate-700 capitalize">{r.entity_type ?? "unknown"}</td>
                      <td className="px-3 py-2 text-xs text-slate-700">
                        <RowSummary mapped={r.mapped as Record<string, unknown>} entity={r.entity_type} />
                        {r.error_message ? (
                          <div className="mt-1 text-amber-700 text-[11px]">{r.error_message}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <ConfidencePill value={r.confidence ?? 0} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.status === "duplicate" ? (
                          <form action={ignoreDuplicateRow.bind(null, r.id)} className="inline">
                            <button
                              type="submit"
                              className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                              title="Skip this row — keep the existing record"
                            >
                              duplicate · skip
                            </button>
                          </form>
                        ) : (
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                            {r.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(rows ?? []).length > 50 ? (
                <p className="mt-3 text-xs text-slate-500">
                  Showing first 50 of {rows?.length ?? 0} rows. All rows will be processed on commit.
                </p>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-6">
            <h2 className="text-base font-semibold text-slate-900">4. Approve + import</h2>
            <p className="mt-1 text-xs text-slate-600">
              Rows below 50% confidence are skipped automatically. Duplicates
              you haven&apos;t addressed are also skipped. Everything else is
              inserted into your live tables and recorded in the audit log
              so you can roll back in one click.
            </p>
            <form action={commitImport.bind(null, imp.id)} className="mt-4">
              <button
                type="submit"
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700"
              >
                Commit import
              </button>
            </form>
          </section>
        </>
      ) : null}

      {/* Post-commit summary + rollback */}
      {imp.status === "committed" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">5. Imported</h2>
          <p className="mt-1 text-xs text-slate-500">
            Committed at {imp.committed_at?.slice(0, 16).replace("T", " ")}.
            Anything you&apos;re unhappy with can be reversed in one click.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
            {Array.from(summary.entries()).map(([entity, t]) => (
              <li key={entity} className="rounded-lg border border-slate-200 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500">{entity}</div>
                <div className="mt-1 text-xl font-bold text-slate-900">{t.count}</div>
              </li>
            ))}
          </ul>

          {/* Wave 6 — staff invite follow-up */}
          {(summary.get("staff")?.count ?? 0) > 0 ? (
            <div className="mt-5 rounded-md border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-medium text-blue-900">
                {summary.get("staff")?.count} staff row{summary.get("staff")?.count === 1 ? "" : "s"} detected
              </p>
              <p className="mt-1 text-xs text-blue-800">
                Staff rows can&apos;t be auto-provisioned — they need an
                auth account first. Send each one a magic-link invite to
                join your org now.
              </p>
              <form action={sendStaffInvitesFromImport.bind(null, imp.id)} className="mt-3">
                <button
                  type="submit"
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  Send invites to imported staff
                </button>
              </form>
            </div>
          ) : null}

          <form action={rollbackImport.bind(null, imp.id)} className="mt-4">
            <button
              type="submit"
              className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Roll back this entire import
            </button>
          </form>
        </section>
      ) : null}

      {imp.status === "rolled_back" ? (
        <section className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
          This import was rolled back at {imp.rolled_back_at?.slice(0, 16).replace("T", " ")}.
          Every row it created has been deleted from your live tables.
        </section>
      ) : null}
    </div>
  );
}

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "detected", label: "Detected" },
  { key: "preview", label: "Preview" },
  { key: "approve", label: "Approve" },
  { key: "import", label: "Import" },
];

function isStepActive(status: string, step: string): boolean {
  if (status === "uploaded" || status === "failed") return step === "upload";
  if (status === "detected") return step === "preview" || step === "approve" || step === "detected";
  if (status === "committed") return step === "import";
  return false;
}

function isStepDone(status: string, step: string): boolean {
  const order = ["upload", "detected", "preview", "approve", "import"];
  const cur =
    status === "uploaded" || status === "failed"
      ? -1
      : status === "detected"
        ? order.indexOf("detected")
        : status === "committed"
          ? order.indexOf("import")
          : -1;
  return order.indexOf(step) < cur;
}

function pillClass(status: string): string {
  switch (status) {
    case "uploaded":
      return "bg-slate-100 text-slate-700";
    case "detected":
      return "bg-amber-100 text-amber-800";
    case "committed":
      return "bg-green-100 text-green-800";
    case "rolled_back":
      return "bg-red-100 text-red-700";
    case "failed":
      return "bg-red-100 text-red-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function ConfidencePill({ value }: { value: number }) {
  const cls =
    value >= 80
      ? "bg-green-100 text-green-800"
      : value >= 60
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-700";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {value}%
    </span>
  );
}

function RowSummary({
  mapped,
  entity,
}: {
  mapped: Record<string, unknown>;
  entity: string | null;
}) {
  // Render the 2–3 most-recognisable mapped fields.
  const order: Record<string, string[]> = {
    customer: ["name", "email", "phone"],
    invoice: ["number", "total", "due_date"],
    lead: ["name", "service", "estimated_value"],
    staff: ["full_name", "email", "hourly_pay"],
    cost: ["amount", "category", "notes"],
    supplier: ["name", "email"],
  };
  const fields = order[entity ?? ""] ?? Object.keys(mapped).slice(0, 3);
  return (
    <span>
      {fields.map((f, i) => {
        const v = mapped[f];
        if (v === undefined || v === null || v === "") return null;
        const display =
          f === "total" || f === "amount" || f === "estimated_value" || f === "hourly_pay"
            ? GBP.format(Number(v))
            : String(v);
        return (
          <span key={f} className="mr-2">
            <span className="text-slate-500">{f}</span>: <span className="text-slate-900">{display}</span>
            {i < fields.length - 1 ? " ·" : ""}
          </span>
        );
      })}
    </span>
  );
}
