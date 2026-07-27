import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { resolveScannedAsset } from "../../assets/_scan";
import {
  ASSET_OWNERSHIP_LABELS,
  ASSET_STATUS_LABELS,
  type AssetOwnership,
  type AssetStatus,
} from "@/lib/assets/schema";

/**
 * /a/[token] — the QR scan landing.
 *
 * Under the (app) auth group, so an unauthenticated scan follows the app's
 * normal sign-in flow and returns here (an internal route — no open-redirect
 * surface). resolveScannedAsset is tenant-scoped, so a token that isn't the
 * scanner's org — or is unknown / revoked / malformed — renders the SAME
 * notFound(). The landing is deliberately thin: it confirms the asset and hands
 * off to the full detail page, which already carries the M2 custody actions
 * (check out / return / transfer) — no QR-specific custody logic.
 */
export default async function ScanPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await requireOrgContext();
  const { token } = await params;
  const asset = await resolveScannedAsset(token);
  if (!asset) notFound();

  const status = asset.status as AssetStatus;
  const ownership = asset.ownership as AssetOwnership;
  const spec = [asset.manufacturer, asset.model].filter(Boolean).join(" ");
  const idn = asset.registration || asset.serial_number;

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 py-8">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        Scanned asset
      </p>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
            {ASSET_STATUS_LABELS[status] ?? asset.status}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
            {ASSET_OWNERSHIP_LABELS[ownership] ?? asset.ownership}
          </span>
          {asset.category ? <span className="text-slate-500">{asset.category}</span> : null}
        </div>
        <h1 className="mt-2 text-xl font-bold text-slate-900">{asset.name}</h1>
        <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-slate-500">
          {spec ? <span>{spec}</span> : null}
          {idn ? <span className="font-mono">{idn}</span> : null}
        </div>

        <Link
          href={`/assets/${asset.id}`}
          className="mt-5 flex w-full items-center justify-center rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
        >
          View asset &amp; custody
        </Link>
      </div>

      <p className="text-center text-xs text-slate-400">
        Check-out, return and transfer are on the asset page.
      </p>
    </div>
  );
}
