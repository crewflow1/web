import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUSES,
  type AssetOwnership,
  type AssetStatus,
} from "@/lib/assets/schema";
import { deleteAsset, updateAssetStatus } from "../actions";

type AssetRow = {
  id: string;
  name: string;
  category: string | null;
  asset_ref: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  registration: string | null;
  ownership: string;
  status: string;
  supplier_id: string | null;
  purchase_date: string | null;
  purchase_price: number | string | null;
  current_value: number | string | null;
  warranty_expires_at: string | null;
  hire_start: string | null;
  hire_end: string | null;
  hire_rate: number | string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
};

const STATUS_STYLES: Record<AssetStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  retired: "bg-slate-100 text-slate-600",
  sold: "bg-blue-100 text-blue-700",
  lost: "bg-amber-100 text-amber-800",
  stolen: "bg-red-100 text-red-800",
  written_off: "bg-red-100 text-red-800",
};

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });
const money = (v: number | string | null) => (v == null ? "—" : GBP.format(Number(v)));

const SAVED_MAP: Record<string, string> = { created: "Asset added.", status: "Status updated." };
const ERROR_MAP: Record<string, string> = {
  bad_status: "Invalid status.",
  update_failed: "Couldn't update the asset.",
};

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: asset } = await (
    supabase.from("assets" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: AssetRow | null }> };
      };
    }
  )
    .select(
      "id, name, category, asset_ref, manufacturer, model, serial_number, registration, ownership, status, supplier_id, purchase_date, purchase_price, current_value, warranty_expires_at, hire_start, hire_end, hire_rate, notes, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (!asset) notFound();

  const status = asset.status as AssetStatus;
  const ownership = asset.ownership as AssetOwnership;
  const canDelete = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  let supplierName: string | null = null;
  if (asset.supplier_id) {
    const { data: s } = await (
      supabase.from("suppliers" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: { name: string | null } | null }>;
          };
        };
      }
    )
      .select("name")
      .eq("id", asset.supplier_id)
      .maybeSingle();
    supplierName = s?.name ?? null;
  }

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link href="/assets" className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900">
          ← Assets
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{asset.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
            {ASSET_STATUS_LABELS[status] ?? asset.status}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
            {ASSET_OWNERSHIP_LABELS[ownership] ?? asset.ownership}
          </span>
          {asset.category ? <span className="text-slate-500">{asset.category}</span> : null}
        </div>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedMessage}</div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Detail label="Manufacturer">{asset.manufacturer}</Detail>
          <Detail label="Model">{asset.model}</Detail>
          <Detail label="Serial number">{asset.serial_number}</Detail>
          <Detail label="Registration">{asset.registration}</Detail>
          <Detail label="Your reference">{asset.asset_ref}</Detail>
          <Detail label="Supplier">{supplierName}</Detail>
          <Detail label="Purchase date">{asset.purchase_date}</Detail>
          <Detail label="Purchase price">{money(asset.purchase_price)}</Detail>
          <Detail label="Current value">{money(asset.current_value)}</Detail>
          <Detail label="Warranty expiry">{asset.warranty_expires_at}</Detail>
          {ownership === "hired" ? (
            <>
              <Detail label="Hire period">
                {asset.hire_start || asset.hire_end
                  ? `${asset.hire_start ?? "—"} → ${asset.hire_end ?? "—"}`
                  : "—"}
              </Detail>
              <Detail label="Hire rate">{money(asset.hire_rate)}</Detail>
            </>
          ) : null}
        </dl>
        {asset.notes ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{asset.notes}</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Status</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {ASSET_STATUSES.map((s) => {
            const isCurrent = s === status;
            return (
              <form key={s} action={updateAssetStatus}>
                <input type="hidden" name="id" value={asset.id} />
                <input type="hidden" name="status" value={s} />
                <button
                  type="submit"
                  disabled={isCurrent}
                  className={
                    isCurrent
                      ? "cursor-default rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                      : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  }
                >
                  {ASSET_STATUS_LABELS[s]}
                </button>
              </form>
            );
          })}
        </div>
      </section>

      {/* Images, manuals, certificates — via the universal attachments pipeline. */}
      <AttachmentsPanel targetTable="assets" targetId={asset.id} />

      {canDelete ? (
        <form action={deleteAsset.bind(null, asset.id)}>
          <button type="submit" className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
            Delete asset
          </button>
          <span className="ml-3 text-xs text-slate-500">Prefer a status change (retired/sold) to keep the history.</span>
        </form>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children || "—"}</dd>
    </div>
  );
}
