import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createImport } from "./actions";
import { CONNECTORS } from "@/lib/imports/connectors";
import { CreateImportForm } from "./_create-form";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui";

/**
 * Migration OS entry point. Admins only.
 *
 *   /imports          — list past sessions + create new
 *   /imports/[id]     — wizard: upload → detect → preview → commit
 *   /imports/[id]/audit — committed-row list + rollback
 */

type SP = Promise<{ error?: string; saved?: string }>;

export default async function ImportsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) {
    return (
      <p className="text-sm text-slate-700">
        Imports are admin-only. Ask your owner for access.
      </p>
    );
  }
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: imports } = await supabase
    .from("imports")
    .select("id, name, status, created_at, committed_at, rolled_back_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "rolled_back"
      ? "Import rolled back — every row deleted."
      : null
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Migration OS</h1>
        <p className="mt-1 text-sm text-slate-600">
          Move your existing company into CrewFlow. Upload CSVs or Excel
          files; CrewFlow detects what each one is, shows you a sandbox
          preview, you approve, and we import. Anything imported can be
          rolled back from the audit log.
        </p>
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

      <section
        id="start-import"
        className="scroll-mt-20 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-900">Start a new import</h2>
        <p className="mt-1 text-xs text-slate-500">
          Supports <strong>CSV, Excel, PDF invoices/quotes, photos or
          screenshots</strong> (JPG, PNG, HEIC) <strong>and ZIP archives</strong>{" "}
          of any of these. Exporting from Sage, Xero, QuickBooks or
          Buildertrend? Use the guided steps below, then upload here.
        </p>
        <CreateImportForm action={createImport} />
      </section>

      <FadeIn className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">Past imports</h2>
        </header>
        {(imports ?? []).length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No imports yet.</p>
        ) : (
          <Stagger className="divide-y divide-slate-100">
            {(imports ?? []).map((im) => (
              <StaggerItem key={im.id} className="flex items-center justify-between px-6 py-3 text-sm">
                <div className="min-w-0">
                  <Link
                    href={`/imports/${im.id}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {im.name}
                  </Link>
                  <div className="text-xs text-slate-500">
                    started {im.created_at.slice(0, 16).replace("T", " ")}
                    {im.committed_at ? ` · committed ${im.committed_at.slice(0, 10)}` : ""}
                    {im.rolled_back_at ? ` · rolled back ${im.rolled_back_at.slice(0, 10)}` : ""}
                  </div>
                </div>
                <StatusPill status={im.status} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </FadeIn>

      {/* Connector catalogue — v2 placeholders, file-export upload now */}
      <FadeIn className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">
            Move from another system
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Guided import for your current tool. Export CSV/Excel (or a ZIP of
            several), then upload it — CrewFlow detects, maps and previews each
            file before anything is committed.
          </p>
        </header>
        <ul className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2">
          {CONNECTORS.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-slate-200 bg-slate-50/60 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {c.name}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">{c.blurb}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Accepts: {c.exportHints.join(", ")}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                  Guided
                </span>
              </div>
              <ol className="mt-3 list-decimal space-y-1 pl-4 text-[11px] text-slate-600">
                {c.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <a
                  href="#start-import"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800"
                >
                  Start {c.name} import →
                </a>
                {c.docs ? (
                  <a
                    href={c.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-medium text-slate-600 hover:text-slate-900"
                  >
                    How to export from {c.name} →
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </FadeIn>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    uploaded: "bg-slate-100 text-slate-700",
    detected: "bg-amber-100 text-amber-800",
    committed: "bg-green-100 text-green-800",
    rolled_back: "bg-red-100 text-red-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status] ?? "bg-slate-100 text-slate-700"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
