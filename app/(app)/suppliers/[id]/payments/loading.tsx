import { SkeletonDetail, SkeletonHeader } from "@/components/ui/skeleton";

// Instant Suspense fallback so opening a supplier's payment ledger shows a
// skeleton rather than holding on the previous route.
export default function SupplierPaymentsLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <SkeletonHeader />
      <SkeletonDetail cards={4} />
    </div>
  );
}
