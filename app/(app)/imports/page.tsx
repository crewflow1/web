import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createImport } from "./actions";
import { CreateImportForm } from "./_create-form";

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

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Start a new import</h2>
        <p className="mt-1 text-xs text-slate-500">
          v1 supports <strong>CSV + Excel</strong>. v2 will add PDF +
          photos via OCR; v3 native connectors for Sage, Xero, QuickBooks
          and Buildertrend.
        </p>
        <CreateImportForm action={createImport} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">Past imports</h2>
        </header>
        {(imports ?? []).length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No imports yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {(imports ?? []).map((im) => (
              <li key={im.id} className="flex items-center justify-between px-6 py-3 text-sm">
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
              </li>
            ))}
          </ul>
        )}
      </section>
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
