import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  uploadImportFiles,
  commitImport,
  rollbackImport,
  ignoreDuplicateRow,
  resolveReviewRow,
  sendStaffInvitesFromImport,
  overrideSheetEntity,
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
    // ACTIVE-org pin — `imports: admin all` is `is_org_admin(org_id)`, which a
    // dual-org OWNER satisfies for BOTH orgs. This wizard commits and rolls
    // back rows, so opening the other company's session here is destructive.
    // Pinning the session makes the file/row reads below derived-safe.
    .eq("org_id", ctx.org.id)
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

  // Summary by entity type — covers both the pre-commit detection
  // view (counts + confidence) and the post-commit progress view
  // (imported vs flagged, matching the CEO directive's "Jobs: 98
  // imported, 2 flagged" example).
  type EntitySummary = {
    count: number;
    avgConfidence: number;
    duplicates: number;
    imported: number;
    flagged: number;
  };
  const summary = new Map<string, EntitySummary>();
  for (const r of rows ?? []) {
    const key = r.entity_type ?? "unknown";
    const t =
      summary.get(key) ??
      ({
        count: 0,
        avgConfidence: 0,
        duplicates: 0,
        imported: 0,
        flagged: 0,
      } as EntitySummary);
    t.count++;
    t.avgConfidence += r.confidence ?? 0;
    if (r.status === "duplicate") t.duplicates++;
    if (r.status === "imported") t.imported++;
    // "Flagged" = anything operator should look at: duplicates, errors,
    // skipped-with-message, and any row carrying an explicit warning.
    if (
      r.status === "duplicate" ||
      r.status === "error" ||
      r.status === "needs_review" ||
      (r.status === "skipped" && r.error_message) ||
      (r.error_message && r.status !== "imported")
    ) {
      t.flagged++;
    }
    summary.set(key, t);
  }
  for (const [, v] of summary) {
    v.avgConfidence = v.count > 0 ? Math.round(v.avgConfidence / v.count) : 0;
  }

  const errorMessage = sp.error
    ? sp.error === "pick_entity_type"
      ? "Pick an entity type before confirming this row."
      : sp.error === "not_reviewable"
        ? "This import can no longer be re-classified — it's already been committed or rolled back."
        : decodeURIComponent(sp.error)
    : null;
  // Rows we couldn't classify confidently — surfaced for the operator to
  // confirm / re-classify / skip. Never silently dropped from the import.
  const reviewRows = (rows ?? []).filter((r) => r.status === "needs_review");
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
              : sp.saved === "review_confirmed"
                ? "Row confirmed — it'll be included on the next commit."
                : sp.saved === "review_skipped"
                  ? "Row skipped — it won't be imported."
                  : sp.saved === "reclassified"
                    ? `Re-classified ${sp.count ?? 0} row${sp.count === "1" ? "" : "s"} — review and commit.`
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
              accept=".csv,.tsv,.tab,.txt,.psv,.xlsx,.xlsm,.xlsb,.xls,.xlt,.xltx,.ods,.fods,.numbers,.dif,.prn,.slk,.dbf,.pdf,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.zip,text/csv,application/csv,text/tab-separated-values,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet,application/pdf,image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/zip,application/x-zip-compressed"
              required
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800"
            />
            <p className="text-xs text-slate-500">
              Accepts every common export format — CSV, TSV/TXT, Excel
              (xlsx/xlsm/xlsb/xls), OpenDocument (ODS), Apple Numbers, PDF
              invoices/quotes, photos/screenshots (JPG / PNG / GIF / WEBP /
              HEIC), and ZIP archives of any of these. Spreadsheets/text are
              parsed directly; PDFs and images are read by an LLM. Every
              extracted row is reviewable before commit.
            </p>
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
              columns. Anything below 70% is worth a manual review. If a whole
              sheet was read as the wrong type, re-classify every row of it with
              the dropdown on its card.
            </p>
            <ul className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
              {Array.from(summary.entries()).map(([entity, t]) => (
                <li key={entity} className="flex flex-col rounded-lg border border-slate-200 p-3">
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
                  {/* Whole-sheet re-classification. The detector picks one type
                      per sheet; this lets the operator correct it for every row
                      of `entity` in one go, before commit. */}
                  <form
                    action={overrideSheetEntity.bind(null, imp.id, entity)}
                    className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3"
                  >
                    <label className="sr-only" htmlFor={`override-${entity}`}>
                      Re-classify {entity} rows as
                    </label>
                    <select
                      id={`override-${entity}`}
                      name="entity_type"
                      defaultValue={
                        SHEET_OVERRIDE_OPTIONS.some((o) => o.value === entity)
                          ? entity
                          : ""
                      }
                      className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                    >
                      <option value="">— set type —</option>
                      {SHEET_OVERRIDE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Override
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>

          {reviewRows.length > 0 ? (
            <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 shadow-sm">
              <h2 className="text-base font-semibold text-amber-900">
                Needs review
                <span className="ml-2 inline-flex rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                  {reviewRows.length}
                </span>
              </h2>
              <p className="mt-1 text-xs text-amber-800">
                We weren&apos;t confident enough to auto-import these rows — the
                entity type was unclear or required fields were missing. Nothing
                here is lost or failed. Confirm a row (correcting its type if
                needed) to include it on commit, or skip it. Rows left in review
                are simply not imported.
              </p>
              <div className="mt-4 space-y-3">
                {reviewRows.slice(0, 50).map((r) => {
                  const mapped = (r.mapped ?? {}) as Record<string, unknown>;
                  const current = r.entity_type ?? "";
                  const selectDefault = REVIEW_ENTITY_OPTIONS.includes(current)
                    ? current
                    : "";
                  return (
                    <form
                      key={r.id}
                      action={resolveReviewRow.bind(null, r.id)}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-white p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-slate-700">
                          <RowSummary mapped={mapped} entity={r.entity_type} />
                        </div>
                        {r.error_message ? (
                          <div className="mt-1 text-[11px] text-amber-700">
                            {r.error_message}
                          </div>
                        ) : (
                          <div className="mt-1 text-[11px] text-slate-400">
                            detected: {r.entity_type ?? "unknown"} · confidence{" "}
                            {r.confidence ?? 0}%
                          </div>
                        )}
                      </div>
                      <label className="text-[11px] text-slate-600">
                        Import as{" "}
                        <select
                          name="entity_type"
                          defaultValue={selectDefault}
                          className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
                        >
                          <option value="">— pick type —</option>
                          {REVIEW_ENTITY_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          name="intent"
                          value="confirm"
                          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                        >
                          Confirm &amp; include
                        </button>
                        <button
                          type="submit"
                          name="intent"
                          value="skip"
                          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Skip
                        </button>
                      </div>
                    </form>
                  );
                })}
              </div>
              {reviewRows.length > 50 ? (
                <p className="mt-3 text-xs text-amber-700">
                  Showing first 50 of {reviewRows.length} rows needing review.
                </p>
              ) : null}
            </section>
          ) : null}

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
              Rows we couldn&apos;t classify confidently are held in{" "}
              <strong>Needs review</strong> above — confirm or skip each one;
              they aren&apos;t imported until you do. Duplicates you
              haven&apos;t addressed are skipped. Everything else is inserted
              into your live tables and recorded in the audit log so you can
              roll back in one click.
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
                <div className="flex items-baseline justify-between">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{entity}</div>
                  <div className="text-[10px] text-slate-400">
                    of {t.count}
                  </div>
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span>
                    <span className="text-xl font-bold text-emerald-700">
                      {t.imported}
                    </span>
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-emerald-700">
                      imported
                    </span>
                  </span>
                  {t.flagged > 0 ? (
                    <span>
                      <span className="text-xl font-bold text-amber-700">
                        {t.flagged}
                      </span>
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-700">
                        flagged
                      </span>
                    </span>
                  ) : null}
                </div>
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

// Entity types an operator can assign to a row in the Needs-review queue.
// Mirrors the detector's EntityType union. (Can't import the runtime list
// from actions.ts — a "use server" module may only export async functions.)
const REVIEW_ENTITY_OPTIONS: readonly string[] = [
  "customer",
  "supplier",
  "staff",
  "lead",
  "invoice",
  "cost",
  "quote",
  "job",
  "payment",
];

// Entity types the operator can assign to a whole sheet via the per-card
// override on the detection screen. "Expense" is the human label for the
// `cost` entity. Mirrors SHEET_OVERRIDE_ENTITIES in actions.ts (kept in sync by
// hand — a "use server" module can only export async functions, not arrays).
const SHEET_OVERRIDE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "customer", label: "Customer" },
  { value: "staff", label: "Staff" },
  { value: "job", label: "Job" },
  { value: "quote", label: "Quote" },
  { value: "invoice", label: "Invoice" },
  { value: "supplier", label: "Supplier" },
  { value: "cost", label: "Expense" },
  { value: "payment", label: "Payment" },
];

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
    job: ["customer_name", "status", "scheduled_date"],
    quote: ["number", "customer_name", "total"],
    payment: ["invoice_number", "amount", "paid_at"],
  };
  const fields = order[entity ?? ""] ?? Object.keys(mapped).slice(0, 3);
  return (
    <span>
      {fields.map((f, i) => {
        const v = mapped[f];
        if (v === undefined || v === null || v === "") return null;
        const display =
          f === "total" ||
          f === "amount" ||
          f === "estimated_value" ||
          f === "hourly_pay" ||
          f === "value"
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
