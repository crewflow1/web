import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { deleteComplianceDocument } from "./actions";

/**
 * /compliance — library of insurance, certificates, permits, contracts.
 *
 * Rows with `expires_at` set get the daily compliance-expiry cron
 * pinging the owner at 30d / 7d / today thresholds.
 */

type DocRow = {
  id: string;
  kind: string;
  title: string;
  filename: string | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
};

const KIND_LABELS: Record<string, string> = {
  insurance: "Insurance",
  certificate: "Certificate",
  permit: "Permit",
  contract: "Contract",
  other: "Other",
};

const KIND_STYLES: Record<string, string> = {
  insurance: "bg-indigo-100 text-indigo-800",
  certificate: "bg-emerald-100 text-emerald-800",
  permit: "bg-amber-100 text-amber-800",
  contract: "bg-slate-100 text-slate-800",
  other: "bg-slate-100 text-slate-600",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid document.",
  delete_failed: "Couldn't delete the document.",
  forbidden: "Only an owner or admin can delete compliance documents.",
  not_found: "That document no longer exists.",
};

const SAVED_MAP: Record<string, string> = {
  uploaded: "Document uploaded.",
  deleted: "Document deleted.",
};

type SP = Promise<{ kind?: string; saved?: string; error?: string }>;

export default async function CompliancePage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const filter =
    sp.kind && ["insurance", "certificate", "permit", "contract", "other"].includes(sp.kind)
      ? sp.kind
      : null;

  const baseQuery = (
    supabase.from("compliance_documents" as never) as unknown as {
      select: (cols: string) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => {
            eq: (
              k: string,
              v: unknown,
            ) => Promise<{ data: DocRow[] | null }>;
          } & Promise<{ data: DocRow[] | null }>;
        };
      };
    }
  )
    .select("id, kind, title, filename, expires_at, notes, created_at")
    .order("expires_at", { ascending: true })
    .limit(500);

  const result = filter
    ? await baseQuery.eq("kind", filter)
    : await (baseQuery as unknown as Promise<{ data: DocRow[] | null }>);
  const rows = result.data ?? [];

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? null : null;
  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? null : null;

  const today = new Date();
  const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Compliance</h1>
          <p className="mt-1 text-sm text-slate-600">
            Insurance certificates, trade permits, contracts. You&rsquo;ll get a
            reminder 30 days, 7 days and the day each expiry lands.
          </p>
        </div>
        <Link
          href="/compliance/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Add document
        </Link>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      <nav aria-label="Kind" className="flex flex-wrap gap-2 text-xs">
        <FilterLink current={sp.kind ?? "all"} value="all" label="All" />
        {(["insurance", "certificate", "permit", "contract", "other"] as const).map(
          (k) => (
            <FilterLink
              key={k}
              current={sp.kind ?? "all"}
              value={k}
              label={KIND_LABELS[k] ?? k}
            />
          ),
        )}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          icon="📄"
          title="No compliance docs yet"
          body="Upload insurance certificates, permits and contracts so we can chase you before they expire."
          primary={{ href: "/compliance/new", label: "Add a document" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
            const expiresInDays = expiresAt
              ? Math.ceil(
                  (expiresAt.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
                )
              : null;
            const urgent =
              expiresInDays != null && expiresInDays <= 7 && expiresInDays >= 0;
            const expired = expiresInDays != null && expiresInDays < 0;
            const soon =
              expiresInDays != null && expiresInDays > 7 && expiresInDays <= 30;

            return (
              <li
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${
                          KIND_STYLES[row.kind] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {KIND_LABELS[row.kind] ?? row.kind}
                      </span>
                      {expired ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                          EXPIRED
                        </span>
                      ) : urgent ? (
                        <span className="rounded-full bg-orange-100 px-2 py-0.5 font-medium text-orange-800">
                          Expires in {expiresInDays}d
                        </span>
                      ) : soon ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                          Expires in {expiresInDays}d
                        </span>
                      ) : row.expires_at ? (
                        <span className="text-slate-500">
                          Expires {row.expires_at}
                        </span>
                      ) : (
                        <span className="text-slate-500">No expiry</span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">
                      {row.title}
                    </p>
                    {row.filename ? (
                      <p className="text-xs text-slate-500">{row.filename}</p>
                    ) : null}
                    {row.notes ? (
                      <p className="mt-1 text-xs text-slate-600">{row.notes}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/compliance/${row.id}`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      View
                    </Link>
                    <form action={deleteComplianceDocument.bind(null, row.id)}>
                      <button
                        type="submit"
                        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        Showing {rows.length} document{rows.length === 1 ? "" : "s"}. Threshold
        for &ldquo;expiring soon&rdquo; is {in30.toISOString().slice(0, 10)}.
      </p>
    </div>
  );
}

function FilterLink({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href = value === "all" ? "/compliance" : `/compliance?kind=${value}`;
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
