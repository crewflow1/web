import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { AssetScanner } from "./_scanner";

export const metadata = { title: "Scan asset · CrewFlow" };

/**
 * /assets/scan — the in-app QR scanner entry. A thin authed server shell
 * (tenant context required, like every asset surface) that renders the client
 * scanner. The scanner never resolves an asset itself; it only extracts a token
 * and hands off to the existing `/a/[token]` route, which resolves behind auth
 * + RLS.
 */
export default async function AssetScanPage() {
  await requireOrgContext();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Scan an asset</h1>
          <p className="mt-1 text-sm text-slate-600">
            Scan a printed QR label to jump straight to an asset and its custody
            actions.
          </p>
        </div>
        <Link
          href="/assets"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          All assets
        </Link>
      </header>

      <AssetScanner />
    </div>
  );
}
