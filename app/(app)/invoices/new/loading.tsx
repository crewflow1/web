import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeleton for /invoices/new.
 *
 * WITHOUT this file the segment falls back to the nearest ancestor boundary —
 * app/(app)/invoices/loading.tsx — which renders a full 8×7 TABLE skeleton.
 * That table is the wrong shape for this form page and, on real network
 * latency while the server fetches the org's accepted quotes, it visibly
 * "sits" looking broken. This form-shaped skeleton matches what actually
 * renders, so the navigation transition stays calm.
 */
export default function NewInvoiceLoading() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      {/* breadcrumb */}
      <Skeleton className="h-4 w-32" />

      {/* header */}
      <div>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>

      {/* form card: three fields + a submit button */}
      <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-1.5 h-10 w-full" />
          </div>
        ))}
        <Skeleton className="h-10 w-36" />
      </div>
    </div>
  );
}
