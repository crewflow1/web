import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import {
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUSES,
  isDisposed,
  type AssetOwnership,
  type AssetStatus,
} from "@/lib/assets/schema";

/**
 * /assets — the asset register. One org-scoped read; optional status filter.
 */

type AssetRow = {
  id: string;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  registration: string | null;
  ownership: string;
  status: string;
  created_at: string;
};

const STATUS_STYLES: Record<AssetStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  retired: "bg-slate-100 text-slate-600",
  sold: "bg-blue-100 text-blue-700",
  lost: "bg-amber-100 text-amber-800",
  stolen: "bg-red-100 text-red-800",
  written_off: "bg-red-100 text-red-800",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid asset.",
  forbidden: "Only an owner or admin can delete an asset.",
  delete_failed: "Couldn't delete that asset.",
  not_found: "That asset no longer exists.",
};
const SAVED_MAP: Record<string, string> = {
  created: "Asset added.",
  status: "Status updated.",
  deleted: "Asset deleted.",
};

type AssetQuery = Promise<{ data: AssetRow[] | null }> & {
  eq: (k: string, v: unknown) => AssetQuery;
};

type SP = Promise<{ status?: string; saved?: string; error?: string }>;

export default async function AssetsPage({ searchParams }: { searchParams: SP }) {
  await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const statusFilter =
    sp.status && (ASSET_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null;

  let query = (
    supabase.from("assets" as never) as unknown as {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => { limit: (n: number) => AssetQuery };
      };
    }
  )
    .select(
      "id, name, category, manufacturer, model, serial_number, registration, ownership, status, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(1000);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data } = await query;
  const rows = data ?? [];

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const activeCount = rows.filter((r) => !isDisposed(r.status as AssetStatus)).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Assets</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every van, machine and tool you own or hire — with serials, warranties,
            documents and history in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/assets/inspections"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Inspections
          </Link>
          <Link
            href="/assets/templates"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Templates
          </Link>
          <Link
            href="/assets/scan"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Scan
          </Link>
          <Link
            href="/assets/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            + Add asset
          </Link>
        </div>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <FilterLink current={sp.status ?? "all"} value="all" label="All" />
        {ASSET_STATUSES.map((s) => (
          <FilterLink key={s} current={sp.status ?? "all"} value={s} label={ASSET_STATUS_LABELS[s]} />
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          icon="🚜"
          title={statusFilter ? "No assets with this status" : "No assets yet"}
          body="Add your first asset — a van, a digger, a generator. Track its serial, warranty, documents, inspections and where it is."
          primary={{ href: "/assets/new", label: "Add an asset" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const status = row.status as AssetStatus;
            const ownership = row.ownership as AssetOwnership;
            const spec = [row.manufacturer, row.model].filter(Boolean).join(" ");
            const idn = row.registration || row.serial_number;
            return (
              <li key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
                        {ASSET_STATUS_LABELS[status] ?? row.status}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                        {ASSET_OWNERSHIP_LABELS[ownership] ?? row.ownership}
                      </span>
                      {row.category ? <span className="text-slate-500">{row.category}</span> : null}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">{row.name}</p>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      {spec ? <span>{spec}</span> : null}
                      {idn ? <span className="font-mono">{idn}</span> : null}
                    </div>
                  </div>
                  <Link
                    href={`/assets/${row.id}`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {rows.length} asset{rows.length === 1 ? "" : "s"} shown · {activeCount} active.
      </p>
    </div>
  );
}

function FilterLink({ current, value, label }: { current: string; value: string; label: string }) {
  const isActive = current === value;
  const href = value === "all" ? "/assets" : `/assets?status=${value}`;
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
